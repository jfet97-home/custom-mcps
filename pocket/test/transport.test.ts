import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, Redacted } from "effect"
import { Session } from "../src/session.js"
import { makePocketTransportLive, PocketTransport } from "../src/transport.js"

test("reads retry once, uncertain writes never retry, and responses do not leak upstream errors", async () => {
  for (const method of ["GET", "PATCH"] as const) {
    let calls = 0
    const layer = makePocketTransportLive(async (_url, init) => {
      calls++
      assert.equal(init?.redirect, "error")
      return Response.json({ error: "private token and upstream body" }, { status: 503 })
    }).pipe(Layer.provide(Layer.succeed(Session, { token: Effect.succeed(Redacted.make("test-token")), invalidate: Effect.void, status: Effect.succeed({ authenticated: true }) })))
    await Effect.runPromise(Effect.gen(function*() {
      const result = yield* (yield* PocketTransport).request(method, "/api/v1/recordings/test").pipe(Effect.result)
      assert.equal(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, method === "GET" ? "upstream" : "uncertain_write")
        assert.ok(!JSON.stringify(result.failure).includes("private"))
      }
      assert.equal(calls, method === "GET" ? 2 : 1)
    }).pipe(Effect.provide(layer)))
  }
})
