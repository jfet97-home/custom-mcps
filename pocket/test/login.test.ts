import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { cleanLoginProfiles, withLoginBrowser, type LoginBrowser } from "../src/login.js"
import { failure } from "../src/core.js"

test("dedicated browser profiles are fresh and cleaned on success, failure and interruption", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-login-test-"))
  const profiles: string[] = []
  try {
    for (const outcome of ["success", "failure", "interrupt"] as const) {
      let resource: LoginBrowser | undefined
      const login = withLoginBrowser({ dataDir, executable: process.execPath, extraArgs: ["-e", "setInterval(() => {}, 1000)", "--"] }, (browser) => {
        resource = browser; profiles.push(browser.profile)
        return outcome === "failure" ? Effect.fail(failure("authentication", "Cancelled login")) : outcome === "interrupt" ? Effect.never : Effect.succeed(true)
      })
      if (outcome === "interrupt") await Effect.runPromise(Effect.gen(function*() {
        const fiber = yield* login.pipe(Effect.forkChild)
        while (!resource) yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(fiber)
      }))
      else await Effect.runPromise(login.pipe(Effect.result))
      assert.ok(resource)
      await assert.rejects(stat(resource.profile), { code: "ENOENT" })
      assert.throws(() => process.kill(resource!.child.pid!, 0), { code: "ESRCH" })
    }
    assert.equal(new Set(profiles).size, 3)
    assert.deepEqual(await readdir(join(dataDir, "login-profiles")), [])
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})

test("a crashed login profile is swept only after its recorded process group is gone", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pocket-stale-login-"))
  try {
    const profile = join(dataDir, "login-profiles", "00000000-0000-0000-0000-000000000000")
    await mkdir(profile, { recursive: true, mode: 0o700 })
    await writeFile(join(profile, "pocket-login-process.json"), JSON.stringify({ pid: 2147483647 }), { mode: 0o600 })
    await cleanLoginProfiles(dataDir)
    await assert.rejects(stat(profile), { code: "ENOENT" })
  } finally { await rm(dataDir, { recursive: true, force: true }) }
})
