import assert from "node:assert/strict"
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { createMediaClient, MediaError } from "../src/media.js"

const configText = (token = "dummy-local-test-token") => [
  "ATLASSIAN_SITE_URL=https://example.atlassian.net",
  "ATLASSIAN_CLOUD_ID=123e4567-e89b-42d3-a456-426614174000",
  "ATLASSIAN_AUTH_MODE=scoped",
  "ATLASSIAN_EMAIL=test@example.invalid",
  `ATLASSIAN_API_TOKEN=${token}`
].join("\n")

const withConfig = async (run: (path: string) => Promise<void>, contents = configText()) => {
  const directory = await mkdtemp(join(tmpdir(), "media-client-test-"))
  const path = join(directory, "settings.env")
  await writeFile(path, contents, { mode: 0o600 })
  await chmod(path, 0o600)
  try { await run(path) } finally { await rm(directory, { recursive: true, force: true }) }
}

const withEnvironment = async (run: () => Promise<void>) => {
  const values: Record<string, string> = {
    ATLASSIAN_SITE_URL: "https://example.atlassian.net",
    ATLASSIAN_CLOUD_ID: "123e4567-e89b-42d3-a456-426614174000",
    ATLASSIAN_AUTH_MODE: "scoped",
    ATLASSIAN_EMAIL: "test@example.invalid",
    ATLASSIAN_API_TOKEN: "dummy-env-test-token",
    MEDIA_CONFIG_FILE: "/path/that/must/not/be/read"
  }
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  try { await run() } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const bootstrapResponse = (collections = ["collection-1"]) => new Response(JSON.stringify({
  body: { view: { mediaToken: { token: "opaque-media-token", clientId: "opaque-client-id", collectionIds: collections } } }
}), { status: 200, headers: { "content-type": "application/json" } })

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const contentId = "10001"
const fileId = "123e4567-e89b-42d3-a456-426614174001"
const imageResponse = (bytes = png) => new Response(bytes, { status: 200, headers: { "content-type": "image/png" } })

test("uses scoped basic auth for bootstrap and separate media token headers; caches bytes for chunks", async () => {
  await withConfig(async (configFile) => {
    const calls: Array<{ url: URL; headers: Headers }> = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      calls.push({ url, headers })
      if (url.hostname === "api.atlassian.com") return bootstrapResponse()
      return imageResponse()
    }
    const client = await Effect.runPromise(createMediaClient({ configFile, fetch: fetcher, minIntervalMs: 0 }))
    const [info] = await Effect.runPromise(client.downloadImages(contentId, [fileId]))
    assert.equal(info?.mimeType, "image/png")
    assert.equal(info?.byteLength, png.byteLength)
    assert.equal(info?.base64Length, Buffer.from(png).toString("base64").length)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.headers.get("authorization"), `Basic ${Buffer.from("test@example.invalid:dummy-local-test-token").toString("base64")}`)
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer opaque-media-token")
    assert.equal(calls[1]?.headers.get("x-client-id"), "opaque-client-id")
    assert.equal(calls[1]?.url.searchParams.get("collection"), "collection-1")
    assert.equal(calls[0]?.url.pathname, `/ex/confluence/123e4567-e89b-42d3-a456-426614174000/wiki/rest/api/content/${contentId}`)
    assert.equal(calls[1]?.url.hostname, "api.media.atlassian.com")
    const first = await Effect.runPromise(client.readChunk(`${contentId}:${fileId}`, 0, 8))
    const second = await Effect.runPromise(client.readChunk(`${contentId}:${fileId}`, 8, 8))
    assert.equal(first.base64 + second.base64, Buffer.from(png).toString("base64"))
    assert.equal(first.sha256, info?.sha256)
    assert.equal(calls.length, 2)
    const status = await Effect.runPromise(client.status())
    assert.deepEqual(status, { configured: true, site: "example.atlassian.net", authMode: "scoped", tokenExpiry: null, cachedImageCount: 1 })
    assert.equal(JSON.stringify(status).includes("opaque-media-token"), false)
  })
})

test("loads runtime settings from process environment without reading MEDIA_CONFIG_FILE", { concurrency: false }, async () => {
  await withEnvironment(async () => {
    const calls: Array<{ url: URL; headers: Headers }> = []
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      calls.push({ url, headers })
      return url.hostname === "api.atlassian.com" ? bootstrapResponse() : imageResponse()
    }
    const client = await Effect.runPromise(createMediaClient({ fetch: fetcher, minIntervalMs: 0 }))
    assert.equal((await Effect.runPromise(client.status())).configured, true)
    await Effect.runPromise(client.downloadImages(contentId, [fileId]))
    assert.equal(calls[0]?.headers.get("authorization"), `Basic ${Buffer.from("test@example.invalid:dummy-env-test-token").toString("base64")}`)
  })
})

test("allows process environment overrides when an explicit config file is selected", { concurrency: false }, async () => {
  await withEnvironment(async () => withConfig(async (configFile) => {
    let authorization = ""
    const client = await Effect.runPromise(createMediaClient({
      configFile,
      minIntervalMs: 0,
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.hostname === "api.atlassian.com") {
          authorization = new Headers(init?.headers).get("authorization") ?? ""
          return bootstrapResponse()
        }
        return imageResponse()
      }
    }))
    await Effect.runPromise(client.downloadImages(contentId, [fileId]))
    assert.equal(authorization, `Basic ${Buffer.from("test@example.invalid:dummy-env-test-token").toString("base64")}`)
  }))
})

test("requires explicit collection selection when bootstrap lists several collections", async () => {
  await withConfig(async (configFile) => {
    const client = await Effect.runPromise(createMediaClient({ configFile, fetch: async () => bootstrapResponse(["a", "b"]), minIntervalMs: 0 }))
    await assert.rejects(Effect.runPromise(client.downloadImages(contentId, [fileId])), (error: MediaError) => error.code === "INPUT")
  })
})

test("stops at the first rate limit response without retrying", async () => {
  await withConfig(async (configFile) => {
    let calls = 0
    const client = await Effect.runPromise(createMediaClient({ configFile, fetch: async () => { calls++; return new Response("", { status: 429 }) }, minIntervalMs: 0 }))
    await assert.rejects(Effect.runPromise(client.downloadImages(contentId, [fileId])), (error: MediaError) => error.code === "RATE_LIMITED" && error.status === 429)
    assert.equal(calls, 1)
  })
})

test("rejects oversized images and never returns the credential in config errors", async () => {
  await withConfig(async (configFile) => {
    let call = 0
    const client = await Effect.runPromise(createMediaClient({ configFile, fetch: async () => ++call === 1 ? bootstrapResponse() : new Response(null, { status: 200, headers: { "content-length": String(20 * 1024 * 1024 + 1), "content-type": "image/png" } }), minIntervalMs: 0 }))
    await assert.rejects(Effect.runPromise(client.downloadImages(contentId, [fileId])), (error: MediaError) => error.code === "TOO_LARGE")
  })
  const secret = "sensitive-invalid-token-value"
  await withConfig(async (configFile) => {
    const client = await Effect.runPromise(createMediaClient({ configFile, fetch: async () => bootstrapResponse(), minIntervalMs: 0 }))
    await assert.rejects(Effect.runPromise(client.downloadImages(contentId, [fileId])), (error: MediaError) => {
      assert.equal(error.code, "CONFIG")
      assert.equal(error.message.includes(secret), false)
      return true
    })
  }, `ATLASSIAN_SITE_URL=https://example.atlassian.net\nATLASSIAN_CLOUD_ID=invalid\nATLASSIAN_AUTH_MODE=scoped\nATLASSIAN_EMAIL=test@example.invalid\nATLASSIAN_API_TOKEN=${secret}`)
})

test("rejects config files readable by group or others", async () => {
  await withConfig(async (configFile) => {
    await chmod(configFile, 0o644)
    const client = await Effect.runPromise(createMediaClient({ configFile, fetch: async () => bootstrapResponse(), minIntervalMs: 0 }))
    assert.deepEqual(await Effect.runPromise(client.status()), { configured: false, site: null, authMode: null, tokenExpiry: null, cachedImageCount: 0 })
  })
})

test("validates numeric content IDs, UUID file IDs, and the one-to-five file limit", async () => {
  await withConfig(async (configFile) => {
    let calls = 0
    const client = await Effect.runPromise(createMediaClient({ configFile, fetch: async () => { calls++; return bootstrapResponse() }, minIntervalMs: 0 }))
    for (const [content, ids] of [["page", [fileId]], [contentId, ["file"]], [contentId, []], [contentId, Array(6).fill(fileId)]] as const) {
      await assert.rejects(Effect.runPromise(client.downloadImages(content, ids)), (error: MediaError) => error.code === "INPUT")
    }
    assert.equal(calls, 0)
  })
})
