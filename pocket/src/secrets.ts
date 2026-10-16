import { constants } from "node:fs"
import { open, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
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

export const sessionPath = (directory: string) => join(directory, "firebase-session.json")

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

export const readSessionFile = async (directory: string): Promise<Redacted.Redacted<Credential> | null> => {
  await privateDirectory(directory)
  const handle = await open(sessionPath(directory), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!handle) return null
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16384 || (metadata.mode & 0o077) !== 0 || process.getuid && metadata.uid !== process.getuid()) {
      throw failure("storage", "The Pocket session must be an owned regular file with mode 0600 or stricter.")
    }
    return Redacted.make(decode(Credential, JSON.parse(await handle.readFile("utf8"))))
  } finally { await handle.close() }
}

export const saveSessionFile = async (directory: string, credential: Redacted.Redacted<Credential>): Promise<void> => {
  await privateDirectory(directory)
  // reject unsafe existing files before replacing a rotated credential
  await readSessionFile(directory)
  const temporary = join(directory, `.firebase-session-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(JSON.stringify(decode(Credential, Redacted.value(credential))))
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, sessionPath(directory))
    const parent = await open(directory, constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
  } finally { await unlink(temporary).catch((error) => { if (!missing(error)) throw error }) }
}

export const makeFileSecretStorage = (directory: string, lockDirectory = directory): typeof SecretStorage.Service => {
  return {
    load: attempt(() => readSessionFile(directory), "storage", "Cannot read the private Pocket session file."),
    save: (credential) => attempt(() => saveSessionFile(directory, credential), "storage", "Cannot save the private Pocket session file."),
    remove: attempt(async () => {
      await readSessionFile(directory)
      await unlink(sessionPath(directory)).catch((error) => { if (!missing(error)) throw error })
    }, "storage", "Cannot remove the private Pocket session file."),
    withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => withSessionLock(effect, lockDirectory)
  }
}

export const SecretStorageLive = Layer.effect(SecretStorage, Effect.gen(function*() {
  const settings = yield* Settings
  return makeFileSecretStorage(settings.dataDir, settings.sessionLockDir ?? settings.dataDir)
}))

export const migrateKeychainSession = Effect.gen(function*() {
  if (process.platform !== "darwin") return yield* Effect.fail(failure("configuration", "Keychain migration runs once on the Mac, outside Docker."))
  const secrets = yield* SecretStorage
  yield* secrets.withLock(Effect.gen(function*() {
    if (yield* secrets.load) return yield* Effect.fail(failure("conflict", "A file session already exists. Verify it with auth status instead of overwriting it."))
    const credential = yield* attempt(async () => {
      const { AsyncEntry } = await import("@napi-rs/keyring")
      const value = await new AsyncEntry("pocket-personal-mcp", "firebase-session").getPassword()
      if (value === null) throw failure("authentication", "No previous Pocket Keychain session exists. Run the browser login instead.")
      return Redacted.make(decode(Credential, JSON.parse(value)))
    }, "storage", "Cannot migrate the existing Pocket Keychain session.")
    yield* secrets.save(credential)
  }))
  return { migrated: true, storage: "private session file" }
})
