import { createHash } from "node:crypto";
import { open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ImageInfo } from "./media.js";

type CliOptions = {
  url: string;
  contentId?: string;
  fileIds: string[];
  output: string;
  prefix: string;
};

type ImageChunk = {
  imageId: string;
  offset: number;
  base64: string;
  totalLength: number;
  sha256: string;
};

const usage = "Usage: verify-live [--url URL] [--content-id ID --file-ids UUID,UUID] [--output DIR] [--prefix NAME]";

const parseArgs = (args: readonly string[]): CliOptions => {
  const options: CliOptions = {
    url: "http://localhost:9005/mcp",
    fileIds: [],
    output: "/tmp/atlassian-api-media-test",
    prefix: "",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (argument === "--url") options.url = value;
    else if (argument === "--content-id") options.contentId = value;
    else if (argument === "--file-ids") options.fileIds = value.split(",").filter(Boolean);
    else if (argument === "--output") options.output = value;
    else if (argument === "--prefix") options.prefix = value;
    else throw new Error(usage);
    index += 1;
  }
  if (options.fileIds.length > 0 && (!options.contentId || !/^\d{1,32}$/.test(options.contentId))) {
    throw new Error("--content-id must be numeric when --file-ids are provided.");
  }
  if (options.fileIds.length > 5 || options.fileIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error("--file-ids must contain up to five UUIDs.");
  }
  return options;
};

const textContent = (result: unknown): string => {
  if (typeof result !== "object" || result === null) throw new Error("The media server returned an invalid response.");
  const value = result as { content?: unknown; isError?: unknown };
  if (value.isError === true || !Array.isArray(value.content)) throw new Error("The media server returned an error.");
  const item = value.content.find((candidate): candidate is { type: string; text: string } =>
    typeof candidate === "object" && candidate !== null &&
    (candidate as { type?: unknown }).type === "text" &&
    typeof (candidate as { text?: unknown }).text === "string");
  const text = item?.text;
  if (text === undefined) throw new Error("The media server returned an invalid response.");
  return text;
};

const callJson = async <A>(client: Client, name: string, args: Record<string, unknown>): Promise<A> => {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(textContent(result)) as A;
};

const extensionFor = (mimeType: string): string => {
  const extensions: Record<string, string> = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
  };
  return extensions[mimeType.toLowerCase()] ?? ".bin";
};

const readWholeImage = async (client: Client, prefix: string, image: ImageInfo): Promise<Buffer> => {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < image.base64Length) {
    const chunk = await callJson<ImageChunk>(client, `${prefix}read_image_chunk`, {
      image_id: image.imageId,
      offset,
      length: Math.min(8192, image.base64Length - offset),
    });
    if (chunk.imageId !== image.imageId || chunk.offset !== offset || chunk.totalLength !== image.base64Length || chunk.sha256 !== image.sha256 || chunk.base64.length === 0) {
      throw new Error("The media server returned an invalid image chunk.");
    }
    chunks.push(chunk.base64);
    offset += chunk.base64.length;
    if (offset > image.base64Length) throw new Error("The media server returned too many image bytes.");
  }
  const bytes = Buffer.from(chunks.join(""), "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== image.byteLength || digest !== image.sha256.toLowerCase()) {
    throw new Error("Image length or SHA-256 verification failed.");
  }
  return bytes;
};

const saveWithoutReplacement = async (destination: string, bytes: Buffer): Promise<void> => {
  try {
    const file = await open(destination, "wx", 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await open(destination, "r");
    try {
      const current = await existing.readFile();
      if (!current.equals(bytes)) throw new Error("Refusing to replace an existing file with different bytes.");
    } finally {
      await existing.close();
    }
  }
};

const verify = async (options: CliOptions): Promise<void> => {
  const transport = new StreamableHTTPClientTransport(new URL(options.url));
  const client = new Client({ name: "atlassian-media-live-verifier", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    process.stdout.write(`Tools: ${tools.tools.map((tool) => tool.name).join(", ")}\n`);
    const status = await callJson<unknown>(client, `${options.prefix}media_status`, {});
    process.stdout.write(`Status: ${JSON.stringify(status)}\n`);

    if (options.fileIds.length === 0) return;

    const images = await callJson<ImageInfo[]>(client, `${options.prefix}download_whiteboard_images`, {
      content_id: options.contentId,
      file_ids: options.fileIds,
    });
    if (!Array.isArray(images) || images.length !== options.fileIds.length) {
      throw new Error("The media server returned an unexpected number of image records.");
    }
    await mkdir(options.output, { recursive: true });
    for (const image of images) {
      if (!options.fileIds.includes(image.fileId) || !/^[0-9a-f-]{36}$/i.test(image.fileId)) {
        throw new Error("The media server returned an unexpected file ID.");
      }
      const bytes = await readWholeImage(client, options.prefix, image);
      const destination = join(options.output, `${image.fileId}${extensionFor(image.mimeType)}`);
      await saveWithoutReplacement(destination, bytes);
      process.stdout.write(`Saved ${destination}\n`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
};

try {
  await verify(parseArgs(process.argv.slice(2)));
} catch {
  process.stderr.write("Live media verification failed. Check the local server and arguments.\n");
  process.exitCode = 1;
}
