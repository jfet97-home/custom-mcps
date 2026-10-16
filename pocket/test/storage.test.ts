import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { authorized, ensureHttpToken, readHttpToken } from "../src/http-auth.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { Backups, BackupsLive } from "../src/backups.js"
import { Settings } from "../src/core.js"
import { makeFileSecretStorage, readSessionFile, saveSessionFile, sessionPath, withSessionLock } from "../src/secrets.js"
import { makeSessionLive, Session } from "../src/session.js"
import { SecretStorage } from "../src/secrets.js"

test("private backup content is recoverable with restrictive permissions outside the source tree", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-backups-test-"))
  try {
    const layer = BackupsLive.pipe(Layer.provide(Layer.succeed(Settings, { dataDir, port: 9011 })))
    const { backupId } = await Effect.runPromise(Backups.use((backups) => backups.save("notes", "recording-1", "Original private Notes", "summary-1")).pipe(Effect.provide(layer)))
    const path = join(dataDir, "backups", `${backupId}.json`)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(dataDir, "backups"))).mode & 0o777, 0o700)
    assert.equal(JSON.parse(await readFile(path, "utf8")).content, "Original private Notes")
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test("independent runtimes serialize the shared session lock without reading Keychain", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-lock-test-"))
  const trace: string[] = []
  try {
    const run = (name: string) => Effect.runPromise(withSessionLock(Effect.gen(function*() {
      trace.push(`${name}:start`); yield* Effect.sleep("30 millis"); trace.push(`${name}:end`)
    }), dataDir))
    await Promise.all([run("a"), run("b")])
    assert.equal(trace.length, 4)
    assert.ok(trace[0]?.endsWith(":start"))
    assert.equal(trace[1], trace[0]?.replace(":start", ":end"))
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test("separate processes serialize the renewable-session lock", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-cross-process-"))
  try {
    const run = (name: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./lock-worker.js", import.meta.url)), dataDir, name], { stdio: "pipe" })
      child.on("error", reject)
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock worker failed: ${code}`)))
    })
    await Promise.all([run("a"), run("b")])
    const trace = (await readFile(join(dataDir, "trace"), "utf8")).trim().split("\n")
    assert.equal(trace.length, 4)
    assert.equal(trace[1], trace[0]?.replace(":start", ":end"))
    assert.equal(trace[3], trace[2]?.replace(":start", ":end"))
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test("HTTP secret permissions and constant-time bearer validation fail closed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-http-auth-"))
  try {
    await ensureHttpToken(dataDir)
    const token = await readHttpToken(dataDir)
    assert.equal(authorized(undefined, token), false)
    assert.equal(authorized("Bearer invalid", token), false)
    assert.equal(authorized(`Bearer ${Redacted.value(token)}`, token), true)
    await chmod(join(dataDir, "http-token"), 0o644)
    await assert.rejects(readHttpToken(dataDir))
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test("file sessions persist rotated credentials across runtimes and running caches observe logout", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-file-session-"))
  const credential = { apiKey: "project-key", projectId: "test-project", userId: "user-1", email: "test@example.com", refreshToken: "original" }
  const token = `header.${Buffer.from(JSON.stringify({ aud: credential.projectId, iss: `https://securetoken.google.com/${credential.projectId}`, sub: credential.userId })).toString("base64url")}.signature`
  try {
    assert.equal(await readSessionFile(dataDir), null)
    await saveSessionFile(dataDir, Redacted.make(credential))
    assert.equal((await stat(sessionPath(dataDir))).mode & 0o777, 0o600)
    const secrets = makeFileSecretStorage(dataDir)
    const live = makeSessionLive(async () => Response.json({ id_token: token, refresh_token: "rotated", expires_in: "3600", user_id: credential.userId }))
      .pipe(Layer.provide(Layer.succeed(SecretStorage, secrets)))
    await Effect.runPromise(Effect.gen(function*() {
      const session = yield* Session
      yield* session.token
      const freshStore = makeFileSecretStorage(dataDir)
      const persisted = yield* freshStore.load
      assert.equal(persisted && Redacted.value(persisted).refreshToken, "rotated")
      yield* freshStore.withLock(freshStore.remove)
      assert.equal((yield* session.status).authenticated, false)
    }).pipe(Effect.provide(live)))
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test("file credentials reject public permissions and symlinks without replacing the target", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-file-permissions-"))
  const credential = Redacted.make({ apiKey: "key", projectId: "project", userId: "user", email: "test@example.com", refreshToken: "private-value" })
  try {
    await saveSessionFile(dataDir, credential)
    await chmod(sessionPath(dataDir), 0o644)
    await assert.rejects(readSessionFile(dataDir))
    await assert.rejects(saveSessionFile(dataDir, credential))
    await rm(sessionPath(dataDir))
    const target = join(dataDir, "unrelated")
    await writeFile(target, "untouched", { mode: 0o600 })
    await symlink(target, sessionPath(dataDir))
    await assert.rejects(readSessionFile(dataDir))
    await assert.rejects(saveSessionFile(dataDir, credential))
    assert.equal(await readFile(target, "utf8"), "untouched")
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})


test("the session lock completes under an uninterruptible caller", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-masked-lock-"))
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./lock-worker.js", import.meta.url)), dataDir, "masked", "masked"], { stdio: "ignore" })
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("uninterruptible lock race hung")) }, 3000)
      child.on("error", reject)
      child.on("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("lock worker failed")) })
    })
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test("losing a session lock fails safely without removing the replacement lock", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-lost-lock-"))
  let entered = false
  try {
    const running = Effect.runPromise(withSessionLock(Effect.gen(function*() { entered = true; yield* Effect.never }), dataDir).pipe(Effect.result))
    while (!entered) await new Promise((r) => setTimeout(r, 10))
    const lock = join(dataDir, "session.lock")
    await rm(lock, { recursive: true })
    await mkdir(lock)
    const changed = new Date(Date.now() + 5000)
    await utimes(lock, changed, changed)
    const result = await running
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.code, "storage")
    assert.equal((await stat(lock)).isDirectory(), true)
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})
