import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Settings, SettingsLive, attempt, failure, privateDirectory } from "./core.js"

const exec = promisify(execFile)
const label = "com.jfet97.pocket-mcp"
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const launchAgentPlist = (options: { node: string; entry: string; root: string; dataDir: string; port: number }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(options.node)}</string><string>${xml(options.entry)}</string><string>serve</string></array>
<key>WorkingDirectory</key><string>${xml(options.root)}</string>
<key>EnvironmentVariables</key><dict><key>POCKET_DATA_DIR</key><string>${xml(options.dataDir)}</string><key>POCKET_PORT</key><string>${options.port}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(options.dataDir, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.dataDir, "stderr.log"))}</string>
</dict></plist>
`

const program = Effect.gen(function*() {
  if (process.platform !== "darwin") return yield* Effect.fail(failure("configuration", "This installer targets macOS LaunchAgents. Use the documented stdio/HTTP command with an OS secret store on another system."))
  const settings = yield* Settings
  return yield* attempt(async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const repository = resolve(root, "..")
    const status = await exec("git", ["status", "--porcelain", "--", "pocket", "README.md"], { cwd: repository })
    if (status.stdout.trim()) throw failure("configuration", "Commit the Pocket source before installing the service.")
    const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim()
    const entry = join(root, "dist/src/cli.js")
    await readFile(entry)
    await privateDirectory(settings.dataDir)
    const agents = join(homedir(), "Library/LaunchAgents")
    await mkdir(agents, { recursive: true })
    const plist = join(agents, `${label}.plist`)
    await writeFile(plist, launchAgentPlist({ node: process.execPath, entry, root, dataDir: settings.dataDir, port: settings.port }), { mode: 0o600 })
    for (const name of ["stdout.log", "stderr.log"]) await writeFile(join(settings.dataDir, name), "", { flag: "a", mode: 0o600 })
    await writeFile(join(settings.dataDir, "deployment.json"), JSON.stringify({ revision, installedAt: new Date().toISOString(), port: settings.port }), { mode: 0o600 })
    const bin = join(homedir(), ".local/bin")
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, "pocket-mcp"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`, { mode: 0o755 })
    const domain = `gui/${process.getuid!()}`
    const running = await exec("launchctl", ["print", `${domain}/${label}`]).then(() => true, () => false)
    if (running) await exec("launchctl", ["bootout", `${domain}/${label}`])
    await exec("launchctl", ["bootstrap", domain, plist])
    return { installed: true, label, revision, port: settings.port, command: join(bin, "pocket-mcp") }
  }, "configuration", "Could not install the Pocket LaunchAgent. Inspect launchctl state and the private service logs.")
})

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) NodeRuntime.runMain(program.pipe(
  Effect.provide(SettingsLive), Effect.match({
    onSuccess: (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    onFailure: (error) => { process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1 }
  })
), { disableErrorReporting: true })
