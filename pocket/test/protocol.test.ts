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
    assert.equal(tools.length, 12)
    assert.equal(tools.find((t) => t.name === "get_notes")?.annotations?.readOnlyHint, true)
    assert.equal(tools.find((t) => t.name === "update_notes")?.annotations?.destructiveHint, true)
    const before = await client.callTool({ name: "get_notes", arguments: { recordingId: "recording-1" } })
    const notes = before.structuredContent as { markdown: string; hash: string; summarizationId: string }
    assert.equal(notes.markdown, "# Original\n\nComplete Notes.")
    assert.equal(notes.summarizationId, "summary-1")
    const update = await client.callTool({ name: "update_notes", arguments: { recordingId: "recording-1", summarizationId: notes.summarizationId, markdown: "Saved by protocol", expectedHash: notes.hash } })
    assert.notEqual(update.isError, true)
    const stale = await client.callTool({ name: "update_notes", arguments: { recordingId: "recording-1", summarizationId: notes.summarizationId, markdown: "stale", expectedHash: notes.hash } })
    assert.equal(stale.isError, true)
    assert.ok(JSON.stringify(stale).includes("conflict"))
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
  const child = spawn(process.execPath, [harness, "http"], { env: { ...process.env, POCKET_PORT: String(port) }, stdio: "ignore" })
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
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)))
    assert.equal((await client.listTools()).tools.length, 12)
    const account = await client.callTool({ name: "get_account_info", arguments: {} })
    assert.equal((account.structuredContent as { subscriptionType: string }).subscriptionType, "FREE")
    assert.ok(!JSON.stringify(account).includes("private-push-token"))
  } finally {
    await client.close().catch(() => undefined)
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    await exit
  }
})
