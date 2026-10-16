import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const context = process.env.POCKET_DOCKER_CONTEXT
const docker = (...args) => exec("docker", [...(context ? ["--context", context] : []), ...args], { timeout: 60000, maxBuffer: 1024 * 1024 })
const directory = await mkdtemp(join(tmpdir(), "pocket-container-check-"))
const name = `pocket-check-${randomUUID()}`
let created = false
try {
  await writeFile(join(directory, "http-token"), "1".repeat(64), { mode: 0o600 })
  created = true
  await docker("run", "-d", "--name", name, "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=bind,source=${directory},target=/data`,
    "-p", "127.0.0.1::9011", process.argv[2] ?? "pocket-personal-mcp:check")
  const state = JSON.parse((await docker("inspect", name)).stdout)[0]
  const port = state.NetworkSettings.Ports["9011/tcp"][0].HostPort
  const url = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(ready, true, "container HTTP did not become ready")
  const auth = await docker("exec", name, "node", "dist/src/cli.js", "auth", "status")
  assert.deepEqual(JSON.parse(auth.stdout), { authenticated: false })
  const missing = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  assert.equal(missing.status, 401)
  const ui = await fetch(`${url}/archive/`)
  assert.equal(ui.status, 200)
  assert.ok(ui.headers.get("content-security-policy").includes("frame-ancestors 'none'"))
  assert.ok((await ui.text()).includes("Pocket local archive"))
  const bundle = await fetch(`${url}/archive/assets/archive-ui.js`)
  assert.equal(bundle.status, 200)
  assert.ok((await bundle.text()).length > 1000)
  assert.equal((await fetch(`${url}/archive/api/recordings`, { headers: { "x-pocket-ui": "1" } })).status, 401)
  const fileCheck = await docker("exec", name, "node", "--input-type=module", "-e", `
    import { Redacted } from 'effect';
    import { writeFileSync, linkSync, readFileSync, unlinkSync } from 'node:fs';
    import { readSessionFile, saveSessionFile } from './dist/src/secrets.js';
    const original = '/data/.query-journal-link-probe';
    const linked = original + '-linked';
    try {
      writeFileSync(original, 'fixture', { mode: 0o600, flag: 'wx' });
      linkSync(original, linked);
      if (readFileSync(linked, 'utf8') !== 'fixture') process.exit(1);
    } finally {
      for (const path of [linked, original]) try { unlinkSync(path); } catch {}
    }
    const value = {apiKey:'fixture',projectId:'fixture',userId:'fixture',email:'fixture@example.com',refreshToken:'fixture'};
    await saveSessionFile('/data', Redacted.make(value));
    if (Redacted.value(await readSessionFile('/data')).refreshToken !== 'fixture') process.exit(1);
  `)
  assert.equal(fileCheck.stderr, "")
  console.log("Container checks passed: native HTTP, bearer protection, private file session, non-root user and read-only root.")
} finally {
  if (created) await docker("rm", "-f", name).catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
}
