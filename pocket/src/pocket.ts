import { Cause, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { Backups, contentHash } from "./backups.js"
import { decode, failure, PocketError } from "./core.js"
import { Account, ActionCategory, ActionItem, ActionPage, ActionPriority, ActionStatus, ArchiveSnapshotInput, Folders, RawActionPage, RecordingPage, SearchPage, Space } from "./contracts.js"
import { normalizePocketTimestamp } from "./pocket-date.js"
import { Id, notesFrom, RecordingDetail, transcriptFrom } from "./recording.js"
import { PocketTransport, type PreparedRequest } from "./transport.js"

export const checked = <A>(f: () => A): Effect.Effect<A, PocketError> => Effect.try({
  try: f, catch: (error) => error instanceof PocketError ? error : failure("upstream", "Pocket returned an unsupported response.")
})

export interface RecordingQuery { readonly page?: number; readonly limit?: number; readonly folderId?: string }
export interface SearchQuery { readonly query: string; readonly limit?: number; readonly workspaceId?: string }
export interface NotesUpdate { readonly recordingId: string; readonly summarizationId: string; readonly markdown: string; readonly expectedHash: string; readonly expectedRowId?: string }
export interface TranscriptEdit {
  readonly recordingId: string; readonly expectedHash: string; readonly allowOriginalTextOverwrite?: boolean
  readonly corrections: ReadonlyArray<{ readonly segmentIndex: number; readonly text: string }>
}
export interface ActionQuery {
  readonly query?: string; readonly recordingId?: string; readonly limit?: number; readonly offset?: number
  readonly status?: typeof ActionStatus.Type; readonly priority?: typeof ActionPriority.Type; readonly category?: typeof ActionCategory.Type
  readonly dueBefore?: string; readonly dueAfter?: string; readonly recordingDateFrom?: string; readonly recordingDateTo?: string
}
export interface ActionUpdate {
  readonly recordingId: string; readonly actionItemId: string; readonly expectedHash: string
  readonly title?: string; readonly label?: string; readonly description?: string; readonly context?: string
  readonly dueDate?: string | null; readonly completed?: boolean; readonly status?: typeof ActionStatus.Type
  readonly priority?: typeof ActionPriority.Type; readonly assignee?: string
}

const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/
const isoDateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/
const validCalendarDate = (year: number, month: number, day: number) => {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0)
}
export const validIsoDate = (value: string): boolean => {
  const date = isoDateOnly.exec(value)
  if (date) return validCalendarDate(Number(date[1]), Number(date[2]), Number(date[3]))
  const timestamp = isoDateTime.exec(value)
  if (!timestamp || !validCalendarDate(Number(timestamp[1]), Number(timestamp[2]), Number(timestamp[3]))) return false
  const hour = Number(timestamp[4]); const minute = Number(timestamp[5]); const second = Number(timestamp[6] ?? 0)
  if (hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) return false
  if (timestamp[8] !== "Z") {
    const zoneHour = Number(timestamp[8]?.slice(1, 3)); const zoneMinute = Number(timestamp[8]?.slice(4, 6))
    if (zoneHour > 14 || zoneMinute > 59 || zoneHour === 14 && zoneMinute !== 0) return false
  }
  return true
}

const isoDateTimestamp = (value: string, side: "lower" | "upper" = "lower"): number | null => {
  if (!validIsoDate(value)) return null
  const parsed = isoDateOnly.exec(value)
    ? Date.parse(`${value}T${side === "upper" ? "23:59:59.999" : "00:00:00.000"}Z`)
    : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
const pocketDateTimestamp = (value: string, side: "lower" | "upper" = "lower"): number | null =>
  isoDateTimestamp(normalizePocketTimestamp(value), side)
const validPocketDate = (value: string): boolean => pocketDateTimestamp(value) !== null
const validateDateRange = (lower: string | undefined, upper: string | undefined, label: string) => {
  for (const value of [lower, upper]) if (value !== undefined && !validIsoDate(value)) throw failure("validation", `${label} filters must be ISO dates or timezone-qualified ISO timestamps.`)
  if (lower !== undefined && upper !== undefined) {
    const from = isoDateTimestamp(lower)
    const to = isoDateTimestamp(upper, "upper")
    if (from === null || to === null || from > to) throw failure("validation", `${label} lower bound must not be after its upper bound.`)
  }
}
const normalizedStatus = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null
  const status = value.toUpperCase()
  return ["DONE", "COMPLETE"].includes(status) ? "COMPLETED" : status
}
const actionMetadata = (raw: Record<string, unknown>): Record<string, unknown> =>
  typeof raw.metadata === "object" && raw.metadata !== null && !Array.isArray(raw.metadata) ? raw.metadata as Record<string, unknown> : {}
const metadataHashFields = ["label", "context", "priority", "assignee", "assignees"] as const
const actionHash = (item: typeof ActionItem.Type, raw: Record<string, unknown>) => {
  const metadata = actionMetadata(raw)
  return contentHash({ item, metadata: Object.fromEntries(metadataHashFields.flatMap((key) => key in metadata ? [[key, metadata[key]]] : [])) })
}
const metadataText = (metadata: Record<string, unknown>, key: string): string | null | undefined => {
  const value = metadata[key]
  return typeof value === "string" || value === null ? value : undefined
}
const normalizedPriority = (item: typeof ActionItem.Type, raw: Record<string, unknown>): string | null => {
  const value = item.priority ?? metadataText(actionMetadata(raw), "priority")
  return typeof value === "string" ? value.toUpperCase() : null
}
const normalizedAssignee = (item: typeof ActionItem.Type, raw: Record<string, unknown>): string | null => {
  const value = item.assignee ?? metadataText(actionMetadata(raw), "assignee")
  return typeof value === "string" && value.length > 0 ? value : null
}
const matchesDateRange = (value: string | null | undefined, lower?: string, upper?: string): boolean => {
  if (lower === undefined && upper === undefined) return true
  if (typeof value !== "string") return false
  const actual = pocketDateTimestamp(value)
  const from = lower === undefined ? null : isoDateTimestamp(lower)
  const to = upper === undefined ? null : isoDateTimestamp(upper, "upper")
  return actual !== null && (from === null || actual >= from) && (to === null || actual <= to)
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
  yield* Effect.sync(() => { process.stderr.write(`${JSON.stringify({ event: "pocket_write", kind, backupId, outcome: "started" })}\n`) })
  const result = yield* operation.pipe(Effect.timeoutOrElse({ duration: "45 seconds", orElse: () => Effect.fail(failure("uncertain_write", "The protected write/verification deadline expired.")) }), Effect.exit)
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

type ActionEntry = {
  readonly item: typeof ActionItem.Type & { readonly hash: string }
  readonly raw: Record<string, unknown>
  readonly hierarchyParent: boolean
}
const rawActions = (groups: ReadonlyArray<Record<string, unknown>>) => {
  const found = new Map<string, ActionEntry>()
  const makeEntry = (raw: Record<string, unknown>, hierarchyParent: boolean): ActionEntry => {
    const decoded = decode(ActionItem, raw)
    const metadata = actionMetadata(raw)
    const item = decode(ActionItem, {
      ...decoded,
      ...(decoded.title === null && typeof metadata.label === "string" ? { title: metadata.label } : {}),
      ...(decoded.description == null && typeof metadata.context === "string" ? { description: metadata.context } : {}),
      ...(decoded.priority == null && typeof metadata.priority === "string" ? { priority: metadata.priority } : {}),
      ...(decoded.assignee == null && typeof metadata.assignee === "string" ? { assignee: metadata.assignee } : {})
    })
    return { item: { ...item, hash: actionHash(item, raw) }, raw, hierarchyParent }
  }
  const visit = (node: Record<string, unknown>, depth: number) => {
    if (depth > 20) throw failure("upstream", "Pocket returned an excessively nested action-item hierarchy.")
    const subtasks = Array.isArray(node.subtasks) ? node.subtasks : []
    if (typeof node.id === "string" && "title" in node) {
      const entry = makeEntry(node, subtasks.length > 0)
      const existing = found.get(entry.item.id)
      if (existing) {
        if (!existing.hierarchyParent || !entry.hierarchyParent) throw failure("upstream", "Pocket repeated a counted action-item ID in one hierarchy page.")
        if (existing.item.hash !== entry.item.hash) throw failure("upstream", "Pocket returned conflicting versions of one hierarchy parent.")
      } else found.set(entry.item.id, entry)
    }
    for (const child of subtasks) {
      if (typeof child !== "object" || child === null || Array.isArray(child)) throw failure("upstream", "Pocket returned an invalid action item.")
      visit(child as Record<string, unknown>, depth + 1)
    }
  }
  for (const group of groups) visit(group, 0)
  return [...found.values()]
}
export const flattenActions = (groups: ReadonlyArray<Record<string, unknown>>) => rawActions(groups).map(({ item }) => item)

export const actionCompleted = (item: typeof ActionItem.Type): boolean => item.isCompleted ?? (
  typeof item.status === "string" ? normalizedStatus(item.status) === "COMPLETED" : item.completedAt != null
)
export const sameDueDate = (expected: string | null | undefined, actual: string | null | undefined): boolean =>
  expected === undefined || (expected === null || expected === "") && (actual == null || actual === "") ||
  typeof expected === "string" && typeof actual === "string" && validIsoDate(expected) && validPocketDate(actual) && (
    isoDateOnly.test(expected) ? normalizePocketTimestamp(actual).slice(0, 10) === expected : Date.parse(expected) === Date.parse(normalizePocketTimestamp(actual))
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
  const actionPageRaw = (input: ActionQuery, request: PreparedRequest = api.request) => Effect.gen(function*() {
    const query = input.query?.trim()
    yield* checked(() => {
      if (input.query !== undefined && !query) throw failure("validation", "query must not be empty when provided.")
      if (input.status !== undefined && !["TODO", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(input.status)) throw failure("validation", "status must be TODO, IN_PROGRESS, COMPLETED, or CANCELLED.")
      if (input.priority !== undefined && !["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(input.priority)) throw failure("validation", "priority must be CRITICAL, HIGH, MEDIUM, or LOW.")
      if (input.category !== undefined && !["TASK", "MEETING", "REMINDER"].includes(input.category)) throw failure("validation", "category must be TASK, MEETING, or REMINDER.")
      validateDateRange(input.dueAfter, input.dueBefore, "due date")
      validateDateRange(input.recordingDateFrom, input.recordingDateTo, "recording date")
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw failure("validation", "limit must be an integer from 1 to 100.")
      if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 1000000)) throw failure("validation", "offset must be a nonnegative integer.")
    })
    const isSearch = query !== undefined
    const raw = yield* request("GET", queryPath(isSearch ? "/api/v1/global-action-items/search" : "/api/v1/global-action-items/hierarchy", {
      query, recordingId: input.recordingId, limit: input.limit ?? 50, offset: input.offset ?? 0,
      status: isSearch ? undefined : input.status, priority: isSearch ? undefined : input.priority, category: isSearch ? undefined : input.category,
      startDate: isSearch ? undefined : input.dueAfter, endDate: isSearch ? undefined : input.dueBefore
    }))
    return yield* checked(() => {
      const page = decode(RawActionPage, raw)
      if (!page.success) throw failure("upstream", "Pocket could not load action items.")
      const entries = rawActions(page.data)
      const returned = entries.filter((entry) => !entry.hierarchyParent).length
      const limit = input.limit ?? 50
      const offset = input.offset ?? 0
      const remaining = Math.max(0, page.pagination.total - offset)
      if (!Number.isInteger(page.pagination.total) || page.pagination.total < 0 || page.pagination.limit !== limit ||
        page.pagination.offset !== offset || returned > limit || returned > remaining || returned === 0 && offset < page.pagination.total) {
        throw failure("upstream", "Pocket returned inconsistent action-item leaf pagination.")
      }
      return { ...page, pagination: { ...page.pagination, returned }, entries }
    })
  })
  const collectActionPages = (input: ActionQuery) => Effect.gen(function*() {
    const entries = new Map<string, ActionEntry>()
    let offset = 0
    let expectedTotal: number | undefined
    let complete = false
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = yield* actionPageRaw({ ...input, limit: 100, offset })
      if (expectedTotal === undefined) expectedTotal = page.pagination.total
      else if (expectedTotal !== page.pagination.total) return yield* Effect.fail(failure("upstream", "Pocket action-item pagination changed during the filtered read."))
      const returned = page.pagination.returned
      if (!Number.isInteger(expectedTotal) || expectedTotal < 0 || page.pagination.limit !== 100 || page.pagination.offset !== offset ||
        returned !== page.entries.filter((entry) => !entry.hierarchyParent).length || returned < 0 || returned > page.pagination.limit ||
        offset + returned > expectedTotal || returned === 0 && offset < expectedTotal) {
        return yield* Effect.fail(failure("upstream", "Pocket returned incomplete action-item pagination for the requested local filters."))
      }
      if (returned > 0 && !page.entries.some((entry) => !entry.hierarchyParent)) return yield* Effect.fail(failure("upstream", "Pocket action-item pagination reported rows without returning items."))
      for (const entry of page.entries) {
        const existing = entries.get(entry.item.id)
        if (!existing) entries.set(entry.item.id, entry)
        else if (!existing.hierarchyParent || !entry.hierarchyParent) return yield* Effect.fail(failure("upstream", "Pocket repeated a counted action-item ID across hierarchy pages."))
        else if (existing.item.hash !== entry.item.hash) return yield* Effect.fail(failure("conflict", "Pocket changed a repeated hierarchy parent while action items were being read."))
      }
      offset += returned
      if (offset === expectedTotal) { complete = true; break }
    }
    if (!complete) return yield* Effect.fail(failure("upstream", "The filtered action-item scan exceeded its 100-page safety limit."))
    const result = [...entries.values()]
    if (result.filter((entry) => !entry.hierarchyParent).length !== expectedTotal) return yield* Effect.fail(failure("upstream", "The completed action-item scan did not contain the expected number of unique action rows."))
    return result
  })
  const actionPage = (input: ActionQuery) => Effect.gen(function*() {
    yield* checked(() => {
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw failure("validation", "limit must be an integer from 1 to 100.")
      if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > 1000000)) throw failure("validation", "offset must be a nonnegative integer.")
    })
    const requiresLocalFilter = input.recordingDateFrom !== undefined || input.recordingDateTo !== undefined ||
      input.query !== undefined && (input.status !== undefined || input.priority !== undefined || input.category !== undefined || input.dueAfter !== undefined || input.dueBefore !== undefined)
    if (!requiresLocalFilter) {
      const page = yield* actionPageRaw(input)
      return yield* checked(() => decode(ActionPage, { items: page.entries.map(({ item }) => item), pagination: page.pagination }))
    }
    const entries = yield* collectActionPages(input)
    const filteredLeaves = yield* checked(() => entries.filter(({ item, raw, hierarchyParent }) => {
      if (hierarchyParent) return false
      if (input.status !== undefined && normalizedStatus(item.status) !== input.status) return false
      if (input.priority !== undefined && normalizedPriority(item, raw) !== input.priority) return false
      if (input.category !== undefined && item.category?.toUpperCase() !== input.category) return false
      if (input.dueAfter !== undefined || input.dueBefore !== undefined) {
        if (item.dueDate == null) return false
        if (typeof item.dueDate !== "string" || !validPocketDate(item.dueDate)) throw failure("upstream", "Pocket returned an invalid dueDate needed for the requested due-date filter.")
        if (!matchesDateRange(item.dueDate, input.dueAfter, input.dueBefore)) return false
      }
      if (input.recordingDateFrom !== undefined || input.recordingDateTo !== undefined) {
        if (typeof item.recordedAt !== "string" || !validPocketDate(item.recordedAt)) throw failure("upstream", "Pocket omitted a valid recordedAt value needed for the requested recording-date filter.")
        if (!matchesDateRange(item.recordedAt, input.recordingDateFrom, input.recordingDateTo)) return false
      }
      return true
    }))
    const limit = input.limit ?? 50
    const offset = input.offset ?? 0
    const leafPage = filteredLeaves.slice(offset, offset + limit)
    const selectedIds = new Set(leafPage.map(({ item }) => item.id))
    const entriesById = new Map(entries.map((entry) => [entry.item.id, entry]))
    for (const leaf of leafPage) {
      let parentId = leaf.item.parentTaskId
      while (parentId !== undefined && parentId !== null) {
        const parent = entriesById.get(parentId)
        if (!parent?.hierarchyParent || selectedIds.has(parentId)) break
        selectedIds.add(parentId)
        parentId = parent.item.parentTaskId
      }
    }
    const items = entries.filter((entry) => selectedIds.has(entry.item.id)).map(({ item }) => item)
    return yield* checked(() => decode(ActionPage, {
      items,
      pagination: { limit, offset, total: filteredLeaves.length, returned: leafPage.length }
    }))
  })
  const findAction = (recordingId: string, actionItemId: string, request: PreparedRequest = api.request) => Effect.gen(function*() {
    let offset = 0
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = yield* actionPageRaw({ recordingId, limit: 100, offset }, request)
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
    archiveSnapshot: (recordingId: string, source: "backfill" | "workflow") => Effect.gen(function*() {
      const raw = yield* detail(recordingId)
      return yield* checked(() => {
        const capturedAt = new Date().toISOString()
        try {
          const value = decode(RecordingDetail, raw)
          if (value.recording.id !== recordingId) throw failure("upstream", "Pocket returned a different recording than the requested ID.")
          const transcript = value.transcription?.transcription ? transcriptFrom(raw) : null
          const notes = Object.values(value.summarizations ?? {}).sort((a, b) =>
            (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "")).flatMap((summary) =>
            summary.v2?.summary ?? summary.summary ? [notesFrom(raw, summary.summarizationId)] : [])
          return decode(ArchiveSnapshotInput, { recordingId, capturedAt, metadata: value.recording, raw, transcript, notes, source })
        } catch (error) {
          const rawRecord = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
          const rawRecording = typeof rawRecord?.recording === "object" && rawRecord.recording !== null && !Array.isArray(rawRecord.recording)
            ? rawRecord.recording as Record<string, unknown> : undefined
          const metadata = rawRecording?.id === recordingId ? rawRecording : { id: recordingId }
          const decodeError = error instanceof PocketError ? error.code : "upstream"
          return decode(ArchiveSnapshotInput, { recordingId, capturedAt, metadata, raw, transcript: null, notes: [], source, decodeError })
        }
      })
    }),
    getNotes, getTranscript,
    updateNotes: (input: NotesUpdate) => writes.withPermit(Effect.gen(function*() {
      const raw = yield* detail(input.recordingId)
      const before = yield* checked(() => notesFrom(raw, input.summarizationId))
      yield* checked(() => {
        requireHash(input.expectedHash, before.hash)
        if (input.expectedRowId !== undefined && input.expectedRowId !== before.rowId) throw failure("conflict", "The Notes row changed since the source snapshot. Read it again before writing.")
      })
      const backup = yield* backups.save("notes", input.recordingId, { document: before, rawRecording: raw }, before.summarizationId)
      return yield* withBackup(backup.backupId, Effect.gen(function*() {
        const current = yield* getNotes(input.recordingId, input.summarizationId)
        yield* checked(() => {
          requireHash(before.hash, current.hash)
          if (current.rowId !== before.rowId || current.updatedAt !== before.updatedAt) throw failure("conflict", "The Notes changed during preparation. Read them again.")
        })
        const request = yield* api.prepare
        return yield* commitWrite(backup.backupId, "notes", Effect.gen(function*() {
          yield* request("PATCH", `/api/v1/summarize/${idPath(input.summarizationId)}/markdown`, { markdown: input.markdown })
          const after = yield* request("GET", `/api/v1/recordings/${idPath(input.recordingId)}?include=all`).pipe(Effect.flatMap((raw) => checked(() => notesFrom(raw, input.summarizationId))))
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
        const request = yield* api.prepare
        return yield* commitWrite(backup.backupId, "transcript", Effect.gen(function*() {
          yield* request("POST", `/api/v1/transcript-edit/${idPath(input.recordingId)}/batch`, { actions: input.corrections.map((correction) => ({ type: "edit_text", ...correction })) })
          const after = yield* request("GET", `/api/v1/recordings/${idPath(input.recordingId)}?include=all`).pipe(Effect.flatMap((raw) => checked(() => transcriptFrom(raw))))
          const corrections = new Map(input.corrections.map((c) => [c.segmentIndex, c.text]))
          const expected = before.segments.map((segment) => corrections.has(segment.segmentIndex) ? { ...segment, text: corrections.get(segment.segmentIndex)!, originalText: corrections.get(segment.segmentIndex)! } : segment)
          if (after.transcriptionId !== before.transcriptionId || contentHash(after.segments) !== contentHash(expected)) return yield* Effect.fail(failure("upstream", "The complete transcript reread differs from the expected correction batch."))
          return { recordingId: input.recordingId, hash: after.hash, ...backup, concurrency: "client_side_compare" as const, verified: true as const }
        }))
      }))
    })),
    searchActionItems: actionPage,
    updateActionItem: (input: ActionUpdate) => writes.withPermit(Effect.gen(function*() {
      const title = input.title ?? input.label
      const description = input.description ?? input.context
      const dueDate = input.dueDate === "" ? null : input.dueDate
      const assignee = input.assignee === "" ? null : input.assignee
      const updateFields = [title, description, dueDate, input.priority, assignee].some((value) => value !== undefined)
      yield* checked(() => {
        if (input.title !== undefined && input.label !== undefined && input.title !== input.label) throw failure("validation", "title and label aliases must have the same value when both are provided.")
        if (input.description !== undefined && input.context !== undefined && input.description !== input.context) throw failure("validation", "description and context aliases must have the same value when both are provided.")
        if (title !== undefined && (title.trim().length === 0 || title.length > 10000)) throw failure("validation", "title/label must contain 1 to 10000 characters.")
        if (description !== undefined && description.length > 100000) throw failure("validation", "description/context cannot exceed 100000 characters.")
        if (assignee !== undefined && assignee !== null && assignee.length > 1000) throw failure("validation", "assignee cannot exceed 1000 characters.")
        if (dueDate !== undefined && dueDate !== null && !validIsoDate(dueDate)) throw failure("validation", "dueDate must be an ISO date or a timezone-qualified ISO timestamp.")
        if (input.status !== undefined && !["TODO", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(input.status)) throw failure("validation", "status must be TODO, IN_PROGRESS, COMPLETED, or CANCELLED.")
        if (input.priority !== undefined && !["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(input.priority)) throw failure("validation", "priority must be CRITICAL, HIGH, MEDIUM, or LOW.")
        if (input.completed !== undefined && input.status !== undefined && input.completed !== (input.status === "COMPLETED")) throw failure("validation", "completed and status fields conflict.")
        if ((input.completed === true || input.status === "COMPLETED") && updateFields) throw failure("validation", "Change completion separately from title, context, priority, assignee, or due date so each update uses one upstream write.")
        if (input.completed !== undefined && updateFields) throw failure("validation", "Change completion separately from title, context, priority, assignee, or due date so each update uses one upstream write.")
        if (input.completed === undefined && input.status === undefined && !updateFields) throw failure("validation", "Provide at least one action-item field to update.")
      })
      const before = yield* findAction(input.recordingId, input.actionItemId)
      yield* checked(() => requireHash(input.expectedHash, before.item.hash))
      const backup = yield* backups.save("action_item", input.recordingId, { document: before.item, rawActionItem: before.raw })
      return yield* withBackup(backup.backupId, Effect.gen(function*() {
        const current = yield* findAction(input.recordingId, input.actionItemId)
        yield* checked(() => requireHash(before.item.hash, current.item.hash))
        const requestedStatus = input.status ?? (input.completed === undefined ? undefined : input.completed ? "COMPLETED" : "TODO")
        const body: Record<string, unknown> = {
          ...(title === undefined ? {} : { title }),
          ...(dueDate === undefined ? {} : { dueDate }),
          ...(requestedStatus === undefined || requestedStatus === "COMPLETED" ? {} : { status: requestedStatus }),
          ...(assignee === undefined ? {} : { assignee })
        }
        const metadata = actionMetadata(current.raw)
        const metadataChanges: Record<string, unknown> = {
          ...(title === undefined ? {} : { label: title }),
          ...(description === undefined ? {} : { context: description }),
          ...(input.priority === undefined ? {} : { priority: input.priority.toLowerCase() }),
          ...(assignee === undefined ? {} : { assignee, assignees: assignee === null ? [] : [assignee] })
        }
        if (Object.keys(metadataChanges).length > 0) body.metadata = { ...metadata, ...metadataChanges }
        const request = yield* api.prepare
        return yield* commitWrite(backup.backupId, "action_item", Effect.gen(function*() {
          const completionRoute = requestedStatus === "COMPLETED"
          yield* request("PATCH", `/api/v1/global-action-items/${idPath(input.actionItemId)}${completionRoute ? "/complete" : ""}`, completionRoute ? {} : body)
          const after = yield* findAction(input.recordingId, input.actionItemId, request)
          const afterMetadata = actionMetadata(after.raw)
          const completedAt = typeof after.item.completedAt === "string" ? normalizePocketTimestamp(after.item.completedAt) : null
          const clearedOrEqual = (expected: string, actual: string | null | undefined) => expected === "" ? actual == null || actual === "" : actual === expected
          if (title !== undefined && (after.item.title !== title || afterMetadata.label !== title) ||
            description !== undefined && (!clearedOrEqual(description, after.item.description) || !clearedOrEqual(description, metadataText(afterMetadata, "context"))) ||
            !sameDueDate(dueDate, after.item.dueDate) ||
            input.priority !== undefined && (after.item.priority?.toUpperCase() !== input.priority || typeof afterMetadata.priority !== "string" || afterMetadata.priority.toUpperCase() !== input.priority) ||
            assignee !== undefined && (normalizedAssignee(after.item, after.raw) !== assignee || (afterMetadata.assignee ?? null) !== assignee ||
              !Array.isArray(afterMetadata.assignees) || contentHash(afterMetadata.assignees) !== contentHash(assignee === null ? [] : [assignee])) ||
            requestedStatus !== undefined && normalizedStatus(after.item.status) !== requestedStatus ||
            requestedStatus === "COMPLETED" && (!actionCompleted(after.item) || completedAt === null || !isoDateTime.test(completedAt) || !validIsoDate(completedAt)) ||
            requestedStatus !== undefined && requestedStatus !== "COMPLETED" && (actionCompleted(after.item) || after.item.completedAt != null)) {
            return yield* Effect.fail(failure("upstream", "The action-item reread differs from the intended fields or completion timestamp."))
          }
          return { recordingId: input.recordingId, hash: after.item.hash, ...backup, concurrency: "client_side_compare" as const, verified: true as const }
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
