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
  const action = { id: "global-1", title: "Original action", recordingId: "recording-1", summarizationId: "summary-1", parentTaskId: "source-1", dueDate: null as string | null, status: "TODO", completedAt: null as string | null, version: 1 }
  const state = { detail, action, requests: [] as { method: string; path: string; body?: unknown }[], backups: [] as unknown[], rejectBackup: false, failAfterWrite: false, beforeRead: undefined as (() => void) | undefined, afterWrite: undefined as (() => void) | undefined, readFailure: false, writeDelay: 0 }
  const request: PreparedRequest = (method, path, body) => Effect.suspend((): Effect.Effect<unknown, PocketError> => {
      state.requests.push({ method, path, body })
      if (method === "GET") {
        state.beforeRead?.()
        if (state.readFailure) return Effect.fail(failure("network", "Read unavailable"))
        if (path.startsWith("/api/v1/recordings/")) return Effect.succeed(structuredClone(state.detail))
        if (path.startsWith("/api/v1/recordings?")) return Effect.succeed({ data: [state.detail.recording], totalCount: 1, totalPages: 1, currentPage: 1 })
        if (path.startsWith("/api/v1/global-action-items/")) return Effect.succeed({ success: true, data: [{ parentTaskId: "source-1", subtasks: [structuredClone(state.action)] }], pagination: { limit: 100, offset: 0, total: 1, returned: 1 } })
        if (path === "/api/v1/users/current/profile") return Effect.succeed({ id: "user-1", email: "test@example.com", isActive: true, subscriptionType: "FREE", fcmToken: "private-push-token" })
        if (path === "/api/v1/folders") return Effect.succeed({ data: [] })
        if (path === "/api/v1/organization/current") return Effect.succeed({ organization: null })
      }
      if (path === "/api/v1/summarize/summary-1/markdown" && method === "PATCH") {
        state.detail.summarizations["summary-map-key"].v2.summary.markdown = (body as { markdown: string }).markdown
      } else if (path === "/api/v1/transcript-edit/recording-1/batch" && method === "POST") {
        for (const action of (body as { actions: { segmentIndex: number; text: string }[] }).actions) {
          const segment = state.detail.transcription.transcription.segments[action.segmentIndex]!
          segment.text = action.text; segment.originalText = action.text
        }
      } else if (path === "/api/v1/global-action-items/global-1" && method === "PATCH") {
        Object.assign(state.action, body)
      } else if (path === "/api/v1/global-action-items/global-1/complete" && method === "PATCH") {
        state.action.status = "DONE"; state.action.completedAt = new Date().toISOString()
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
  return { state, layer: PocketLive.pipe(Layer.provide(Layer.merge(transport, backups))) }
}
