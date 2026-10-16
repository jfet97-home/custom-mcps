import { Cause, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { Backups, contentHash } from "./backups.js"
import { decode, failure, PocketError } from "./core.js"
import { Account, ActionItem, ActionPage, Folders, RawActionPage, RecordingPage, SearchPage, Space } from "./contracts.js"
import { Id, notesFrom, RecordingDetail, transcriptFrom } from "./recording.js"
import { PocketTransport } from "./transport.js"

export const checked = <A>(f: () => A): Effect.Effect<A, PocketError> => Effect.try({
  try: f, catch: (error) => error instanceof PocketError ? error : failure("upstream", "Pocket returned an unsupported response.")
})

export interface RecordingQuery { readonly page?: number; readonly limit?: number; readonly folderId?: string }
export interface SearchQuery { readonly query: string; readonly limit?: number; readonly workspaceId?: string }
export interface NotesUpdate { readonly recordingId: string; readonly summarizationId: string; readonly markdown: string; readonly expectedHash: string }
export interface TranscriptEdit {
  readonly recordingId: string; readonly expectedHash: string; readonly allowOriginalTextOverwrite?: boolean
  readonly corrections: ReadonlyArray<{ readonly segmentIndex: number; readonly text: string }>
}
export interface ActionQuery { readonly query?: string; readonly recordingId?: string; readonly limit?: number; readonly offset?: number }
export interface ActionUpdate {
  readonly recordingId: string; readonly actionItemId: string; readonly expectedHash: string
  readonly title?: string; readonly dueDate?: string | null; readonly completed?: boolean
}

const idPath = (id: string) => encodeURIComponent(id)
const queryPath = (path: string, values: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value))
  return `${path}?${query}`
}
const requireHash = (expected: string, actual: string) => {
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw failure("validation", "An expectedHash from a fresh read is required before every write.")
  if (expected !== actual) throw failure("conflict", "Content changed since it was read. Read it again before editing.")
}
const withBackup = <A, R>(backupId: string, effect: Effect.Effect<A, PocketError, R>) => effect.pipe(
  Effect.mapError((error) => new PocketError({ ...error, backupId }))
)

const commitWrite = <A, R>(backupId: string, kind: string, operation: Effect.Effect<A, PocketError, R>) => Effect.uninterruptible(Effect.gen(function*() {
  const result = yield* operation.pipe(Effect.exit)
  const outcome = result._tag === "Success" ? "verified" : "uncertain"
  yield* Effect.sync(() => { process.stderr.write(`${JSON.stringify({ event: "pocket_write", kind, backupId, outcome })}\n`) })
  if (result._tag === "Failure") {
    const found = Cause.findFail(result.cause)
    const original = found._tag === "Success" && found.success.error instanceof PocketError ? found.success.error : undefined
    return yield* Effect.fail(new PocketError({
      code: "uncertain_write", backupId,
      message: `${original?.message ?? "Write verification did not complete."} The write may already be applied; reread before another write.`,
      ...(original?.status === undefined ? {} : { status: original.status })
    }))
  }
  return result.value
}))

const rawActions = (groups: ReadonlyArray<Record<string, unknown>>) => {
  const found = new Map<string, { item: typeof ActionItem.Type; raw: Record<string, unknown> }>()
  const visit = (node: Record<string, unknown>, depth: number) => {
    if (depth > 20) throw failure("upstream", "Pocket returned an excessively nested action-item hierarchy.")
    if (typeof node.id === "string" && "title" in node) found.set(node.id, { item: decode(ActionItem, node), raw: node })
    if (Array.isArray(node.subtasks)) for (const child of node.subtasks) {
      if (typeof child !== "object" || child === null || Array.isArray(child)) throw failure("upstream", "Pocket returned an invalid action item.")
      visit(child as Record<string, unknown>, depth + 1)
    }
  }
  for (const group of groups) visit(group, 0)
  return [...found.values()].map(({ item, raw }) => ({ item: { ...item, hash: contentHash(item) }, raw }))
}
export const flattenActions = (groups: ReadonlyArray<Record<string, unknown>>) => rawActions(groups).map(({ item }) => item)

export const actionCompleted = (item: typeof ActionItem.Type): boolean => item.isCompleted ?? (
  typeof item.status === "string" ? ["DONE", "COMPLETED", "COMPLETE"].includes(item.status.toUpperCase()) : item.completedAt != null
)
export const sameDueDate = (expected: string | null | undefined, actual: string | null | undefined): boolean =>
  expected === undefined || expected === null && actual == null || typeof expected === "string" && typeof actual === "string" && (
    /^\d{4}-\d{2}-\d{2}$/.test(expected) ? actual.slice(0, 10) === expected : Date.parse(expected) === Date.parse(actual)
  )

const makePocket = Effect.gen(function*() {
  const api = yield* PocketTransport
  const backups = yield* Backups
  const writes = yield* Semaphore.make(1)
  const detail = (recordingId: string) => api.request("GET", `/api/v1/recordings/${idPath(recordingId)}?include=all`)
  const getNotes = (recordingId: string, summarizationId?: string) => Effect.gen(function*() {
    const raw = yield* detail(recordingId)
    return yield* checked(() => notesFrom(raw, summarizationId))
  })
  const getTranscript = (recordingId: string) => Effect.gen(function*() {
    const raw = yield* detail(recordingId)
    return yield* checked(() => transcriptFrom(raw))
  })
  const actionPageRaw = (input: ActionQuery) => Effect.gen(function*() {
    const raw = yield* api.request("GET", queryPath(input.query ? "/api/v1/global-action-items/search" : "/api/v1/global-action-items/hierarchy", {
      query: input.query, recordingId: input.recordingId, limit: input.limit ?? 50, offset: input.offset ?? 0
    }))
    return yield* checked(() => {
      const page = decode(RawActionPage, raw)
      if (!page.success) throw failure("upstream", "Pocket could not load action items.")
      return { ...page, entries: rawActions(page.data) }
    })
  })
  const actionPage = (input: ActionQuery) => actionPageRaw(input).pipe(Effect.flatMap((page) => checked(() =>
    decode(ActionPage, { items: page.entries.map(({ item }) => item), pagination: page.pagination })
  )))
  const findAction = (recordingId: string, actionItemId: string) => Effect.gen(function*() {
    let offset = 0
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = yield* actionPageRaw({ recordingId, limit: 100, offset })
      const found = page.entries.find(({ item }) => item.id === actionItemId && item.recordingId === recordingId)
      if (found) return found
      const returned = page.pagination.returned
      if (returned <= 0 || offset + returned >= page.pagination.total) break
      offset += returned
    }
    return yield* Effect.fail(failure("validation", "The global action-item ID was not found on this recording. Use search_action_items to obtain its ID."))
  })
  return {
    listRecordings: (input: RecordingQuery) => Effect.gen(function*() {
      const raw = yield* api.request("GET", queryPath("/api/v1/recordings", { limit: input.limit ?? 50, page: input.page ?? 1, folderId: input.folderId }))
      return yield* checked(() => decode(RecordingPage, raw))
    }),
    searchRecordings: (input: SearchQuery) => Effect.gen(function*() {
      if (!input.query.trim()) return yield* Effect.fail(failure("validation", "Provide a nonempty search query."))
      const raw = yield* api.request("GET", queryPath("/api/v1/search", { q: input.query.trim(), searchType: "hybrid_semantic", sort: "relevance", limit: input.limit ?? 20, workspaceId: input.workspaceId }))
      return yield* checked(() => decode(SearchPage, raw))
    }),
    getRecording: (recordingId: string) => Effect.gen(function*() {
      const raw = yield* detail(recordingId)
      return yield* checked(() => {
        const value = decode(RecordingDetail, raw)
        return { ...value, contentHashes: {
          transcript: value.transcription?.transcription ? transcriptFrom(raw).hash : null,
          notes: Object.values(value.summarizations ?? {}).flatMap((s) => (s.v2?.summary ?? s.summary)?.markdown === undefined ? [] : [{ summarizationId: s.summarizationId, hash: notesFrom(raw, s.summarizationId).hash }])
        } }
      })
    }),
    getNotes, getTranscript,
    updateNotes: (input: NotesUpdate) => writes.withPermit(Effect.gen(function*() {
      const raw = yield* detail(input.recordingId)
      const before = yield* checked(() => notesFrom(raw, input.summarizationId))
      yield* checked(() => requireHash(input.expectedHash, before.hash))
      const backup = yield* backups.save("notes", input.recordingId, { document: before, rawRecording: raw }, before.summarizationId)
      return yield* withBackup(backup.backupId, Effect.gen(function*() {
        const current = yield* getNotes(input.recordingId, input.summarizationId)
        yield* checked(() => {
          requireHash(before.hash, current.hash)
          if (current.rowId !== before.rowId || current.updatedAt !== before.updatedAt) throw failure("conflict", "The Notes changed during preparation. Read them again.")
        })
        return yield* commitWrite(backup.backupId, "notes", Effect.gen(function*() {
          yield* api.request("PATCH", `/api/v1/summarize/${idPath(input.summarizationId)}/markdown`, { markdown: input.markdown })
          const after = yield* getNotes(input.recordingId, input.summarizationId)
          if (after.markdown !== input.markdown) return yield* Effect.fail(failure("upstream", "The Notes reread differs from the supplied Markdown."))
          return { recordingId: input.recordingId, hash: after.hash, ...backup, concurrency: "client_side_compare" as const, verified: true as const }
        }))
      }))
    })),
    editTranscript: (input: TranscriptEdit) => writes.withPermit(Effect.gen(function*() {
      const raw = yield* detail(input.recordingId)
      const before = yield* checked(() => transcriptFrom(raw))
      yield* checked(() => {
        requireHash(input.expectedHash, before.hash)
        if (!before.supportsSegmentEdits) throw failure("validation", "Pocket returned an unsegmented legacy transcript; segment editing is unavailable.")
        const seen = new Set<number>()
        for (const correction of input.corrections) {
          const segment = before.segments[correction.segmentIndex]
          if (!Number.isInteger(correction.segmentIndex) || !segment || seen.has(correction.segmentIndex)) throw failure("validation", "Transcript corrections require distinct raw segment indices from the current transcript.")
          if (segment.originalText !== undefined && segment.text !== segment.originalText && !input.allowOriginalTextOverwrite) throw failure("validation", "Pocket overwrites both text and originalText. Read the differing fields, then explicitly set allowOriginalTextOverwrite if that is intended.")
          seen.add(correction.segmentIndex)
        }
        if (input.corrections.length === 0) throw failure("validation", "Provide at least one transcript correction.")
      })
      const backup = yield* backups.save("transcript", input.recordingId, { document: before, rawRecording: raw })
      return yield* withBackup(backup.backupId, Effect.gen(function*() {
        const current = yield* getTranscript(input.recordingId)
        yield* checked(() => requireHash(before.hash, current.hash))
        return yield* commitWrite(backup.backupId, "transcript", Effect.gen(function*() {
          yield* api.request("POST", `/api/v1/transcript-edit/${idPath(input.recordingId)}/batch`, { actions: input.corrections.map((correction) => ({ type: "edit_text", ...correction })) })
          const after = yield* getTranscript(input.recordingId)
          const corrections = new Map(input.corrections.map((c) => [c.segmentIndex, c.text]))
          const expected = before.segments.map((segment) => corrections.has(segment.segmentIndex) ? { ...segment, text: corrections.get(segment.segmentIndex)!, originalText: corrections.get(segment.segmentIndex)! } : segment)
          if (after.transcriptionId !== before.transcriptionId || contentHash(after.segments) !== contentHash(expected)) return yield* Effect.fail(failure("upstream", "The complete transcript reread differs from the expected correction batch."))
          return { recordingId: input.recordingId, hash: after.hash, ...backup, concurrency: "client_side_compare" as const, verified: true as const }
        }))
      }))
    })),
    searchActionItems: actionPage,
    updateActionItem: (input: ActionUpdate) => writes.withPermit(Effect.gen(function*() {
      if (input.dueDate !== undefined && input.dueDate !== null && !Number.isFinite(Date.parse(input.dueDate))) return yield* Effect.fail(failure("validation", "dueDate must be a valid ISO date or date/time."))
      if (input.completed !== undefined && (input.title !== undefined || input.dueDate !== undefined)) return yield* Effect.fail(failure("validation", "Change completion separately from title or due date so each update uses one upstream write."))
      if (input.completed === undefined && input.title === undefined && input.dueDate === undefined) return yield* Effect.fail(failure("validation", "Provide a title, due date, or completion change."))
      const before = yield* findAction(input.recordingId, input.actionItemId)
      yield* checked(() => requireHash(input.expectedHash, before.item.hash))
      const backup = yield* backups.save("action_item", input.recordingId, { document: before.item, rawActionItem: before.raw })
      return yield* withBackup(backup.backupId, Effect.gen(function*() {
        const current = yield* findAction(input.recordingId, input.actionItemId)
        yield* checked(() => requireHash(before.item.hash, current.item.hash))
        const body = input.completed === true ? {} : input.completed === false ? { status: "TODO" } : {
          ...(input.title === undefined ? {} : { title: input.title }), ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate })
        }
        return yield* commitWrite(backup.backupId, "action_item", Effect.gen(function*() {
          yield* api.request("PATCH", `/api/v1/global-action-items/${idPath(input.actionItemId)}${input.completed === true ? "/complete" : ""}`, body)
          const after = (yield* findAction(input.recordingId, input.actionItemId)).item
          if (input.title !== undefined && input.title !== after.title || !sameDueDate(input.dueDate, after.dueDate) || input.completed !== undefined && input.completed !== actionCompleted(after)) return yield* Effect.fail(failure("upstream", "The action-item reread differs from the intended change."))
          return { recordingId: input.recordingId, hash: after.hash, ...backup, concurrency: "client_side_compare" as const, verified: true as const }
        }))
      }))
    })),
    listFolders: Effect.gen(function*() {
      const raw = yield* api.request("GET", "/api/v1/folders")
      return yield* checked(() => decode(Folders, raw))
    }),
    account: Effect.gen(function*() {
      const raw = yield* api.request("GET", "/api/v1/users/current/profile")
      return yield* checked(() => decode(Account, raw))
    }),
    listSpaces: Effect.gen(function*() {
      const raw = yield* api.request("GET", "/api/v1/organization/current")
      const current = yield* checked(() => decode(Schema.Struct({ organization: Schema.NullOr(Schema.Struct({ id: Id })) }), raw))
      if (current.organization === null) return { available: false, organizationId: null, spaces: [] }
      const spaces = yield* api.request("GET", `/api/v1/organization/${idPath(current.organization.id)}/spaces`)
      const result = yield* checked(() => decode(Schema.Struct({ data: Schema.Array(Space) }), spaces))
      return { available: true, organizationId: current.organization.id, spaces: result.data }
    })
  }
})

export class Pocket extends Context.Service<Pocket, Effect.Success<typeof makePocket>>() ("pocket/Pocket") {}
export const PocketLive = Layer.effect(Pocket, makePocket)
