import { Schema } from "effect"
import { Id, Recording, Segment } from "./recording.js"

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
  segments: Schema.Array(IndexedSegment), hash: Hash, updatedAt: Schema.NullOr(Schema.String)
})
export const RecordingPage = Schema.Struct({
  data: Schema.Array(Recording), totalCount: Schema.Number, totalPages: Schema.Number, currentPage: Schema.Number
})
export const SearchPage = Schema.Struct({
  data: Schema.Struct({ recordings: Schema.Array(Recording) }),
  metadata: Schema.Struct({ total: Schema.Number, page: Schema.optionalKey(Schema.Number), limit: Schema.optionalKey(Schema.Number) })
})
export const ActionItem = Schema.Struct({
  id: Id, title: Schema.String,
  recordingId: Schema.NullOr(Id), summarizationId: Schema.optionalKey(Schema.NullOr(Id)),
  parentTaskId: Schema.optionalKey(Schema.NullOr(Id)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dueDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.String),
  completedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isCompleted: Schema.optionalKey(Schema.Boolean),
  version: Schema.optionalKey(Schema.Number), updatedAt: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(Schema.String), category: Schema.optionalKey(Schema.String)
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
  id: Id, email: Schema.String, displayName: Schema.optionalKey(Schema.String),
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
