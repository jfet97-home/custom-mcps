import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { Backups, contentHash } from "./backups.js"
import { decode, failure, PocketError } from "./core.js"
import { Account, ActionItem, ActionPage, Folders, RawActionPage, RecordingPage, SearchPage, Space } from "./contracts.js"
import { notesFrom, RecordingDetail, transcriptFrom } from "./recording.js"
import { PocketTransport } from "./transport.js"

export const checked = <A>(f: () => A): Effect.Effect<A, PocketError> => Effect.try({
  try: f, catch: (error) => error instanceof PocketError ? error : failure("upstream", "Pocket returned an unsupported response.")
})

export interface RecordingQuery { readonly page?: number; readonly limit?: number; readonly folderId?: string }
export interface SearchQuery { readonly query: string; readonly limit?: number; readonly workspaceId?: string }
export interface NotesUpdate { readonly recordingId: string; readonly summarizationId: string; readonly markdown: string; readonly expectedHash?: string; readonly expectedVersion?: string | number }
export interface TranscriptEdit { readonly recordingId: string; readonly expectedHash?: string; readonly corrections: ReadonlyArray<{ readonly segmentIndex: number; readonly text: string }> }
export interface ActionQuery { readonly query?: string; readonly recordingId?: string; readonly limit?: number; readonly offset?: number }
export interface ActionUpdate {
  readonly recordingId: string; readonly actionItemId: string; readonly expectedHash?: string
  readonly title?: string; readonly dueDate?: string | null; readonly completed?: boolean
}

const idPath = (id: string) => encodeURIComponent(id)
const queryPath = (path: string, values: Record<string, string | number | undefined>) => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value))
  return `${path}?${query}`
}
const requireHash = (expected: string | undefined, actual: string) => {
  if (expected !== undefined && expected !== actual) throw failure("conflict", "Content changed since it was read. Read it again before editing.")
}

export const flattenActions = (groups: ReadonlyArray<Record<string, unknown>>) => {
  const found = new Map<string, typeof ActionItem.Type>()
  const visit = (node: Record<string, unknown>, depth: number) => {
    if (depth > 20) throw failure("upstream", "Pocket returned an excessively nested action-item hierarchy.")
    if (typeof node.id === "string" && typeof node.title === "string") {
      const item = decode(ActionItem, node)
      found.set(item.id, item)
    }
    if (Array.isArray(node.subtasks)) for (const child of node.subtasks) {
      if (typeof child !== "object" || child === null || Array.isArray(child)) throw failure("upstream", "Pocket returned an invalid action item.")
      visit(child as Record<string, unknown>, depth + 1)
    }
  }
  for (const group of groups) visit(group, 0)
  return [...found.values()].map((item) => ({ ...item, hash: contentHash(item) }))
}

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
  const actionPage = (input: ActionQuery) => Effect.gen(function*() {
    const raw = yield* api.request("GET", queryPath(input.query ? "/api/v1/global-action-items/search" : "/api/v1/global-action-items/hierarchy", {
      query: input.query, recordingId: input.recordingId, limit: input.limit ?? 50, offset: input.offset ?? 0
    }))
    return yield* checked(() => {
      const page = decode(RawActionPage, raw)
      if (!page.success) throw failure("upstream", "Pocket could not load action items.")
      return decode(ActionPage, { items: flattenActions(page.data), pagination: page.pagination })
    })
  })
  const findAction = (recordingId: string, actionItemId: string) => Effect.gen(function*() {
    let offset = 0
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = yield* actionPage({ recordingId, limit: 100, offset })
      const found = page.items.find((item) => item.id === actionItemId && item.recordingId === recordingId)
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
      const raw = yield* api.request("GET", queryPath("/api/v1/search", { q: input.query.trim(), searchType: "hybrid_semantic", sort: "relevance", limit: input.limit ?? 20, workspaceId: input.workspaceId }))
      return yield* checked(() => decode(SearchPage, raw))
    }),
    getRecording: (recordingId: string) => Effect.gen(function*() {
      const raw = yield* detail(recordingId)
      return yield* checked(() => decode(RecordingDetail, raw))
    }),
    getNotes, getTranscript,
    updateNotes: (input: NotesUpdate) => writes.withPermit(Effect.gen(function*() {
      const before = yield* getNotes(input.recordingId, input.summarizationId)
      yield* checked(() => {
        requireHash(input.expectedHash, before.hash)
        if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) throw failure("conflict", "The Notes version changed. Read the Notes again.")
      })
      const backup = yield* backups.save("notes", input.recordingId, before.markdown, before.summarizationId)
      const current = yield* getNotes(input.recordingId, input.summarizationId)
      yield* checked(() => {
        requireHash(before.hash, current.hash)
        if (current.rowId !== before.rowId || current.version !== before.version || current.updatedAt !== before.updatedAt) throw failure("conflict", "The Notes version changed during preparation. Read the Notes again.")
      })
      yield* api.request("PATCH", `/api/v1/summarize/${idPath(input.summarizationId)}/markdown`, { markdown: input.markdown })
      const after = yield* getNotes(input.recordingId, input.summarizationId)
      if (after.markdown !== input.markdown) return yield* Effect.fail(failure("conflict", "Pocket accepted the write, but the reread differs. Read the current Notes before another edit."))
      return { recordingId: input.recordingId, hash: after.hash, ...backup, concurrency: "client_side_compare" as const, verified: true as const }
    })),
    editTranscript: (input: TranscriptEdit) => writes.withPermit(Effect.gen(function*() {
      const before = yield* getTranscript(input.recordingId)
      yield* checked(() => {
        requireHash(input.expectedHash, before.hash)
        const seen = new Set<number>()
        for (const correction of input.corrections) {
          if (!Number.isInteger(correction.segmentIndex) || correction.segmentIndex < 0 || correction.segmentIndex >= before.segments.length || seen.has(correction.segmentIndex)) {
            throw failure("validation", "Transcript corrections require distinct raw segment indices from the current transcript.")
          }
          seen.add(correction.segmentIndex)
        }
        if (input.corrections.length === 0) throw failure("validation", "Provide at least one transcript correction.")
      })
      const backup = yield* backups.save("transcript", input.recordingId, before)
      const current = yield* getTranscript(input.recordingId)
      yield* checked(() => {
        requireHash(before.hash, current.hash)
        if (current.transcriptionId !== before.transcriptionId || current.rowId !== before.rowId) throw failure("conflict", "The transcript identity changed during preparation. Read it again.")
      })
      yield* api.request("POST", `/api/v1/transcript-edit/${idPath(input.recordingId)}/batch`, {
        actions: input.corrections.map((correction) => ({ type: "edit_text", ...correction }))
      })
      const after = yield* getTranscript(input.recordingId)
      if (after.transcriptionId !== before.transcriptionId || after.segments.length !== before.segments.length || input.corrections.some((correction) => after.segments[correction.segmentIndex]?.text !== correction.text)) {
        return yield* Effect.fail(failure("conflict", "Pocket accepted the edit, but the transcript reread differs. Read the current transcript before another edit."))
      }
      return { recordingId: input.recordingId, hash: after.hash, ...backup, concurrency: "client_side_compare" as const, verified: true as const }
    })),
    searchActionItems: actionPage,
    updateActionItem: (input: ActionUpdate) => writes.withPermit(Effect.gen(function*() {
      if (input.dueDate !== undefined && input.dueDate !== null && !Number.isFinite(Date.parse(input.dueDate))) return yield* Effect.fail(failure("validation", "dueDate must be a valid ISO date or date/time."))
      if (input.completed !== undefined && (input.title !== undefined || input.dueDate !== undefined)) return yield* Effect.fail(failure("validation", "Change completion separately from title or due date so each update uses one upstream write."))
      if (input.completed === undefined && input.title === undefined && input.dueDate === undefined) return yield* Effect.fail(failure("validation", "Provide a title, due date, or completion change."))
      const before = yield* findAction(input.recordingId, input.actionItemId)
      yield* checked(() => requireHash(input.expectedHash, before.hash))
      const backup = yield* backups.save("action_item", input.recordingId, before)
      const current = yield* findAction(input.recordingId, input.actionItemId)
      yield* checked(() => requireHash(before.hash, current.hash))
      const body = input.completed === true ? {} : input.completed === false ? { status: "TODO" } : {
        ...(input.title === undefined ? {} : { title: input.title }), ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate })
      }
      yield* api.request("PATCH", `/api/v1/global-action-items/${idPath(input.actionItemId)}${input.completed === true ? "/complete" : ""}`, body)
      const after = yield* findAction(input.recordingId, input.actionItemId)
      const completed = after.isCompleted ?? (after.completedAt !== null && after.completedAt !== undefined || after.status === "DONE" || after.status === "COMPLETED")
      const dateMatches = input.dueDate === undefined || input.dueDate === null && after.dueDate === null || typeof input.dueDate === "string" && typeof after.dueDate === "string" && Date.parse(input.dueDate) === Date.parse(after.dueDate)
      if (input.title !== undefined && input.title !== after.title || !dateMatches || input.completed !== undefined && input.completed !== completed) {
        return yield* Effect.fail(failure("conflict", "Pocket accepted the update, but the action-item reread differs. Search again before another edit."))
      }
      return { recordingId: input.recordingId, hash: after.hash, ...backup, concurrency: "client_side_compare" as const, verified: true as const }
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
      const current = yield* checked(() => decode(Schema.Struct({ organization: Schema.NullOr(Schema.Struct({ id: Schema.String })) }), raw))
      if (current.organization === null) return { available: false, organizationId: null, spaces: [] }
      const spaces = yield* api.request("GET", `/api/v1/organization/${idPath(current.organization.id)}/spaces`)
      const result = yield* checked(() => decode(Schema.Struct({ data: Schema.Array(Space) }), spaces))
      return { available: true, organizationId: current.organization.id, spaces: result.data }
    })
  }
})

export class Pocket extends Context.Service<Pocket, Effect.Success<typeof makePocket>>() ("pocket/Pocket") {}
export const PocketLive = Layer.effect(Pocket, makePocket)
