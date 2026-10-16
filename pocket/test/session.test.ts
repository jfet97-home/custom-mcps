import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, Redacted } from "effect"
import { makeSessionLive, refreshCredential, Session } from "../src/session.js"
import { SecretStorage, type Credential } from "../src/secrets.js"

const credential = { apiKey: "public-project-key", projectId: "pocket-project", userId: "user-1", email: "test@example.com", refreshToken: "refresh-1" }
const idToken = `header.${Buffer.from(JSON.stringify({ aud: "pocket-project", iss: "https://securetoken.google.com/pocket-project", sub: "user-1" })).toString("base64url")}.signature`

test("Firebase renewal sends form data and accepts a rotated refresh token", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, "securetoken.googleapis.com")
    assert.equal(init?.redirect, "error")
    assert.equal(String(init?.body), "grant_type=refresh_token&refresh_token=refresh-1")
    return Response.json({ id_token: idToken, refresh_token: "refresh-2", expires_in: "3600", user_id: "user-1", project_id: "123456789" })
  }
  const result = await Effect.runPromise(refreshCredential(credential, fetcher))
  assert.equal(Redacted.value(result.credential).refreshToken, "refresh-2")
  assert.equal(Redacted.value(result.token), idToken)
  assert.ok(result.expiresAt > Date.now() + 3500000)
})

test("concurrent calls share renewal, persist rotation, and observe logout immediately", async () => {
  let stored: Redacted.Redacted<Credential> | null = Redacted.make(credential)
  let renewals = 0
  let locks = 0
  const secrets = Layer.succeed(SecretStorage, {
    load: Effect.sync(() => stored),
    save: (value) => Effect.sync(() => { stored = value }),
    remove: Effect.sync(() => { stored = null }),
    withLock: (effect) => Effect.suspend(() => { locks++; return effect })
  })
  const live = makeSessionLive(async () => {
    renewals++
    await new Promise((r) => setTimeout(r, 10))
    return Response.json({ id_token: idToken, refresh_token: "rotated", expires_in: "3600", user_id: "user-1" })
  }).pipe(Layer.provideMerge(secrets))
  await Effect.runPromise(Effect.gen(function*() {
    const session = yield* Session
    const tokens = yield* Effect.all(Array.from({ length: 20 }, () => session.token), { concurrency: "unbounded" })
    assert.equal(tokens.length, 20)
    assert.equal(renewals, 1)
    assert.equal(locks, 1)
    assert.equal(stored && Redacted.value(stored).refreshToken, "rotated")
    yield* (yield* SecretStorage).remove
    const result = yield* session.token.pipe(Effect.result)
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.code, "authentication")
  }).pipe(Effect.provide(live)))
})

test("renewal rejects revoked sessions and account substitution without exposing tokens", async () => {
  for (const response of [Response.json({ error: "secret payload" }, { status: 400 }), Response.json({ id_token: "secret-id", refresh_token: "secret-refresh", expires_in: "3600", user_id: "other-user" })]) {
    const result = await Effect.runPromise(refreshCredential(credential, async () => response).pipe(Effect.result))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "authentication")
      assert.ok(!JSON.stringify(result.failure).includes("secret"))
    }
  }
})
