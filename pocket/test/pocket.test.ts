import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { Pocket, flattenActions } from "../src/pocket.js"
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
    assert.equal(state.backups[0], before.markdown)
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
      const result = yield* (yield* Pocket).updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", markdown: "Attempt" }).pipe(Effect.result)
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
      const result = yield* pocket.editTranscript({ recordingId: "recording-1", corrections }).pipe(Effect.result)
      assert.equal(result._tag, "Failure")
    }
    assert.equal(state.requests.filter((r) => r.method === "POST").length, 0)
    yield* pocket.editTranscript({ recordingId: "recording-1", corrections: [{ segmentIndex: 0, text: "New start" }, { segmentIndex: 1, text: "Corrected" }] })
    assert.deepEqual(state.requests.find((r) => r.method === "POST")?.body, { actions: [{ type: "edit_text", segmentIndex: 0, text: "New start" }, { type: "edit_text", segmentIndex: 1, text: "Corrected" }] })
    assert.equal(state.backups.length, 1)
  }).pipe(Effect.provide(layer)))
})

test("an uncertain mutation is not automatically retried", async () => {
  const { state, layer } = fixture()
  state.failAfterWrite = true
  await Effect.runPromise(Effect.gen(function*() {
    const result = yield* (yield* Pocket).updateNotes({ recordingId: "recording-1", summarizationId: "summary-1", markdown: "Saved despite timeout" }).pipe(Effect.result)
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
    yield* pocket.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", completed: true })
    assert.equal(state.action.status, "DONE")
    const account = yield* pocket.account
    assert.ok(!JSON.stringify(account).includes("private-push-token"))
    assert.equal(state.backups.length, 2)
  }).pipe(Effect.provide(layer)))
})
