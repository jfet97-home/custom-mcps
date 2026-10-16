import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer } from "effect"
import { searchDate, searchRecordings, listTags } from "../src/recording-search.js"
import { PocketTransport, type PreparedRequest } from "../src/transport.js"

const withSearch = (response: (path: string) => unknown) => {
  const paths: string[] = []
  const request: PreparedRequest = (_method, path) => Effect.sync(() => { paths.push(path); return response(path) })
  return { paths, layer: Layer.succeed(PocketTransport, { request, prepare: Effect.succeed(request) }) }
}
const page = (items: unknown[], total = items.length, currentPage = 1, limit = 100) => ({ data: { recordings: items }, metadata: { total, page: currentPage, limit } })

test("recording search sends the live-verified date and tag parameters and preserves safe metadata", async () => {
  const mock = withSearch(() => ({ ...page([{ id: "r1", title: "One", relevance: 0.8, audioUrl: "private", userId: "private" }], 1, 2, 5), metadata: {
    total: 1, page: 2, limit: 5, appliedFilters: { tagIds: ["t1", "t2"], dateRange: { startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-10-16T12:00:00Z" } }
  } }))
  const result = await Effect.runPromise(searchRecordings({ query: "plan", page: 2, limit: 5, tagIds: ["t1", "t2"], workspaceId: "w1", recordingDateAfter: "2026-01-01", recordingDateBefore: "2026-10-16T12:00:00Z" }).pipe(Effect.provide(mock.layer)))
  const query = new URL(mock.paths[0]!, "https://example.com").searchParams
  assert.equal(query.get("startDate"), "2026-01-01T00:00:00.000Z")
  assert.equal(query.get("endDate"), "2026-10-16T12:00:00.000Z")
  assert.equal(query.get("tagIds"), "t1,t2")
  assert.equal(query.get("page"), "2")
  assert.equal(query.get("workspaceId"), "w1")
  assert.equal(result.filtering, "upstream")
  assert.equal(result.data.recordings[0]?.relevance, 0.8)
  assert.ok(!JSON.stringify(result).includes("private"))
})

test("unconfirmed upstream filters fail instead of returning apparently filtered results", async () => {
  const mock = withSearch(() => page([{ id: "r1" }], 1, 1, 20))
  const result = await Effect.runPromise(searchRecordings({ query: "plan", recordingDateAfter: "2026-01-01" }).pipe(Effect.provide(mock.layer), Effect.result))
  assert.equal(result._tag, "Failure")
})

test("folder filtering scans every result before paginating without forwarding ignored folder parameters", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, folderId: "other" }))
  first[0] = { id: "r0", folderId: "wanted" }
  const mock = withSearch((path) => new URL(path, "https://example.com").searchParams.get("page") === "1" ? page(first, 101) : page([{ id: "r100", folderId: "wanted" }], 101, 2))
  const result = await Effect.runPromise(searchRecordings({ query: "plan", folderIds: ["wanted"], limit: 1, page: 2 }).pipe(Effect.provide(mock.layer)))
  assert.deepEqual(result.data.recordings.map((r) => r.id), ["r100"])
  assert.equal(result.metadata.total, 2)
  assert.equal(result.filtering, "complete_result_scan")
  assert.equal(mock.paths.length, 2)
  assert.ok(mock.paths.every((path) => !path.includes("folder")))
})

test("folder filtering rejects changed totals and repeated pages rather than presenting partial matches", async () => {
  for (const second of [page([], 102, 2), page([{ id: "r0" }], 101, 2)]) {
    const mock = withSearch((path) => new URL(path, "https://example.com").searchParams.get("page") === "1" ? page(Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` })), 101) : second)
    const result = await Effect.runPromise(searchRecordings({ query: "plan", folderIds: ["wanted"] }).pipe(Effect.provide(mock.layer), Effect.result))
    assert.equal(result._tag, "Failure")
  }
})

test("invalid or reversed recording dates fail before an API request", async () => {
  assert.equal(searchDate("2026-10-16", "upper"), Date.parse("2026-10-16T23:59:59.999Z"))
  assert.equal(searchDate("2026-10-16T12:00:00Z", "upper"), Date.parse("2026-10-16T12:00:00Z"))
  for (const value of ["2026-02-30", "2026-01-01T10:00:00", "tomorrow"]) assert.throws(() => searchDate(value))
  const mock = withSearch(() => page([]))
  const result = await Effect.runPromise(searchRecordings({ query: "plan", recordingDateAfter: "2026-10-16", recordingDateBefore: "2026-01-01" }).pipe(Effect.provide(mock.layer), Effect.result))
  assert.equal(result._tag, "Failure")
  assert.equal(mock.paths.length, 0)
})

test("list tags allows only safe tag fields", async () => {
  const mock = withSearch(() => ({ tags: [{ id: "tag1", name: "Work", color: null, userId: "private" }], count: 1 }))
  const result = await Effect.runPromise(listTags.pipe(Effect.provide(mock.layer)))
  assert.deepEqual(result, { tags: [{ id: "tag1", name: "Work", color: null }], count: 1 })
})
