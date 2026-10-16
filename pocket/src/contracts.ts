import { Schema } from "effect"
import { Id, Recording, RecordingDetail, Segment } from "./recording.js"

export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Version = Schema.Union([Schema.String, Schema.Number, Schema.Null])
export const Notes = Schema.Struct({
  recordingId: Id, summarizationId: Id, rowId: Id,
  markdown: Schema.String, hash: Hash, version: Version, summarizationVersion: Version,
  updatedAt: Schema.NullOr(Schema.String), edited: Schema.Boolean, editedAt: Schema.NullOr(Schema.String),
  selection: Schema.Literals(["latest_updated", "explicit"]),
  availableVersions: Schema.Array(Schema.Struct({ summarizationId: Id, rowId: Id, updatedAt: Schema.NullOr(Schema.String), version: Version }))
})
export const IndexedSegment = Schema.Struct({ ...Segment.fields, segmentIndex: Schema.Number })
export const Transcript = Schema.Struct({
  recordingId: Id, transcriptionId: Id, rowId: Id, text: Schema.String,
  segments: Schema.Array(IndexedSegment), hash: Hash, supportsSegmentEdits: Schema.Boolean, updatedAt: Schema.NullOr(Schema.String)
})
export const RecordingWithHashes = Schema.Struct({ ...RecordingDetail.fields,
  contentHashes: Schema.Struct({ transcript: Schema.NullOr(Hash), notes: Schema.Array(Schema.Struct({ summarizationId: Id, hash: Hash })) })
})
export const RecordingPage = Schema.Struct({
  data: Schema.Array(Recording), totalCount: Schema.Number, totalPages: Schema.Number, currentPage: Schema.Number
})
export const SearchPage = Schema.Struct({
  data: Schema.Struct({ recordings: Schema.Array(Recording) }),
  metadata: Schema.Struct({ total: Schema.Number, page: Schema.optionalKey(Schema.Number), limit: Schema.optionalKey(Schema.Number) })
})
export const ActionItem = Schema.Struct({
  id: Id, title: Schema.NullOr(Schema.String),
  recordingId: Schema.optionalKey(Schema.NullOr(Id)), summarizationId: Schema.optionalKey(Schema.NullOr(Id)),
  parentTaskId: Schema.optionalKey(Schema.NullOr(Id)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dueDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  completedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isCompleted: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  version: Schema.optionalKey(Schema.NullOr(Schema.Number)), updatedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  priority: Schema.optionalKey(Schema.NullOr(Schema.String)), category: Schema.optionalKey(Schema.NullOr(Schema.String))
})
export const ActionItemWithHash = Schema.Struct({ ...ActionItem.fields, hash: Hash })
export const ActionPagination = Schema.Struct({ limit: Schema.Number, offset: Schema.Number, total: Schema.Number, returned: Schema.Number })
export const RawActionPage = Schema.Struct({ success: Schema.Boolean, data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)), pagination: ActionPagination })
export const ActionPage = Schema.Struct({ items: Schema.Array(ActionItemWithHash), pagination: ActionPagination })

export interface Folder {
  readonly id: string; readonly name: string; readonly kind?: string
  readonly parentFolderId?: string | null; readonly spaceId?: string | null
  readonly recordingCount?: number; readonly totalRecordingCount?: number
  readonly children?: ReadonlyArray<Folder>
}
export const Folder: Schema.Codec<Folder> = Schema.Struct({
  id: Id, name: Schema.String, kind: Schema.optionalKey(Schema.String),
  parentFolderId: Schema.optionalKey(Schema.NullOr(Id)), spaceId: Schema.optionalKey(Schema.NullOr(Id)),
  recordingCount: Schema.optionalKey(Schema.Number), totalRecordingCount: Schema.optionalKey(Schema.Number),
  children: Schema.optionalKey(Schema.Array(Schema.suspend(() => Folder)))
})
export const Folders = Schema.Struct({ data: Schema.Array(Folder) })
export const Account = Schema.Struct({
  id: Id, email: Schema.String, displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isActive: Schema.Boolean, authProvider: Schema.optionalKey(Schema.String),
  emailVerified: Schema.optionalKey(Schema.Boolean), timezone: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subscriptionType: Schema.String
})
export const Space = Schema.Struct({ id: Id, name: Schema.String })
export const Spaces = Schema.Struct({ available: Schema.Boolean, organizationId: Schema.NullOr(Id), spaces: Schema.Array(Space) })
export const WriteResult = Schema.Struct({
  recordingId: Id, hash: Hash, backupId: Schema.String,
  concurrency: Schema.Literal("client_side_compare"), verified: Schema.Literal(true)
})

export const ArchiveSource = Schema.Literals(["backfill", "workflow", "draft", "final"])
export const ArchiveSnapshotInput = Schema.Struct({
  recordingId: Id, capturedAt: Schema.String, metadata: Schema.Unknown, raw: Schema.Unknown,
  transcript: Schema.NullOr(Transcript), notes: Schema.Array(Notes), source: Schema.Literals(["backfill", "workflow"]),
  decodeError: Schema.optionalKey(Schema.String)
})
export const ArchiveSearchResult = Schema.Struct({
  results: Schema.Array(Schema.Struct({ recordingId: Id, title: Schema.NullOr(Schema.String), kind: Schema.String, excerpt: Schema.String, capturedAt: Schema.String })),
  pagination: Schema.Struct({ limit: Schema.Number, offset: Schema.Number, total: Schema.Number })
})
export const ArchiveRecordingRead = Schema.Struct({
  recordingId: Id, metadata: Schema.Unknown, firstSeenAt: Schema.String, lastSeenAt: Schema.String,
  snapshots: Schema.Array(Schema.Struct({ capturedAt: Schema.String, source: Schema.String, raw: Schema.Unknown })),
  transcriptVersions: Schema.Array(Schema.Struct({ capturedAt: Schema.String, source: Schema.String, transcript: Transcript })),
  notesVersions: Schema.Array(Schema.Struct({ capturedAt: Schema.String, source: ArchiveSource, notes: Notes })),
  events: Schema.Array(Schema.Struct({ id: Schema.String, receivedAt: Schema.String, eventType: Schema.NullOr(Schema.String), state: Schema.String, payload: Schema.Unknown, rawBodyBase64: Schema.String })),
  drafts: Schema.Array(Schema.Struct({ id: Schema.String, savedAt: Schema.String, hash: Hash, markdown: Schema.String, contextId: Schema.String })),
  jobs: Schema.Array(Schema.Struct({ id: Schema.String, eventType: Schema.String, state: Schema.String, createdAt: Schema.String, updatedAt: Schema.String, attempts: Schema.Number, lastError: Schema.NullOr(Schema.String) }))
})
export const ArchiveEventRead = Schema.Struct({
  id: Schema.String, receivedAt: Schema.String, eventType: Schema.NullOr(Schema.String), recordingId: Schema.NullOr(Id),
  state: Schema.String, payload: Schema.Unknown, rawBodyBase64: Schema.String, jobIds: Schema.Array(Schema.String)
})
export const ArchiveStatus = Schema.Struct({
  recordings: Schema.Number, apiSnapshots: Schema.Number, transcriptVersions: Schema.Number,
  notesVersions: Schema.Number, webhookEvents: Schema.Number, queuedJobs: Schema.Number,
  activeLeases: Schema.Number, failedJobs: Schema.Number, lastBridgeSyncAt: Schema.NullOr(Schema.String),
  bridgeConfigured: Schema.Boolean, bridgeLastError: Schema.NullOr(Schema.String), writesEnabled: Schema.Boolean,
  backfill: Schema.Struct({ nextPage: Schema.Number, complete: Schema.Boolean, lastRunAt: Schema.NullOr(Schema.String), failedRecordings: Schema.Array(Schema.Struct({ recordingId: Id, code: Schema.String })) })
})
export const ArchiveBackfillResult = Schema.Struct({
  pagesRead: Schema.Number, recordingsRead: Schema.Number, snapshotsWritten: Schema.Number,
  nextPage: Schema.Number, complete: Schema.Boolean,
  failedRecordings: Schema.Array(Schema.Struct({ recordingId: Id, code: Schema.String }))
})
export const ArchiveJob = Schema.Struct({
  id: Schema.String, recordingId: Id, eventType: Schema.String, state: Schema.String,
  createdAt: Schema.String, updatedAt: Schema.String, attempts: Schema.Number,
  fencingToken: Schema.Number, leaseUntil: Schema.NullOr(Schema.String), lastError: Schema.NullOr(Schema.String),
  draftId: Schema.NullOr(Schema.String), reconcileState: Schema.NullOr(Schema.String)
})
export const ArchiveJobClaim = Schema.Struct({
  job: Schema.NullOr(ArchiveJob), leaseToken: Schema.NullOr(Schema.String), fencingToken: Schema.NullOr(Schema.Number), leaseUntil: Schema.NullOr(Schema.String)
})
export const ArchiveJobContext = Schema.Struct({
  contextId: Schema.String, jobId: Schema.String, recordingId: Id, transcript: Transcript,
  notes: Notes, capturedAt: Schema.String
})
export const ArchiveSourcePage = Schema.Struct({
  contextId: Schema.String, jobId: Schema.String, recordingId: Id, transcriptionId: Id, transcriptHash: Hash,
  summarizationId: Id, notesHash: Hash,
  source: Schema.Literals(["transcript", "notes"]), cursor: Schema.Number, nextCursor: Schema.NullOr(Schema.Number),
  totalCharacters: Schema.Number, sourceHash: Hash, chunkHash: Hash, content: Schema.String
})
export const ArchiveDraftResult = Schema.Struct({ draftId: Schema.String, hash: Hash, savedAt: Schema.String, state: Schema.String })
export const ArchiveJobSaveResult = Schema.Struct({
  state: Schema.Literals(["complete", "uncertain", "conflict", "source_gone", "needs_review"]), jobId: Schema.String,
  recordingId: Id, draftId: Schema.String, reconciliation: Schema.NullOr(Schema.String),
  notesHash: Schema.NullOr(Hash), retryAllowed: Schema.Boolean
})
export const ArchiveJobFinishResult = Schema.Struct({ jobId: Schema.String, state: Schema.Literals(["needs_review", "source_gone", "skipped"]), eventsCompleted: Schema.Boolean })
export const ArchiveBridgeSyncResult = Schema.Struct({
  configured: Schema.Boolean, pagesRead: Schema.Number, eventsRead: Schema.Number,
  archived: Schema.Number, completed: Schema.Number, jobsCreated: Schema.Number,
  lastCursor: Schema.NullOr(Schema.String), lastError: Schema.NullOr(Schema.String)
})
