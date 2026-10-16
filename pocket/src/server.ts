import { createServer } from "node:http"
import { ByteSize, Deferred, Effect, Exit, Layer, Logger, Schema, Sink, Stdio } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NodeHttpServer, NodeStdio } from "@effect/platform-node"
import { failure, PocketError, Settings } from "./core.js"
import { Pocket } from "./pocket.js"
import {
  Account, ActionCategory, ActionPage, ActionPriority, ActionStatus, ArchiveBackfillResult, ArchiveBridgeSyncResult, ArchiveDraftResult, ArchiveEventRead,
  ArchiveJob, ArchiveJobClaim, ArchiveJobFinishResult, ArchiveJobSaveResult, ArchiveRecordingRead, ArchiveSearchResult,
  ArchiveSourcePage, ArchiveStatus, Folders, Hash, Notes, RecordingPage, RecordingWithHashes, Spaces,
  Transcript, WriteResult
} from "./contracts.js"
import { Id } from "./recording.js"
import { authorized, HttpAuthorization, HttpAuthorizationLive } from "./http-auth.js"
import { ArchiveWorkflow } from "./archive-workflow.js"
import { ArchiveUiRoutes, isArchiveUiPath } from "./archive-ui.js"
import { PocketTransport } from "./transport.js"
import { listTags, RecordingSearchInput, RecordingSearchResult, searchRecordings, Tags } from "./recording-search.js"
import { MeetingQuery, MeetingQueryInputSchema, MeetingQueryResultSchema, MeetingQueryLookupInputSchema, MeetingQueryLookupResultSchema } from "./meeting-query.js"
import { Archive } from "./archive.js"

const positive = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100000 }))
const limit = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
const offset = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1000000 }))
const markdown = Schema.String.check(Schema.isMaxLength(2000000))
const text = Schema.String.check(Schema.isMaxLength(100000))
const isoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/))
const dueDate = Schema.String.check(Schema.isPattern(/^(?:|\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?)$/))
const archiveLimit = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
const archiveOffset = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1000000 }))
const sourceCursor = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100000000 }))
const sourcePageLimit = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 12000 }))
const archiveMarkdown = Schema.String.check(Schema.isMaxLength(2000000))
const leaseToken = Schema.NonEmptyString.check(Schema.isMaxLength(128))
const fence = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2147483647 }))
const common = { failure: PocketError, dependencies: [Pocket] }
const archiveCommon = { failure: PocketError, dependencies: [ArchiveWorkflow] }
const localCommon = { failure: PocketError, dependencies: [Archive] }
const nullableText = Schema.NullOr(Schema.String)
const LocalArchiveList = Schema.Struct({
  recordings: Schema.Array(Schema.Struct({
    recordingId: Id, title: nullableText, description: nullableText, recordingAt: nullableText,
    createdAt: nullableText, updatedAt: nullableText, duration: Schema.NullOr(Schema.Number),
    firstSeenAt: Schema.String, lastSeenAt: Schema.String, snapshotCount: Schema.Number,
    transcriptVersionCount: Schema.Number, notesVersionCount: Schema.Number, localNotesRevisionCount: Schema.Number
  })), pagination: Schema.Struct({ limit: Schema.Number, offset: Schema.Number, total: Schema.Number })
})
const LocalNotesEditor = Schema.Struct({ summarizationId: Id, source: Schema.Literals(["local", "pocket"]), expectedHash: Hash,
  baseRemoteHash: Hash, remoteHash: Hash, localRevisionId: Schema.NullOr(Schema.Number), changedRemotely: Schema.Boolean,
  textLength: Schema.Number, markdown: Schema.NullOr(Schema.String)
})
const LocalNotesWrite = Schema.Struct({ source: Schema.Literal("local"), revisionId: Schema.Number, hash: Hash, previousHash: Hash,
  baseRemoteHash: Hash, capturedAt: Schema.String
})
const RefreshResult = Schema.Struct({ refreshed: Schema.Boolean, rawCaptured: Schema.Literal(true), capturedAt: Schema.String,
  message: Schema.optionalKey(Schema.String)
})

export const toolkit = Toolkit.make(
  Tool.make("remote_list_recordings", {
    ...common, description: "List accessible Pocket recordings with explicit page/total pagination. Does not include full Notes or transcripts; use their dedicated tools.",
    parameters: Schema.Struct({ page: Schema.optionalKey(positive), limit: Schema.optionalKey(limit), folderId: Schema.optionalKey(Id) }), success: RecordingPage
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("remote_search_recordings", {
    failure: PocketError, dependencies: [PocketTransport], description: "REMOTE Pocket recording-level semantic search with page/limit, workspace, inclusive UTC recording dates, tag IDs and exact folder IDs (without descendants). Date-only upper bounds include that entire UTC day. Folder filters scan the complete upstream result set before paginating and fail on incomplete/inconsistent scans. Returns metadata, not section hits or complete Notes. Use remote_list_tags for IDs and remote_get_notes for full Notes.",
    parameters: RecordingSearchInput, success: RecordingSearchResult
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("remote_list_tags", {
    failure: PocketError, dependencies: [PocketTransport], description: "REMOTE: list Pocket tag IDs, names and colors for recording search filters. Does not change tags.",
    parameters: Tool.EmptyParams, success: Tags
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_remote_query_pocket_meetings", {
    failure: PocketError, dependencies: [MeetingQuery], description: "LOCAL + REMOTE: ask Pocket's in-app Ask Pocket engine about meetings. Creates a chat and can consume quota; requires consumeQuota=true. Pass a fresh clientRequestId for a new question and reuse it after a timeout to avoid another paid request. Journals intent/answer locally. A long query returns status=running and continues in this service; poll local_query_pocket_meetings_status until complete. Returns Pocket's answer and sources without provider fallback; account/quota limits apply. Do not retry with a new key automatically. Not used by webhook automation.",
    parameters: MeetingQueryInputSchema, success: MeetingQueryResultSchema
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, false).annotate(Tool.OpenWorld, true),
  Tool.make("local_query_pocket_meetings_status", {
    failure: PocketError, dependencies: [MeetingQuery], description: "LOCAL ONLY: recover a persisted meeting query by operationId or clientRequestId, including partial/final answer, sources and outcome. Omit IDs for bounded recent metadata only. Does not contact Pocket, create a chat or consume quota. An incomplete operation is not permission to resend with a new key.",
    parameters: MeetingQueryLookupInputSchema, success: MeetingQueryLookupResultSchema
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false),
  Tool.make("remote_get_recording", {
    ...common, description: "Read recording metadata, complete segmented transcript and all available original Markdown Notes versions. Row IDs, recording IDs, transcription IDs and summarization IDs are distinct.",
    parameters: Schema.Struct({ recordingId: Id }), success: RecordingWithHashes
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("remote_get_transcript", {
    ...common, description: "Read the complete current Pocket transcript with raw segmentIndex values (including empty segments), transcriptionId and a hash binding content to that transcription. Pocket text edits overwrite both text and originalText; differing fields are preserved in private raw backups.",
    parameters: Schema.Struct({ recordingId: Id }), success: Transcript
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("remote_get_notes", {
    ...common, description: "Read the COMPLETE original Pocket AI Notes Markdown, summarizationId, rowId, versions and hash. Defaults to the most recently updated summarization; pass summarizationId to select explicitly. This is not a section-summary search.",
    parameters: Schema.Struct({ recordingId: Id, summarizationId: Schema.optionalKey(Id) }), success: Notes
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_remote_update_notes", {
    ...common, description: "Save exactly the supplied full Markdown without regenerating Notes. Requires expectedHash from remote_get_notes. A private raw backup is saved first. Comparison is client-side, not atomic. Every failure after sending the write is uncertain_write and includes backupId; reread before another write. Notes version fields describe source formats and are not edit revisions.",
    parameters: Schema.Struct({ recordingId: Id, summarizationId: Id, markdown, expectedHash: Hash }), success: WriteResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, false),
  Tool.make("local_remote_edit_transcript", {
    ...common, description: "Correct one or more raw segment indices in a single batch. Requires expectedHash from remote_get_transcript; rejects duplicate/out-of-range indices. Pocket overwrites BOTH text and originalText. When those fields differ, explicitly set allowOriginalTextOverwrite to permit that loss of distinction; the full raw response is backed up first. Post-send failures are uncertain_write with backupId. Client-side comparison is not atomic.",
    parameters: Schema.Struct({ recordingId: Id, expectedHash: Hash, allowOriginalTextOverwrite: Schema.optionalKey(Schema.Boolean),
      corrections: Schema.Array(Schema.Struct({ segmentIndex: offset, text })).check(Schema.isBetweenLength(1, 100)) }), success: WriteResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, false),
  Tool.make("remote_search_action_items", {
    ...common, description: "REMOTE: search or list Pocket action items with status, priority, category, due and source-recording-date filters. Query filters scan the complete matching result set before local filtering. Returns global IDs, hashes and pagination; pagination.returned is normalized to leaf rows because Pocket can report group counts. Advance offset by returned, not flattened item count. Incomplete or changed scans fail closed.",
    parameters: Schema.Struct({
      query: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(1000))), recordingId: Schema.optionalKey(Id),
      status: Schema.optionalKey(ActionStatus), priority: Schema.optionalKey(ActionPriority), category: Schema.optionalKey(ActionCategory),
      dueBefore: Schema.optionalKey(isoDate), dueAfter: Schema.optionalKey(isoDate),
      recordingDateFrom: Schema.optionalKey(isoDate), recordingDateTo: Schema.optionalKey(isoDate),
      limit: Schema.optionalKey(limit), offset: Schema.optionalKey(offset)
    }), success: ActionPage
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_remote_update_action_item", {
    ...common, description: "Update a global action item using its global ID, recordingId and required expectedHash from remote_search_action_items. Supports status, priority, title/label, description/context, assignee and dueDate. Empty dueDate, description/context or assignee clears that value. Completion uses one separate write and verifies Pocket's reread completion timestamp. Saves a raw private backup; post-send failures are uncertain_write with backupId. Comparison is client-side.",
    parameters: Schema.Struct({ recordingId: Id, actionItemId: Id, expectedHash: Hash,
      title: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(10000))), label: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(10000))),
      description: Schema.optionalKey(text), context: Schema.optionalKey(text), dueDate: Schema.optionalKey(Schema.NullOr(dueDate)),
      status: Schema.optionalKey(ActionStatus), priority: Schema.optionalKey(ActionPriority), assignee: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
      completed: Schema.optionalKey(Schema.Boolean) }), success: WriteResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, false),
  Tool.make("remote_list_folders", {
    ...common, description: "List the current account's Pocket folder hierarchy, with space links and recording counts when Pocket supplies them.", parameters: Tool.EmptyParams, success: Folders
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("remote_list_spaces", {
    ...common, description: "Read spaces for the active organization when available. Returns available=false and an empty list for a personal account without an active organization. No member, billing or administration operations are exposed.", parameters: Tool.EmptyParams, success: Spaces
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("remote_get_account_info", {
    ...common, description: "Read only account identity, activity, authentication-provider name, timezone and subscription type. Excludes credentials, push tokens, billing and member data.", parameters: Tool.EmptyParams, success: Account
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_archive_search", {
    ...archiveCommon, description: "Search only the private local archive across recording metadata, complete transcript versions, original Notes versions, drafts and final Notes. Results include a short excerpt; use local_archive_read for the complete stored content.",
    parameters: Schema.Struct({ query: Schema.NonEmptyString.check(Schema.isMaxLength(1000)), limit: Schema.optionalKey(archiveLimit), offset: Schema.optionalKey(archiveOffset) }), success: ArchiveSearchResult
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_archive_list", {
    ...localCommon, description: "LOCAL ONLY: browse saved recordings with optional text search and explicit pagination. Includes local Notes revision counts. Does not contact Pocket or the Pi.",
    parameters: Schema.Struct({ query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))), limit: Schema.optionalKey(archiveLimit), offset: Schema.optionalKey(archiveOffset) }), success: LocalArchiveList
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false),
  Tool.make("local_archive_notes_editor", {
    ...localCommon, description: "LOCAL ONLY: read the current independent local Notes copy or captured Pocket base, plus expectedHash for a local edit and whether the captured remote base changed. Does not fetch Pocket. source=pocket means an archived snapshot, not a live read.",
    parameters: Schema.Struct({ recordingId: Id, summarizationId: Id }), success: LocalNotesEditor
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true).annotate(Tool.OpenWorld, false),
  Tool.make("local_archive_update_notes", {
    ...localCommon, description: "LOCAL ONLY: append an independent Notes revision using expectedHash from local_archive_notes_editor. Preserves prior local revisions and captured Pocket originals. Never uploads to Pocket or changes webhook sources/final Notes. Read local_archive_read for history.",
    parameters: Schema.Struct({ recordingId: Id, summarizationId: Id, expectedHash: Hash, markdown: archiveMarkdown }), success: LocalNotesWrite
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false).annotate(Tool.OpenWorld, false),
  Tool.make("local_remote_archive_refresh", {
    failure: PocketError, dependencies: [Archive, Pocket], description: "LOCAL + REMOTE: explicitly read a current Pocket recording and capture its raw snapshot, transcript and Notes locally. Preserves local Notes edits and never uploads them. Does not enqueue refinement jobs. refreshed=false reports an unsupported decoded shape while retaining raw data and earlier versions.",
    parameters: Schema.Struct({ recordingId: Id }), success: RefreshResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false).annotate(Tool.OpenWorld, true),
  Tool.make("local_archive_read", {
    ...archiveCommon, description: "Read complete local API snapshots, every archived transcript and Notes version, webhook payloads with exact raw bytes, drafts, and job state for a recording. It remains available after Pocket expiry or deletion.",
    parameters: Schema.Struct({ recordingId: Id, limit: Schema.optionalKey(archiveLimit) }), success: ArchiveRecordingRead
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_archive_read_event", {
    ...archiveCommon, description: "Read one exact archived Pocket webhook event, including its parsed payload, original raw body bytes, processing state and linked jobs.",
    parameters: Schema.Struct({ eventId: Hash }), success: ArchiveEventRead
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_archive_status", {
    ...archiveCommon, description: "Read local archive counts, backfill progress, bridge sync health, pending job and lease counts, and whether remote Notes writes are enabled.",
    parameters: Tool.EmptyParams, success: ArchiveStatus
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_remote_archive_backfill", {
    ...archiveCommon, description: "Page through existing Pocket recordings and archive every available original transcript and Notes version. This is snapshot-only: it does not enqueue jobs or rewrite historical Notes. Progress resumes from the local page cursor.",
    parameters: Schema.Struct({ maxPages: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20 }))), startPage: Schema.optionalKey(positive) }), success: ArchiveBackfillResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_remote_archive_sync_bridge", {
    ...archiveCommon, description: "Fetch a bounded number of pages from the private Pi bridge, transactionally archive exact webhook bodies, create deduplicated jobs for supported events and acknowledge each event only after local persistence.",
    parameters: Schema.Struct({ maxPages: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20 }))) }), success: ArchiveBridgeSyncResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_archive_jobs", {
    ...archiveCommon, description: "Inspect durable job state, lease expiry, fencing token, attempts, last safe error, draft ID and uncertain-write reconciliation state. Draft contents are available through local_archive_read.",
    parameters: Schema.Struct({ recordingId: Schema.optionalKey(Id), limit: Schema.optionalKey(archiveLimit) }), success: Schema.Array(ArchiveJob)
  }).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_remote_archive_job_claim", {
    ...archiveCommon, description: "Sync the Pi event queue before claiming the oldest eligible job. Claims serialize per recording and return a renewable 30-minute lease token and fencing token. Only one job can be active for a recording.",
    parameters: Tool.EmptyParams, success: ArchiveJobClaim
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false),
  Tool.make("local_archive_job_renew", {
    ...archiveCommon, description: "Renew a still-active job lease. Every later operation must include the same lease token and fencing token.",
    parameters: Schema.Struct({ jobId: Schema.NonEmptyString, leaseToken, fencingToken: fence }), success: ArchiveJobClaim
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_remote_archive_job_sources", {
    ...archiveCommon, description: "Capture and archive a fresh complete transcript and selected full Notes document before synthesis, then serve only the requested source page. Pages are at most 12,000 Unicode characters; follow nextCursor to the end of each source. Use the returned contextId for all pages and draft preparation. The server records page coverage and hashes.",
    parameters: Schema.Struct({ jobId: Schema.NonEmptyString, leaseToken, fencingToken: fence, source: Schema.Literals(["transcript", "notes"]), contextId: Schema.optionalKey(Schema.NonEmptyString), cursor: Schema.optionalKey(sourceCursor), limit: Schema.optionalKey(sourcePageLimit), summarizationId: Schema.optionalKey(Id) }), success: ArchiveSourcePage
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_archive_job_prepare_draft", {
    ...archiveCommon, description: "Persist a complete proposed Markdown draft before any Pocket write. Preparation fails until every page of both the transcript and Notes source context has been served. Drafts cannot be empty; much shorter replacements require allowShorter=true.",
    parameters: Schema.Struct({ jobId: Schema.NonEmptyString, leaseToken, fencingToken: fence, contextId: Schema.NonEmptyString, markdown: archiveMarkdown, allowShorter: Schema.optionalKey(Schema.Boolean) }), success: ArchiveDraftResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false),
  Tool.make("local_remote_archive_job_save", {
    ...archiveCommon, description: "Save only the previously persisted draftId for this leased job. The server rechecks complete transcript and Notes hashes, verifies ownership and fencing, atomically marks the job saving before the remote request, and uses Pocket's existing backed-up verified Notes writer. Writes require writesEnabled=true in private bridge.json; uncertain results must be reconciled before the single permitted retry.",
    parameters: Schema.Struct({ jobId: Schema.NonEmptyString, leaseToken, fencingToken: fence, draftId: Schema.NonEmptyString }), success: ArchiveJobSaveResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true).annotate(Tool.Idempotent, false),
  Tool.make("local_remote_archive_job_reconcile", {
    ...archiveCommon, description: "Reread and archive complete current transcript and Notes after a possible write. It finalizes an exact normalized draft match, allows one explicit retry only when both original source hashes are unchanged, and otherwise records terminal conflict while preserving the draft.",
    parameters: Schema.Struct({ jobId: Schema.NonEmptyString, leaseToken, fencingToken: fence, draftId: Schema.NonEmptyString }), success: ArchiveJobSaveResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, true),
  Tool.make("local_archive_job_finish", {
    ...archiveCommon, description: "Close a leased job as needs_review, source_gone or skipped. All linked Pi events are marked complete while local snapshots and drafts remain archived.",
    parameters: Schema.Struct({ jobId: Schema.NonEmptyString, leaseToken, fencingToken: fence, state: Schema.Literals(["needs_review", "source_gone", "skipped"]), reason: Schema.String.check(Schema.isMaxLength(1000)) }), success: ArchiveJobFinishResult
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false),
  Tool.make("local_archive_job_retry", {
    ...archiveCommon, description: "Explicitly requeue a failed or terminal conflict job after inspecting its local draft and status. Uncertain writes cannot be retried through this tool; reconcile them first.",
    parameters: Schema.Struct({ jobId: Schema.NonEmptyString }), success: ArchiveJob
  }).annotate(Tool.Readonly, false).annotate(Tool.Destructive, false).annotate(Tool.Idempotent, false)
)

export const handlers = toolkit.toLayer({
  remote_list_recordings: (input) => Pocket.use((p) => p.listRecordings(input)),
  remote_search_recordings: searchRecordings,
  remote_list_tags: () => listTags,
  local_remote_query_pocket_meetings: (input) => MeetingQuery.use((query) => query.query(input)),
  local_query_pocket_meetings_status: (input) => MeetingQuery.use((query) => query.lookup(input)),
  remote_get_recording: ({ recordingId }) => Pocket.use((p) => p.getRecording(recordingId)),
  remote_get_transcript: ({ recordingId }) => Pocket.use((p) => p.getTranscript(recordingId)),
  remote_get_notes: ({ recordingId, summarizationId }) => Pocket.use((p) => p.getNotes(recordingId, summarizationId)),
  local_remote_update_notes: (input) => Pocket.use((p) => p.updateNotes(input)),
  local_remote_edit_transcript: (input) => Pocket.use((p) => p.editTranscript(input)),
  remote_search_action_items: (input) => Pocket.use((p) => p.searchActionItems(input)),
  local_remote_update_action_item: (input) => Pocket.use((p) => p.updateActionItem(input)),
  remote_list_folders: () => Pocket.use((p) => p.listFolders),
  remote_list_spaces: () => Pocket.use((p) => p.listSpaces),
  remote_get_account_info: () => Pocket.use((p) => p.account),
  local_archive_search: (input) => ArchiveWorkflow.use((archive) => archive.search({ query: input.query, limit: input.limit ?? 20, offset: input.offset ?? 0 })),
  local_archive_list: (input) => Archive.use((archive) => archive.uiBrowse(input.query ?? "", input.limit ?? 20, input.offset ?? 0)),
  local_archive_notes_editor: ({ recordingId, summarizationId }) => Archive.use((archive) => archive.uiReadLocalNotesEditor(recordingId, summarizationId)),
  local_archive_update_notes: ({ recordingId, summarizationId, expectedHash, markdown }) => Archive.use((archive) => archive.uiSaveLocalNotes(recordingId, summarizationId, expectedHash, markdown).pipe(Effect.map((result) => ({ ...result, source: "local" as const })))),
  local_remote_archive_refresh: ({ recordingId }) => Effect.gen(function*() {
    const snapshot = yield* Pocket.use((pocket) => pocket.archiveSnapshot(recordingId, "backfill"))
    yield* Archive.use((archive) => archive.recordSnapshot(snapshot))
    return { refreshed: !snapshot.decodeError, rawCaptured: true as const, capturedAt: snapshot.capturedAt,
      ...(snapshot.decodeError ? { message: "Raw Pocket data was captured, but its decoded shape is unsupported. Earlier versions and local edits were preserved." } : {}) }
  }),
  local_archive_read: (input) => ArchiveWorkflow.use((archive) => archive.read({ recordingId: input.recordingId, limit: input.limit ?? 20 })),
  local_archive_read_event: ({ eventId }) => ArchiveWorkflow.use((archive) => archive.readEvent(eventId)),
  local_archive_status: () => ArchiveWorkflow.use((archive) => archive.status),
  local_remote_archive_backfill: (input) => ArchiveWorkflow.use((archive) => archive.backfill({ maxPages: input.maxPages ?? 1, ...(input.startPage === undefined ? {} : { startPage: input.startPage }) })),
  local_remote_archive_sync_bridge: (input) => ArchiveWorkflow.use((archive) => archive.syncBridge(input.maxPages ?? 5)),
  local_archive_jobs: (input) => ArchiveWorkflow.use((archive) => archive.jobs({ ...(input.recordingId === undefined ? {} : { recordingId: input.recordingId }), limit: input.limit ?? 20 })),
  local_remote_archive_job_claim: () => ArchiveWorkflow.use((archive) => archive.claimJob),
  local_archive_job_renew: (input) => ArchiveWorkflow.use((archive) => archive.renewJob(input)),
  local_remote_archive_job_sources: (input) => ArchiveWorkflow.use((archive) => archive.sources({
    ...input, limit: input.limit ?? 12000,
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.summarizationId === undefined ? {} : { summarizationId: input.summarizationId })
  })),
  local_archive_job_prepare_draft: (input) => ArchiveWorkflow.use((archive) => archive.prepareDraft({ ...input, allowShorter: input.allowShorter ?? false })),
  local_remote_archive_job_save: (input) => ArchiveWorkflow.use((archive) => archive.save(input)),
  local_remote_archive_job_reconcile: (input) => ArchiveWorkflow.use((archive) => archive.reconcile(input)),
  local_archive_job_finish: (input) => ArchiveWorkflow.use((archive) => archive.finish(input)),
  local_archive_job_retry: ({ jobId }) => ArchiveWorkflow.use((archive) => archive.retry(jobId))
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
      ["localhost", "127.0.0.1", "[::1]", "host.docker.internal", "pocket-mcp"].includes(parsed.hostname)
  } catch { return false }
}

const localOnly = HttpRouter.middleware((http) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (!hostAllowed(request.headers.host)) return HttpServerResponse.empty({ status: 403 })
  if (isArchiveUiPath(request.url)) return yield* http
  if (request.headers.origin !== undefined) return HttpServerResponse.empty({ status: 403 })
  if (request.url.split("?", 1)[0] !== "/health" && !authorized(request.headers.authorization, (yield* HttpAuthorization).token)) return HttpServerResponse.empty({ status: 401 })
  return yield* http
}), { global: true })

export const serverProgram = (stdio: boolean, authLayer = HttpAuthorizationLive) => Effect.gen(function*() {
  const settings = yield* Settings
  const archiveWorkflow = yield* ArchiveWorkflow
  const registered = McpServer.toolkit(toolkit).pipe(Layer.provide(handlers))
  if (stdio) return yield* Effect.scoped(Effect.gen(function*() {
    yield* archiveWorkflow.start
    const drained = yield* Deferred.make<void, PocketError>()
    const original = yield* Stdio.Stdio
    const observed = Stdio.make({ ...original, stdout: (options) => original.stdout(options).pipe(Sink.onExit((exit) => Exit.isSuccess(exit) ? Deferred.succeed(drained, undefined) : Deferred.fail(drained, failure("configuration", "The MCP output stream closed before protocol draining completed.")))) })
    yield* Layer.build(Layer.merge(registered, McpServer.layerStdio(options)).pipe(Layer.provide(Layer.succeed(Stdio.Stdio, observed))))
    yield* Effect.sync(() => { process.stderr.write("Pocket MCP ready (stdio).\n") })
    yield* Deferred.await(drained)
  })).pipe(Effect.provide(NodeStdio.layer))
  const server = HttpRouter.serve(Layer.mergeAll(
      registered, McpServer.layerHttp({ ...options, path: "/mcp", allowedOrigins: [] }), localOnly, ArchiveUiRoutes,
      HttpRouter.add("GET", "/health", Effect.succeed(HttpServerResponse.jsonUnsafe({ service: "pocket-personal", version: "0.1.0", revision: settings.sourceRevision ?? "development", ok: true })))
    ), { disableLogger: true, disableListenLog: true, middleware: (http) => http.pipe(Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.mebibytes(12))) })
    .pipe(Layer.provide(authLayer), Layer.provide(NodeHttpServer.layer(createServer, { host: settings.host ?? "127.0.0.1", port: settings.port })))
  yield* Effect.scoped(Effect.gen(function*() {
    yield* archiveWorkflow.start
    yield* Layer.build(server)
    yield* Effect.sync(() => { process.stderr.write(`Pocket MCP ready (${settings.host ?? "127.0.0.1"}:${settings.port}).\n`) })
    yield* Effect.never
  }))
}).pipe(Effect.mapError(() => failure("configuration", "Could not start the Pocket MCP transport. Check the configured port and runtime.")), Effect.provideService(Logger.LogToStderr, true))
