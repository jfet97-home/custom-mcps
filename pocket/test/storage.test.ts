import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Backups, BackupsLive } from "../src/backups.js"
import { Settings } from "../src/core.js"
import { SecretStorage, SecretStorageLive } from "../src/secrets.js"
import { launchAgentPlist } from "../src/install.js"

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
    const runtime = () => SecretStorageLive.pipe(Layer.provide(Layer.succeed(Settings, { dataDir, port: 9011 })))
    const run = (name: string) => Effect.runPromise(SecretStorage.use((secrets) => secrets.withLock(Effect.gen(function*() {
      trace.push(`${name}:start`); yield* Effect.sleep("30 millis"); trace.push(`${name}:end`)
    }))).pipe(Effect.provide(runtime())))
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
