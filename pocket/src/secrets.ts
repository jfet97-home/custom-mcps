import { AsyncEntry } from "@napi-rs/keyring"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import lockfile from "proper-lockfile"
import { Settings, attempt, decode, defaultDataDir, failure, privateDirectory, type PocketError } from "./core.js"

export const Credential = Schema.Struct({
  apiKey: Schema.NonEmptyString,
  projectId: Schema.NonEmptyString,
  userId: Schema.NonEmptyString,
  email: Schema.String,
  refreshToken: Schema.NonEmptyString
})
export type Credential = typeof Credential.Type

export class SecretStorage extends Context.Service<SecretStorage, {
  readonly load: Effect.Effect<Redacted.Redacted<Credential> | null, PocketError>
  readonly save: (credential: Redacted.Redacted<Credential>) => Effect.Effect<void, PocketError>
  readonly remove: Effect.Effect<void, PocketError>
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | PocketError, R>
}>()("pocket/SecretStorage") {}

export const withSessionLock = <A, E, R>(effect: Effect.Effect<A, E, R>, directory = defaultDataDir): Effect.Effect<A, E | PocketError, R> => Effect.suspend(() => {
  let compromised = false
  let report: (() => void) | undefined
  const lost = Effect.callback<never, PocketError>((resume) => {
    report = () => resume(Effect.fail(failure("storage", "The Pocket session lock was lost. Retry after the other session operation finishes.")))
    if (compromised) report()
    return Effect.sync(() => { report = undefined })
  })
  const acquire = attempt(async () => {
    await privateDirectory(directory)
    return lockfile.lock(directory, {
      lockfilePath: `${directory}/session.lock`, stale: 30000, update: 10000,
      retries: { retries: 200, factor: 1, minTimeout: 250, maxTimeout: 250 },
      onCompromised: () => { compromised = true; report?.() }
    })
  }, "storage", "Could not acquire the Pocket session lock. Another login or renewal may still be running.")
  return Effect.acquireUseRelease(acquire, () => Effect.raceFirst(effect, lost),
    (release) => Effect.promise(() => release()).pipe(Effect.catchCause(() => Effect.void)))
})

export const SecretStorageLive = Layer.effect(SecretStorage, Effect.gen(function*() {
  const settings = yield* Settings
  const entry = new AsyncEntry("pocket-personal-mcp", "firebase-session")
  return {
    load: attempt(async () => {
      const value = await entry.getPassword()
      return value === null ? null : Redacted.make(decode(Credential, JSON.parse(value)))
    }, "storage", "Cannot read the Pocket session from the operating system credential store."),
    save: (credential) => attempt(() => entry.setPassword(JSON.stringify(Redacted.value(credential))), "storage", "Cannot save the Pocket session in the operating system credential store."),
    remove: attempt(async () => { await entry.deleteCredential() }, "storage", "Cannot remove the Pocket session from the operating system credential store."),
    withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => withSessionLock(effect, settings.sessionLockDir ?? defaultDataDir)
  }
}))
