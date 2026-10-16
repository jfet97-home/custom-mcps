import { Effect, Layer } from "effect"
import { Backups } from "../src/backups.js"
import { failure, type PocketError } from "../src/core.js"
import { PocketLive } from "../src/pocket.js"
import { PocketTransport, type PreparedRequest } from "../src/transport.js"

export const fixture = () => {
  const detail = {
    recording: { id: "recording-1", title: "Test recording" },
    transcription: { id: "transcript-row-1", transcriptionId: "transcript-1", transcription: { segments: [
      { text: "", originalText: "", start: 0, end: 0 },
      { text: "First words", originalText: "First words", start: 0, end: 1 }
    ] } },
    summarizations: {
      "summary-map-key": { id: "summary-row-1", summarizationId: "summary-1", version: 3, updatedAt: "2026-10-16T12:00:00Z", v2: { summary: { markdown: "# Original\n\nComplete Notes.", version: "3" } } },
      "older-map-key": { id: "older-row-1", summarizationId: "summary-old", updatedAt: "2026-10-15T12:00:00Z", v2: { summary: { markdown: "Old Notes", version: "2" } } }
    }
  }
  const action = {
    id: "global-1", title: "Original action", description: "Original context", recordingId: "recording-1", summarizationId: "summary-1",
    parentTaskId: "source-1", dueDate: null as string | null, status: "TODO", completedAt: null as string | null, isCompleted: false,
    priority: "MEDIUM", category: "TASK", assignee: null as string | null, recordedAt: "2026-10-16T12:00:00Z", version: 1,
    metadata: { type: "task", label: "Original action", context: "Original context", priority: "medium", assignee: null as string | null, assignees: [] as string[], payload: { retained: true } }
  }
  const state = {
    detail, action, additionalActions: [] as typeof action[], actionHierarchyParent: undefined as Record<string, unknown> | undefined,
    duplicateHierarchyLeafOnNextPage: false, additionalRecordings: [] as { id: string; title?: string | null }[], failDetailIds: new Set<string>(),
    malformedDetailIds: new Set<string>(), detailGone: false, requests: [] as { method: string; path: string; body?: unknown }[],
    backups: [] as unknown[], rejectBackup: false, failAfterWrite: false, failBeforeWrite: false,
    beforeRead: undefined as (() => void) | undefined, afterWrite: undefined as (() => void) | undefined,
    readFailure: false, writeDelay: 0
  }
  const request: PreparedRequest = (method, path, body) => Effect.suspend((): Effect.Effect<unknown, PocketError> => {
      state.requests.push({ method, path, body })
      if (method === "GET") {
        state.beforeRead?.()
        if (state.readFailure) return Effect.fail(failure("network", "Read unavailable"))
        if (path.startsWith("/api/v1/recordings/")) {
          const recordingId = decodeURIComponent(path.slice("/api/v1/recordings/".length).split("?")[0]!)
          if (state.failDetailIds.has(recordingId) || recordingId === state.detail.recording.id && state.detailGone) return Effect.fail(failure("upstream", "Recording unavailable", 404))
          if (state.malformedDetailIds.has(recordingId)) return Effect.succeed({ recording: { id: recordingId, title: 42 } })
          if (recordingId === state.detail.recording.id) return Effect.succeed(structuredClone(state.detail))
          const metadata = state.additionalRecordings.find((item) => item.id === recordingId)
          if (!metadata) return Effect.fail(failure("upstream", "Recording unavailable", 404))
          return Effect.succeed({ ...structuredClone(state.detail), recording: { ...state.detail.recording, ...metadata } })
        }
        if (path.startsWith("/api/v1/recordings?")) {
          const data = [state.detail.recording, ...state.additionalRecordings]
          return Effect.succeed({ data, totalCount: data.length, totalPages: 1, currentPage: 1 })
        }
        if (path.startsWith("/api/v1/global-action-items/hierarchy") || path.startsWith("/api/v1/global-action-items/search")) {
          const url = new URL(path, "https://pocket.test")
          const query = url.searchParams
          const status = (value: string) => ["DONE", "COMPLETE"].includes(value.toUpperCase()) ? "COMPLETED" : value.toUpperCase()
          let items = [state.action, ...state.additionalActions].map((item) => structuredClone(item))
          const queryText = query.get("query")?.trim().toLowerCase()
          if (queryText) items = items.filter((item) => `${item.title} ${item.description} ${item.metadata.label} ${item.metadata.context}`.toLowerCase().includes(queryText))
          const recordingId = query.get("recordingId")
          if (recordingId) items = items.filter((item) => item.recordingId === recordingId)
          const requestedStatus = query.get("status")
          if (requestedStatus) items = items.filter((item) => status(item.status) === requestedStatus)
          const priority = query.get("priority")
          if (priority) items = items.filter((item) => (item.priority || item.metadata.priority).toUpperCase() === priority)
          const category = query.get("category")
          if (category) items = items.filter((item) => item.category.toUpperCase() === category)
          const startDate = query.get("startDate")
          if (startDate) items = items.filter((item) => item.dueDate !== null && Date.parse(item.dueDate) >= Date.parse(startDate))
          const endDate = query.get("endDate")
          if (endDate) items = items.filter((item) => item.dueDate !== null && Date.parse(item.dueDate) <= Date.parse(endDate + (endDate.length === 10 ? "T23:59:59.999Z" : "")))
          const total = items.length
          const limit = Number(query.get("limit") ?? 50)
          const offset = Number(query.get("offset") ?? 0)
          const duplicateLeaf = state.duplicateHierarchyLeafOnNextPage && path.startsWith("/api/v1/global-action-items/hierarchy") && offset > 0
          const pageItems = duplicateLeaf ? items.slice(0, 1) : items.slice(offset, offset + limit)
          if (path.startsWith("/api/v1/global-action-items/search")) {
            return Effect.succeed({ success: true, data: pageItems, pagination: { limit, offset, total, returned: pageItems.length } })
          }
          const groups = new Map<string, typeof pageItems>()
          for (const item of pageItems) {
            const groupId = typeof item.parentTaskId === "string" ? item.parentTaskId : `action:${item.id}`
            const group = groups.get(groupId) ?? []
            group.push(item)
            groups.set(groupId, group)
          }
          const data = state.actionHierarchyParent && pageItems.length > 0
            ? [{ ...structuredClone(state.actionHierarchyParent), subtasks: pageItems }]
            : [...groups].map(([parentTaskId, subtasks]) => ({ parentTaskId, subtasks }))
          return Effect.succeed({ success: true, data, pagination: { limit, offset, total, returned: data.length } })
        }
        if (path === "/api/v1/users/current/profile") return Effect.succeed({ id: "user-1", email: "test@example.com", isActive: true, subscriptionType: "FREE", fcmToken: "private-push-token" })
        if (path === "/api/v1/folders") return Effect.succeed({ data: [] })
        if (path === "/api/v1/organization/current") return Effect.succeed({ organization: null })
      }
      if (method !== "GET" && state.failBeforeWrite) return Effect.fail(failure("uncertain_write", "A test transport failed before applying a write."))
      if (path === "/api/v1/summarize/summary-1/markdown" && method === "PATCH") {
        state.detail.summarizations["summary-map-key"].v2.summary.markdown = (body as { markdown: string }).markdown
      } else if (path === "/api/v1/transcript-edit/recording-1/batch" && method === "POST") {
        for (const action of (body as { actions: { segmentIndex: number; text: string }[] }).actions) {
          const segment = state.detail.transcription.transcription.segments[action.segmentIndex]!
          segment.text = action.text; segment.originalText = action.text
        }
      } else if (path.startsWith("/api/v1/global-action-items/") && method === "PATCH") {
        const completedRoute = path.endsWith("/complete")
        if (completedRoute) {
          state.action.status = "DONE"; state.action.isCompleted = true; state.action.completedAt = new Date().toISOString()
        } else {
          const update = body as Record<string, unknown>
          if (typeof update.title === "string") state.action.title = update.title
          if (typeof update.dueDate === "string" || update.dueDate === null) state.action.dueDate = update.dueDate
          if (typeof update.status === "string") {
            state.action.status = update.status
            state.action.isCompleted = ["COMPLETED", "DONE", "COMPLETE"].includes(update.status.toUpperCase())
            state.action.completedAt = state.action.isCompleted ? new Date().toISOString() : null
          }
          if (typeof update.assignee === "string" || update.assignee === null) state.action.assignee = update.assignee
          if (typeof update.metadata === "object" && update.metadata !== null && !Array.isArray(update.metadata)) {
            const changes = update.metadata as Record<string, unknown>
            state.action.metadata = { ...state.action.metadata, ...changes }
            if (typeof changes.label === "string") state.action.title = changes.label
            if (typeof changes.context === "string") state.action.description = changes.context
            if (typeof changes.priority === "string") state.action.priority = changes.priority.toUpperCase()
            if (typeof changes.assignee === "string" || changes.assignee === null) state.action.assignee = changes.assignee
          }
        }
      } else return Effect.fail(failure("upstream", "Unexpected test operation."))
      state.afterWrite?.()
      if (state.writeDelay > 0) return Effect.sleep(`${state.writeDelay} millis`).pipe(Effect.as({ success: true }))
      return state.failAfterWrite ? Effect.fail(failure("uncertain_write", "A test transport failed after applying the write.")) : Effect.succeed({ success: true })
    })
  const transport = Layer.succeed(PocketTransport, { request, prepare: Effect.succeed(request) })
  const backups = Layer.succeed(Backups, { save: (_kind, _recordingId, content) => Effect.suspend(() => {
    if (state.rejectBackup) return Effect.fail(failure("storage", "Cannot save backup."))
    state.backups.push(structuredClone(content))
    return Effect.succeed({ backupId: `backup-${state.backups.length}` })
  }) })
  return { state, layer: PocketLive.pipe(Layer.provideMerge(Layer.merge(transport, backups))) }
}
