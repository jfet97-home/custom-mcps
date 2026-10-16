import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Fiber } from "effect"
import { Pocket, actionCompleted, flattenActions, sameDueDate } from "../src/pocket.js"
import { notesFrom, transcriptFrom } from "../src/recording.js"
import { fixture } from "./fixture.js"

test("complete Notes select the explicit summarization ID rather than row ID or map key", () => {
  const { state } = fixture()
  const latest = notesFrom(state.detail)
  assert.equal(latest.summarizationId, "summary-1")
  assert.equal(latest.rowId, "summary-row-1")
  assert.equal(latest.markdown, "# Original\n\nComplete Notes.")
  assert.equal(notesFrom(state.detail, "summary-old").markdown, "Old Notes")
  assert.throws(() => notesFrom(state.detail, "summary-row-1"))
  assert.equal(transcriptFrom(state.detail).segments[1]?.segmentIndex, 1)
})

test("Notes writes check stale hashes, back up first, use summarization ID and verify the result", async () => {
  const { state, layer } = fixture()
  await Effect.runPromise(Effect.gen(function*() {
    const pocket = yield* Pocket
    const before = yield* pocket.getNotes("recording-1")
    const stale = yield* pocket.updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", markdown: "stale", expectedHash: "0".repeat(64) }).pipe(Effect.result)
    assert.equal(stale._tag, "Failure")
    assert.equal(state.requests.filter((r) => r.method === "PATCH").length, 0)
    const result = yield* pocket.updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", markdown: "New Markdown", expectedHash: before.hash })
    assert.equal(result.verified, true)
    assert.equal((state.backups[0] as { document: { markdown: string } }).document.markdown, before.markdown)
    assert.equal(state.requests.find((r) => r.method === "PATCH")?.path, "/api/v1/summarize/summary-1/markdown")
    assert.equal(notesFrom(state.detail).markdown, "New Markdown")
  }).pipe(Effect.provide(layer)))
})

test("backup failures and changes detected during the second read prevent overwriting", async () => {
  for (const reason of ["backup", "concurrent"] as const) {
    const { state, layer } = fixture()
    if (reason === "backup") state.rejectBackup = true
    else {
      let reads = 0
      state.beforeRead = () => { if (++reads === 2) state.detail.summarizations["summary-map-key"].v2.summary.markdown = "Other editor" }
    }
    await Effect.runPromise(Effect.gen(function*() {
      const result = yield* (yield* Pocket).updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", markdown: "Attempt", expectedHash: notesFrom(state.detail).hash }).pipe(Effect.result)
      assert.equal(result._tag, "Failure")
      assert.equal(state.requests.filter((r) => r.method !== "GET").length, 0)
    }).pipe(Effect.provide(layer)))
  }
})

test("transcript batch preserves raw empty-segment indices and rejects duplicate/out-of-range edits", async () => {
  const { state, layer } = fixture()
  await Effect.runPromise(Effect.gen(function*() {
    const pocket = yield* Pocket
    for (const corrections of [[{ segmentIndex: 2, text: "bad" }], [{ segmentIndex: 1, text: "a" }, { segmentIndex: 1, text: "b" }]]) {
      const result = yield* pocket.editTranscript({ recordingId: "recording-1", expectedHash: transcriptFrom(state.detail).hash, corrections }).pipe(Effect.result)
      assert.equal(result._tag, "Failure")
    }
    assert.equal(state.requests.filter((r) => r.method === "POST").length, 0)
    yield* pocket.editTranscript({ recordingId: "recording-1", expectedHash: transcriptFrom(state.detail).hash, corrections: [{ segmentIndex: 0, text: "New start" }, { segmentIndex: 1, text: "Corrected" }] })
    assert.deepEqual(state.requests.find((r) => r.method === "POST")?.body, { actions: [{ type: "edit_text", segmentIndex: 0, text: "New start" }, { type: "edit_text", segmentIndex: 1, text: "Corrected" }] })
    assert.equal(state.backups.length, 1)
  }).pipe(Effect.provide(layer)))
})

test("an uncertain mutation is not automatically retried", async () => {
  const { state, layer } = fixture()
  state.failAfterWrite = true
  await Effect.runPromise(Effect.gen(function*() {
    const result = yield* (yield* Pocket).updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", markdown: "Saved despite timeout", expectedHash: notesFrom(state.detail).hash }).pipe(Effect.result)
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.code, "uncertain_write")
    assert.equal(state.requests.filter((r) => r.method === "PATCH").length, 1)
    assert.equal(notesFrom(state.detail).markdown, "Saved despite timeout")
  }).pipe(Effect.provide(layer)))
})

test("global action IDs are preserved, updates are backed up, and account output omits push tokens", async () => {
  const { state, layer } = fixture()
  assert.equal(flattenActions([{ id: "root-1", title: "Root", recordingId: "recording-1", subtasks: [] }])[0]?.id, "root-1")
  await Effect.runPromise(Effect.gen(function*() {
    const pocket = yield* Pocket
    const page = yield* pocket.searchActionItems({ recordingId: "recording-1" })
    assert.equal(page.items[0]?.id, "global-1")
    yield* pocket.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", expectedHash: page.items[0]!.hash, title: "New title" })
    assert.equal(state.action.title, "New title")
    yield* pocket.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", expectedHash: (yield* pocket.searchActionItems({ recordingId: "recording-1" })).items[0]!.hash, completed: true })
    assert.equal(state.action.status, "DONE")
    const account = yield* pocket.account
    assert.ok(!JSON.stringify(account).includes("private-push-token"))
    assert.equal(state.backups.length, 2)
  }).pipe(Effect.provide(layer)))
})


test("post-send reread failures and mismatches are uncertain and retain raw recovery backups", async () => {
  for (const reason of ["read", "mismatch"] as const) {
    const { state, layer } = fixture()
    const hash = notesFrom(state.detail).hash
    state.afterWrite = () => {
      if (reason === "read") state.readFailure = true
      else state.detail.summarizations["summary-map-key"].v2.summary.markdown = "Concurrent content"
    }
    const result = await Effect.runPromise(Pocket.use((p) => p.updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", markdown: "Requested", expectedHash: hash })).pipe(Effect.result, Effect.provide(layer)))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") { assert.equal(result.failure.code, "uncertain_write"); assert.equal(result.failure.backupId, "backup-1") }
    assert.equal(state.requests.filter((r) => r.method === "PATCH").length, 1)
    const backup = state.backups[0] as { document: { markdown: string }; rawRecording: unknown }
    assert.equal(backup.document.markdown, "# Original\n\nComplete Notes.")
    assert.ok(backup.rawRecording)
  }
})

test("cancelling an in-flight write still drains verification", async () => {
  const { state, layer } = fixture()
  state.writeDelay = 50
  await Effect.runPromise(Effect.gen(function*() {
    const p = yield* Pocket
    const before = yield* p.getNotes("recording-1")
    const fiber = yield* p.updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", markdown: "Requested", expectedHash: before.hash }).pipe(Effect.forkChild)
    yield* Effect.sleep("10 millis")
    yield* Fiber.interrupt(fiber)
    assert.equal(state.requests.filter((r) => r.method === "GET").length, 4)
  }).pipe(Effect.provide(layer)))
})

test("transcript guards bind identity, preserve unedited segments and require consent for differing originalText", async () => {
  const { state, layer } = fixture()
  const first = transcriptFrom(state.detail)
  state.detail.transcription.transcriptionId = "replacement-transcript"
  assert.notEqual(transcriptFrom(state.detail).hash, first.hash)
  state.detail.transcription.transcription.segments[1]!.originalText = "Original recognition"
  const expectedHash = transcriptFrom(state.detail).hash
  await Effect.runPromise(Effect.gen(function*() {
    const p = yield* Pocket
    const input = { recordingId: "recording-1", expectedHash, corrections: [{ segmentIndex: 1, text: "Corrected" }] }
    const rejected = yield* p.editTranscript(input).pipe(Effect.result)
    assert.equal(rejected._tag, "Failure")
    assert.equal(state.backups.length, 0)
    yield* p.editTranscript({ ...input, allowOriginalTextOverwrite: true })
    const backup = state.backups[0] as { rawRecording: typeof state.detail }
    assert.equal(backup.rawRecording.transcription.transcription.segments[1]!.originalText, "Original recognition")
  }).pipe(Effect.provide(layer)))
  const changed = fixture()
  changed.state.afterWrite = () => { Object.assign(changed.state.detail.transcription.transcription.segments[0]!, { speaker: "Unexpected" }) }
  const result = await Effect.runPromise(Pocket.use((p) => p.editTranscript({ recordingId: "recording-1", expectedHash: transcriptFrom(changed.state.detail).hash, corrections: [{ segmentIndex: 1, text: "Corrected" }] })).pipe(Effect.result, Effect.provide(changed.layer)))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") assert.equal(result.failure.code, "uncertain_write")
})

test("read adapters tolerate nullable actions and legacy transcripts independently of Notes", () => {
  const { state } = fixture()
  const raw = { ...state.detail, recording: { id: "recording-1", title: null }, summarizations: null,
    transcription: { ...state.detail.transcription, transcription: "Legacy complete text" } }
  assert.equal(transcriptFrom(raw).text, "Legacy complete text")
  assert.equal(transcriptFrom(raw).supportsSegmentEdits, false)
  assert.notEqual(transcriptFrom(raw).hash, transcriptFrom({ ...raw, transcription: { ...raw.transcription, transcription: "Changed" } }).hash)
  assert.equal(notesFrom({ ...state.detail, transcription: { unexpected: true } }).markdown, "# Original\n\nComplete Notes.")
  assert.equal(flattenActions([{ id: "nullable", title: null, status: null, updatedAt: null, priority: null, category: null, recordingId: null }]).length, 1)
})

test("action completion and due-date comparisons follow explicit state and calendar semantics", async () => {
  assert.equal(actionCompleted({ id: "a", title: null, status: "TODO", completedAt: "2026-01-01" }), false)
  assert.equal(actionCompleted({ id: "a", title: null, isCompleted: false, status: "DONE", completedAt: "2026-01-01" }), false)
  assert.equal(sameDueDate("2026-10-20", "2026-10-20T12:00:00.000Z"), true)
  assert.equal(sameDueDate("2026-10-20T14:00:00+02:00", "2026-10-20T12:00:00.000Z"), true)
  assert.equal(sameDueDate(null, undefined), true)
  assert.equal(sameDueDate("2026-10-20", "2026-10-21"), false)
  const { state, layer } = fixture()
  state.action.status = "DONE"; state.action.completedAt = "2026-01-01"
  await Effect.runPromise(Effect.gen(function*() {
    const p = yield* Pocket
    const hash = () => p.searchActionItems({ recordingId: "recording-1" }).pipe(Effect.map((page) => page.items[0]!.hash))
    yield* p.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", expectedHash: yield* hash(), completed: false })
    assert.equal(state.action.status, "TODO")
    yield* p.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", expectedHash: yield* hash(), dueDate: "2026-10-20" })
    assert.equal(state.action.dueDate, "2026-10-20")
    yield* p.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", expectedHash: yield* hash(), dueDate: null })
    assert.equal(state.action.dueDate, null)
  }).pipe(Effect.provide(layer)))
})

test("missing originalText and reordered object keys do not produce false transcript mismatches", async () => {
  const { state, layer } = fixture()
  delete (state.detail.transcription.transcription.segments[1] as { originalText?: string }).originalText
  await Effect.runPromise(Effect.gen(function*() {
    const p = yield* Pocket
    const full = yield* p.getRecording("recording-1")
    const notesHash = full.contentHashes.notes.find((n) => n.summarizationId === "summary-1")!.hash
    yield* p.updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", expectedHash: notesHash, markdown: "From recording hash" })
    const result = yield* p.editTranscript({ recordingId: "recording-1", expectedHash: full.contentHashes.transcript!, corrections: [{ segmentIndex: 1, text: "Correction" }] })
    assert.equal(result.verified, true)
  }).pipe(Effect.provide(layer)))
})

test("action-item post-send errors carry the private backup ID", async () => {
  const { state, layer } = fixture()
  state.failAfterWrite = true
  await Effect.runPromise(Effect.gen(function*() {
    const p = yield* Pocket
    const page = yield* p.searchActionItems({ recordingId: "recording-1" })
    const result = yield* p.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", expectedHash: page.items[0]!.hash, title: "Saved" }).pipe(Effect.result)
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") { assert.equal(result.failure.code, "uncertain_write"); assert.equal(result.failure.backupId, "backup-1") }
  }).pipe(Effect.provide(layer)))
})
