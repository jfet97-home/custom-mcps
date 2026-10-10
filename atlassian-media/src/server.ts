import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createMediaClient, type MediaClient } from "./media.js";

const allowedHostnames = new Set(["localhost", "127.0.0.1", "::1", "atlassian-media"]);
const allowedListenHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const contentIdSchema = z.string().regex(/^\d{1,32}$/);
const fileIdsSchema = z.array(z.string().uuid()).min(1).max(5);

type ToolFailure = { readonly code: string; readonly message: string };

const jsonToolResult = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  isError,
});

const failureValue = (error: unknown): ToolFailure => {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code : "media_error";
    const message = typeof candidate.message === "string" ? candidate.message : "The media operation failed.";
    return { code, message };
  }
  return { code: "media_error", message: "The media operation failed." };
};

const invoke = async <A, E>(effect: Effect.Effect<A, E>): Promise<{ ok: true; value: A } | { ok: false; error: ToolFailure }> => {
  try {
    return await Effect.runPromise(Effect.match(effect, {
      onFailure: (error) => ({ ok: false as const, error: failureValue(error) }),
      onSuccess: (value) => ({ ok: true as const, value }),
    }));
  } catch {
    return { ok: false, error: { code: "internal_error", message: "The media operation failed." } };
  }
};

const registerTools = (server: McpServer, media: MediaClient): void => {
  server.registerTool("media_status", {
    title: "Media service status",
    description: "Read safe connection, site expiry, and cache status for the media service.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const result = await invoke(media.status());
    return result.ok ? jsonToolResult(result.value) : jsonToolResult(result.error, true);
  });

  server.registerTool("download_whiteboard_images", {
    title: "Download whiteboard images",
    description: "Fetch selected image metadata for a numeric content ID and Atlassian file IDs.",
    inputSchema: {
      content_id: contentIdSchema,
      file_ids: fileIdsSchema,
      collection_id: z.string().min(1).max(256).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ content_id, file_ids, collection_id }) => {
    const result = await invoke(media.downloadImages(content_id, file_ids, collection_id));
    return result.ok ? jsonToolResult(result.value) : jsonToolResult(result.error, true);
  });

  server.registerTool("read_image_chunk", {
    title: "Read image chunk",
    description: "Read a bounded base64 chunk from an image already downloaded by the media service.",
    inputSchema: {
      image_id: z.string().min(1).max(2048),
      offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      length: z.number().int().min(1).max(8192).default(8192),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ image_id, offset, length }) => {
    const result = await invoke(media.readChunk(image_id, offset, length));
    return result.ok ? jsonToolResult(result.value) : jsonToolResult(result.error, true);
  });
};

const newMcpServer = (media: MediaClient): McpServer => {
  const server = new McpServer({ name: "atlassian-media", version: "0.1.0" });
  registerTools(server, media);
  return server;
};

const hostnameFromHeader = (header: string | undefined): string | undefined => {
  if (!header) return undefined;
  try {
    const parsed = new URL(`http://${header}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
};

const requestIsLocal = (request: IncomingMessage): boolean => {
  const host = hostnameFromHeader(request.headers.host);
  if (!host || !allowedHostnames.has(host)) return false;

  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash &&
      allowedHostnames.has(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
};

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

const handleMcpPost = async (request: IncomingMessage, response: ServerResponse, media: MediaClient): Promise<void> => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const mcp = newMcpServer(media);
  try {
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  } catch {
    if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
    else response.destroy();
  } finally {
    await mcp.close().catch(() => undefined);
  }
};

export const createHttpServer = (media: MediaClient): Server => createServer((request, response) => {
  void (async () => {
    if (!requestIsLocal(request)) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, { ok: true, service: "atlassian-media" });
      return;
    }
    if (pathname !== "/mcp") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      response.end();
      return;
    }
    await handleMcpPost(request, response, media);
  })().catch(() => {
    if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
    else response.destroy();
  });
});

const listen = (server: Server, host: string, port: number): Promise<void> => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => {
    server.off("error", reject);
    resolve();
  });
});

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

const validPort = (value: string | undefined): number => {
  if (value === undefined || value === "") return 9005;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MEDIA_PORT must be a valid TCP port.");
  return port;
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  void (async () => {
    try {
      const host = process.env.MEDIA_HOST ?? "127.0.0.1";
      if (!allowedListenHosts.has(host)) throw new Error("invalid host");
      const port = validPort(process.env.MEDIA_PORT);
      const media = await Effect.runPromise(createMediaClient());
      const server = createHttpServer(media);
      await listen(server, host, port);
      process.stdout.write(`atlassian-media listening on ${host}:${port}\n`);
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        const timeout = setTimeout(() => process.exit(1), 5000);
        timeout.unref();
        void close(server).then(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    } catch {
      process.stderr.write("atlassian-media failed to start; check local configuration.\n");
      process.exitCode = 1;
    }
  })();
}
