import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { join } from "node:path"
import { rm } from "node:fs/promises"
import { chromium } from "playwright"
import { Effect, Redacted, Schema } from "effect"
import { API_ORIGIN, APP_ORIGIN, Settings, attempt, decode, failure, privateDirectory } from "./core.js"
import { Credential, SecretStorage } from "./secrets.js"
import { refreshCredential } from "./session.js"

const FirebaseUser = Schema.Struct({
  uid: Schema.NonEmptyString,
  email: Schema.optional(Schema.String),
  apiKey: Schema.NonEmptyString,
  stsTokenManager: Schema.Struct({ refreshToken: Schema.NonEmptyString })
})

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") { server.close(); reject(failure("configuration", "Could not allocate the login browser port.")); return }
    server.close(() => resolve(address.port))
  })
})

export const login = Effect.gen(function*() {
  const settings = yield* Settings
  const secrets = yield* SecretStorage
  const credential = yield* attempt(async (signal) => {
    const profile = join(settings.dataDir, "browser-profile")
    await privateDirectory(profile)
    const port = await freePort()
    const executable = process.env.POCKET_CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome")
    const child = spawn(executable, [
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", APP_ORIGIN
    ], { stdio: "ignore" })
    let spawnFailed = false
    child.once("error", () => { spawnFailed = true })
    process.stderr.write("Complete your normal Pocket login in the dedicated Chrome window. Waiting for Firebase session…\n")
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
    try {
      const deadline = Date.now() + 15 * 60 * 1000
      while (Date.now() < deadline && !signal.aborted) {
        if (spawnFailed) throw failure("configuration", "Chrome could not start. Set POCKET_CHROME_PATH to a normal Chrome executable.")
        if (!browser) {
          try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }) }
          catch { await new Promise((r) => setTimeout(r, 1000)); continue }
        }
        for (const page of browser.contexts().flatMap((c) => c.pages())) {
          if (new URL(page.url()).origin !== APP_ORIGIN) continue
          const value: unknown = await page.evaluate(async () => {
            const databases = await indexedDB.databases()
            if (databases.some((db) => db.name === "firebaseLocalStorageDb")) {
              const rows = await new Promise<unknown[]>((resolve, reject) => {
                const request = indexedDB.open("firebaseLocalStorageDb")
                request.onerror = () => reject(new Error("cannot open Firebase persistence"))
                request.onsuccess = () => {
                  const db = request.result
                  if (!db.objectStoreNames.contains("firebaseLocalStorage")) { db.close(); resolve([]); return }
                  const read = db.transaction("firebaseLocalStorage", "readonly").objectStore("firebaseLocalStorage").getAll()
                  read.onsuccess = () => { db.close(); resolve(read.result) }
                  read.onerror = () => { db.close(); reject(new Error("cannot read Firebase persistence")) }
                }
              })
              for (const row of rows) {
                if (typeof row === "object" && row !== null && "fbase_key" in row && typeof row.fbase_key === "string" && row.fbase_key.startsWith("firebase:authUser:") && "value" in row) return row.value
              }
            }
            for (const key of Object.keys(localStorage)) {
              if (key.startsWith("firebase:authUser:")) return JSON.parse(localStorage.getItem(key)!) as unknown
            }
            return null
          }).catch(() => null)
          if (!value) continue
          const user = decode(FirebaseUser, value)
          // discover and verify the Firebase project configuration from the current public client
          const html = await fetch(APP_ORIGIN, { signal: AbortSignal.timeout(20000) }).then((r) => r.text())
          const asset = html.match(/src="([^\"]*\/assets\/main-[^\"]+\.js)"/)?.[1]
          if (!asset) throw failure("authentication", "Cannot identify Pocket's current Firebase configuration.")
          const assetUrl = new URL(asset, APP_ORIGIN)
          if (assetUrl.origin !== APP_ORIGIN) throw failure("authentication", "Pocket's client asset origin changed.")
          const source = await fetch(assetUrl, { signal: AbortSignal.timeout(20000) }).then((r) => r.text())
          const configs = [...source.matchAll(/apiKey:"([^\"]+)",authDomain:"([^\"]+)",projectId:"([^\"]+)"/g)]
          const config = configs.find((m) => m[1] === user.apiKey)
          if (!config?.[3]) throw failure("authentication", "The Firebase login does not match Pocket's current project.")
          const result = decode(Credential, { apiKey: user.apiKey, projectId: config[3], userId: user.uid, email: user.email ?? "", refreshToken: user.stsTokenManager.refreshToken })
          return Redacted.make(result)
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
      throw failure("authentication", "Pocket login timed out or was cancelled. Run pocket-mcp login again.")
    } finally {
      await browser?.close().catch(() => undefined)
      child.kill("SIGTERM")
    }
  }, "authentication", "Could not complete Pocket browser login. Run pocket-mcp login again.")
  const renewed = yield* secrets.withLock(Effect.gen(function*() {
    const renewed = yield* refreshCredential(Redacted.value(credential))
    yield* attempt(async (signal) => {
    const response = await fetch(`${API_ORIGIN}/api/v1/users/current/profile`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), redirect: "error",
      headers: { authorization: `Bearer ${Redacted.value(renewed.token)}` }
    })
    if (!response.ok) throw failure("authentication", "Firebase login succeeded, but Pocket did not accept this account.", response.status)
    // inspect only the identity fields and never print the upstream profile or token
    const body = await response.json() as unknown
    if (typeof body !== "object" || body === null) throw failure("authentication", "Pocket returned an invalid profile.")
    }, "network", "Could not verify the authenticated Pocket account.")
    yield* secrets.save(renewed.credential)
    return renewed
  }))
  // the browser is only a bootstrap; remove its duplicate persistent credential after export
  yield* attempt(() => rm(join(settings.dataDir, "browser-profile"), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }), "storage", "Login saved, but the dedicated browser profile could not be removed.")
  const value = Redacted.value(renewed.credential)
  return { authenticated: true, userId: value.userId, email: value.email, storage: process.platform === "darwin" ? "macOS Keychain" : "OS credential store" }
})
