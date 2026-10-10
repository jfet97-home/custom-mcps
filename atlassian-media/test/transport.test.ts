import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MediaClient } from "../src/media.js";
import { createHttpServer as createMediaHttpServer } from "../src/server.js";

const textOf = (result: unknown): string => {
  assert.ok(typeof result === "object" && result !== null);
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const item = content.find((candidate) => typeof candidate === "object" && candidate !== null && (candidate as { type?: unknown }).type === "text");
  assert.ok(item && typeof (item as { text?: unknown }).text === "string");
  return (item as { text: string }).text;
};

const imageInfo = {
  imageId: "page-123:file-123",
  fileId: "123e4567-e89b-42d3-a456-426614174000",
  contentId: "123",
  mimeType: "image/png",
  byteLength: 3,
  base64Length: 4,
  sha256: "0123456789abcdef",
} as const;

const mediaClient: MediaClient = {
  status: () => Effect.succeed({
    configured: true,
    site: "example.atlassian.net",
    authMode: "scoped",
    tokenExpiry: null,
    cachedImageCount: 1,
  }),
  downloadImages: (contentId, fileIds) => Effect.succeed(fileIds.map((fileId) => ({ ...imageInfo, contentId, fileId, imageId: `${contentId}:${fileId}` }))),
  readChunk: (imageId, offset, length) => Effect.succeed({
    imageId,
    offset,
    base64: "AQID".slice(offset, offset + length),
    totalLength: 4,
    sha256: imageInfo.sha256,
  }),
};

const withServer = async (run: (baseUrl: string) => Promise<void>): Promise<void> => {
  const server = createMediaHttpServer(mediaClient);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

const postStatus = (url: string, headers: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
  const request = httpRequest(url, { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers } }, (response) => {
    response.resume();
    response.on("end", () => resolve(response.statusCode ?? 0));
  });
  request.on("error", reject);
  request.end("{}");
});

test("serves stateless MCP initialization, tool discovery, and media tool calls", async () => {
  await withServer(async (baseUrl) => {
    const client = new Client({ name: "transport-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "download_whiteboard_images",
        "media_status",
        "read_image_chunk",
      ]);

      const status = await client.callTool({ name: "media_status", arguments: {} });
      assert.equal(status.isError, false);
      assert.deepEqual(JSON.parse(textOf(status)), {
        configured: true,
        site: "example.atlassian.net",
        authMode: "scoped",
        tokenExpiry: null,
        cachedImageCount: 1,
      });

      const downloaded = await client.callTool({
        name: "download_whiteboard_images",
        arguments: { content_id: "123", file_ids: [imageInfo.fileId] },
      });
      assert.equal(downloaded.isError, false);
      assert.equal(JSON.parse(textOf(downloaded))[0]?.imageId, `123:${imageInfo.fileId}`);

      const chunk = await client.callTool({
        name: "read_image_chunk",
        arguments: { image_id: imageInfo.imageId, offset: 0, length: 4 },
      });
      assert.equal(JSON.parse(textOf(chunk)).base64, "AQID");
    } finally {
      await client.close();
    }
  });
});

test("health endpoint is minimal and MCP routes reject external origins and hosts", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "atlassian-media" });

    assert.equal(await postStatus(`${baseUrl}/mcp`, { origin: "https://outside.example" }), 403);
    assert.equal(await postStatus(`${baseUrl}/mcp`, { host: "outside.example" }), 403);

    const wrongMethod = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  });
});
