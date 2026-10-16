import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { flattenActions, Pocket, sameDueDate, validIsoDate } from "../src/pocket.js"
import { normalizePocketTimestamp } from "../src/pocket-date.js"
import { fixture } from "./fixture.js"

test("action filters use the verified routes and map due bounds to camel-case date parameters", async () => {
  const { state, layer } = fixture()
  state.action.dueDate = "2026-10-20"
  state.additionalActions.push({
    ...structuredClone(state.action), id: "global-2", title: "Review reminder", description: "Follow-up", status: "IN_PROGRESS",
    priority: "HIGH", category: "REMINDER", dueDate: "2026-10-25", recordedAt: "2026-09-05T12:00:00Z",
    metadata: { ...structuredClone(state.action.metadata), label: "Review reminder", priority: "high" }
  })
  await Effect.runPromise(Effect.gen(function*() {
    const page = yield* (yield* Pocket).searchActionItems({
      status: "TODO", priority: "MEDIUM", category: "TASK", dueAfter: "2026-10-01", dueBefore: "2026-10-31"
    })
    assert.deepEqual(page.items.map((item) => item.id), ["global-1"])
    assert.equal(page.pagination.total, 1)
    const request = state.requests.find((entry) => entry.path.startsWith("/api/v1/global-action-items/hierarchy"))!
    const query = new URL(request.path, "https://pocket.test").searchParams
    assert.equal(query.get("status"), "TODO")
    assert.equal(query.get("priority"), "MEDIUM")
    assert.equal(query.get("category"), "TASK")
    assert.equal(query.get("startDate"), "2026-10-01")
    assert.equal(query.get("endDate"), "2026-10-31")
    assert.equal(query.has("dueAfter"), false)
    assert.equal(query.has("recordingDateFrom"), false)
  }).pipe(Effect.provide(layer)))
})

test("query priority and category filters are applied after complete search pagination", async () => {
  const { state, layer } = fixture()
  state.action.dueDate = "2026-10-20 00:00:00"
  state.additionalActions.push(
    { ...structuredClone(state.action), id: "global-2", title: "Review reminder", status: "IN_PROGRESS", category: "REMINDER", priority: "HIGH", metadata: { ...structuredClone(state.action.metadata), label: "Review reminder", priority: "high" } },
    { ...structuredClone(state.action), id: "global-3", title: "Review task", category: "TASK", priority: "HIGH", metadata: { ...structuredClone(state.action.metadata), label: "Review task", priority: "high" } }
  )
  await Effect.runPromise(Effect.gen(function*() {
    const page = yield* (yield* Pocket).searchActionItems({
      query: "Review", status: "IN_PROGRESS", priority: "HIGH", category: "REMINDER", dueAfter: "2026-10-01", dueBefore: "2026-10-31"
    })
    assert.deepEqual(page.items.map((item) => item.id), ["global-2"])
    assert.equal(page.pagination.total, 1)
    const requests = state.requests.filter((entry) => entry.path.startsWith("/api/v1/global-action-items/search"))
    assert.equal(requests.length, 1)
    const query = new URL(requests[0]!.path, "https://pocket.test").searchParams
    assert.equal(query.get("query"), "Review")
    assert.equal(query.has("status"), false)
    assert.equal(query.has("startDate"), false)
    assert.equal(query.has("endDate"), false)
    assert.equal(query.has("priority"), false)
    assert.equal(query.has("category"), false)
  }).pipe(Effect.provide(layer)))
})

test("hierarchy group counters normalize to leaf rows and stop at the verified total", async () => {
  const { state, layer } = fixture()
  state.action.recordedAt = "2026-10-16 12:00:00.000"
  state.additionalActions.push(...Array.from({ length: 11 }, (_, index) => {
    const id = index + 2
    return {
      ...structuredClone(state.action), id: `global-${id}`, title: `Action ${id}`,
      parentTaskId: id === 2 ? "source-1" : `source-${id}`, recordedAt: "2026-10-17 12:00:00.000",
      metadata: { ...structuredClone(state.action.metadata), label: `Action ${id}` }
    }
  }))
  await Effect.runPromise(Effect.gen(function*() {
    const page = yield* (yield* Pocket).searchActionItems({ recordingDateFrom: "2026-10-01", recordingDateTo: "2026-10-31" })
    assert.equal(page.items.length, 12)
    assert.equal(page.pagination.total, 12)
    assert.equal(page.pagination.returned, 12)
    const requests = state.requests.filter((entry) => entry.path.startsWith("/api/v1/global-action-items/hierarchy"))
    assert.deepEqual(requests.map((entry) => new URL(entry.path, "https://pocket.test").searchParams.get("offset")), ["0"])
  }).pipe(Effect.provide(layer)))
})

test("identical parent containers may repeat across leaf pages, while changed parents conflict", async () => {
  const stable = fixture()
  stable.state.actionHierarchyParent = {
    id: "parent-1", title: "Grouped actions", recordingId: "recording-1", status: "TODO", isCompleted: false
  }
  stable.state.action.parentTaskId = "parent-1"
  stable.state.action.recordedAt = "2026-10-16 12:00:00.000"
  stable.state.additionalActions.push(...Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(stable.state.action), id: `global-${index + 2}`, title: `Action ${index + 2}`,
    recordedAt: "2026-10-17 12:00:00.000", metadata: { ...structuredClone(stable.state.action.metadata), label: `Action ${index + 2}` }
  })))
  const page = await Effect.runPromise(Pocket.use((p) => p.searchActionItems({
    recordingDateFrom: "2026-10-01", recordingDateTo: "2026-10-31", limit: 1, offset: 99
  })).pipe(Effect.provide(stable.layer)))
  assert.deepEqual(page.items.map((item) => item.id), ["parent-1", "global-100"])
  assert.equal(page.pagination.total, 101)
  assert.equal(page.pagination.returned, 1)
  assert.deepEqual(stable.state.requests.filter((entry) => entry.path.startsWith("/api/v1/global-action-items/hierarchy"))
    .map((entry) => new URL(entry.path, "https://pocket.test").searchParams.get("offset")), ["0", "100"])

  const changed = fixture()
  changed.state.actionHierarchyParent = { id: "parent-1", title: "Grouped actions", recordingId: "recording-1", status: "TODO" }
  changed.state.action.parentTaskId = "parent-1"
  changed.state.action.recordedAt = "2026-10-16 12:00:00.000"
  changed.state.additionalActions.push(...Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(changed.state.action), id: `global-${index + 2}`, title: `Action ${index + 2}`,
    recordedAt: "2026-10-17 12:00:00.000", metadata: { ...structuredClone(changed.state.action.metadata), label: `Action ${index + 2}` }
  })))
  let reads = 0
  changed.state.beforeRead = () => { if (++reads === 2) changed.state.actionHierarchyParent!.title = "Changed group" }
  const result = await Effect.runPromise(Pocket.use((p) => p.searchActionItems({
    recordingDateFrom: "2026-10-01", recordingDateTo: "2026-10-31", limit: 1, offset: 99
  }).pipe(Effect.result)).pipe(Effect.provide(changed.layer)))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") assert.equal(result.failure.code, "conflict")
})

test("local hierarchy scans reject a repeated leaf ID", async () => {
  const { state, layer } = fixture()
  state.additionalActions.push(...Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(state.action), id: `global-${index + 2}`, title: `Action ${index + 2}`,
    recordedAt: "2026-10-17T12:00:00Z", metadata: { ...structuredClone(state.action.metadata), label: `Action ${index + 2}` }
  })))
  state.duplicateHierarchyLeafOnNextPage = true
  const result = await Effect.runPromise(Pocket.use((p) => p.searchActionItems({
    recordingDateFrom: "2026-10-01", recordingDateTo: "2026-10-31"
  }).pipe(Effect.result)).pipe(Effect.provide(layer)))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") assert.equal(result.failure.code, "upstream")
})

test("recording-date filters use recordedAt after every page and paginate the filtered result", async () => {
  const { state, layer } = fixture()
  state.additionalActions.push(...Array.from({ length: 101 }, (_, index) => {
    const id = index + 1
    return {
      ...structuredClone(state.action), id: `global-${id + 1}`, title: `Action ${id}`,
      recordedAt: id % 2 === 1 ? "2026-10-17T12:00:00Z" : "2025-10-17T12:00:00Z",
      metadata: { ...structuredClone(state.action.metadata), label: `Action ${id}` }
    }
  }))
  await Effect.runPromise(Effect.gen(function*() {
    const pocket = yield* Pocket
    const page = yield* pocket.searchActionItems({ recordingDateFrom: "2026-10-01", recordingDateTo: "2026-10-31", limit: 10, offset: 50 })
    assert.equal(page.pagination.total, 52)
    assert.equal(page.pagination.offset, 50)
    assert.equal(page.pagination.returned, 2)
    assert.equal(page.items.length, 2)
    const requests = state.requests.filter((entry) => entry.path.startsWith("/api/v1/global-action-items/hierarchy"))
    assert.deepEqual(requests.map((entry) => new URL(entry.path, "https://pocket.test").searchParams.get("offset")), ["0", "100"])
    assert.ok(requests.every((entry) => !entry.path.includes("recordingDateFrom")))
  }).pipe(Effect.provide(layer)))
})

test("local due-date filters exclude null dates and fail closed on malformed dates", async () => {
  const missing = fixture()
  const emptyPage = await Effect.runPromise(Pocket.use((p) => p.searchActionItems({ query: "Original", dueAfter: "2026-01-01" })).pipe(Effect.provide(missing.layer)))
  assert.equal(emptyPage.pagination.total, 0)

  const malformed = fixture()
  malformed.state.action.dueDate = "not-an-iso-date"
  const result = await Effect.runPromise(Pocket.use((p) => p.searchActionItems({ query: "Original", dueAfter: "2026-01-01" }).pipe(Effect.result)).pipe(Effect.provide(malformed.layer)))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") assert.equal(result.failure.code, "upstream")
})

test("Pocket SQL timestamps normalize as UTC while user date filters stay strict ISO", () => {
  assert.equal(normalizePocketTimestamp("2026-10-16 12:34:56.789"), "2026-10-16T12:34:56.789Z")
  assert.equal(normalizePocketTimestamp("2026-10-16T12:34:56"), "2026-10-16T12:34:56Z")
  assert.equal(normalizePocketTimestamp("2026-10-16T12:34:56+02:00"), "2026-10-16T12:34:56+02:00")
  assert.equal(normalizePocketTimestamp("2026-10-16"), "2026-10-16")
  assert.equal(normalizePocketTimestamp("invalid timestamp"), "invalid timestamp")
  assert.equal(validIsoDate("2026-10-16 12:34:56.789"), false)
  assert.equal(sameDueDate("2026-10-16T12:34:56Z", "2026-10-16 12:34:56"), true)
  assert.equal(Date.parse(normalizePocketTimestamp("2026-10-16 12:34:56.789")), Date.parse("2026-10-16T12:34:56.789Z"))
})

test("recording-date filters fail closed on malformed Pocket timestamps", async () => {
  const { state, layer } = fixture()
  state.action.recordedAt = "2026/10/16 12:00:00"
  const result = await Effect.runPromise(Pocket.use((p) => p.searchActionItems({ recordingDateFrom: "2026-10-01" }).pipe(Effect.result)).pipe(Effect.provide(layer)))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") assert.equal(result.failure.code, "upstream")
})

test("action hashes bind title, context, priority and assignee in both app fields and metadata aliases", () => {
  const { state } = fixture()
  const base = structuredClone(state.action)
  const hash = (item: typeof state.action) => flattenActions([item])[0]!.hash
  const original = hash(base)
  assert.notEqual(hash({ ...base, title: "Changed" }), original)
  assert.notEqual(hash({ ...base, description: "Changed" }), original)
  assert.notEqual(hash({ ...base, priority: "HIGH" }), original)
  assert.notEqual(hash({ ...base, assignee: "alex" }), original)
  assert.notEqual(hash({ ...base, metadata: { ...base.metadata, label: "Different" } }), original)
  assert.notEqual(hash({ ...base, metadata: { ...base.metadata, context: "Different" } }), original)
  assert.notEqual(hash({ ...base, metadata: { ...base.metadata, priority: "high" } }), original)
  assert.notEqual(hash({ ...base, metadata: { ...base.metadata, assignee: "alex" } }), original)
})

test("action updates map aliases to supported fields, preserve metadata, and clear empty values", async () => {
  const { state, layer } = fixture()
  await Effect.runPromise(Effect.gen(function*() {
    const pocket = yield* Pocket
    let page = yield* pocket.searchActionItems({ recordingId: "recording-1" })
    yield* pocket.updateActionItem({
      recordingId: "recording-1", actionItemId: "global-1", expectedHash: page.items[0]!.hash,
      label: "Updated label", context: "Updated context", status: "IN_PROGRESS", priority: "HIGH",
      assignee: "alex", dueDate: "2026-10-20T14:00:00+02:00"
    })
    assert.equal(state.action.title, "Updated label")
    assert.equal(state.action.description, "Updated context")
    assert.equal(state.action.status, "IN_PROGRESS")
    assert.equal(state.action.priority, "HIGH")
    assert.equal(state.action.assignee, "alex")
    assert.equal(state.action.dueDate, "2026-10-20T14:00:00+02:00")
    assert.equal(state.action.metadata.payload.retained, true)
    assert.equal(state.action.metadata.label, "Updated label")
    assert.equal(state.action.metadata.context, "Updated context")
    assert.deepEqual(state.action.metadata.assignees, ["alex"])
    const patch = state.requests.find((entry) => entry.method === "PATCH")!
    assert.equal(patch.path, "/api/v1/global-action-items/global-1")
    assert.equal(state.requests.filter((entry) => entry.method === "PATCH").length, 1)
    assert.deepEqual(patch.body, {
      title: "Updated label", dueDate: "2026-10-20T14:00:00+02:00", status: "IN_PROGRESS", assignee: "alex",
      metadata: { ...state.action.metadata, priority: "high" }
    })

    page = yield* pocket.searchActionItems({ recordingId: "recording-1" })
    yield* pocket.updateActionItem({
      recordingId: "recording-1", actionItemId: "global-1", expectedHash: page.items[0]!.hash,
      description: "", context: "", dueDate: "", assignee: ""
    })
    assert.equal(state.action.description, "")
    assert.equal(state.action.metadata.context, "")
    assert.equal(state.action.dueDate, null)
    assert.equal(state.action.assignee, null)
    assert.deepEqual(state.action.metadata.assignees, [])

    page = yield* pocket.searchActionItems({ recordingId: "recording-1" })
    yield* pocket.updateActionItem({
      recordingId: "recording-1", actionItemId: "global-1", expectedHash: page.items[0]!.hash, status: "CANCELLED"
    })
    assert.equal(state.action.status, "CANCELLED")
    assert.equal(state.action.completedAt, null)
    assert.equal(state.requests.filter((entry) => entry.method === "PATCH").length, 3)
  }).pipe(Effect.provide(layer)))
})

test("action update aliases and ISO inputs reject conflicts before writing", async () => {
  const { state, layer } = fixture()
  await Effect.runPromise(Effect.gen(function*() {
    const pocket = yield* Pocket
    const page = yield* pocket.searchActionItems({ recordingId: "recording-1" })
    const hash = page.items[0]!.hash
    const invalid = [
      { title: "First", label: "Second" },
      { description: "First", context: "Second" },
      { status: "TODO" as const, completed: true },
      { dueDate: "2026-02-30" },
      { dueDate: "2026-10-20T12:00:00" },
      { priority: "URGENT" as never }
    ]
    for (const fields of invalid) {
      const result = yield* pocket.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", expectedHash: hash, ...fields }).pipe(Effect.result)
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") assert.equal(result.failure.code, "validation")
    }
    assert.equal(state.requests.filter((entry) => entry.method === "PATCH").length, 0)
    const invalidFilter = yield* pocket.searchActionItems({ dueAfter: "2026-02-30" }).pipe(Effect.result)
    assert.equal(invalidFilter._tag, "Failure")
    if (invalidFilter._tag === "Failure") assert.equal(invalidFilter.failure.code, "validation")
    const invalidEnum = yield* pocket.searchActionItems({ status: "UNKNOWN" as never }).pipe(Effect.result)
    assert.equal(invalidEnum._tag, "Failure")
    if (invalidEnum._tag === "Failure") assert.equal(invalidEnum.failure.code, "validation")
  }).pipe(Effect.provide(layer)))
})

test("status completion uses one completion call and verifies Pocket's timestamp", async () => {
  const { state, layer } = fixture()
  state.afterWrite = () => { state.action.completedAt = "2026-10-16 12:00:00.000" }
  await Effect.runPromise(Effect.gen(function*() {
    const pocket = yield* Pocket
    const page = yield* pocket.searchActionItems({ recordingId: "recording-1" })
    const result = yield* pocket.updateActionItem({
      recordingId: "recording-1", actionItemId: "global-1", expectedHash: page.items[0]!.hash, status: "COMPLETED"
    })
    assert.equal(result.verified, true)
    assert.equal(state.action.status, "DONE")
    assert.ok(state.action.completedAt)
    assert.equal(normalizePocketTimestamp(state.action.completedAt), "2026-10-16T12:00:00.000Z")
    assert.equal(state.requests.filter((entry) => entry.method === "PATCH").length, 1)
    assert.equal(state.requests.find((entry) => entry.method === "PATCH")?.path, "/api/v1/global-action-items/global-1/complete")
  }).pipe(Effect.provide(layer)))
})

test("completion rejects a malformed source timestamp after the write", async () => {
  const { state, layer } = fixture()
  state.afterWrite = () => { state.action.completedAt = "2026-10-16 25:00:00" }
  const result = await Effect.runPromise(Pocket.use((p) => p.searchActionItems({ recordingId: "recording-1" }).pipe(
    Effect.flatMap((page) => p.updateActionItem({ recordingId: "recording-1", actionItemId: "global-1", expectedHash: page.items[0]!.hash, status: "COMPLETED" })),
    Effect.result
  )).pipe(Effect.provide(layer)))
  assert.equal(result._tag, "Failure")
  if (result._tag === "Failure") assert.equal(result.failure.code, "uncertain_write")
  assert.equal(state.requests.filter((entry) => entry.method === "PATCH").length, 1)
})

test("an action update with metadata mismatch is uncertain and keeps its raw backup", async () => {
  const { state, layer } = fixture()
  state.afterWrite = () => { state.action.metadata.context = "Concurrent context" }
  await Effect.runPromise(Effect.gen(function*() {
    const pocket = yield* Pocket
    const page = yield* pocket.searchActionItems({ recordingId: "recording-1" })
    const result = yield* pocket.updateActionItem({
      recordingId: "recording-1", actionItemId: "global-1", expectedHash: page.items[0]!.hash, context: "Requested context"
    }).pipe(Effect.result)
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "uncertain_write")
      assert.equal(result.failure.backupId, "backup-1")
    }
    assert.equal(state.requests.filter((entry) => entry.method === "PATCH").length, 1)
    const backup = state.backups[0] as { rawActionItem: { metadata: { payload: { retained: boolean } } } }
    assert.equal(backup.rawActionItem.metadata.payload.retained, true)
  }).pipe(Effect.provide(layer)))
})
