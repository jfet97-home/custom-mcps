import { randomBytes, timingSafeEqual } from "node:crypto"
import { lstat, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer, Redacted } from "effect"
import { Settings, attempt, failure, privateDirectory } from "./core.js"

export const httpTokenPath = (dataDir: string) => join(dataDir, "http-token")
export const readHttpToken = async (dataDir: string): Promise<Redacted.Redacted<string>> => {
  const path = httpTokenPath(dataDir)
  const metadata = await lstat(path)
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || process.getuid && metadata.uid !== process.getuid()) throw failure("storage", "The Pocket HTTP secret must be an owned regular file with mode 0600 or stricter.")
  const value = (await readFile(path, "utf8")).trim()
  if (!/^[a-f0-9]{64}$/.test(value)) throw failure("storage", "The Pocket HTTP secret has an invalid format.")
  return Redacted.make(value)
}
export const ensureHttpToken = async (dataDir: string): Promise<void> => {
  await privateDirectory(dataDir)
  try { await lstat(httpTokenPath(dataDir)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await writeFile(httpTokenPath(dataDir), randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" })
  }
  await readHttpToken(dataDir)
}
export const authorized = (header: string | undefined, token: Redacted.Redacted<string>): boolean => {
  const expected = Buffer.from(`Bearer ${Redacted.value(token)}`)
  const actual = Buffer.from(header ?? "")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
export class HttpAuthorization extends Context.Service<HttpAuthorization, { readonly token: Redacted.Redacted<string> }>()("pocket/HttpAuthorization") {}
export const HttpAuthorizationLive = Layer.effect(HttpAuthorization, Effect.gen(function*() {
  const settings = yield* Settings
  const token = yield* attempt(() => readHttpToken(settings.dataDir), "configuration", "The Pocket HTTP secret is missing or inaccessible. Run install-service before starting HTTP.")
  return { token }
}))
