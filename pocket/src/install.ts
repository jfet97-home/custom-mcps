import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Settings, SettingsLive, attempt, failure, privateDirectory } from "./core.js"
import { contentHash } from "./backups.js"
import { ensureHttpToken } from "./http-auth.js"

const exec = promisify(execFile)
const label = "com.jfet97.pocket-mcp"
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const launchAgentPlist = (options: { node: string; entry: string; root: string; dataDir: string; port: number; revision?: string; sessionLockDir?: string }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(options.node)}</string><string>${xml(options.entry)}</string><string>serve</string></array>
<key>WorkingDirectory</key><string>${xml(options.root)}</string>
<key>EnvironmentVariables</key><dict><key>POCKET_DATA_DIR</key><string>${xml(options.dataDir)}</string><key>POCKET_PORT</key><string>${options.port}</string><key>POCKET_SESSION_LOCK_DIR</key><string>${xml(options.sessionLockDir ?? options.dataDir)}</string><key>POCKET_SOURCE_REVISION</key><string>${xml(options.revision ?? "development")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>120</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(options.dataDir, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.dataDir, "stderr.log"))}</string>
</dict></plist>
`

const treeHash = async (root: string): Promise<string> => {
  const hash = createHash("sha256")
  const visit = async (path: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      if (path === root && name === "release.json") continue
      const child = join(path, name)
      const metadata = await lstat(child)
      hash.update(`${relative(root, child)}\0`)
      if (metadata.isSymbolicLink()) {
        const target = await readlink(child)
        if (relative(root, resolve(dirname(child), target)).startsWith("..") || isAbsolute(target)) throw failure("configuration", "Release dependencies must not link outside their release directory.")
        hash.update(`link:${target}\0`)
      } else if (metadata.isDirectory()) { hash.update("directory\0"); await visit(child) }
      else if (metadata.isFile()) { hash.update("file\0"); hash.update(await readFile(child)); hash.update("\0") }
      else throw failure("configuration", "Release contains an unsupported filesystem entry.")
    }
  }
  await visit(root)
  return hash.digest("hex")
}
const seal = async (path: string): Promise<void> => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) return
  if (metadata.isDirectory()) for (const name of await readdir(path)) await seal(join(path, name))
  await chmod(path, metadata.isDirectory() || (metadata.mode & 0o111) !== 0 ? 0o500 : 0o400)
}

export const stageRelease = async (source: string, dataDir: string, revision: string): Promise<string> => {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw failure("configuration", "A committed source revision is required for deployment.")
  const releases = join(dataDir, "releases")
  await privateDirectory(releases)
  const target = join(releases, revision)
  if (await lstat(target).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e })) {
    const manifest = JSON.parse(await readFile(join(target, "release.json"), "utf8")) as { revision?: string; hash?: string }
    if (manifest.revision !== revision || manifest.hash !== await treeHash(target)) throw failure("configuration", "The installed release differs from its manifest. Preserve it for inspection and deploy a new commit.")
    return target
  }
  const staging = join(releases, `.staging-${randomUUID()}`)
  await privateDirectory(staging)
  try {
    for (const name of ["dist", "node_modules", "package.json", "package-lock.json"]) await cp(join(source, name), join(staging, name), { recursive: true, dereference: false, verbatimSymlinks: true })
    await writeFile(join(staging, "release.json"), JSON.stringify({ revision, hash: await treeHash(staging), lockfileHash: contentHash(await readFile(join(staging, "package-lock.json"), "utf8")), buildNodeVersion: process.version }), { mode: 0o600 })
    await rename(staging, target)
    await seal(target)
    return target
  } finally { await rm(staging, { recursive: true, force: true }) }
}

const program = Effect.gen(function*() {
  if (process.platform !== "darwin") return yield* Effect.fail(failure("configuration", "This installer targets macOS LaunchAgents. Use the documented stdio/HTTP command with an OS secret store on another system."))
  const settings = yield* Settings
  return yield* attempt(async () => {
    const source = fileURLToPath(new URL("../../", import.meta.url))
    const repository = resolve(source, "..")
    const status = await exec("git", ["status", "--porcelain", "--", "pocket"], { cwd: repository })
    if (status.stdout.trim()) throw failure("configuration", "Commit the Pocket source before installing the service.")
    const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim()
    const after = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim()
    if (after !== revision || (await exec("git", ["status", "--porcelain", "--", "pocket"], { cwd: repository })).stdout.trim()) throw failure("configuration", "Pocket source changed while preparing deployment.")
    await privateDirectory(settings.dataDir)
    await ensureHttpToken(settings.dataDir)
    const builds = join(settings.dataDir, "builds")
    await privateDirectory(builds)
    const build = join(builds, randomUUID())
    await privateDirectory(build)
    let root: string
    try {
      const archive = await exec("git", ["archive", "--format=tar", revision, "pocket"], { cwd: repository, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })
      const archivePath = join(build, "source.tar")
      await writeFile(archivePath, archive.stdout, { mode: 0o600 })
      await exec("/usr/bin/tar", ["-xf", archivePath, "-C", build])
      const exported = join(build, "pocket")
      const options = { cwd: exported, env: { ...process.env, npm_config_cache: join(build, "npm-cache"), npm_config_update_notifier: "false" }, maxBuffer: 4 * 1024 * 1024 }
      const lockHash = contentHash(await readFile(join(exported, "package-lock.json"), "utf8"))
      await exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], options)
      await exec("npm", ["run", "build"], options)
      await exec("npm", ["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], options)
      if (contentHash(await readFile(join(exported, "package-lock.json"), "utf8")) !== lockHash) throw failure("configuration", "The deployment build changed its lockfile.")
      await rm(join(exported, "dist", "test"), { recursive: true, force: true })
      root = await stageRelease(exported, settings.dataDir, revision)
    } finally { await rm(build, { recursive: true, force: true }) }
    const entry = join(root, "dist/src/cli.js")
    const node = process.env.POCKET_NODE_PATH ?? (await exec("/usr/bin/which", ["node"])).stdout.trim()
    if (!isAbsolute(node) || node.startsWith("/nix/store/") || !process.env.POCKET_NODE_PATH && /\/(?:\.nvm\/versions|fnm\/node-versions|asdf\/installs|mise\/installs)\//.test(node)) throw failure("configuration", "POCKET_NODE_PATH must name a stable absolute Node executable, rather than a collectible Nix store path.")
    const version = (await exec(node, ["--version"])).stdout.trim()
    if (Number(version.replace(/^v/, "").split(".")[0]) < 24) throw failure("configuration", "Pocket requires Node 24 or newer.")
    const agents = join(homedir(), "Library/LaunchAgents")
    await mkdir(agents, { recursive: true })
    const plist = join(agents, `${label}.plist`)
    for (const name of ["stdout.log", "stderr.log"]) await writeFile(join(settings.dataDir, name), "", { flag: "a", mode: 0o600 })
    const domain = `gui/${process.getuid!()}`
    const existing = await exec("launchctl", ["print", `${domain}/${label}`]).then((r) => r.stdout, () => "")
    if (existing) {
      const pid = Number(existing.match(/\bpid = (\d+)/)?.[1])
      await exec("launchctl", ["bootout", `${domain}/${label}`])
      const deadline = Date.now() + 125000
      const alive = () => { try { if (pid) process.kill(pid, 0); else return false; return true } catch { return false } }
      while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      if (alive()) throw failure("configuration", "The previous Pocket service has not exited. Deployment stopped before starting a second instance.")
    }
    await writeFile(plist, launchAgentPlist({ node, entry, root, dataDir: settings.dataDir, port: settings.port, revision, sessionLockDir: settings.sessionLockDir }), { mode: 0o600 })
    await exec("launchctl", ["bootstrap", domain, plist])
    let ready = false
    const readyDeadline = Date.now() + 60000
    while (Date.now() < readyDeadline) {
      ready = await fetch(`http://127.0.0.1:${settings.port}/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, readyDeadline - Date.now()))) }).then(async (r) => r.ok && (await r.json() as { revision?: string; sessionLockDir?: string }).revision === revision, () => false)
      if (ready) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ready) throw failure("configuration", "The replacement Pocket LaunchAgent is loaded but did not become ready within 60 seconds. Its previous wrapper/deployment record were retained. Inspect the private logs and launchctl state, then rerun the installer to reconcile.")
    const bin = join(homedir(), ".local/bin")
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, "pocket-mcp"), `#!/bin/sh\nexport POCKET_DATA_DIR=${quote(settings.dataDir)}\nexport POCKET_SESSION_LOCK_DIR=${quote(settings.sessionLockDir ?? settings.dataDir)}\nexec ${quote(node)} ${quote(entry)} "$@"\n`, { mode: 0o755 })
    await writeFile(join(settings.dataDir, "deployment.json"), JSON.stringify({ revision, root, node, installedAt: new Date().toISOString(), port: settings.port }), { mode: 0o600 })
    return { installed: true, label, revision, port: settings.port, command: join(bin, "pocket-mcp") }
  }, "configuration", "Could not install the Pocket LaunchAgent. Inspect launchctl state and the private service logs.")
})

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) NodeRuntime.runMain(program.pipe(
  Effect.provide(SettingsLive), Effect.match({
    onSuccess: (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    onFailure: (error) => { process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1 }
  })
), { disableErrorReporting: true })
