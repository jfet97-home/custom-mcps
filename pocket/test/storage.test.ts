import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { authorized, ensureHttpToken, readHttpToken } from "../src/http-auth.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { Backups, BackupsLive } from "../src/backups.js"
import { Settings } from "../src/core.js"
import { withSessionLock } from "../src/secrets.js"
import { launchAgentPlist, stageRelease } from "../src/install.js"

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

test("LaunchAgent configuration escapes paths and contains no session or refresh-token fields", () => {
  const plist = launchAgentPlist({ node: "/node", entry: "/repo/a&b/cli.js", root: "/repo/a&b", dataDir: "/private/state", port: 9011 })
  assert.ok(plist.includes("a&amp;b"))
  assert.ok(!plist.includes("refreshToken"))
  assert.ok(plist.includes("<key>KeepAlive</key><true/>"))
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

test("versioned releases are independent of subsequent checkout edits and detect release tampering", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-release-test-"))
  const source = join(dataDir, "source")
  let root: string | undefined
  try {
    await mkdir(join(source, "dist"), { recursive: true })
    await mkdir(join(source, "node_modules"))
    await writeFile(join(source, "dist", "cli.js"), "original")
    await writeFile(join(source, "package.json"), "{}")
    await writeFile(join(source, "package-lock.json"), "{}")
    root = await stageRelease(source, dataDir, "a".repeat(40))
    await writeFile(join(source, "dist", "cli.js"), "later edit")
    assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "original")
    assert.equal(await stageRelease(source, dataDir, "a".repeat(40)), root)
    await chmod(join(root, "dist", "cli.js"), 0o600)
    await writeFile(join(root, "dist", "cli.js"), "tampered")
    await assert.rejects(stageRelease(source, dataDir, "a".repeat(40)))
  } finally {
    if (root) for (const path of [root, join(root, "dist"), join(root, "node_modules")]) await chmod(path, 0o700)
    await rm(dataDir, { recursive: true, force: true })
  }
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
