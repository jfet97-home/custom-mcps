import { Schema } from "effect"
import { contentHash } from "./backups.js"
import { decode, failure } from "./core.js"

export const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/))
const maybeString = Schema.optionalKey(Schema.NullOr(Schema.String))
export const Recording = Schema.Struct({
  id: Id, title: Schema.String, description: maybeString,
  duration: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  recordingAt: maybeString, createdAt: maybeString, updatedAt: maybeString,
  folderId: maybeString, workspaceId: maybeString, recordingType: maybeString,
  hasTranscription: Schema.optionalKey(Schema.Boolean), hasSummarization: Schema.optionalKey(Schema.Boolean)
})
export const Segment = Schema.Struct({
  text: Schema.optionalKey(Schema.String), originalText: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(Schema.Number), end: Schema.optionalKey(Schema.Number),
  speaker: maybeString, speakerLabel: maybeString, speakerId: maybeString
})
const Summary = Schema.Struct({
  markdown: Schema.String,
  version: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  edited: Schema.optionalKey(Schema.Boolean), editedAt: maybeString
})
const Summarization = Schema.Struct({
  id: Id, summarizationId: Id, processingStatus: maybeString,
  version: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  createdAt: maybeString, updatedAt: maybeString,
  v2: Schema.optionalKey(Schema.NullOr(Schema.Struct({ summary: Schema.optionalKey(Schema.NullOr(Summary)) }))),
  summary: Schema.optionalKey(Schema.NullOr(Summary))
})
export const RecordingDetail = Schema.Struct({
  recording: Recording,
  transcription: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    id: Id, transcriptionId: Id, processingStatus: maybeString, updatedAt: maybeString,
    transcription: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      text: Schema.optionalKey(Schema.String), segments: Schema.Array(Segment)
    })))
  }))),
  summarizations: Schema.Record(Schema.String, Summarization)
})
export type RecordingDetail = typeof RecordingDetail.Type

export const notesFrom = (raw: unknown, selectedId?: string) => {
  const detail = decode(RecordingDetail, raw)
  const versions = Object.values(detail.summarizations).sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))
  const selected = selectedId === undefined ? versions[0] : versions.find((entry) => entry.summarizationId === selectedId)
  if (!selected) throw failure("validation", "The selected summarization does not exist on this recording.")
  const summary = selected.v2?.summary ?? selected.summary
  if (!summary) throw failure("validation", "This summarization has no Markdown Notes yet.")
  return {
    recordingId: detail.recording.id,
    summarizationId: selected.summarizationId,
    rowId: selected.id,
    markdown: summary.markdown,
    hash: contentHash(summary.markdown),
    version: summary.version ?? null,
    summarizationVersion: selected.version ?? null,
    updatedAt: selected.updatedAt ?? null,
    edited: summary.edited ?? false, editedAt: summary.editedAt ?? null,
    selection: selectedId === undefined ? "latest_updated" as const : "explicit" as const,
    availableVersions: versions.map((entry) => ({ summarizationId: entry.summarizationId, rowId: entry.id, updatedAt: entry.updatedAt ?? null, version: entry.version ?? null }))
  }
}

export const transcriptFrom = (raw: unknown) => {
  const detail = decode(RecordingDetail, raw)
  const transcription = detail.transcription
  if (!transcription?.transcription) throw failure("validation", "This recording has no completed segmented transcript.")
  const segments = transcription.transcription.segments
  return {
    recordingId: detail.recording.id,
    transcriptionId: transcription.transcriptionId,
    rowId: transcription.id,
    text: segments.map((segment) => segment.text ?? segment.originalText ?? "").join("\n"),
    segments: segments.map((segment, segmentIndex) => ({ ...segment, segmentIndex })),
    hash: contentHash(segments), updatedAt: transcription.updatedAt ?? null
  }
}
