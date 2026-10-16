import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { chmod, lstat, open } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Context, Effect, Layer, Schema } from "effect"
import lockfile from "proper-lockfile"
import { ArchiveJob as ArchiveJobSchema, ArchiveSnapshotInput, ArchiveSource, Notes, Transcript } from "./contracts.js"
import { attempt, failure, privateDirectory, PocketError, Settings } from "./core.js"
import { canonicalJson, contentHash, normalizeMarkdown } from "./backups.js"

export type ArchiveSnapshot = typeof ArchiveSnapshotInput.Type
export type ArchiveSourceName = typeof ArchiveSource.Type
export type TranscriptDocument = typeof Transcript.Type
export type NotesDocument = typeof Notes.Type

export interface BridgeEventInput {
  readonly id: string
  readonly receivedAt: string
  readonly payload: unknown
  readonly rawBodyBase64: string
  readonly eventType?: string | null
  readonly phase?: string
  readonly seq?: number
}

export interface JobLease {
  readonly job: typeof ArchiveJobSchema.Type
  readonly leaseToken: string
  readonly fencingToken: number
  readonly leaseUntil: string
}

export interface JobContextInput {
  readonly contextId: string
  readonly jobId: string
  readonly fencingToken: number
  readonly recordingId: string
  readonly transcriptionId: string
  readonly transcriptHash: string
  readonly notesSelection: "latest" | "explicit"
  readonly summarizationId: string
  readonly notesHash: string
  readonly notesRowId: string
  readonly transcript: TranscriptDocument
  readonly notes: NotesDocument
  readonly capturedAt: string
}

export interface BackfillFailure {
  readonly recordingId: string
  readonly code: string
}

export interface ArchiveService {
  readonly assertExclusive: Effect.Effect<void, PocketError>
  readonly recordSnapshot: (snapshot: ArchiveSnapshot) => Effect.Effect<void, PocketError>
  readonly search: (query: string, limit: number, offset: number) => Effect.Effect<unknown, PocketError>
  readonly read: (recordingId: string, limit: number) => Effect.Effect<unknown, PocketError>
  readonly readEvent: (eventId: string) => Effect.Effect<unknown, PocketError>
  readonly status: (bridge: { configured: boolean; error: string | null; writesEnabled: boolean }) => Effect.Effect<unknown, PocketError>
  readonly backfillState: Effect.Effect<{ readonly nextPage: number; readonly complete: boolean; readonly lastRunAt: string | null; readonly failedRecordings: ReadonlyArray<BackfillFailure> }, PocketError>
  readonly setBackfillState: (state: { readonly nextPage: number; readonly complete: boolean; readonly lastRunAt: string; readonly failedRecordings: ReadonlyArray<BackfillFailure> }) => Effect.Effect<void, PocketError>
  readonly bridgeCursor: Effect.Effect<string | null, PocketError>
  readonly setBridgeCursor: (cursor: string | null) => Effect.Effect<void, PocketError>
  readonly setBridgeStatus: (status: { readonly configured: boolean; readonly error: string | null; readonly syncedAt?: string }) => Effect.Effect<void, PocketError>
  readonly importWebhook: (event: BridgeEventInput, ownerId: string) => Effect.Effect<{ readonly phase: "archived" | "complete"; readonly inserted: boolean; readonly jobCreated: boolean }, PocketError>
  readonly recoverSaving: Effect.Effect<void, PocketError>
  readonly listJobs: (recordingId: string | undefined, limit: number) => Effect.Effect<ReadonlyArray<typeof ArchiveJobSchema.Type>, PocketError>
  readonly claimNext: (leaseMs: number) => Effect.Effect<JobLease | null, PocketError>
  readonly renewLease: (jobId: string, leaseToken: string, fencingToken: number, leaseMs: number) => Effect.Effect<JobLease, PocketError>
  readonly getJob: (jobId: string) => Effect.Effect<typeof ArchiveJobSchema.Type, PocketError>
  readonly createContext: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, context: Omit<JobContextInput, "jobId" | "fencingToken">) => Effect.Effect<{ readonly contextId: string }, PocketError>
  readonly getContext: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, contextId: string) => Effect.Effect<JobContextInput, PocketError>
  readonly trackSourcePage: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, input: { readonly contextId: string; readonly source: "transcript" | "notes"; readonly start: number; readonly end: number; readonly total: number; readonly hash: string; readonly chunkHash: string }) => Effect.Effect<void, PocketError>
  readonly persistDraft: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, contextId: string, markdown: string, allowShorter: boolean) => Effect.Effect<{ readonly draftId: string; readonly hash: string; readonly savedAt: string }, PocketError>
  readonly getDraftContext: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }) => Effect.Effect<{ readonly draftId: string; readonly contextId: string; readonly markdown: string; readonly hash: string; readonly context: JobContextInput; readonly state: string; readonly reconcileState: string | null; readonly saveRetries: number }, PocketError>
  readonly markSaving: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, draftId: string, contextId: string) => Effect.Effect<void, PocketError>
  readonly resetDrafted: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }) => Effect.Effect<void, PocketError>
  readonly setReconcileState: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, state: "pending" | "retry_safe" | "conflict" | "needs_review", message: string) => Effect.Effect<void, PocketError>
  readonly completeJob: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, notes: NotesDocument, completedAt: string) => Effect.Effect<void, PocketError>
  readonly finishJob: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, state: "needs_review" | "source_gone" | "skipped", reason: string) => Effect.Effect<void, PocketError>
  readonly finishSourceGone: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, reason: string) => Effect.Effect<void, PocketError>
  readonly retryJob: (jobId: string) => Effect.Effect<void, PocketError>
  readonly failJob: (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, reason: string) => Effect.Effect<void, PocketError>
}

export class Archive extends Context.Service<Archive, ArchiveService>()("pocket/Archive") {}

type SqlRow = Record<string, unknown>
const asRow = (value: unknown): SqlRow => value as SqlRow
const json = (value: unknown): string => {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw failure("storage", "Archive content could not be encoded.")
  return serialized
}
const parseJson = <A>(value: unknown): A => JSON.parse(String(value)) as A
const utcNow = (): string => new Date().toISOString()
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const readyEvents = new Set(["summary.completed", "summary.regenerated", "transcript.edited", "speakers.labeled"])
const ackEventId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

const schemaSql = `
  PRAGMA journal_mode = DELETE;
  PRAGMA synchronous = FULL;
  PRAGMA trusted_schema = OFF;
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS recordings (
    recording_id TEXT PRIMARY KEY,
    metadata_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS api_snapshots (
    snapshot_id INTEGER PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(recording_id),
    captured_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('backfill', 'workflow')),
    content_hash TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    UNIQUE(recording_id, source, content_hash)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS transcript_versions (
    version_id INTEGER PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(recording_id),
    transcription_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('backfill', 'workflow')),
    document_json TEXT NOT NULL,
    UNIQUE(recording_id, transcription_id, content_hash, source)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS notes_versions (
    version_id INTEGER PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(recording_id),
    summarization_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('backfill', 'workflow', 'draft', 'final')),
    markdown TEXT NOT NULL,
    document_json TEXT NOT NULL,
    UNIQUE(recording_id, summarization_id, content_hash, source)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS search_documents (
    document_id INTEGER PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(recording_id),
    kind TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    text TEXT NOT NULL,
    UNIQUE(recording_id, kind, document_hash)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS search_recording_idx ON search_documents(recording_id, captured_at DESC);
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    event_type TEXT,
    recording_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('archived', 'complete')),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    raw_body_base64 TEXT NOT NULL,
    sequence_number INTEGER,
    imported_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS webhook_recording_idx ON webhook_events(recording_id, received_at DESC);
  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(recording_id),
    event_type TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'sources_ready', 'drafted', 'saving', 'uncertain', 'conflict', 'needs_review', 'source_gone', 'skipped', 'failed', 'complete')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    save_retries INTEGER NOT NULL DEFAULT 0,
    fencing_token INTEGER NOT NULL DEFAULT 0,
    lease_token_hash TEXT,
    lease_until INTEGER,
    context_id TEXT,
    draft_id TEXT,
    reconcile_state TEXT,
    last_error TEXT,
    completed_at TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(state, lease_until, created_at);
  CREATE INDEX IF NOT EXISTS jobs_recording_idx ON jobs(recording_id, state, created_at);
  CREATE TABLE IF NOT EXISTS event_jobs (
    event_id TEXT NOT NULL REFERENCES webhook_events(event_id),
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    PRIMARY KEY(event_id, job_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS job_contexts (
    context_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    fencing_token INTEGER NOT NULL,
    recording_id TEXT NOT NULL,
    transcription_id TEXT NOT NULL,
    transcript_hash TEXT NOT NULL,
    notes_selection TEXT NOT NULL CHECK (notes_selection IN ('latest','explicit')),
    summarization_id TEXT NOT NULL,
    notes_hash TEXT NOT NULL,
    notes_row_id TEXT NOT NULL,
    transcript_json TEXT NOT NULL,
    notes_json TEXT NOT NULL,
    captured_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS job_drafts (
    draft_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id),
    context_id TEXT NOT NULL REFERENCES job_contexts(context_id),
    fencing_token INTEGER NOT NULL,
    markdown TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    saved_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS job_source_pages (
    context_id TEXT NOT NULL REFERENCES job_contexts(context_id),
    source TEXT NOT NULL CHECK (source IN ('transcript','notes')),
    page_start INTEGER NOT NULL,
    page_end INTEGER NOT NULL,
    total_characters INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    PRIMARY KEY(context_id, source, page_start, page_end)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS final_notes (
    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
    recording_id TEXT NOT NULL,
    summarization_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    markdown TEXT NOT NULL,
    completed_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS final_notes_echo_idx ON final_notes(recording_id, summarization_id, content_hash);
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO sync_state(key, value) VALUES ('backfill_page', '1'), ('backfill_complete', '0'), ('backfill_failures', '[]');
  PRAGMA user_version = 2;
`

const transaction = <A>(database: DatabaseSync, run: () => A): A => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const value = run()
    database.exec("COMMIT")
    return value
  } catch (error) {
    try { database.exec("ROLLBACK") } catch { /* ignore a failed rollback */ }
    throw error
  }
}

const databaseEffectBase = <A>(run: () => A, message = "The private Pocket archive operation failed."): Effect.Effect<A, PocketError> =>
  Effect.try({ try: run, catch: (error) => error instanceof PocketError ? error : failure("storage", message) })

const tokenDigest = (token: string): string => contentHash(token)
const safeSame = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const readJob = (row: SqlRow): typeof ArchiveJobSchema.Type => {
  const leaseUntil = typeof row.lease_until === "number" ? new Date(row.lease_until).toISOString() : null
  return Schema.decodeUnknownSync(ArchiveJobSchema)({
    id: row.job_id, recordingId: row.recording_id, eventType: row.event_type, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at, attempts: row.attempts,
    fencingToken: row.fencing_token, leaseUntil, lastError: row.last_error ?? null,
    draftId: row.draft_id ?? null, reconcileState: row.reconcile_state ?? null
  })
}

const readContext = (row: SqlRow): JobContextInput => ({
  contextId: String(row.context_id), jobId: String(row.job_id), fencingToken: Number(row.fencing_token),
  recordingId: String(row.recording_id), transcriptionId: String(row.transcription_id), transcriptHash: String(row.transcript_hash),
  notesSelection: row.notes_selection === "latest" ? "latest" : "explicit",
  summarizationId: String(row.summarization_id), notesHash: String(row.notes_hash), notesRowId: String(row.notes_row_id),
  transcript: parseJson(row.transcript_json), notes: parseJson(row.notes_json), capturedAt: String(row.captured_at)
})

export const canonicalTranscriptSource = (transcript: TranscriptDocument): string => JSON.stringify({
  recordingId: transcript.recordingId,
  transcriptionId: transcript.transcriptionId,
  rowId: transcript.rowId,
  hash: transcript.hash,
  supportsSegmentEdits: transcript.supportsSegmentEdits,
  ...(transcript.supportsSegmentEdits ? {} : { text: transcript.text }),
  segments: transcript.segments.map((segment) => {
    const text = segment.text ?? segment.originalText ?? ""
    return {
      segmentIndex: segment.segmentIndex,
      ...(segment.start === undefined ? {} : { start: segment.start }),
      ...(segment.end === undefined ? {} : { end: segment.end }),
      ...(segment.speaker === undefined ? {} : { speaker: segment.speaker }),
      ...(segment.speakerLabel === undefined ? {} : { speakerLabel: segment.speakerLabel }),
      ...(segment.speakerId === undefined ? {} : { speakerId: segment.speakerId }),
      text,
      ...(segment.originalText === undefined || segment.originalText === text ? {} : { originalText: segment.originalText })
    }
  })
})

const sourceContent = (context: JobContextInput, source: "transcript" | "notes"): string =>
  source === "transcript" ? canonicalTranscriptSource(context.transcript) : context.notes.markdown

interface ArchiveHandle {
  readonly database: DatabaseSync
  readonly release: () => Promise<void>
  readonly lockHealth: { compromised: boolean }
}

const openArchive = async (dataDir: string): Promise<ArchiveHandle> => {
  await privateDirectory(dataDir)
  const path = join(dataDir, "archive.sqlite")
  await open(path, "wx", 0o600).then((handle) => handle.close(), (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw failure("storage", "The archive database must be a private regular file.")
  if (existing && (existing.mode & 0o077) !== 0) throw failure("storage", "The archive database has unsafe permissions; set it to mode 0600 before retrying.")
  const lockHealth = { compromised: false }
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(path, {
      stale: 60000, update: 20000, retries: 0,
      onCompromised: () => { lockHealth.compromised = true }
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw failure("storage", "Another Pocket server process owns the private archive lock.")
    throw error
  }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { timeout: 5000 })
    await chmod(path, 0o600)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw failure("storage", "The archive database must be a private regular file with mode 0600.")
    database.exec(schemaSql)
    const contextColumns = database.prepare("PRAGMA table_info(job_contexts)").all() as SqlRow[]
    if (!contextColumns.some((column) => column.name === "notes_selection")) {
      database.exec("ALTER TABLE job_contexts ADD COLUMN notes_selection TEXT NOT NULL DEFAULT 'explicit' CHECK (notes_selection IN ('latest','explicit'))")
    }
    database.exec("PRAGMA user_version = 2")
    return { database, release: release!, lockHealth }
  } catch (error) {
    database?.close()
    if (release) await release().catch(() => undefined)
    throw error
  }
}

const makeArchive = (database: DatabaseSync, lockHealth: ArchiveHandle["lockHealth"]): ArchiveService => {
  const databaseEffect = <A>(run: () => A, message = "The private Pocket archive operation failed."): Effect.Effect<A, PocketError> =>
    databaseEffectBase(() => {
      if (lockHealth.compromised) throw failure("storage", "The private archive process lock was lost; this server will not access the database again.")
      return run()
    }, message)
  const insertSearchDocument = (recordingId: string, kind: string, hash: string, capturedAt: string, text: string) => {
    if (!text) return
    database.prepare(`INSERT INTO search_documents(recording_id,kind,document_hash,captured_at,text) VALUES(?,?,?,?,?)
      ON CONFLICT(recording_id,kind,document_hash) DO UPDATE SET captured_at=excluded.captured_at,text=excluded.text`)
      .run(recordingId, kind, hash, capturedAt, text)
  }
  const insertNotesVersion = (recordingId: string, notes: NotesDocument, capturedAt: string, source: ArchiveSourceName) => {
    const notesHash = contentHash(notes.markdown)
    const document = { ...notes, hash: notesHash }
    database.prepare(`INSERT OR IGNORE INTO notes_versions(recording_id,summarization_id,row_id,content_hash,captured_at,source,markdown,document_json)
      VALUES(?,?,?,?,?,?,?,?)`).run(recordingId, notes.summarizationId, notes.rowId, notesHash, capturedAt, source, notes.markdown, json(document))
    insertSearchDocument(recordingId, "notes", `${notes.summarizationId}:${notesHash}:${source}`, capturedAt, notes.markdown)
  }
  const rowByJobId = (jobId: string): SqlRow => {
    const row = database.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId)
    if (!row) throw failure("validation", "The archive job does not exist.")
    return asRow(row)
  }
  const requireLease = (jobId: string, leaseToken: string, fencingToken: number): SqlRow => {
    const row = rowByJobId(jobId)
    const stored = row.lease_token_hash
    const until = row.lease_until
    if (typeof stored !== "string" || typeof until !== "number" || until <= Date.now() || row.fencing_token !== fencingToken || !safeSame(stored, tokenDigest(leaseToken))) {
      throw failure("conflict", "The archive job lease expired or was replaced. Claim the job again before continuing.")
    }
    if (row.state === "complete" || row.state === "failed") throw failure("conflict", "The archive job is no longer active.")
    return row
  }
  const recordSnapshotTx = (snapshot: ArchiveSnapshot): void => {
    const capturedAt = new Date(snapshot.capturedAt)
    const metadata = asRecord(snapshot.metadata)
      if (!Number.isFinite(capturedAt.valueOf()) || metadata?.id !== snapshot.recordingId ||
      snapshot.transcript && snapshot.transcript.recordingId !== snapshot.recordingId ||
      snapshot.notes.some((notes) => notes.recordingId !== snapshot.recordingId)) {
      throw failure("validation", "The archived recording snapshot is internally inconsistent.")
    }
    const serializedMetadata = json(snapshot.metadata)
    database.prepare(`INSERT INTO recordings(recording_id,metadata_json,first_seen_at,last_seen_at) VALUES(?,?,?,?)
      ON CONFLICT(recording_id) DO UPDATE SET metadata_json=excluded.metadata_json,last_seen_at=excluded.last_seen_at`)
      .run(snapshot.recordingId, serializedMetadata, snapshot.capturedAt, snapshot.capturedAt)
    const rawHash = contentHash(snapshot.raw)
    database.prepare(`INSERT OR IGNORE INTO api_snapshots(recording_id,captured_at,source,content_hash,raw_json) VALUES(?,?,?,?,?)`)
      .run(snapshot.recordingId, snapshot.capturedAt, snapshot.source, rawHash, json(snapshot.raw))
    const title = typeof metadata.title === "string" ? metadata.title : ""
    const description = typeof metadata.description === "string" ? metadata.description : ""
    insertSearchDocument(snapshot.recordingId, "recording", rawHash, snapshot.capturedAt, `${title}\n${description}`)
    if (snapshot.transcript) {
      const transcriptHash = contentHash(snapshot.transcript)
      database.prepare(`INSERT OR IGNORE INTO transcript_versions(recording_id,transcription_id,content_hash,captured_at,source,document_json)
        VALUES(?,?,?,?,?,?)`).run(snapshot.recordingId, snapshot.transcript.transcriptionId, transcriptHash, snapshot.capturedAt, snapshot.source, json(snapshot.transcript))
      insertSearchDocument(snapshot.recordingId, "transcript", `${snapshot.transcript.transcriptionId}:${transcriptHash}:${snapshot.source}`, snapshot.capturedAt, snapshot.transcript.text)
    }
    for (const notes of snapshot.notes) insertNotesVersion(snapshot.recordingId, notes, snapshot.capturedAt, snapshot.source)
  }
  const currentBackfill = () => {
    const values = database.prepare("SELECT key,value FROM sync_state WHERE key IN ('backfill_page','backfill_complete','backfill_last_run','backfill_failures')").all() as SqlRow[]
    const state = new Map(values.map((row) => [String(row.key), String(row.value)]))
    const parsed = parseJson<unknown>(state.get("backfill_failures") ?? "[]")
    const failedRecordings = Array.isArray(parsed) ? parsed.filter((item): item is BackfillFailure =>
      typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).recordingId === "string" && typeof (item as Record<string, unknown>).code === "string") : []
    return { nextPage: Math.max(1, Number(state.get("backfill_page") ?? "1")), complete: state.get("backfill_complete") === "1", lastRunAt: state.get("backfill_last_run") ?? null, failedRecordings }
  }
  const recoverExpiredSavingTx = () => database.prepare(`UPDATE jobs SET state='uncertain',reconcile_state='pending',last_error='save lease expired while outcome required reconciliation',
    lease_token_hash=NULL,lease_until=NULL,updated_at=? WHERE state='saving' AND (lease_until IS NULL OR lease_until<=?)`).run(utcNow(), Date.now())
  const eventEcho = (recordingId: string | undefined, candidates: ReadonlyArray<{ summarizationId: string; markdown: string }>): boolean => {
    if (!recordingId || candidates.length === 0) return false
    for (const candidate of candidates) {
      const rows = database.prepare("SELECT markdown FROM final_notes WHERE recording_id=? AND summarization_id=?")
        .all(recordingId, candidate.summarizationId) as SqlRow[]
      const pending = database.prepare(`SELECT d.markdown FROM jobs j JOIN job_contexts c ON c.context_id=j.context_id
        JOIN job_drafts d ON d.draft_id=j.draft_id WHERE j.recording_id=? AND c.summarization_id=? AND j.state IN ('saving','uncertain')`)
        .all(recordingId, candidate.summarizationId) as SqlRow[]
      if ([...rows, ...pending].some((row) => normalizeMarkdown(String(row.markdown)) === normalizeMarkdown(candidate.markdown))) return true
    }
    return false
  }
  return {
    assertExclusive: databaseEffect(() => undefined),
    recordSnapshot: (snapshot) => databaseEffect(() => transaction(database, () => recordSnapshotTx(Schema.decodeUnknownSync(ArchiveSnapshotInput)(snapshot)))),
    search: (query, limit, offset) => databaseEffect(() => {
      const trimmed = query.trim()
      if (!trimmed) throw failure("validation", "Provide a nonempty archive search query.")
      const count = asRow(database.prepare("SELECT COUNT(*) AS total FROM search_documents WHERE instr(lower(text),lower(?)) > 0").get(trimmed)).total
      const rows = database.prepare(`SELECT s.recording_id,r.metadata_json,s.kind,s.captured_at,s.text
        FROM search_documents s JOIN recordings r USING(recording_id)
        WHERE instr(lower(s.text),lower(?)) > 0 ORDER BY s.captured_at DESC,s.document_id DESC LIMIT ? OFFSET ?`).all(trimmed, limit, offset) as SqlRow[]
      return {
        results: rows.map((row) => {
          const metadata = parseJson<Record<string, unknown>>(row.metadata_json)
          const text = String(row.text)
          return { recordingId: String(row.recording_id), title: typeof metadata.title === "string" ? metadata.title : null,
            kind: String(row.kind), excerpt: text.slice(0, 600), capturedAt: String(row.captured_at) }
        }), pagination: { limit, offset, total: Number(count ?? 0) }
      }
    }),
    read: (recordingId, limit) => databaseEffect(() => {
      const base = database.prepare("SELECT metadata_json,first_seen_at,last_seen_at FROM recordings WHERE recording_id=?").get(recordingId)
      if (!base) throw failure("validation", "The recording is not present in the local archive.")
      const row = asRow(base)
      const snapshots = database.prepare("SELECT captured_at,source,raw_json FROM api_snapshots WHERE recording_id=? ORDER BY captured_at DESC,snapshot_id DESC LIMIT ?").all(recordingId, limit) as SqlRow[]
      const transcripts = database.prepare("SELECT captured_at,source,document_json FROM transcript_versions WHERE recording_id=? ORDER BY captured_at DESC,version_id DESC LIMIT ?").all(recordingId, limit) as SqlRow[]
      const notes = database.prepare("SELECT captured_at,source,document_json FROM notes_versions WHERE recording_id=? ORDER BY captured_at DESC,version_id DESC LIMIT ?").all(recordingId, limit) as SqlRow[]
      const events = database.prepare("SELECT event_id,received_at,event_type,state,payload_json,raw_body_base64 FROM webhook_events WHERE recording_id=? ORDER BY received_at DESC LIMIT ?").all(recordingId, limit) as SqlRow[]
      const jobs = database.prepare("SELECT * FROM jobs WHERE recording_id=? ORDER BY created_at DESC LIMIT ?").all(recordingId, limit) as SqlRow[]
      const drafts = database.prepare("SELECT draft_id,saved_at,content_hash,markdown,context_id FROM job_drafts WHERE job_id IN (SELECT job_id FROM jobs WHERE recording_id=?) ORDER BY saved_at DESC LIMIT ?").all(recordingId, limit) as SqlRow[]
      return {
        recordingId, metadata: parseJson(row.metadata_json), firstSeenAt: String(row.first_seen_at), lastSeenAt: String(row.last_seen_at),
        snapshots: snapshots.map((item) => ({ capturedAt: String(item.captured_at), source: String(item.source), raw: parseJson(item.raw_json) })),
        transcriptVersions: transcripts.map((item) => ({ capturedAt: String(item.captured_at), source: String(item.source), transcript: parseJson(item.document_json) })),
        notesVersions: notes.map((item) => ({ capturedAt: String(item.captured_at), source: String(item.source), notes: parseJson(item.document_json) })),
        events: events.map((item) => ({ id: String(item.event_id), receivedAt: String(item.received_at), eventType: item.event_type === null ? null : String(item.event_type), state: String(item.state), payload: parseJson(item.payload_json), rawBodyBase64: String(item.raw_body_base64) })),
        drafts: drafts.map((item) => ({ id: String(item.draft_id), savedAt: String(item.saved_at), hash: String(item.content_hash), markdown: String(item.markdown), contextId: String(item.context_id) })),
        jobs: jobs.map((item) => readJob(item))
      }
    }),
    readEvent: (eventId) => databaseEffect(() => {
      const value = database.prepare("SELECT event_id,received_at,event_type,recording_id,state,payload_json,raw_body_base64 FROM webhook_events WHERE event_id=?").get(eventId)
      if (!value) throw failure("validation", "The webhook event is not present in the local archive.")
      const row = asRow(value)
      const links = database.prepare("SELECT job_id FROM event_jobs WHERE event_id=? ORDER BY job_id").all(eventId) as SqlRow[]
      return { id: String(row.event_id), receivedAt: String(row.received_at), eventType: row.event_type === null ? null : String(row.event_type),
        recordingId: row.recording_id === null ? null : String(row.recording_id), state: String(row.state), payload: parseJson(row.payload_json), rawBodyBase64: String(row.raw_body_base64), jobIds: links.map((link) => String(link.job_id)) }
    }),
    status: (bridge) => databaseEffect(() => {
      const count = (table: string, where = "") => Number(asRow(database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get()).count ?? 0)
      const jobs = database.prepare("SELECT state,COUNT(*) AS count FROM jobs GROUP BY state").all() as SqlRow[]
      const grouped = new Map(jobs.map((item) => [String(item.state), Number(item.count)]))
      const state = new Map((database.prepare("SELECT key,value FROM sync_state WHERE key LIKE 'bridge_%'").all() as SqlRow[]).map((item) => [String(item.key), String(item.value)]))
      return {
        recordings: count("recordings"), apiSnapshots: count("api_snapshots"), transcriptVersions: count("transcript_versions"),
        notesVersions: count("notes_versions"), webhookEvents: count("webhook_events"), queuedJobs: (grouped.get("queued") ?? 0) + (grouped.get("claimed") ?? 0) + (grouped.get("sources_ready") ?? 0) + (grouped.get("drafted") ?? 0) + (grouped.get("saving") ?? 0) + (grouped.get("uncertain") ?? 0),
        activeLeases: count("jobs", "WHERE lease_until > " + Math.floor(Date.now())), failedJobs: grouped.get("failed") ?? 0,
        lastBridgeSyncAt: state.get("bridge_synced_at") ?? null, bridgeConfigured: bridge.configured,
        bridgeLastError: bridge.error ?? (bridge.configured ? state.get("bridge_error") || null : null), writesEnabled: bridge.writesEnabled, backfill: currentBackfill()
      }
    }),
    backfillState: databaseEffect(currentBackfill),
    setBackfillState: (state) => databaseEffect(() => transaction(database, () => {
      const entries: ReadonlyArray<readonly [string, string]> = [["backfill_page", String(state.nextPage)], ["backfill_complete", state.complete ? "1" : "0"], ["backfill_last_run", state.lastRunAt], ["backfill_failures", json(state.failedRecordings)]]
      for (const [key, value] of entries) {
        database.prepare("INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value)
      }
    })),
    bridgeCursor: databaseEffect(() => {
      const row = database.prepare("SELECT value FROM sync_state WHERE key='bridge_cursor'").get()
      return row ? String(asRow(row).value) : null
    }),
    setBridgeCursor: (cursor) => databaseEffect(() => transaction(database, () => {
      if (cursor === null) database.prepare("DELETE FROM sync_state WHERE key='bridge_cursor'").run()
      else database.prepare("INSERT INTO sync_state(key,value) VALUES('bridge_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cursor)
    })),
    setBridgeStatus: (state) => databaseEffect(() => transaction(database, () => {
      const entries: Array<readonly [string, string]> = [["bridge_configured", state.configured ? "1" : "0"], ["bridge_error", state.error ?? ""]]
      if (state.syncedAt !== undefined) entries.push(["bridge_synced_at", state.syncedAt])
      for (const [key, value] of entries) database.prepare("INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value)
    })),
    recoverSaving: databaseEffect(() => transaction(database, () => {
      recoverExpiredSavingTx()
    })),
    importWebhook: (event, ownerId) => databaseEffect(() => transaction(database, () => {
      if (!ackEventId(event.id) || !Number.isFinite(new Date(event.receivedAt).valueOf()) || typeof event.rawBodyBase64 !== "string") throw failure("validation", "The bridge returned an invalid event envelope.")
      const rawBytes = Buffer.from(event.rawBodyBase64, "base64")
      if (!rawBytes.length || rawBytes.toString("base64") !== event.rawBodyBase64 || rawBytes.byteLength > 12 * 1024 * 1024 || createHash("sha256").update(rawBytes).digest("hex") !== event.id) {
        throw failure("validation", "The bridge event raw body does not match its stable SHA-256 ID.")
      }
      const payloadJson = json(event.payload)
      let parsedRaw: unknown
      try { parsedRaw = JSON.parse(rawBytes.toString("utf8")) } catch { throw failure("validation", "The bridge event raw body is not valid JSON.") }
      if (canonicalJson(parsedRaw) !== canonicalJson(event.payload) || Buffer.byteLength(payloadJson, "utf8") > 12 * 1024 * 1024) throw failure("validation", "The bridge event payload differs from its signed raw body.")
      const payloadHash = contentHash(event.payload)
      const existing = database.prepare("SELECT received_at,payload_hash,raw_body_base64,state FROM webhook_events WHERE event_id=?").get(event.id)
      if (existing) {
        const row = asRow(existing)
        if (row.received_at !== event.receivedAt || row.payload_hash !== payloadHash || row.raw_body_base64 !== event.rawBodyBase64) throw failure("conflict", "The bridge reused an event ID with different content.")
        return { phase: row.state === "complete" ? "complete" as const : "archived" as const, inserted: false, jobCreated: false }
      }
      const payload = asRecord(event.payload)
      const eventType = typeof payload?.event === "string" ? payload.event : null
      if (event.eventType !== undefined && event.eventType !== eventType) throw failure("validation", "The bridge event type differs from its signed payload.")
      const recording = asRecord(payload?.recording)
      const recordingId = safeId(recording?.id) ? recording.id : null
      const user = asRecord(payload?.user)
      if (user?.id !== ownerId) throw failure("permission", "The bridge returned a Pocket event for a different account.")
      const ownerMatches = true
      const summaries = asRecord(payload?.summarizations)
      const candidates = summaries ? Object.entries(summaries).flatMap(([key, raw]) => {
        const value = asRecord(raw)
        const v2 = asRecord(value?.v2)
        const summary = asRecord(v2?.summary)
        const id = safeId(value?.summarizationId) ? value.summarizationId : safeId(key) ? key : undefined
        return id && typeof summary?.markdown === "string" ? [{ summarizationId: id, markdown: summary.markdown }] : []
      }) : []
      const echo = eventEcho(recordingId ?? undefined, candidates)
      const relevant = eventType !== null && readyEvents.has(eventType) && recordingId !== null && ownerMatches && !echo
      let state: "archived" | "complete" = relevant ? "archived" : "complete"
      database.prepare(`INSERT INTO webhook_events(event_id,received_at,event_type,recording_id,state,payload_hash,payload_json,raw_body_base64,sequence_number,imported_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(event.id, event.receivedAt, event.eventType ?? eventType, recordingId, state, payloadHash, payloadJson, event.rawBodyBase64, event.seq ?? null, utcNow())
      let jobCreated = false
      if (eventType === "recording.deleted" && recordingId) {
        database.prepare(`UPDATE jobs SET state='source_gone',last_error='Pocket reported that this recording was deleted',completed_at=?,updated_at=?,
          lease_token_hash=NULL,lease_until=NULL WHERE recording_id=? AND state IN ('queued','claimed','sources_ready','drafted','uncertain')`)
          .run(utcNow(), utcNow(), recordingId)
        database.prepare(`UPDATE webhook_events SET state='complete' WHERE event_id IN (
          SELECT ej.event_id FROM event_jobs ej JOIN jobs j ON j.job_id=ej.job_id WHERE j.recording_id=? AND j.state='source_gone')`).run(recordingId)
      }
      if (relevant && recordingId && eventType) {
        const metadata = recording ?? { id: recordingId }
        database.prepare(`INSERT INTO recordings(recording_id,metadata_json,first_seen_at,last_seen_at) VALUES(?,?,?,?)
          ON CONFLICT(recording_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
          .run(recordingId, json(metadata), event.receivedAt, event.receivedAt)
        const sourceVersion = candidates.length > 0 || payload?.transcript !== undefined || payload?.speakers !== undefined
          ? contentHash({ eventType, recordingId, summaries: candidates, transcript: payload?.transcript ?? null, speakers: payload?.speakers ?? null })
          : payloadHash
        const dedupeKey = contentHash({ recordingId, eventType, sourceVersion })
        const createdAt = utcNow()
        const inserted = database.prepare(`INSERT OR IGNORE INTO jobs(job_id,recording_id,event_type,dedupe_key,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), recordingId, eventType, dedupeKey, "queued", createdAt, createdAt)
        jobCreated = Number(inserted.changes) > 0
        const job = asRow(database.prepare("SELECT job_id,state FROM jobs WHERE dedupe_key=?").get(dedupeKey))
        const jobId = String(job.job_id)
        database.prepare("INSERT OR IGNORE INTO event_jobs(event_id,job_id) VALUES(?,?)").run(event.id, jobId)
        if (["complete", "needs_review", "source_gone", "skipped", "conflict"].includes(String(job.state))) {
          state = "complete"
          database.prepare("UPDATE webhook_events SET state='complete' WHERE event_id=?").run(event.id)
        }
      }
      return { phase: state, inserted: true, jobCreated }
    })),
    listJobs: (recordingId, limit) => databaseEffect(() => {
      const rows = recordingId === undefined
        ? database.prepare("SELECT * FROM jobs ORDER BY created_at DESC,job_id DESC LIMIT ?").all(limit)
        : database.prepare("SELECT * FROM jobs WHERE recording_id=? ORDER BY created_at DESC,job_id DESC LIMIT ?").all(recordingId, limit)
      return (rows as SqlRow[]).map(readJob)
    }),
    claimNext: (leaseMs) => databaseEffect(() => transaction(database, () => {
      if (!Number.isInteger(leaseMs) || leaseMs < 30000 || leaseMs > 3600000) throw failure("validation", "Job leases must be between 30 seconds and 60 minutes.")
      const now = Date.now()
      recoverExpiredSavingTx()
      const row = database.prepare(`SELECT j.* FROM jobs j
        WHERE j.state IN ('queued','claimed','sources_ready','drafted','uncertain')
          AND (j.lease_until IS NULL OR j.lease_until <= ?)
          AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.recording_id=j.recording_id AND active.job_id<>j.job_id AND active.lease_until>?)
          AND NOT EXISTS (SELECT 1 FROM jobs earlier WHERE earlier.recording_id=j.recording_id AND earlier.state NOT IN ('complete','failed','conflict','needs_review','source_gone','skipped')
            AND (earlier.created_at<j.created_at OR (earlier.created_at=j.created_at AND earlier.job_id<j.job_id)))
        ORDER BY j.created_at,j.job_id LIMIT 1`).get(now, now)
      if (!row) return null
      const selected = asRow(row)
      const leaseToken = randomBytes(32).toString("base64url")
      const leaseUntilEpoch = now + leaseMs
      const nextFence = Number(selected.fencing_token) + 1
      const nextState = selected.state === "queued" || selected.state === "claimed" ? "claimed" : String(selected.state)
      const update = database.prepare(`UPDATE jobs SET state=?,fencing_token=?,lease_token_hash=?,lease_until=?,attempts=attempts+1,updated_at=?
        WHERE job_id=? AND (lease_until IS NULL OR lease_until<=?)`)
        .run(nextState, nextFence, tokenDigest(leaseToken), leaseUntilEpoch, utcNow(), String(selected.job_id), now)
      if (Number(update.changes) !== 1) throw failure("conflict", "Another worker claimed this archive job. Retry the claim.")
      const job = readJob(rowByJobId(String(selected.job_id)))
      return { job, leaseToken, fencingToken: nextFence, leaseUntil: new Date(leaseUntilEpoch).toISOString() }
    })),
    renewLease: (jobId, leaseToken, fencingToken, leaseMs) => databaseEffect(() => transaction(database, () => {
      if (!Number.isInteger(leaseMs) || leaseMs < 30000 || leaseMs > 3600000) throw failure("validation", "Job leases must be between 30 seconds and 60 minutes.")
      const row = requireLease(jobId, leaseToken, fencingToken)
      const leaseUntil = Date.now() + leaseMs
      database.prepare("UPDATE jobs SET lease_until=?,updated_at=? WHERE job_id=? AND fencing_token=?")
        .run(leaseUntil, utcNow(), jobId, fencingToken)
      return { job: readJob(rowByJobId(String(row.job_id))), leaseToken, fencingToken, leaseUntil: new Date(leaseUntil).toISOString() }
    })),
    getJob: (jobId) => databaseEffect(() => readJob(rowByJobId(jobId))),
    createContext: (lease, context) => databaseEffect(() => transaction(database, () => {
      const job = requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      if (job.state === "saving" || job.state === "uncertain") throw failure("conflict", "A possible save must be reconciled before source context can be replaced.")
      if (job.recording_id !== context.recordingId || context.transcript.recordingId !== context.recordingId || context.notes.recordingId !== context.recordingId ||
        context.transcript.transcriptionId !== context.transcriptionId || context.transcript.hash !== context.transcriptHash ||
        context.notes.summarizationId !== context.summarizationId || context.notes.rowId !== context.notesRowId || context.notes.hash !== context.notesHash) {
        throw failure("validation", "The archived job sources do not match their recording and content hashes.")
      }
      const contextId = context.contextId
      database.prepare(`INSERT INTO job_contexts(context_id,job_id,fencing_token,recording_id,transcription_id,transcript_hash,notes_selection,summarization_id,notes_hash,notes_row_id,transcript_json,notes_json,captured_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(contextId, lease.jobId, lease.fencingToken, context.recordingId, context.transcriptionId,
          context.transcriptHash, context.notesSelection, context.summarizationId, context.notesHash, context.notesRowId, json(context.transcript), json(context.notes), context.capturedAt)
      database.prepare("UPDATE jobs SET state='sources_ready',context_id=?,draft_id=NULL,save_retries=0,reconcile_state=NULL,last_error=NULL,updated_at=? WHERE job_id=?")
        .run(contextId, utcNow(), lease.jobId)
      return { contextId }
    })),
    getContext: (lease, contextId) => databaseEffect(() => {
      const job = requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      if (job.context_id !== contextId) throw failure("conflict", "The source context is no longer active for this job.")
      const row = database.prepare("SELECT * FROM job_contexts WHERE context_id=? AND job_id=? AND fencing_token=?").get(contextId, lease.jobId, lease.fencingToken)
      if (!row) throw failure("conflict", "The source context belongs to a different job lease.")
      return readContext(asRow(row))
    }),
    trackSourcePage: (lease, input) => databaseEffect(() => transaction(database, () => {
      const job = requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      if (job.context_id !== input.contextId) throw failure("conflict", "The source context is no longer active for this job.")
      const contextRow = database.prepare("SELECT * FROM job_contexts WHERE context_id=? AND job_id=? AND fencing_token=?").get(input.contextId, lease.jobId, lease.fencingToken)
      if (!contextRow) throw failure("conflict", "The source context belongs to a different job lease.")
      const context = readContext(asRow(contextRow))
      const fullText = sourceContent(context, input.source)
      const points = Array.from(fullText)
      const total = points.length
      const chunkHash = contentHash(points.slice(input.start, input.end).join(""))
      if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end < input.start || input.end > total ||
        input.end - input.start > 12000 || input.total !== total || input.hash !== contentHash(fullText) || input.chunkHash !== chunkHash) {
        throw failure("validation", "The source page does not match the complete archived source or exceeds its page limit.")
      }
      database.prepare(`INSERT OR IGNORE INTO job_source_pages(context_id,source,page_start,page_end,total_characters,source_hash,chunk_hash)
        VALUES(?,?,?,?,?,?,?)`).run(input.contextId, input.source, input.start, input.end, input.total, input.hash, input.chunkHash)
    })),
    persistDraft: (lease, contextId, markdown, allowShorter) => databaseEffect(() => transaction(database, () => {
      if (!markdown.trim()) throw failure("validation", "The proposed Markdown draft cannot be empty.")
      if (Buffer.byteLength(markdown, "utf8") > 2 * 1024 * 1024) throw failure("validation", "The proposed Markdown draft exceeds the 2 MiB archive limit.")
      const job = requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      if (job.state !== "sources_ready" && !(job.state === "drafted" && Number(job.save_retries) === 0)) {
        throw failure("conflict", "A draft can only be prepared from complete sources before any possible remote write.")
      }
      if (job.context_id !== contextId) throw failure("conflict", "The source context is no longer the active context for this job.")
      const contextRow = database.prepare("SELECT * FROM job_contexts WHERE context_id=? AND job_id=? AND fencing_token=?").get(contextId, lease.jobId, lease.fencingToken)
      if (!contextRow) throw failure("conflict", "The source context belongs to a different job lease.")
      const context = asRow(contextRow)
      const notes = parseJson<NotesDocument>(context.notes_json)
      if (!allowShorter && notes.markdown.trim().length > 200 && markdown.trim().length < notes.markdown.trim().length / 2) {
        throw failure("validation", "The draft is much shorter than the current Notes. Explicitly allow a shorter replacement if that is intended.")
      }
      const sourceContext = readContext(context)
      for (const source of ["transcript", "notes"] as const) {
        const rows = database.prepare("SELECT page_start,page_end,total_characters,source_hash FROM job_source_pages WHERE context_id=? AND source=? ORDER BY page_start,page_end")
          .all(contextId, source) as SqlRow[]
        const expectedText = sourceContent(sourceContext, source)
        const total = Array.from(expectedText).length
        const sourceHash = contentHash(expectedText)
        let coveredUntil = 0
        for (const page of rows) {
          if (page.total_characters !== total || page.source_hash !== sourceHash || Number(page.page_start) > coveredUntil) {
            throw failure("conflict", `Every transcript and Notes source page must be read before a draft is saved.`)
          }
          coveredUntil = Math.max(coveredUntil, Number(page.page_end))
        }
        if (rows.length === 0 || coveredUntil !== total) throw failure("conflict", `Every transcript and Notes source page must be read before a draft is saved.`)
      }
      const draftId = randomUUID()
      const hash = contentHash(markdown)
      const savedAt = utcNow()
      database.prepare("INSERT INTO job_drafts(draft_id,job_id,context_id,fencing_token,markdown,content_hash,saved_at) VALUES(?,?,?,?,?,?,?)")
        .run(draftId, lease.jobId, contextId, lease.fencingToken, markdown, hash, savedAt)
      const draftNotes = { ...notes, markdown, hash }
      insertNotesVersion(String(context.recording_id), draftNotes, savedAt, "draft")
      database.prepare("UPDATE jobs SET state='drafted',draft_id=?,reconcile_state=NULL,last_error=NULL,updated_at=? WHERE job_id=?")
        .run(draftId, savedAt, lease.jobId)
      return { draftId, hash, savedAt }
    })),
    getDraftContext: (lease) => databaseEffect(() => {
      const job = requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      if (typeof job.draft_id !== "string" || typeof job.context_id !== "string") throw failure("validation", "Prepare and persist a complete draft before saving or reconciling this job.")
      const draftRow = asRow(database.prepare("SELECT * FROM job_drafts WHERE draft_id=? AND job_id=?").get(job.draft_id, lease.jobId))
      const contextRow = asRow(database.prepare("SELECT * FROM job_contexts WHERE context_id=? AND job_id=?").get(job.context_id, lease.jobId))
      return {
        draftId: String(draftRow.draft_id), contextId: String(draftRow.context_id), markdown: String(draftRow.markdown), hash: String(draftRow.content_hash),
        context: {
          contextId: String(contextRow.context_id), jobId: String(contextRow.job_id), fencingToken: Number(contextRow.fencing_token),
          recordingId: String(contextRow.recording_id), transcriptionId: String(contextRow.transcription_id), transcriptHash: String(contextRow.transcript_hash),
          notesSelection: contextRow.notes_selection === "latest" ? "latest" : "explicit",
          summarizationId: String(contextRow.summarization_id), notesHash: String(contextRow.notes_hash), notesRowId: String(contextRow.notes_row_id),
          transcript: parseJson(contextRow.transcript_json), notes: parseJson(contextRow.notes_json), capturedAt: String(contextRow.captured_at)
        },
        state: String(job.state), reconcileState: job.reconcile_state === null ? null : String(job.reconcile_state), saveRetries: Number(job.save_retries)
      }
    }),
    markSaving: (lease, draftId, contextId) => databaseEffect(() => transaction(database, () => {
      const job = requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      if (job.state !== "drafted" && !(job.state === "uncertain" && job.reconcile_state === "retry_safe")) throw failure("conflict", "This job is not ready to save. Reconcile or prepare a draft first.")
      if (job.draft_id !== draftId || job.context_id !== contextId) throw failure("conflict", "The stored draft changed before the save could start.")
      if (job.state === "uncertain" && job.reconcile_state !== "retry_safe") throw failure("conflict", "Reconcile the previous write before retrying it.")
      if (Number(job.save_retries) >= 1) throw failure("conflict", "This draft has already used its one permitted reconciled retry.")
      const retry = job.state === "uncertain" ? 1 : Number(job.save_retries)
      database.prepare("UPDATE jobs SET state='saving',save_retries=?,reconcile_state='pending',last_error=NULL,updated_at=? WHERE job_id=?")
        .run(retry, utcNow(), lease.jobId)
    })),
    resetDrafted: (lease) => databaseEffect(() => transaction(database, () => {
      requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      database.prepare("UPDATE jobs SET state='drafted',reconcile_state=NULL,updated_at=? WHERE job_id=?")
        .run(utcNow(), lease.jobId)
    })),
    setReconcileState: (lease, state, message) => databaseEffect(() => transaction(database, () => {
      requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      const terminal = state === "conflict" || state === "needs_review"
      const jobState = state === "conflict" || state === "needs_review" ? state : "uncertain"
      const updatedAt = utcNow()
      database.prepare("UPDATE jobs SET state=?,reconcile_state=?,last_error=?,updated_at=?,completed_at=CASE WHEN ? THEN ? ELSE completed_at END WHERE job_id=?")
        .run(jobState, state, message.slice(0, 1000), updatedAt, terminal ? 1 : 0, updatedAt, lease.jobId)
      if (terminal) {
        database.prepare("UPDATE jobs SET lease_token_hash=NULL,lease_until=NULL WHERE job_id=?").run(lease.jobId)
        database.prepare("UPDATE webhook_events SET state='complete' WHERE event_id IN (SELECT event_id FROM event_jobs WHERE job_id=?)").run(lease.jobId)
      }
    })),
    completeJob: (lease, notes, completedAt) => databaseEffect(() => transaction(database, () => {
      const job = requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      if (typeof job.draft_id !== "string" || typeof job.context_id !== "string") throw failure("conflict", "A verified persisted draft is required before job completion.")
      const draftRow = asRow(database.prepare("SELECT markdown,content_hash FROM job_drafts WHERE draft_id=? AND job_id=?").get(job.draft_id, lease.jobId))
      const contextRow = asRow(database.prepare("SELECT notes_json,notes_selection,captured_at FROM job_contexts WHERE context_id=? AND job_id=?").get(job.context_id, lease.jobId))
      if (normalizeMarkdown(notes.markdown) !== normalizeMarkdown(String(draftRow.markdown))) throw failure("conflict", "The archived final Notes do not match the persisted draft.")
      const original = parseJson<NotesDocument>(contextRow.notes_json)
      if (notes.recordingId !== job.recording_id || notes.summarizationId !== original.summarizationId || notes.rowId !== original.rowId) throw failure("conflict", "The final Notes belong to a different source row.")
      const finalNotes = { ...notes, hash: contentHash(notes.markdown) }
      insertNotesVersion(String(job.recording_id), finalNotes, completedAt, "final")
      database.prepare(`INSERT INTO final_notes(job_id,recording_id,summarization_id,row_id,content_hash,markdown,completed_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET content_hash=excluded.content_hash,markdown=excluded.markdown,completed_at=excluded.completed_at`)
        .run(lease.jobId, finalNotes.recordingId, finalNotes.summarizationId, finalNotes.rowId, finalNotes.hash, finalNotes.markdown, completedAt)
      database.prepare(`UPDATE jobs SET state='complete',reconcile_state='applied',last_error=NULL,completed_at=?,updated_at=?,lease_token_hash=NULL,lease_until=NULL
        WHERE job_id=?`).run(completedAt, completedAt, lease.jobId)
      database.prepare("UPDATE webhook_events SET state='complete' WHERE event_id IN (SELECT event_id FROM event_jobs WHERE job_id=?)").run(lease.jobId)
      if (contextRow.notes_selection === "latest") {
        const reason = `superseded by ${lease.jobId}`
        database.prepare(`UPDATE jobs SET state='skipped',last_error=?,completed_at=?,updated_at=?,lease_token_hash=NULL,lease_until=NULL
          WHERE recording_id=? AND job_id<>? AND state='queued' AND created_at<?`)
          .run(reason, completedAt, completedAt, String(job.recording_id), lease.jobId, String(contextRow.captured_at))
        database.prepare(`UPDATE webhook_events SET state='complete' WHERE event_id IN (
          SELECT ej.event_id FROM event_jobs ej JOIN jobs j ON j.job_id=ej.job_id
          WHERE j.recording_id=? AND j.state='skipped' AND j.last_error=?)`).run(String(job.recording_id), reason)
      }
    })),
    finishJob: (lease, state, reason) => databaseEffect(() => transaction(database, () => {
      const job = requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      if (job.state === "saving") throw failure("conflict", "A save is in progress and must be reconciled before finishing the job.")
      const completedAt = utcNow()
      database.prepare(`UPDATE jobs SET state=?,last_error=?,completed_at=?,updated_at=?,lease_token_hash=NULL,lease_until=NULL WHERE job_id=?`)
        .run(state, reason.slice(0, 1000), completedAt, completedAt, lease.jobId)
      database.prepare("UPDATE webhook_events SET state='complete' WHERE event_id IN (SELECT event_id FROM event_jobs WHERE job_id=?)").run(lease.jobId)
    })),
    finishSourceGone: (lease, reason) => databaseEffect(() => transaction(database, () => {
      requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      const completedAt = utcNow()
      database.prepare(`UPDATE jobs SET state='source_gone',last_error=?,completed_at=?,updated_at=?,lease_token_hash=NULL,lease_until=NULL WHERE job_id=?`)
        .run(reason.slice(0, 1000), completedAt, completedAt, lease.jobId)
      database.prepare("UPDATE webhook_events SET state='complete' WHERE event_id IN (SELECT event_id FROM event_jobs WHERE job_id=?)").run(lease.jobId)
    })),
    retryJob: (jobId) => databaseEffect(() => transaction(database, () => {
      const row = rowByJobId(jobId)
      if (row.state !== "failed" && row.state !== "conflict") throw failure("conflict", "Only an explicitly failed or conflicted archive job can be queued again; reconcile uncertain writes first.")
      database.prepare("UPDATE jobs SET state='queued',last_error=NULL,reconcile_state=NULL,context_id=NULL,draft_id=NULL,lease_token_hash=NULL,lease_until=NULL,updated_at=? WHERE job_id=?")
        .run(utcNow(), jobId)
    })),
    failJob: (lease, reason) => databaseEffect(() => transaction(database, () => {
      requireLease(lease.jobId, lease.leaseToken, lease.fencingToken)
      database.prepare("UPDATE jobs SET state='failed',last_error=?,lease_token_hash=NULL,lease_until=NULL,updated_at=? WHERE job_id=?")
        .run(reason.slice(0, 1000), utcNow(), lease.jobId)
      database.prepare("UPDATE webhook_events SET state='complete' WHERE event_id IN (SELECT event_id FROM event_jobs WHERE job_id=?)").run(lease.jobId)
    }))
  }
}

export const ArchiveLive = Layer.effect(Archive, Effect.gen(function*() {
  const settings = yield* Settings
  const handle = yield* attempt(() => openArchive(settings.dataDir), "storage", "Could not open the private SQLite archive.")
  const service = makeArchive(handle.database, handle.lockHealth)
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    handle.database.close()
    await handle.release()
  }).pipe(Effect.catchCause(() => Effect.void)))
  return service
}))
