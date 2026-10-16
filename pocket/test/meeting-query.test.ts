import assert from "node:assert/strict"
import { chmod, lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { MeetingQuery, makeMeetingQueryLive, type MeetingQueryInput } from "../src/meeting-query.js"
import { makeMeetingQueryJournal } from "../src/meeting-query-journal.js"
import { Settings } from "../src/core.js"
import { Session } from "../src/session.js"

const sessionLayer = () => Layer.succeed(Session, {
  token: Effect.succeed(Redacted.make("test-firebase-token")),
  status: Effect.succeed({ authenticated: true }),
  invalidate: Effect.void
})

const eventStream = (text: string, chunkSize = 13) => {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize))
      controller.close()
    }
  })
}

const response = (text: string, chunkSize = 13) => new Response(eventStream(text, chunkSize), { headers: { "content-type": "text/event-stream; charset=utf-8" } })

const makeLayer = async (
  fetcher: typeof fetch,
  options: { readonly timeoutMs?: number; readonly idleTimeoutMs?: number; readonly maxResponseBytes?: number; readonly maxEvents?: number; readonly initialWaitMs?: number; readonly staleAfterMs?: number } = {}
) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-meeting-query-"))
  await chmod(dataDir, 0o700)
  const settings = Layer.succeed(Settings, { dataDir, port: 9011 })
  const layer = makeMeetingQueryLive(fetcher, options).pipe(Layer.provide(Layer.merge(sessionLayer(), settings)))
  return { layer, dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) }
}

const operationIdFrom = (message: string) => message.match(/operationId: ([a-f0-9-]{36})/)?.[1]
const acknowledged = { consumeQuota: true as const }
type MeetingQueryLayer = Awaited<ReturnType<typeof makeLayer>>["layer"]

const runQuery = (layer: MeetingQueryLayer, input: MeetingQueryInput) => Effect.runPromise(Effect.gen(function*() {
  const meetingQuery = yield* MeetingQuery
  return yield* meetingQuery.query(input)
}).pipe(Effect.provide(layer)))

const runQueryResult = (layer: MeetingQueryLayer, input: MeetingQueryInput) => Effect.runPromise(Effect.gen(function*() {
  const meetingQuery = yield* MeetingQuery
  return yield* meetingQuery.query(input).pipe(Effect.result)
}).pipe(Effect.provide(layer)))

const buildLongLivedService = async (layer: MeetingQueryLayer) => {
  const scope = await Effect.runPromise(Scope.make())
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  return { scope, context }
}

const runQueryInContext = (context: Context.Context<MeetingQuery>, input: MeetingQueryInput) => Effect.runPromise(Effect.gen(function*() {
  const meetingQuery = yield* MeetingQuery
  return yield* meetingQuery.query(input)
}).pipe(Effect.provideContext(context)))

const runQueryResultInContext = (context: Context.Context<MeetingQuery>, input: MeetingQueryInput) => Effect.runPromise(Effect.gen(function*() {
  const meetingQuery = yield* MeetingQuery
  return yield* meetingQuery.query(input).pipe(Effect.result)
}).pipe(Effect.provideContext(context)))

const lookupInContext = (context: Context.Context<MeetingQuery>, input: { readonly operationId: string }) => Effect.runPromise(Effect.gen(function*() {
  const meetingQuery = yield* MeetingQuery
  return yield* meetingQuery.lookup(input)
}).pipe(Effect.provideContext(context)))

const setEntryUpdatedAt = async (dataDir: string, operationId: string, ageMs: number) => {
  const path = join(dataDir, "meeting-queries", operationId + ".json")
  const entry = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  entry.updatedAt = new Date(Date.now() - ageMs).toISOString()
  await writeFile(path, JSON.stringify(entry), { mode: 0o600 })
}

test("uses the app's default Ask Pocket tier and journals only allowlisted SSE sources", async () => {
  let requestUrl = ""
  let requestHeaders: Headers | undefined
  let requestBody: Record<string, unknown> | undefined
  const source = {
    recordingId: "rec_123",
    title: "Weekly Sync",
    relevanceScore: 0.8,
    sectionSummary: "The team chose the launch date.",
    snippet: "We should launch on Friday.",
    date: "2026-10-15T10:00:00Z",
    speakers: "Alex",
    audioUrl: { signedUrl: "https://private.example/audio" },
    gradientData: { arbitrary: "private metadata" },
    apiToken: "secret-value"
  }
  const minimalSource = { recordingId: "rec_minimal", raw: "ignored" }
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input)
    requestHeaders = new Headers(init?.headers)
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return response([
      `data: ${JSON.stringify({ type: "connected" })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: "session", sessionId: "session-safe" })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: "sources", sources: [source, minimalSource, { id: "bad/id" }, null] })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: "chunk", content: "Partial answer" })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: "completed", fullText: "Final answer ✨" })}\r\n\r\n`
    ].join(""), 7)
  }
  const fixture = await makeLayer(fetcher)
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.query({ query: "  What did we decide?  ", ...acknowledged })
    }).pipe(Effect.provide(fixture.layer)))
    const journal = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.lookup({ operationId: result.operationId })
    }).pipe(Effect.provide(fixture.layer)))
    const metadata = await lstat(join(fixture.dataDir, "meeting-queries", `${result.operationId}.json`))

    assert.equal(requestUrl, "https://production.heypocketai.com/api/v1/global-chat/message/stream")
    assert.equal(requestHeaders?.get("authorization"), "Bearer test-firebase-token")
    assert.equal(requestHeaders?.get("accept"), "text/event-stream")
    assert.equal(requestHeaders?.get("content-type"), "application/json")
    assert.deepEqual(requestBody, {
      message: "What did we decide?",
      language: "English (US)",
      modelTier: "thinking",
      structuredXmlCards: true
    })
    assert.match(result.operationId, /^[a-f0-9-]{36}$/)
    assert.deepEqual(result, {
      operationId: result.operationId,
      answer: "Final answer ✨",
      sourceRecordings: [{
        recordingId: "rec_123",
        title: "Weekly Sync",
        relevanceScore: 0.8,
        summary: "The team chose the launch date.",
        snippet: "We should launch on Friday.",
        date: "2026-10-15T10:00:00Z",
        speakers: "Alex"
      }, { recordingId: "rec_minimal" }],
      sessionId: "session-safe",
      engine: "pocket",
      createsRemoteChat: true
    })
    assert.equal("operation" in journal, true)
    if ("operation" in journal) {
      assert.equal(journal.operation.status, "complete")
      assert.equal(journal.operation.answer, "Final answer ✨")
      assert.equal(journal.operation.query, "What did we decide?")
    }
    assert.equal(metadata.mode & 0o777, 0o600)
    assert.ok(!JSON.stringify(result).includes("private.example"))
    assert.ok(!JSON.stringify(result).includes("secret-value"))
  } finally {
    await fixture.cleanup()
  }
})

test("surfaces Pocket chat quota errors, journals rejection, and never retries the POST", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return response(`data: ${JSON.stringify({ type: "error", errorCode: "GLOBAL_CHAT_DAILY_LIMIT", limit: 1, currentUsage: 1, error: "private upstream details" })}\n\n`)
  }
  const fixture = await makeLayer(fetcher)
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.query({ query: "Ask about this week", ...acknowledged }).pipe(Effect.result)
    }).pipe(Effect.provide(fixture.layer)))

    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "permission")
      assert.match(result.failure.message, /GLOBAL_CHAT_DAILY_LIMIT/)
      assert.ok(!result.failure.message.includes("private upstream details"))
      const operationId = operationIdFrom(result.failure.message)
      assert.ok(operationId)
      const journal = await Effect.runPromise(Effect.gen(function*() {
        const meetingQuery = yield* MeetingQuery
        return yield* meetingQuery.lookup({ operationId: operationId! })
      }).pipe(Effect.provide(fixture.layer)))
      assert.equal("operation" in journal, true)
      if ("operation" in journal) {
        assert.equal(journal.operation.status, "rejected")
        assert.equal(journal.operation.errorCode, "permission")
      }
    }
    assert.equal(calls, 1)
  } finally {
    await fixture.cleanup()
  }
})

test("ignores unknown SSE events and records an uncertain outcome when completion is missing", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return response(`data: ${JSON.stringify({ type: "unexpected_event", payload: "ignored" })}\n\n`)
  }
  const fixture = await makeLayer(fetcher)
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.query({ query: "Ask a question", ...acknowledged }).pipe(Effect.result)
    }).pipe(Effect.provide(fixture.layer)))

    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "uncertain_write")
      assert.match(result.failure.message, /chat history before retrying/)
      const operationId = operationIdFrom(result.failure.message)
      assert.ok(operationId)
      const journal = await Effect.runPromise(Effect.gen(function*() {
        const meetingQuery = yield* MeetingQuery
        return yield* meetingQuery.lookup({ operationId: operationId! })
      }).pipe(Effect.provide(fixture.layer)))
      assert.equal("operation" in journal, true)
      if ("operation" in journal) {
        assert.equal(journal.operation.status, "uncertain")
        assert.equal(journal.operation.query, "Ask a question")
      }
    }
    assert.equal(calls, 1)
  } finally {
    await fixture.cleanup()
  }
})

test("ignores unknown SSE event types, handles split CRLF, and accepts optional source fields", async () => {
  const fetcher: typeof fetch = async () => response([
    `data: ${JSON.stringify({ type: "future_event", payload: "ignored" })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: "sources", sources: [{ recordingId: "rec_minimal" }] })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: "completed", fullText: "Completed across CRLF boundaries." })}\r\n\r\n`
  ].join(""), 1)
  const fixture = await makeLayer(fetcher)
  try {
    const result = await runQuery(fixture.layer, { query: "Check parser", ...acknowledged })
    assert.ok("answer" in result)
    if ("answer" in result) {
      assert.equal(result.answer, "Completed across CRLF boundaries.")
      assert.deepEqual(result.sourceRecordings, [{ recordingId: "rec_minimal" }])
    }
  } finally {
    await fixture.cleanup()
  }
})

test("malformed JSON and invalid UTF-8 produce uncertain outcomes", async () => {
  const malformedFixture = await makeLayer(async () => response("data: {bad json}\n\n"))
  try {
    const result = await runQueryResult(malformedFixture.layer, { query: "Malformed event", ...acknowledged })
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.code, "uncertain_write")
  } finally {
    await malformedFixture.cleanup()
  }

  const invalidUtf8Fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]))
      controller.close()
    }
  }), { headers: { "content-type": "text/event-stream" } })
  const invalidUtf8Fixture = await makeLayer(invalidUtf8Fetcher)
  try {
    const result = await runQueryResult(invalidUtf8Fixture.layer, { query: "Invalid encoding", ...acknowledged })
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.code, "uncertain_write")
  } finally {
    await invalidUtf8Fixture.cleanup()
  }
})

test("a midstream network error is uncertain and does not expose upstream details", async () => {
  const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "chunk", content: "partial answer" })}\n\n`))
      controller.error(new Error("private socket details"))
    }
  }), { headers: { "content-type": "text/event-stream" } })
  const fixture = await makeLayer(fetcher)
  try {
    const result = await runQueryResult(fixture.layer, { query: "Network interruption", ...acknowledged })
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "uncertain_write")
      assert.match(result.failure.message, /chat history before retrying/)
      assert.ok(!result.failure.message.includes("private socket details"))
    }
  } finally {
    await fixture.cleanup()
  }
})

test("clientRequestId returns completed results without reposting and rejects query collisions", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return response(`data: ${JSON.stringify({ type: "completed", fullText: "Cached answer." })}\n\n`)
  }
  const fixture = await makeLayer(fetcher)
  const input = { query: "Stable request", language: "English", clientRequestId: "req_123-safe", ...acknowledged }
  try {
    const first = await runQuery(fixture.layer, input)
    const replay = await runQuery(fixture.layer, input)
    const collision = await runQueryResult(fixture.layer, { ...input, query: "A different question" })
    const languageCollision = await runQueryResult(fixture.layer, { ...input, language: "Italian" })
    const lookupByClientId = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.lookup({ clientRequestId: input.clientRequestId })
    }).pipe(Effect.provide(fixture.layer)))

    assert.equal(first.clientRequestId, input.clientRequestId)
    assert.deepEqual(replay, first)
    assert.ok("operation" in lookupByClientId)
    if ("operation" in lookupByClientId) assert.equal(lookupByClientId.operation.answer, "Cached answer.")
    assert.equal(collision._tag, "Failure")
    if (collision._tag === "Failure") {
      assert.equal(collision.failure.code, "conflict")
      assert.match(collision.failure.message, /different query/)
      assert.ok(collision.failure.message.includes(first.operationId))
    }
    assert.equal(languageCollision._tag, "Failure")
    if (languageCollision._tag === "Failure") assert.equal(languageCollision.failure.code, "conflict")
    assert.equal(calls, 1)
  } finally {
    await fixture.cleanup()
  }
})

test("concurrent duplicate clientRequestId never creates a second Pocket POST", async () => {
  let calls = 0
  let releaseResponse!: () => void
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
  const fetcher: typeof fetch = async () => {
    calls++
    await responseGate
    return response(`data: ${JSON.stringify({ type: "completed", fullText: "One remote result." })}\n\n`)
  }
  const fixture = await makeLayer(fetcher, { initialWaitMs: 10 })
  const { scope, context } = await buildLongLivedService(fixture.layer)
  const input = { query: "Concurrent question", clientRequestId: "req_concurrent", ...acknowledged }
  try {
    const firstPending = runQueryInContext(context, input)
    for (let attempt = 0; attempt < 20 && calls === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    const first = await firstPending
    const duplicate = await runQueryResultInContext(context, input)
    assert.equal(duplicate._tag, "Success")
    if (duplicate._tag === "Success") {
      assert.ok("status" in duplicate.success)
      if ("status" in duplicate.success) assert.equal(duplicate.success.status, "running")
      assert.equal(duplicate.success.operationId, first.operationId)
    }
    releaseResponse()
    let complete = false
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = await lookupInContext(context, { operationId: first.operationId })
      if ("operation" in current && current.operation.status === "complete") complete = true
      if (complete) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(complete, true)
    assert.equal(calls, 1)
  } finally {
    releaseResponse()
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await fixture.cleanup()
  }
})

test("a slow query returns pending while its service-scoped stream continues to completion", async () => {
  let calls = 0
  let finishStream!: () => void
  const fetcher: typeof fetch = async () => {
    calls++
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(["data: ", JSON.stringify({ type: "chunk", content: "p".repeat(16_000) }), "\n\n"].join("")))
        finishStream = () => {
          controller.enqueue(encoder.encode(["data: ", JSON.stringify({ type: "completed", fullText: "Background answer complete." }), "\n\n"].join("")))
          controller.close()
        }
      }
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
  const fixture = await makeLayer(fetcher, { initialWaitMs: 5 })
  const { scope, context } = await buildLongLivedService(fixture.layer)
  try {
    const startedAt = Date.now()
    const pending = await runQueryInContext(context, { query: "Slow question", clientRequestId: "req_slow_query", ...acknowledged })
    assert.ok("status" in pending)
    if (!("status" in pending)) throw new Error("Expected a pending query response.")
    assert.equal(pending.status, "running")
    assert.equal(calls, 1)
    assert.ok(Date.now() - startedAt < 1000)

    await new Promise((resolve) => setTimeout(resolve, 1050))
    const progress = await lookupInContext(context, { operationId: pending.operationId })
    assert.ok("operation" in progress)
    if (!("operation" in progress)) throw new Error("Expected a query journal entry.")
    assert.equal(progress.operation.status, "streaming")
    assert.equal(progress.operation.answer?.length, 16_000)

    finishStream()
    let completed = false
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = await lookupInContext(context, { operationId: pending.operationId })
      if ("operation" in current && current.operation.status === "complete") {
        assert.equal(current.operation.answer, "Background answer complete.")
        completed = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(completed, true)
    assert.equal(calls, 1)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await fixture.cleanup()
  }
})

test("closing the service scope marks an in-flight query uncertain", async () => {
  let calls = 0
  const fetcher: typeof fetch = async (_input, init) => {
    calls++
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(["data: ", JSON.stringify({ type: "chunk", content: "p".repeat(16_000) }), "\n\n"].join("")))
        const abort = () => controller.error(new Error("scope closed"))
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener("abort", abort, { once: true })
      }
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
  const fixture = await makeLayer(fetcher, { initialWaitMs: 5 })
  const { scope, context } = await buildLongLivedService(fixture.layer)
  try {
    const pending = await runQueryInContext(context, { query: "Interrupted at shutdown", clientRequestId: "req_scope_close", ...acknowledged })
    assert.ok("status" in pending)
    if (!("status" in pending)) throw new Error("Expected a pending query response.")
    assert.equal(calls, 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const progress = await lookupInContext(context, { operationId: pending.operationId })
    assert.ok("operation" in progress)
    if ("operation" in progress) assert.equal(progress.operation.answer?.length, 16_000)
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    const entry = await makeMeetingQueryJournal(fixture.dataDir).lookup(pending.operationId)
    assert.equal(entry.status, "uncertain")
    assert.equal(entry.errorCode, "uncertain_write")
    assert.equal(entry.answer?.length, 16_000)
    assert.equal(calls, 1)
  } finally {
    if (scope.state._tag !== "Closed") await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await fixture.cleanup()
  }
})

test("stale intent and streaming records normalize to uncertain without changing completed or live records", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return response(["data: ", JSON.stringify({ type: "completed", fullText: "unexpected" }), "\n\n"].join(""))
  }
  const staleAfterMs = 30
  const fixture = await makeLayer(fetcher, { staleAfterMs })
  const journal = makeMeetingQueryJournal(fixture.dataDir, staleAfterMs)
  try {
    const staleIntent = await journal.create({ query: "Stale intent", language: "English (US)", clientRequestId: "req_stale_intent" })
    assert.equal(staleIntent.kind, "created")
    if (staleIntent.kind !== "created") throw new Error("Expected a new stale intent.")
    await setEntryUpdatedAt(fixture.dataDir, staleIntent.entry.operationId, 1000)

    const staleStreaming = await journal.create({ query: "Stale stream", language: "English (US)", clientRequestId: "req_stale_stream" })
    assert.equal(staleStreaming.kind, "created")
    if (staleStreaming.kind !== "created") throw new Error("Expected a new stale stream.")
    await staleStreaming.update({ status: "streaming", answer: "Saved partial answer." })
    await setEntryUpdatedAt(fixture.dataDir, staleStreaming.entry.operationId, 1000)

    const liveStreaming = await journal.create({ query: "Live stream", language: "English (US)" })
    assert.equal(liveStreaming.kind, "created")
    if (liveStreaming.kind !== "created") throw new Error("Expected a new live stream.")
    await liveStreaming.update({ status: "streaming", answer: "Still active." })

    const completed = await journal.create({ query: "Completed answer", language: "English (US)" })
    assert.equal(completed.kind, "created")
    if (completed.kind !== "created") throw new Error("Expected a new completed operation.")
    await completed.update({
      status: "complete",
      answer: "Keep this answer.",
      sourceRecordings: [{ recordingId: "rec_kept", title: "Kept source" }]
    })
    await setEntryUpdatedAt(fixture.dataDir, completed.entry.operationId, 1000)

    const duplicateIntent = await runQueryResult(fixture.layer, { query: "Stale intent", clientRequestId: "req_stale_intent", ...acknowledged })
    const duplicateStreaming = await runQueryResult(fixture.layer, { query: "Stale stream", clientRequestId: "req_stale_stream", ...acknowledged })
    for (const duplicate of [duplicateIntent, duplicateStreaming]) {
      assert.equal(duplicate._tag, "Failure")
      if (duplicate._tag === "Failure") {
        assert.equal(duplicate.failure.code, "uncertain_write")
        assert.match(duplicate.failure.message, /state: uncertain/)
      }
    }

    const staleIntentRead = await journal.lookup(staleIntent.entry.operationId)
    const staleStreamingRead = await journal.lookup(staleStreaming.entry.operationId)
    const liveRead = await journal.lookup(liveStreaming.entry.operationId)
    const completedRead = await journal.lookup(completed.entry.operationId)
    const recent = await journal.listRecent(20)

    assert.equal(staleIntentRead.status, "uncertain")
    assert.equal(staleIntentRead.errorCode, "uncertain_write")
    assert.equal(staleStreamingRead.status, "uncertain")
    assert.equal(staleStreamingRead.answer, "Saved partial answer.")
    assert.equal(liveRead.status, "streaming")
    assert.equal(completedRead.status, "complete")
    assert.equal(completedRead.answer, "Keep this answer.")
    assert.deepEqual(completedRead.sourceRecordings, [{ recordingId: "rec_kept", title: "Kept source" }])
    assert.equal(recent.find((item) => item.operationId === staleIntent.entry.operationId)?.status, "uncertain")
    assert.equal(recent.find((item) => item.operationId === staleStreaming.entry.operationId)?.status, "uncertain")
    assert.equal(recent.find((item) => item.operationId === liveStreaming.entry.operationId)?.status, "streaming")
    assert.equal(recent.find((item) => item.operationId === completed.entry.operationId)?.status, "complete")
    assert.equal(calls, 0)

    const raw = JSON.parse(await readFile(join(fixture.dataDir, "meeting-queries", staleStreaming.entry.operationId + ".json"), "utf8")) as Record<string, unknown>
    assert.equal(raw.status, "streaming")
  } finally {
    await fixture.cleanup()
  }
})

test("a claimed clientRequestId with a missing journal record fails closed", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return response(`data: ${JSON.stringify({ type: "completed", fullText: "Result saved before recovery." })}\n\n`)
  }
  const fixture = await makeLayer(fetcher)
  const input = { query: "Recover from a missing record", clientRequestId: "req_missing_record", ...acknowledged }
  try {
    const first = await runQuery(fixture.layer, input)
    await unlink(join(fixture.dataDir, "meeting-queries", `${first.operationId}.json`))
    const replay = await runQueryResult(fixture.layer, input)

    assert.equal(replay._tag, "Failure")
    if (replay._tag === "Failure") {
      assert.equal(replay.failure.code, "uncertain_write")
      assert.match(replay.failure.message, /state: uncertain/)
      assert.ok(replay.failure.message.includes(first.operationId))
    }
    assert.equal(calls, 1)
  } finally {
    await fixture.cleanup()
  }
})

test("a claimed clientRequestId with a malformed journal record fails closed", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return response(`data: ${JSON.stringify({ type: "completed", fullText: "Result saved before corruption." })}\n\n`)
  }
  const fixture = await makeLayer(fetcher)
  const input = { query: "Recover from a malformed record", clientRequestId: "req_malformed_record", ...acknowledged }
  try {
    const first = await runQuery(fixture.layer, input)
    await writeFile(join(fixture.dataDir, "meeting-queries", `${first.operationId}.json`), "{ malformed", { mode: 0o600 })
    const replay = await runQueryResult(fixture.layer, input)

    assert.equal(replay._tag, "Failure")
    if (replay._tag === "Failure") {
      assert.equal(replay.failure.code, "uncertain_write")
      assert.match(replay.failure.message, /state: uncertain/)
      assert.ok(replay.failure.message.includes(first.operationId))
    }
    assert.equal(calls, 1)
  } finally {
    await fixture.cleanup()
  }
})

test("recent lookup returns bounded metadata without full answers", async () => {
  const fetcher: typeof fetch = async () => response(`data: ${JSON.stringify({ type: "completed", fullText: "Private full answer." })}\n\n`)
  const fixture = await makeLayer(fetcher)
  try {
    const result = await runQuery(fixture.layer, { query: "q".repeat(200), ...acknowledged })
    const recent = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.lookup({})
    }).pipe(Effect.provide(fixture.layer)))

    assert.ok("operations" in recent)
    if ("operations" in recent) {
      assert.equal(recent.operations.length, 1)
      assert.equal(recent.operations[0]?.operationId, result.operationId)
      assert.equal(recent.operations[0]?.queryPreview.length, 160)
      assert.equal("answer" in recent.operations[0]!, false)
      assert.equal("query" in recent.operations[0]!, false)
    }
  } finally {
    await fixture.cleanup()
  }
})

test("requires quota acknowledgement and validates query before creating an intent or posting", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return response(`data: ${JSON.stringify({ type: "completed", fullText: "unexpected" })}\n\n`)
  }
  const fixture = await makeLayer(fetcher)
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.query({ query: "   ", ...acknowledged }).pipe(Effect.result)
    }).pipe(Effect.provide(fixture.layer)))

    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.code, "validation")
    assert.equal(calls, 0)
  } finally {
    await fixture.cleanup()
  }
})

test("bounds total response bytes and records an uncertain partial outcome", async () => {
  const fetcher: typeof fetch = async () => response(`data: ${"x".repeat(1024 * 1024)}\n\n`, 512 * 1024)
  const fixture = await makeLayer(fetcher, { maxResponseBytes: 1024 * 1024 })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.query({ query: "Ask a question", ...acknowledged }).pipe(Effect.result)
    }).pipe(Effect.provide(fixture.layer)))

    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "uncertain_write")
      assert.match(result.failure.message, /response exceeded the 1 MiB limit/)
      const operationId = operationIdFrom(result.failure.message)
      assert.ok(operationId)
      const journal = await Effect.runPromise(Effect.gen(function*() {
        const meetingQuery = yield* MeetingQuery
        return yield* meetingQuery.lookup({ operationId: operationId! })
      }).pipe(Effect.provide(fixture.layer)))
      assert.equal("operation" in journal, true)
      if ("operation" in journal) assert.equal(journal.operation.status, "uncertain")
    }
  } finally {
    await fixture.cleanup()
  }
})

test("bounds event count and stream idle time", async () => {
  const eventLimitedFetcher: typeof fetch = async () => response([
    `data: ${JSON.stringify({ type: "future_event" })}\n\n`,
    `data: ${JSON.stringify({ type: "chunk", content: "partial" })}\n\n`
  ].join(""))
  const eventFixture = await makeLayer(eventLimitedFetcher, { maxEvents: 1 })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.query({ query: "Ask a question", ...acknowledged }).pipe(Effect.result)
    }).pipe(Effect.provide(eventFixture.layer)))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "uncertain_write")
      assert.match(result.failure.message, /event limit/)
    }
  } finally {
    await eventFixture.cleanup()
  }

  const idleFetcher: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`)) }
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
  const idleFixture = await makeLayer(idleFetcher, { idleTimeoutMs: 5 })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.query({ query: "Ask a question", ...acknowledged }).pipe(Effect.result)
    }).pipe(Effect.provide(idleFixture.layer)))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "uncertain_write")
      assert.match(result.failure.message, /stream was idle/)
    }
  } finally {
    await idleFixture.cleanup()
  }
})

test("bounds total request time and reports an uncertain outcome", async () => {
  const fetcher: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
  })
  const fixture = await makeLayer(fetcher, { timeoutMs: 5 })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const meetingQuery = yield* MeetingQuery
      return yield* meetingQuery.query({ query: "Ask a question", ...acknowledged }).pipe(Effect.result)
    }).pipe(Effect.provide(fixture.layer)))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "uncertain_write")
      assert.match(result.failure.message, /timed out/)
      assert.ok(operationIdFrom(result.failure.message))
    }
  } finally {
    await fixture.cleanup()
  }
})
