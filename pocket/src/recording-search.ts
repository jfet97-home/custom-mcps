import { Effect, Schema } from "effect"
import { failure, PocketError } from "./core.js"
import { Id, Recording } from "./recording.js"
import { PocketTransport } from "./transport.js"

const date = Schema.String.check(Schema.isMaxLength(64))
const ids = Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(50))
export const RecordingSearchInput = Schema.Struct({
  query: Schema.NonEmptyString.check(Schema.isMaxLength(1000)),
  page: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10000 }))),
  limit: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))),
  workspaceId: Schema.optionalKey(Id), folderIds: Schema.optionalKey(ids), tagIds: Schema.optionalKey(ids),
  recordingDateAfter: Schema.optionalKey(date), recordingDateBefore: Schema.optionalKey(date)
})
const Tag = Schema.Struct({ id: Id, name: Schema.String, color: Schema.optionalKey(Schema.NullOr(Schema.String)) })
export const Tags = Schema.Struct({ tags: Schema.Array(Tag), count: Schema.Number })
const Hit = Schema.Struct({ ...Recording.fields,
  relevance: Schema.optionalKey(Schema.Number),
  tags: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.optionalKey(Id), name: Schema.String })))
})
const UpstreamPage = Schema.Struct({
  data: Schema.Struct({ recordings: Schema.Array(Hit) }),
  metadata: Schema.Struct({ total: Schema.Number, page: Schema.Number, limit: Schema.Number })
})
export const RecordingSearchResult = Schema.Struct({ ...UpstreamPage.fields,
  filtering: Schema.Literals(["upstream", "complete_result_scan"])
})

const checked = <A>(run: () => A): Effect.Effect<A, PocketError> => Effect.try({ try: run,
  catch: (error) => error instanceof PocketError ? error : failure("upstream", "Pocket returned an unsupported search response.") })

export const searchDate = (value: string | undefined, bound: "lower" | "upper" = "lower"): number | undefined => {
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value)) ||
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw failure("validation", "Dates must be valid YYYY-MM-DD values or ISO timestamps with a timezone.")
  }
  return Date.parse(value) + (value.length === 10 && bound === "upper" ? 86_399_999 : 0)
}

export const searchRecordings = (input: typeof RecordingSearchInput.Type) => Effect.gen(function*() {
  const after = yield* checked(() => searchDate(input.recordingDateAfter))
  const before = yield* checked(() => searchDate(input.recordingDateBefore, "upper"))
  if (after !== undefined && before !== undefined && after > before) return yield* Effect.fail(failure("validation", "The recording date range is reversed."))
  const api = yield* PocketTransport
  const pageSize = input.limit ?? 20
  const page = input.page ?? 1
  const read = (page: number, limit: number) => {
    const query = new URLSearchParams({ q: input.query, searchType: "hybrid_semantic", sort: "relevance", page: String(page), limit: String(limit) })
    if (input.workspaceId) query.set("workspaceId", input.workspaceId)
    if (input.tagIds) query.set("tagIds", input.tagIds.join(","))
    if (after !== undefined) query.set("startDate", new Date(after).toISOString())
    if (before !== undefined) query.set("endDate", new Date(before).toISOString())
    return api.request("GET", `/api/v1/search?${query}`).pipe(Effect.flatMap((raw) => checked(() => {
      const result = Schema.decodeUnknownSync(UpstreamPage)(raw)
      const metadata = (raw as { metadata: { appliedFilters?: { tagIds?: unknown; dateRange?: { startDate?: string; endDate?: string } | null } } }).metadata
      const applied = metadata.appliedFilters
      if (input.tagIds && (!Array.isArray(applied?.tagIds) || JSON.stringify([...new Set(applied.tagIds)].sort()) !== JSON.stringify([...new Set(input.tagIds)].sort())) ||
        after !== undefined && Date.parse(applied?.dateRange?.startDate ?? "") !== after ||
        before !== undefined && Date.parse(applied?.dateRange?.endDate ?? "") !== before) {
        throw failure("upstream", "Pocket did not confirm the requested search filters. No unfiltered results were returned.")
      }
      return result
    })))
  }
  if (!input.folderIds) return { ...yield* read(page, pageSize), filtering: "upstream" as const }

  // the app search ignores folderIds, so filter only after a complete bounded scan
  const hits: Array<typeof Hit.Type> = []
  const seen = new Set<string>()
  let expectedTotal: number | undefined
  for (let scanPage = 1; scanPage <= 100; scanPage++) {
    const result = yield* read(scanPage, 100)
    const total = result.metadata.total
    if (!Number.isInteger(total) || total < 0 || result.metadata.page !== scanPage || result.metadata.limit !== 100 ||
      expectedTotal !== undefined && expectedTotal !== total) return yield* Effect.fail(failure("conflict", "Search pagination changed during folder filtering. Run the search again."))
    expectedTotal = total
    for (const hit of result.data.recordings) {
      if (seen.has(hit.id)) return yield* Effect.fail(failure("conflict", "Search repeated a recording during folder filtering. Run the search again."))
      seen.add(hit.id)
      if (hit.folderId && input.folderIds.includes(hit.folderId)) hits.push(hit)
    }
    if (seen.size > total || result.data.recordings.length > 100 || result.data.recordings.length === 0 && seen.size < total) return yield* Effect.fail(failure("upstream", "Pocket returned inconsistent search pagination."))
    if (seen.size === total) return { data: { recordings: hits.slice((page - 1) * pageSize, page * pageSize) }, metadata: { total: hits.length, page, limit: pageSize }, filtering: "complete_result_scan" as const }
  }
  return yield* Effect.fail(failure("validation", "Folder-filtered search exceeds 10,000 recordings. Narrow the query or date range."))
})

export const listTags = PocketTransport.use((api) => api.request("GET", "/api/v1/tags").pipe(
  Effect.flatMap((raw) => checked(() => Schema.decodeUnknownSync(Tags)(raw)))
))
