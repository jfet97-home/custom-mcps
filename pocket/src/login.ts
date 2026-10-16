import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:net"
import { join } from "node:path"
import { lstat, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises"
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

export interface LoginBrowser { readonly profile: string; readonly port: number; readonly child: ChildProcess }

const groupAlive = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error }
}
const stopBrowser = async ({ child, profile }: LoginBrowser): Promise<void> => {
  const pid = child.pid
  if (pid) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (!groupAlive(pid)) break
      try { process.kill(-pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
      const deadline = Date.now() + 5000
      while (groupAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    }
    if (groupAlive(pid)) throw failure("storage", "The dedicated login browser did not exit. Its private profile was retained for safe cleanup.")
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}

export const cleanLoginProfiles = async (dataDir: string): Promise<void> => {
  const parent = join(dataDir, "login-profiles")
  await privateDirectory(parent)
  for (const name of await readdir(parent)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue
    const profile = join(parent, name)
    await privateDirectory(profile)
    const marker = await readFile(join(profile, "pocket-login-process.json"), "utf8").then((s) => JSON.parse(s) as { pid?: unknown }, () => null)
    if (!marker || typeof marker.pid !== "number" || !Number.isInteger(marker.pid) || marker.pid < 1) throw failure("storage", `A Pocket login profile has no reliable process marker. Close its dedicated window and inspect ${profile} before removing it.`)
    if (groupAlive(marker.pid)) throw failure("authentication", `A previous dedicated Pocket login browser is still running. Close that window, then run login again. Profile: ${profile}`)
    await rm(profile, { recursive: true, force: true })
  }
  const legacy = join(dataDir, "browser-profile")
  if (await lstat(legacy).then(() => true, () => false)) {
    await privateDirectory(legacy)
    const lock = await readlink(join(legacy, "SingletonLock")).catch(() => "")
    const pid = Number(lock.match(/-(\d+)$/)?.[1])
    if (pid) {
      let alive = false
      try { process.kill(pid, 0); alive = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
      if (alive) throw failure("authentication", `Close the legacy dedicated Pocket browser before login. Profile: ${legacy}`)
    }
    await rm(legacy, { recursive: true, force: true })
  }
}

export const withLoginBrowser = <A, E, R>(options: { dataDir: string; executable: string; extraArgs?: string[] }, use: (resource: LoginBrowser) => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(
  attempt(async () => {
    await cleanLoginProfiles(options.dataDir)
    const parent = join(options.dataDir, "login-profiles")
    await privateDirectory(parent)
    const profile = join(parent, randomUUID())
    await privateDirectory(profile)
    try {
      const port = await freePort()
      const child = spawn(options.executable, [
        ...(options.extraArgs ?? []), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", APP_ORIGIN
      ], { stdio: "ignore", detached: true })
      await once(child, "spawn")
      const resource = { profile, port, child }
      try { await writeFile(join(profile, "pocket-login-process.json"), JSON.stringify({ pid: child.pid }), { mode: 0o600, flag: "wx" }) }
      catch (error) { await stopBrowser(resource); throw error }
      return resource
    } catch (error) { await rm(profile, { recursive: true, force: true }); throw error }
  }, "configuration", "Chrome could not start. Set POCKET_CHROME_PATH to a normal Chrome executable."),
  use,
  (resource) => attempt(() => stopBrowser(resource), "storage", "Could not remove the dedicated Pocket login browser profile.").pipe(Effect.tapError(() => Effect.sync(() => { process.stderr.write(`Close the dedicated Pocket browser and inspect its retained private profile: ${resource.profile}\n`) })), Effect.orDie)
)

export const login = Effect.gen(function*() {
  const settings = yield* Settings
  const secrets = yield* SecretStorage
  const credential = yield* withLoginBrowser({ dataDir: settings.dataDir,
    executable: process.env.POCKET_CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome")
  }, ({ child, port }) => attempt(async (signal) => {
    process.stderr.write("Complete your normal Pocket login in the dedicated Chrome window. Waiting for Firebase session…\n")
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
    try {
      const deadline = Date.now() + 15 * 60 * 1000
      while (Date.now() < deadline && !signal.aborted) {
        if (child.exitCode !== null || child.signalCode !== null) throw failure("authentication", "The dedicated Pocket login window was closed. Run pocket-mcp login again.")
        if (!browser) {
          try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 }) }
          catch { await new Promise((r) => setTimeout(r, 1000)); continue }
        }
        const pages = browser.contexts().flatMap((c) => c.pages())
        if (pages.length === 0) throw failure("authentication", "The dedicated Pocket login window was closed. Run pocket-mcp login again.")
        for (const page of pages) {
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
    }
  }, "authentication", "Could not complete Pocket browser login. Run pocket-mcp login again."))
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
    const identity = decode(Schema.Struct({ id: Schema.NonEmptyString, email: Schema.String }), body)
    if (identity.id !== Redacted.value(renewed.credential).userId || identity.email.toLowerCase() !== Redacted.value(renewed.credential).email.toLowerCase()) throw failure("authentication", "Pocket returned a different account identity. The login was not saved.")
    }, "network", "Could not verify the authenticated Pocket account.")
    yield* secrets.save(renewed.credential)
    return renewed
  }))
  const value = Redacted.value(renewed.credential)
  return { authenticated: true, userId: value.userId, email: value.email, storage: "private session file" }
})
