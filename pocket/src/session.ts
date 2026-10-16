import { Context, Effect, Layer, Redacted, Schema, Semaphore } from "effect"
import { APP_ORIGIN, attempt, decode, failure, type PocketError } from "./core.js"
import { Credential, SecretStorage } from "./secrets.js"

const TokenResponse = Schema.Struct({
  id_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.String,
  user_id: Schema.NonEmptyString,
  project_id: Schema.optional(Schema.String)
})

export const refreshCredential = (credential: Credential, fetcher = globalThis.fetch) => attempt(async (signal) => {
  const response = await fetcher(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(credential.apiKey)}`, {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    headers: { "content-type": "application/x-www-form-urlencoded", referer: `${APP_ORIGIN}/` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refreshToken })
  })
  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) throw failure("authentication", "Pocket login expired or was revoked. Run pocket-mcp login again.", response.status)
    throw failure("network", "Firebase session renewal is temporarily unavailable.", response.status)
  }
  const token = decode(TokenResponse, await response.json())
  const expires = Number(token.expires_in)
  if (!Number.isFinite(expires) || expires < 60) throw failure("authentication", "Firebase returned an invalid token lifetime.")
  if (token.user_id !== credential.userId) throw failure("authentication", "Firebase renewed a different account; run pocket-mcp login again.")
  // securetoken's project_id can be the numeric project number; verify the token's project claims instead
  let claims: unknown
  try { claims = JSON.parse(Buffer.from(token.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) }
  catch { throw failure("authentication", "Firebase returned an invalid ID token.") }
  const identity = decode(Schema.Struct({ aud: Schema.String, iss: Schema.String, sub: Schema.String }), claims)
  if (identity.aud !== credential.projectId || identity.iss !== `https://securetoken.google.com/${credential.projectId}` || identity.sub !== credential.userId) {
    throw failure("authentication", "Firebase returned a token for a different Pocket project or account.")
  }
  return {
    token: Redacted.make(token.id_token), expiresAt: Date.now() + expires * 1000,
    credential: Redacted.make({ ...credential, refreshToken: token.refresh_token })
  }
}, "network", "Could not renew the Pocket session. Try again when the network is available.")

export class Session extends Context.Service<Session, {
  readonly token: Effect.Effect<Redacted.Redacted<string>, PocketError>
  readonly status: Effect.Effect<{ authenticated: boolean; userId?: string; email?: string; expiresAt?: string }, PocketError>
  readonly invalidate: Effect.Effect<void>
}>()("pocket/Session") {}

export const makeSessionLive = (fetcher = globalThis.fetch) => Layer.effect(Session, Effect.gen(function*() {
  const secrets = yield* SecretStorage
  const lock = yield* Semaphore.make(1)
  let current: { token: Redacted.Redacted<string>; expiresAt: number; credential: Redacted.Redacted<Credential> } | undefined
  const matches = (stored: Redacted.Redacted<Credential>) => current && current.expiresAt - Date.now() > 120000 &&
    Redacted.value(current.credential).userId === Redacted.value(stored).userId &&
    Redacted.value(current.credential).refreshToken === Redacted.value(stored).refreshToken
  const ensureSession = lock.withPermit(Effect.gen(function*() {
    const stored = yield* secrets.load
    if (!stored) { current = undefined; return yield* Effect.fail(failure("authentication", "Pocket is not signed in. Run pocket-mcp login.")) }
    if (matches(stored)) return current!
    return yield* secrets.withLock(Effect.gen(function*() {
      const latest = yield* secrets.load
      if (!latest) { current = undefined; return yield* Effect.fail(failure("authentication", "Pocket is not signed in. Run pocket-mcp login.")) }
      if (matches(latest)) return current!
      const renewed = yield* refreshCredential(Redacted.value(latest), fetcher)
      yield* secrets.save(renewed.credential)
      current = renewed
      return renewed
    }))
  }))
  return {
    token: ensureSession.pipe(Effect.map((current) => current.token)),
    status: Effect.gen(function*() {
      const session = yield* ensureSession
      const value = Redacted.value(session.credential)
      return { authenticated: true, userId: value.userId, email: value.email, expiresAt: new Date(session.expiresAt).toISOString() }
    }).pipe(Effect.catch((error) => error.code === "authentication" ? Effect.succeed({ authenticated: false }) : Effect.fail(error))),
    invalidate: Effect.sync(() => { current = undefined })
  }
}))

export const SessionLive = makeSessionLive()
