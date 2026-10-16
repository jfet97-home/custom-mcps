import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import { mkdir, lstat, realpath } from "node:fs/promises"
import { Config, Context, Effect, Layer, Schema } from "effect"

export class PocketError extends Schema.TaggedClass<PocketError>()("PocketError", {
  code: Schema.Literals(["authentication", "permission", "conflict", "validation", "network", "uncertain_write", "upstream", "storage", "configuration"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  backupId: Schema.optionalKey(Schema.String)
}) {}

export const failure = (code: PocketError["code"], message: string, status?: number) =>
  new PocketError({ code, message, ...(status === undefined ? {} : { status }) })

export const attempt = <A>(run: (signal: AbortSignal) => Promise<A>, code: PocketError["code"], message: string): Effect.Effect<A, PocketError> =>
  Effect.tryPromise({ try: run, catch: (e) => e instanceof PocketError ? e : failure(code, message) })

export const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown): A => {
  try { return Schema.decodeUnknownSync(schema)(value) }
  catch { throw failure("upstream", "Pocket returned an unsupported response shape; update the adapter before retrying.") }
}

export class Settings extends Context.Service<Settings, {
  readonly dataDir: string
  readonly port: number
  readonly host?: string
  readonly sourceRevision?: string
  readonly sessionLockDir?: string
}>()("pocket/Settings") {}

export const defaultDataDir = resolve(homedir(), "Library/Application Support/pocket-mcp")

export const SettingsLive = Layer.effect(Settings, Effect.gen(function*() {
  const values = yield* Config.all({
    dataDir: Config.withDefault(Config.String("POCKET_DATA_DIR"), defaultDataDir),
    port: Config.withDefault(Config.Int("POCKET_PORT"), 9011),
    host: Config.withDefault(Config.String("POCKET_HOST"), "127.0.0.1"),
    sessionLockDir: Config.withDefault(Config.String("POCKET_SESSION_LOCK_DIR"), ""),
    sourceRevision: Config.withDefault(Config.String("POCKET_SOURCE_REVISION"), "development")
  }).pipe(Effect.mapError(() => failure("configuration", "Invalid Pocket configuration.")))
  if (values.port < 1 || values.port > 65535) return yield* Effect.fail(failure("configuration", "POCKET_PORT must be a valid TCP port."))
  if (!["127.0.0.1", "0.0.0.0"].includes(values.host)) return yield* Effect.fail(failure("configuration", "POCKET_HOST must be 127.0.0.1 or 0.0.0.0."))
  return { ...values, dataDir: resolve(values.dataDir), sessionLockDir: resolve(values.sessionLockDir || values.dataDir) }
}))

export const privateDirectory = async (path: string): Promise<void> => {
  if (resolve(path) === homedir() || dirname(resolve(path)) === resolve(path)) throw failure("configuration", "Pocket private state needs its own directory outside Git.")
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw failure("storage", "Pocket private directories must be real directories.")
  if ((metadata.mode & 0o077) !== 0) throw failure("storage", "Pocket private directories must already have mode 0700 or stricter; choose a dedicated private directory.")
  let ancestor = await realpath(path)
  while (true) {
    const insideGit = await lstat(resolve(ancestor, ".git")).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (insideGit) throw failure("configuration", "Pocket private state and backups must stay outside Git checkouts.")
    if (dirname(ancestor) === ancestor) break
    ancestor = dirname(ancestor)
  }
}

export const APP_ORIGIN = "https://app.heypocket.com"
export const API_ORIGIN = "https://production.heypocketai.com"
