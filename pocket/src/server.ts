import { createServer } from "node:http"
import { ByteSize, Deferred, Effect, Exit, Layer, Logger, Schema, Sink, Stdio } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NodeHttpServer, NodeStdio } from "@effect/platform-node"
import { failure, PocketError, Settings } from "./core.js"
import { Pocket } from "./pocket.js"
import { Account, ActionPage, Folders, Hash, Notes, RecordingPage, RecordingWithHashes, SearchPage, Spaces, Transcript, WriteResult } from "./contracts.js"
import { Id } from "./recording.js"
import { authorized, HttpAuthorization, HttpAuthorizationLive } from "./http-auth.js"

const positive = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100000 }))
const limit = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
const offset = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1000000 }))
const markdown = Schema.String.check(Schema.isMaxLength(2000000))
const text = Schema.String.check(Schema.isMaxLength(100000))
const common = { failure: PocketError, dependencies: [Pocket] }

export const toolkit = Toolkit.make(
  Tool.make("list_recordings", {
    ...common, description: "List accessible Pocket recordings with explicit page/total pagination. Does not include full Notes or transcripts; use their dedicated tools.",
    parameters: Schema.Struct({ page: Schema.optionalKey(positive), limit: Schema.optionalKey(limit), folderId: Schema.optionalKey(Id) }), success: RecordingPage
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("search_recordings", {
    ...common, description: "Search Pocket recordings using Pocket's hybrid semantic search. Returns at most limit matches (default 20, maximum 100); no cursor is supported by this client contract. Read original Notes using get_notes.",
    parameters: Schema.Struct({ query: Schema.NonEmptyString.check(Schema.isMaxLength(1000)), limit: Schema.optionalKey(limit), workspaceId: Schema.optionalKey(Id) }), success: SearchPage
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("get_recording", {
    ...common, description: "Read recording metadata, complete segmented transcript and all available original Markdown Notes versions. Row IDs, recording IDs, transcription IDs and summarization IDs are distinct.",
    parameters: Schema.Struct({ recordingId: Id }), success: RecordingWithHashes
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("get_transcript", {
    ...common, description: "Read the complete current Pocket transcript with raw segmentIndex values (including empty segments), transcriptionId and a hash binding content to that transcription. Pocket text edits overwrite both text and originalText; differing fields are preserved in private raw backups.",
    parameters: Schema.Struct({ recordingId: Id }), success: Transcript
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("get_notes", {
    ...common, description: "Read the COMPLETE original Pocket AI Notes Markdown, summarizationId, rowId, versions and hash. Defaults to the most recently updated summarization; pass summarizationId to select explicitly. This is not a section-summary search.",
    parameters: Schema.Struct({ recordingId: Id, summarizationId: Schema.optionalKey(Id) }), success: Notes
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("update_notes", {
    ...common, description: "Save exactly the supplied full Markdown without regenerating Notes. Requires expectedHash from get_notes. A private raw backup is saved first. Comparison is client-side, not atomic. Every failure after sending the write is uncertain_write and includes backupId; reread before another write. Notes version fields describe source formats and are not edit revisions.",
    parameters: Schema.Struct({ recordingId: Id, summarizationId: Id, markdown, expectedHash: Hash }), success: WriteResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, false),
  Tool.make("edit_transcript", {
    ...common, description: "Correct one or more raw segment indices in a single batch. Requires expectedHash from get_transcript; rejects duplicate/out-of-range indices. Pocket overwrites BOTH text and originalText. When those fields differ, explicitly set allowOriginalTextOverwrite to permit that loss of distinction; the full raw response is backed up first. Post-send failures are uncertain_write with backupId. Client-side comparison is not atomic.",
    parameters: Schema.Struct({ recordingId: Id, expectedHash: Hash, allowOriginalTextOverwrite: Schema.optionalKey(Schema.Boolean),
      corrections: Schema.Array(Schema.Struct({ segmentIndex: offset, text })).check(Schema.isBetweenLength(1, 100)) }), success: WriteResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, false),
  Tool.make("search_action_items", {
    ...common, description: "Search or list global Pocket action items, optionally scoped to recordingId. Returns actual global item IDs, content hashes and pagination. Summary-source item IDs are different. Pagination counts child items; advance offset by pagination.returned.",
    parameters: Schema.Struct({ query: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(1000))), recordingId: Schema.optionalKey(Id), limit: Schema.optionalKey(limit), offset: Schema.optionalKey(offset) }), success: ActionPage
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("update_action_item", {
    ...common, description: "Update a global action item's title/dueDate, OR completed state, using its global ID, recordingId and required expectedHash from search_action_items. Completion changes use a separate call so each operation sends one write. dueDate accepts an ISO date/time or null. Saves a raw private backup; post-send failures are uncertain_write with backupId. Comparison is client-side.",
    parameters: Schema.Struct({ recordingId: Id, actionItemId: Id, expectedHash: Hash,
      title: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(10000))), dueDate: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}(?:T.*)?$/)))), completed: Schema.optionalKey(Schema.Boolean) }), success: WriteResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, false),
  Tool.make("list_folders", {
    ...common, description: "List the current account's Pocket folder hierarchy, with space links and recording counts when Pocket supplies them.", parameters: Tool.EmptyParams, success: Folders
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("list_spaces", {
    ...common, description: "Read spaces for the active organization when available. Returns available=false and an empty list for a personal account without an active organization. No member, billing or administration operations are exposed.", parameters: Tool.EmptyParams, success: Spaces
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("get_account_info", {
    ...common, description: "Read only account identity, activity, authentication-provider name, timezone and subscription type. Excludes credentials, push tokens, billing and member data.", parameters: Tool.EmptyParams, success: Account
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true)
)

export const handlers = toolkit.toLayer({
  list_recordings: (input) => Pocket.use((p) => p.listRecordings(input)),
  search_recordings: (input) => Pocket.use((p) => p.searchRecordings(input)),
  get_recording: ({ recordingId }) => Pocket.use((p) => p.getRecording(recordingId)),
  get_transcript: ({ recordingId }) => Pocket.use((p) => p.getTranscript(recordingId)),
  get_notes: ({ recordingId, summarizationId }) => Pocket.use((p) => p.getNotes(recordingId, summarizationId)),
  update_notes: (input) => Pocket.use((p) => p.updateNotes(input)),
  edit_transcript: (input) => Pocket.use((p) => p.editTranscript(input)),
  search_action_items: (input) => Pocket.use((p) => p.searchActionItems(input)),
  update_action_item: (input) => Pocket.use((p) => p.updateActionItem(input)),
  list_folders: () => Pocket.use((p) => p.listFolders),
  list_spaces: () => Pocket.use((p) => p.listSpaces),
  get_account_info: () => Pocket.use((p) => p.account)
})

const options = {
  name: "pocket-personal", version: "0.1.0",
  instructions: "Read complete Notes/transcripts before editing. Use returned hashes for optimistic concurrency. Writes are never retried automatically. Backups are private on the host; a returned backupId identifies recovery content. Internal Pocket APIs can change independently of the public API.",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26] as const
}

export const hostAllowed = (host: string | undefined): boolean => {
  if (!host) return false
  try {
    const parsed = new URL(`http://${host}`)
    return !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash &&
      ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(parsed.hostname)
  } catch { return false }
}

const localOnly = HttpRouter.middleware((http) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (!hostAllowed(request.headers.host) || request.headers.origin !== undefined) return HttpServerResponse.empty({ status: 403 })
  if (request.url.split("?", 1)[0] !== "/health" && !authorized(request.headers.authorization, (yield* HttpAuthorization).token)) return HttpServerResponse.empty({ status: 401 })
  return yield* http
}), { global: true })

export const serverProgram = (stdio: boolean, authLayer = HttpAuthorizationLive) => Effect.gen(function*() {
  const settings = yield* Settings
  const registered = McpServer.toolkit(toolkit).pipe(Layer.provide(handlers))
  if (stdio) return yield* Effect.scoped(Effect.gen(function*() {
    const drained = yield* Deferred.make<void>()
    const original = yield* Stdio.Stdio
    const observed = Stdio.make({ ...original, stdout: (options) => original.stdout(options).pipe(Sink.onExit((exit) => Exit.isSuccess(exit) ? Deferred.succeed(drained, undefined) : Effect.void)) })
    yield* Layer.build(Layer.merge(registered, McpServer.layerStdio(options)).pipe(Layer.provide(Layer.succeed(Stdio.Stdio, observed))))
    yield* Effect.sync(() => { process.stderr.write("Pocket MCP ready (stdio).\n") })
    yield* Deferred.await(drained)
  })).pipe(Effect.provide(NodeStdio.layer))
  const server = HttpRouter.serve(Layer.mergeAll(
      registered, McpServer.layerHttp({ ...options, path: "/mcp", allowedOrigins: [] }), localOnly,
      HttpRouter.add("GET", "/health", Effect.succeed(HttpServerResponse.jsonUnsafe({ service: "pocket-personal", version: "0.1.0", revision: settings.sourceRevision ?? "development", ok: true })))
    ), { disableLogger: true, disableListenLog: true, middleware: (http) => http.pipe(Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(12))) })
    .pipe(Layer.provide(authLayer), Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: settings.port })))
  yield* Effect.scoped(Effect.gen(function*() {
    yield* Layer.build(server)
    yield* Effect.sync(() => { process.stderr.write(`Pocket MCP ready (127.0.0.1:${settings.port}).\n`) })
    yield* Effect.never
  }))
}).pipe(Effect.mapError(() => failure("configuration", "Could not start the Pocket MCP transport. Check the configured port and runtime.")), Effect.provideService(Logger.LogToStderr, true))
