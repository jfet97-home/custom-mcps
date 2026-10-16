import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Settings, SettingsLive, attempt, failure, privateDirectory } from "./core.js"
import { ensureHttpToken } from "./http-auth.js"

const exec = promisify(execFile)

const program = Effect.gen(function*() {
  const settings = yield* Settings
  return yield* attempt(async () => {
    const source = fileURLToPath(new URL("../../", import.meta.url))
    const repository = resolve(source, "..")
    const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
    const clean = async () => {
      if ((await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim() !== revision ||
        (await exec("git", ["status", "--porcelain", "--", "pocket"], { cwd: repository })).stdout.trim()) {
        throw failure("configuration", "Commit the Pocket source before deploying; it changed or contains uncommitted files.")
      }
    }
    await clean()
    const context = process.env.POCKET_DOCKER_CONTEXT ?? "desktop-linux"
    const image = `pocket-personal-mcp:${revision}`
    const composeFile = join(source, "compose.yaml")
    const env = {
      ...process.env, POCKET_IMAGE: image, POCKET_DATA_DIR: settings.dataDir,
      POCKET_PORT: String(settings.port), LOCAL_UID: String(process.getuid?.() ?? 1000),
      LOCAL_GID: String(process.getgid?.() ?? 1000)
    }
    const options = { cwd: source, env, maxBuffer: 8 * 1024 * 1024 }
    const docker = (...args: string[]) => exec("docker", ["--context", context, ...args], options)
    const compose = (...args: string[]) => docker("compose", "-f", composeFile, ...args)
    await docker("info", "--format", "{{.ServerVersion}}")
    await compose("config", "--quiet")
    await ensureHttpToken(settings.dataDir)
    const build = await mkdtemp(join(tmpdir(), "pocket-docker-build-"))
    try {
      const archive = await exec("git", ["archive", "--format=tar", revision, "pocket"], { cwd: repository, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })
      const archivePath = join(build, "source.tar")
      await writeFile(archivePath, archive.stdout, { mode: 0o600 })
      await exec("tar", ["-xf", archivePath, "-C", build])
      await docker("build", "--build-arg", `POCKET_SOURCE_REVISION=${revision}`, "-t", image, join(build, "pocket"))
    } finally { await rm(build, { recursive: true, force: true }) }
    await clean()
    await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "60")
    const container = (await compose("ps", "-q", "pocket-mcp")).stdout.trim()
    const imageId = (await docker("inspect", "--format", "{{.Image}}", container)).stdout.trim()
    const response = await fetch(`http://127.0.0.1:${settings.port}/health`, { signal: AbortSignal.timeout(10000) })
    const health = await response.json() as { revision?: string }
    if (!response.ok || health.revision !== revision) throw failure("configuration", "The Docker service did not expose the expected committed revision.")
    await privateDirectory(settings.dataDir)
    const deployment = { runtime: "docker", revision, image, imageId, composeFile, context, port: settings.port, installedAt: new Date().toISOString() }
    await writeFile(join(settings.dataDir, "deployment.json"), JSON.stringify(deployment), { mode: 0o600 })
    return { installed: true, ...deployment }
  }, "configuration", "Could not deploy Pocket in Docker. Inspect Compose status and scoped container logs; no native fallback was installed.")
})

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) NodeRuntime.runMain(program.pipe(
  Effect.provide(SettingsLive), Effect.match({
    onSuccess: (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    onFailure: (error) => { process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1 }
  })
), { disableErrorReporting: true })
