import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { request } from "node:http"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const harness = fileURLToPath(new URL("./harness.js", import.meta.url))

test("native Effect MCP stdio discovers tools, reads complete Notes, writes with hashes and reports typed conflicts", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [harness], stderr: "pipe" })
  let stderr = ""
  transport.stderr?.on("data", (data) => { stderr += String(data) })
  const client = new Client({ name: "protocol-test", version: "1" })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.equal(tools.length, 34)
    assert.ok(tools.every((tool) => /^(?:remote_|local_)/.test(tool.name) && `pocket__${tool.name}`.length <= 64))
    assert.equal(tools.find((t) => t.name === "remote_get_notes")?.annotations?.readOnlyHint, true)
    assert.equal(tools.find((t) => t.name === "local_remote_update_notes")?.annotations?.destructiveHint, true)
    const before = await client.callTool({ name: "remote_get_notes", arguments: { recordingId: "recording-1" } })
    const notes = before.structuredContent as { markdown: string; hash: string; summarizationId: string }
    assert.equal(notes.markdown, "# Original\n\nComplete Notes.")
    assert.equal(notes.summarizationId, "summary-1")
    const missingHash = await client.callTool({ name: "local_remote_update_notes", arguments: { recordingId: "recording-1", summarizationId: notes.summarizationId, markdown: "unsafe" } })
    assert.equal(missingHash.isError, true)
    const update = await client.callTool({ name: "local_remote_update_notes", arguments: { recordingId: "recording-1", summarizationId: notes.summarizationId, markdown: "Saved by protocol", expectedHash: notes.hash } })
    assert.notEqual(update.isError, true)
    const stale = await client.callTool({ name: "local_remote_update_notes", arguments: { recordingId: "recording-1", summarizationId: notes.summarizationId, markdown: "stale", expectedHash: notes.hash } })
    assert.equal(stale.isError, true)
    assert.ok(JSON.stringify(stale).includes("conflict"))
    const refresh = await client.callTool({ name: "local_remote_archive_refresh", arguments: { recordingId: "recording-1" } })
    assert.equal((refresh.structuredContent as { refreshed: boolean }).refreshed, true)
    const editor = await client.callTool({ name: "local_archive_notes_editor", arguments: { recordingId: "recording-1", summarizationId: notes.summarizationId } })
    const local = await client.callTool({ name: "local_archive_update_notes", arguments: { recordingId: "recording-1", summarizationId: notes.summarizationId, expectedHash: (editor.structuredContent as { expectedHash: string }).expectedHash, markdown: "Independent local copy" } })
    assert.equal((local.structuredContent as { source: string }).source, "local")
    const remote = await client.callTool({ name: "remote_get_notes", arguments: { recordingId: "recording-1" } })
    assert.equal((remote.structuredContent as { markdown: string }).markdown, "Saved by protocol")
    const noQuotaConsent = await client.callTool({ name: "local_remote_query_pocket_meetings", arguments: { query: "What happened?" } })
    assert.equal(noQuotaConsent.isError, true)
    assert.ok(!stderr.includes("Complete Notes"))
  } finally { await client.close() }
})

test("native HTTP protocol works and rejects browser Origins and foreign Host headers", async () => {
  const port = await new Promise<number>((resolve) => {
    const socket = createServer()
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      assert.ok(address && typeof address !== "string")
      socket.close(() => resolve(address.port))
    })
  })
  const child = spawn(process.execPath, [harness, "http"], { env: { ...process.env, POCKET_PORT: String(port), POCKET_HOST: "0.0.0.0" }, stdio: "ignore" })
  const url = `http://127.0.0.1:${port}`
  const client = new Client({ name: "http-test", version: "1" })
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = await fetch(`${url}/health`).then((r) => r.ok, () => false)
      if (ready) break
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.equal(ready, true)
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/health`, { headers: { host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode ?? 0) })
      req.on("error", reject); req.end()
    })
    assert.equal(foreignHost, 403)
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403)
    for (const method of ["GET", "DELETE", "POST"]) assert.equal((await fetch(`${url}/mcp`, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) })).status, 401)
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: "{}" })).status, 401)
    const alias = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/mcp`, { method: "POST", headers: { host: "pocket-mcp:9011", authorization: "Bearer test-http-secret", "content-type": "application/json" } }, (response) => { response.resume(); resolve(response.statusCode ?? 0) })
      req.on("error", reject); req.end("{}")
    })
    assert.notEqual(alias, 401)
    assert.notEqual(alias, 403)
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: "Bearer test-http-secret" } } }))
    assert.equal((await client.listTools()).tools.length, 34)
    assert.equal((await fetch(`${url}/archive/`)).status, 200)
    assert.equal((await fetch(`${url}/archive/api/recordings`, { headers: { "x-pocket-ui": "1" } })).status, 401)
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers: { cookie: "pocket_archive_session=fake", "content-type": "application/json" }, body: "{}" })).status, 401)
    const account = await client.callTool({ name: "remote_get_account_info", arguments: {} })
    assert.equal((account.structuredContent as { subscriptionType: string }).subscriptionType, "FREE")
    assert.ok(!JSON.stringify(account).includes("private-push-token"))
  } finally {
    await client.close().catch(() => undefined)
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    await exit
  }
})


test("stdio EOF drains the native protocol and exits without a termination signal", async () => {
  const child = spawn(process.execPath, [harness], { stdio: ["pipe", "ignore", "ignore"] })
  const exit = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
  child.stdin.end()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const code = await Promise.race([exit, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("stdio did not exit after EOF")), 5000) })])
    assert.equal(code, 0)
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL") }
})


test("a broken stdout pipe terminates stdio with an error instead of waiting forever", async () => {
  const child = spawn(process.execPath, [harness], { stdio: ["pipe", "pipe", "ignore"] })
  const exit = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
  child.stdout.destroy()
  child.stdin.on("error", () => undefined)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "broken-pipe-test", version: "1" } } }) + "\n")
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const code = await Promise.race([exit, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("stdio did not exit after output failure")), 5000) })])
    assert.notEqual(code, 0)
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL") }
})
