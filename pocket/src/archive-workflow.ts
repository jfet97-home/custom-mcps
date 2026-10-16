import { randomUUID } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Context, Duration, Effect, Layer, Schema, Semaphore, Scope } from "effect"
import {
  ArchiveBackfillResult, ArchiveBridgeSyncResult, ArchiveDraftResult, ArchiveEventRead, ArchiveJob, ArchiveJobClaim,
  ArchiveJobFinishResult, ArchiveJobSaveResult, ArchiveRecordingRead, ArchiveSearchResult,
  ArchiveSourcePage, ArchiveStatus
} from "./contracts.js"
import { Archive, canonicalTranscriptSource, type JobContextInput, type NotesDocument, type TranscriptDocument } from "./archive.js"
import { attempt, failure, PocketError, Settings } from "./core.js"
import { contentHash, normalizeMarkdown } from "./backups.js"
import { Pocket } from "./pocket.js"

const BRIDGE_ORIGIN = "http://192.168.1.47:8084"
const PAGE_SIZE = 20
const MAX_PAGE_CHARS = 12000
const DEFAULT_SYNC_PAGES = 5
const LEASE_MILLIS = 1800000

const BridgeEvent = Schema.Struct({
  id: Schema.String, seq: Schema.optionalKey(Schema.Number), receivedAt: Schema.String,
  phase: Schema.optionalKey(Schema.String), eventType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  payload: Schema.Unknown, rawBodyBase64: Schema.String
})
const BridgePage = Schema.Struct({ events: Schema.Array(BridgeEvent), hasMore: Schema.Boolean, nextCursor: Schema.NullOr(Schema.String) })
const BridgeAck = Schema.Struct({ id: Schema.String, phase: Schema.Literals(["archived", "complete"]) })
type BridgeEventValue = typeof BridgeEvent.Type
type BridgeSettings = { readonly origin: string; readonly token: string; readonly writesEnabled: boolean }
type BridgeLoad = { readonly config: BridgeSettings | null; readonly error: string | null }

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const codepoints = (value: string): ReadonlyArray<string> => Array.from(value)

export interface ArchiveWorkflowService {
  readonly search: (input: { readonly query: string; readonly limit: number; readonly offset: number }) => Effect.Effect<typeof ArchiveSearchResult.Type, PocketError>
  readonly read: (input: { readonly recordingId: string; readonly limit: number }) => Effect.Effect<typeof ArchiveRecordingRead.Type, PocketError>
  readonly readEvent: (eventId: string) => Effect.Effect<typeof ArchiveEventRead.Type, PocketError>
  readonly status: Effect.Effect<typeof ArchiveStatus.Type, PocketError>
  readonly backfill: (input: { readonly maxPages: number; readonly startPage?: number }) => Effect.Effect<typeof ArchiveBackfillResult.Type, PocketError>
  readonly syncBridge: (maxPages: number) => Effect.Effect<typeof ArchiveBridgeSyncResult.Type, PocketError>
  readonly start: Effect.Effect<void, PocketError, Scope.Scope>
  readonly jobs: (input: { readonly recordingId?: string; readonly limit: number }) => Effect.Effect<ReadonlyArray<typeof ArchiveJob.Type>, PocketError>
  readonly claimJob: Effect.Effect<typeof ArchiveJobClaim.Type, PocketError>
  readonly renewJob: (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }) => Effect.Effect<typeof ArchiveJobClaim.Type, PocketError>
  readonly sources: (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly source: "transcript" | "notes"; readonly contextId?: string; readonly cursor?: number; readonly limit: number; readonly summarizationId?: string }) => Effect.Effect<typeof ArchiveSourcePage.Type, PocketError>
  readonly prepareDraft: (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly contextId: string; readonly markdown: string; readonly allowShorter: boolean }) => Effect.Effect<typeof ArchiveDraftResult.Type, PocketError>
  readonly save: (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly draftId: string }) => Effect.Effect<typeof ArchiveJobSaveResult.Type, PocketError>
  readonly reconcile: (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly draftId: string }) => Effect.Effect<typeof ArchiveJobSaveResult.Type, PocketError>
  readonly finish: (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly state: "needs_review" | "source_gone" | "skipped"; readonly reason: string }) => Effect.Effect<typeof ArchiveJobFinishResult.Type, PocketError>
  readonly retry: (jobId: string) => Effect.Effect<typeof ArchiveJob.Type, PocketError>
}

export class ArchiveWorkflow extends Context.Service<ArchiveWorkflow, ArchiveWorkflowService>()("pocket/ArchiveWorkflow") {}

const readPrivateFile = async (path: string, maximumBytes: number): Promise<Buffer | null> => {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw failure("storage", "A bridge state file is not a private regular file.")
  const content = await readFile(path)
  if (content.byteLength > maximumBytes) throw failure("configuration", "A bridge state file exceeds its size limit.")
  return content
}

const loadBridge = (dataDir: string): Effect.Effect<BridgeLoad, never> => attempt(async () => {
  const raw = await readPrivateFile(join(dataDir, "bridge.json"), 16384)
  if (raw === null) return { config: null, error: null }
  let decoded: unknown
  try { decoded = JSON.parse(raw.toString("utf8")) } catch { throw failure("configuration", "Bridge configuration is invalid.") }
  const config = object(decoded)
  if (!config || typeof config.url !== "string" || typeof config.tokenFile !== "string" ||
    config.writesEnabled !== undefined && typeof config.writesEnabled !== "boolean") throw failure("configuration", "Bridge configuration is invalid.")
  let parsed: URL
  try { parsed = new URL(config.url) } catch { throw failure("configuration", "Bridge configuration is invalid.") }
  if (parsed.origin !== BRIDGE_ORIGIN || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash ||
    basename(config.tokenFile) !== config.tokenFile || !/^[A-Za-z0-9._-]{1,128}$/.test(config.tokenFile) || config.tokenFile === "." || config.tokenFile === "..") {
    throw failure("configuration", "Bridge configuration is invalid.")
  }
  const tokenBytes = await readPrivateFile(join(dataDir, config.tokenFile), 4096)
  if (tokenBytes === null) throw failure("configuration", "The private bridge API token is unavailable.")
  const token = tokenBytes.toString("utf8").trim()
  if (!token || token.length > 2048) throw failure("configuration", "The private bridge API token is invalid.")
  return { config: { origin: BRIDGE_ORIGIN, token, writesEnabled: config.writesEnabled === true }, error: null }
}, "configuration", "Bridge configuration is unavailable or invalid.").pipe(
  Effect.map((value) => value),
  Effect.catch((error) => Effect.succeed({ config: null, error: error.message }))
)

const requestBridge = (fetcher: typeof fetch, config: BridgeSettings, path: string, method: "GET" | "POST", body?: unknown): Effect.Effect<unknown, PocketError> =>
  attempt(async (signal) => {
    const response = await fetcher(new URL(path, config.origin), {
      method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401 || response.status === 403) throw failure("permission", "The Pocket bridge rejected its private API token.", response.status)
      if (response.status === 404) throw failure("upstream", "The private Pocket bridge endpoint is unavailable.", response.status)
      throw failure("network", "The private Pocket bridge request failed.", response.status)
    }
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 32 * 1024 * 1024) { await reader.cancel(); throw failure("upstream", "The private Pocket bridge response exceeded 32 MiB.") }
      chunks.push(value)
    }
    if (length === 0) return null
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }
    catch { throw failure("upstream", "The private Pocket bridge returned invalid JSON.") }
  }, "network", "The private Pocket bridge could not be reached.")

const leaseOf = (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }) => ({
  jobId: input.jobId, leaseToken: input.leaseToken, fencingToken: input.fencingToken
})

export const makeArchiveWorkflowLive = (fetcher: typeof fetch = globalThis.fetch, pollInterval: Duration.Input = "60 seconds") => Layer.effect(ArchiveWorkflow, Effect.gen(function*() {
  const archive = yield* Archive
  const pocket = yield* Pocket
  const settings = yield* Settings
  const syncLock = yield* Semaphore.make(1)
  const recordingLocks = new Map<string, Semaphore.Semaphore>()
  const withRecordingLock = <A, E, R>(recordingId: string, effect: Effect.Effect<A, E, R>) => Effect.suspend(() => {
    let lock = recordingLocks.get(recordingId)
    if (!lock) { lock = Semaphore.makeUnsafe(1); recordingLocks.set(recordingId, lock) }
    return lock.withPermit(effect)
  })

  const missingSourceMessage = "The recording no longer has the transcript or Notes version required by this job."
  const isSourceGone = (error: PocketError): boolean => error.status === 404 || error.code === "validation" && error.message === missingSourceMessage

  const readCurrent = (recordingId: string, summarizationId: string) => Effect.gen(function*() {
    const snapshot = yield* pocket.archiveSnapshot(recordingId, "workflow")
    if (snapshot.decodeError !== undefined) return yield* Effect.fail(failure("upstream", "Pocket returned an unsupported recording shape during source verification."))
    const notes = snapshot.notes.find((item) => item.summarizationId === summarizationId)
    if (!snapshot.transcript || !notes) return yield* Effect.fail(failure("validation", missingSourceMessage))
    return { snapshot, transcript: snapshot.transcript, notes }
  })

  const finalize = (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, draftId: string, recordingId: string, notes: NotesDocument) =>
    archive.completeJob(lease, notes, new Date().toISOString()).pipe(Effect.as({ state: "complete" as const, jobId: lease.jobId, recordingId, draftId, reconciliation: "applied", notesHash: contentHash(notes.markdown), retryAllowed: false }))

  const syncBridge = (maxPages: number) => syncLock.withPermit(Effect.gen(function*() {
    const loaded = yield* loadBridge(settings.dataDir)
    if (!loaded.config) {
      yield* archive.setBridgeStatus({ configured: false, error: loaded.error })
      return Schema.decodeUnknownSync(ArchiveBridgeSyncResult)({ configured: false, pagesRead: 0, eventsRead: 0, archived: 0, completed: 0, jobsCreated: 0, lastCursor: null, lastError: loaded.error })
    }
    const accountRead = yield* pocket.account.pipe(Effect.result)
    if (accountRead._tag === "Failure") {
      const lastError = "Pocket account verification failed before bridge import."
      yield* archive.setBridgeStatus({ configured: true, error: lastError, syncedAt: new Date().toISOString() })
      return Schema.decodeUnknownSync(ArchiveBridgeSyncResult)({ configured: true, pagesRead: 0, eventsRead: 0, archived: 0, completed: 0, jobsCreated: 0, lastCursor: yield* archive.bridgeCursor, lastError })
    }
    const account = accountRead.success
    let cursor = yield* archive.bridgeCursor
    let pagesRead = 0
    let eventsRead = 0
    let archived = 0
    let completed = 0
    let jobsCreated = 0
    let lastError: string | null = null
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (cursor !== null) query.set("after", cursor)
      const response = yield* requestBridge(fetcher, loaded.config, `/api/events?${query.toString()}`, "GET").pipe(Effect.result)
      if (response._tag === "Failure") { lastError = "Private bridge event listing failed."; break }
      const decoded = yield* Effect.try({ try: () => Schema.decodeUnknownSync(BridgePage)(response.success), catch: () => failure("upstream", "The private bridge returned an unsupported event page.") }).pipe(Effect.result)
      if (decoded._tag === "Failure") { lastError = decoded.failure.message; break }
      const page = decoded.success
      pagesRead++
      for (const event of page.events as ReadonlyArray<BridgeEventValue>) {
        eventsRead++
        const imported = yield* archive.importWebhook({
          id: event.id, receivedAt: event.receivedAt, payload: event.payload,
          rawBodyBase64: event.rawBodyBase64, eventType: event.eventType,
          phase: event.phase, seq: event.seq
        }, account.id).pipe(Effect.result)
        if (imported._tag === "Failure") { lastError = "A bridge event could not be archived."; continue }
        if (imported.success.phase === "archived") archived++
        else completed++
        if (imported.success.jobCreated) jobsCreated++
        const ackBody = { phase: imported.success.phase }
        const ackPath = `/api/events/${encodeURIComponent(event.id)}/ack`
        const acked = yield* requestBridge(fetcher, loaded.config, ackPath, "POST", ackBody).pipe(Effect.flatMap((body) =>
          Effect.try({ try: () => Schema.decodeUnknownSync(BridgeAck)(body), catch: () => failure("upstream", "The private bridge returned an unsupported acknowledgement.") })), Effect.result)
        if (acked._tag === "Failure" || acked.success.id !== event.id || acked.success.phase !== imported.success.phase) lastError = "The private bridge acknowledgement failed."
      }
      if (page.hasMore) {
        if (!page.nextCursor || page.nextCursor === cursor) { lastError = "The private bridge pagination cursor did not advance."; break }
        cursor = page.nextCursor
        yield* archive.setBridgeCursor(cursor)
      } else {
        cursor = null
        yield* archive.setBridgeCursor(null)
        break
      }
    }
    yield* archive.setBridgeStatus({ configured: true, error: lastError, syncedAt: new Date().toISOString() })
    return Schema.decodeUnknownSync(ArchiveBridgeSyncResult)({ configured: true, pagesRead, eventsRead, archived, completed, jobsCreated, lastCursor: cursor, lastError })
  }))

  const status = Effect.gen(function*() {
    const loaded = yield* loadBridge(settings.dataDir)
    return yield* archive.status({ configured: loaded.config !== null, error: loaded.error, writesEnabled: loaded.config?.writesEnabled ?? false })
  }).pipe(Effect.flatMap((value) => Effect.try({ try: () => Schema.decodeUnknownSync(ArchiveStatus)(value), catch: () => failure("storage", "The archive status response is unsupported.") })))

  const backfill = (input: { readonly maxPages: number; readonly startPage?: number }) => Effect.gen(function*() {
    const current = yield* archive.backfillState
    const failedRecordings = new Map(current.failedRecordings.map((item) => [item.recordingId, item]))
    let page = input.startPage ?? current.nextPage
    let pagesRead = 0
    let recordingsRead = 0
    let snapshotsWritten = 0
    let complete = current.complete && input.startPage === undefined
    while (!complete && pagesRead < input.maxPages) {
      const pageData = yield* pocket.listRecordings({ page, limit: 50 })
      if (pageData.currentPage !== page || pageData.totalPages < 0) return yield* Effect.fail(failure("upstream", "Pocket returned an invalid recording page during archive backfill."))
      for (const recording of pageData.data) {
        const snapshot = yield* pocket.archiveSnapshot(recording.id, "backfill").pipe(Effect.result)
        if (snapshot._tag === "Failure") {
          failedRecordings.set(recording.id, { recordingId: recording.id, code: snapshot.failure.code })
          continue
        }
        recordingsRead++
        const stored = yield* archive.recordSnapshot(snapshot.success).pipe(Effect.result)
        if (stored._tag === "Failure") {
          failedRecordings.set(recording.id, { recordingId: recording.id, code: stored.failure.code })
          continue
        }
        snapshotsWritten++
        if (snapshot.success.decodeError !== undefined) failedRecordings.set(recording.id, { recordingId: recording.id, code: snapshot.success.decodeError })
        else failedRecordings.delete(recording.id)
      }
      pagesRead++
      complete = page >= pageData.totalPages || pageData.totalPages === 0
      page++
      yield* archive.setBackfillState({ nextPage: page, complete, lastRunAt: new Date().toISOString(), failedRecordings: [...failedRecordings.values()] })
    }
    return Schema.decodeUnknownSync(ArchiveBackfillResult)({ pagesRead, recordingsRead, snapshotsWritten, nextPage: page, complete, failedRecordings: [...failedRecordings.values()] })
  })

  const sources = (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly source: "transcript" | "notes"; readonly contextId?: string; readonly cursor?: number; readonly limit: number; readonly summarizationId?: string }) => Effect.gen(function*() {
    const lease = leaseOf(input)
    let contextId = input.contextId
    yield* archive.renewLease(input.jobId, input.leaseToken, input.fencingToken, LEASE_MILLIS)
    if (!contextId) {
      const job = yield* archive.getJob(input.jobId)
      const snapshot = yield* pocket.archiveSnapshot(job.recordingId, "workflow")
      yield* archive.recordSnapshot(snapshot)
      if (snapshot.decodeError !== undefined) return yield* Effect.fail(failure("upstream", "Pocket returned an unsupported recording shape; the raw source was archived for review."))
      if (!snapshot.transcript) return yield* Effect.fail(failure("validation", "This recording has no complete transcript available for source review."))
      const selectedId = input.summarizationId ?? snapshot.notes[0]?.summarizationId
      const notes = snapshot.notes.find((item) => item.summarizationId === selectedId)
      if (!notes) return yield* Effect.fail(failure("validation", "The selected complete Notes version is no longer available."))
      const capturedAt = snapshot.capturedAt
      const created = yield* archive.createContext(lease, {
        contextId: randomUUID(), recordingId: snapshot.recordingId,
        transcriptionId: snapshot.transcript.transcriptionId, transcriptHash: snapshot.transcript.hash,
        notesSelection: input.summarizationId === undefined ? "latest" : "explicit",
        summarizationId: notes.summarizationId, notesHash: notes.hash, notesRowId: notes.rowId,
        transcript: snapshot.transcript as TranscriptDocument, notes: notes as NotesDocument, capturedAt
      })
      contextId = created.contextId
    }
    const context = yield* archive.getContext(lease, contextId)
    const sourceContent = input.source === "transcript" ? canonicalTranscriptSource(context.transcript) : context.notes.markdown
    const points = codepoints(sourceContent)
    const cursor = input.cursor ?? 0
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > points.length || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_CHARS) {
      return yield* Effect.fail(failure("validation", "Source cursors must be in range and page limits cannot exceed 12,000 characters."))
    }
    const end = Math.min(points.length, cursor + input.limit)
    const sourceHash = contentHash(sourceContent)
    const content = points.slice(cursor, end).join("")
    const chunkHash = contentHash(content)
    yield* archive.trackSourcePage(lease, { contextId, source: input.source, start: cursor, end, total: points.length, hash: sourceHash, chunkHash })
    return Schema.decodeUnknownSync(ArchiveSourcePage)({
      contextId, jobId: context.jobId, recordingId: context.recordingId,
      transcriptionId: context.transcriptionId, transcriptHash: context.transcriptHash,
      summarizationId: context.summarizationId, notesHash: context.notesHash,
      source: input.source, cursor, nextCursor: end < points.length ? end : null,
      totalCharacters: points.length, sourceHash, chunkHash, content
    })
  })

  const prepareDraft = (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly contextId: string; readonly markdown: string; readonly allowShorter: boolean }) =>
    Effect.gen(function*() {
      yield* archive.renewLease(input.jobId, input.leaseToken, input.fencingToken, LEASE_MILLIS)
      return yield* archive.persistDraft(leaseOf(input), input.contextId, input.markdown, input.allowShorter)
    }).pipe(Effect.flatMap((value) =>
      Effect.try({ try: () => Schema.decodeUnknownSync(ArchiveDraftResult)({ ...value, state: "drafted" }), catch: () => failure("storage", "The archive draft response is unsupported.") })))

  const reconcileUnlocked = (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly draftId: string }) => Effect.gen(function*() {
    const lease = leaseOf(input)
    const active = yield* archive.getDraftContext(lease)
    if (active.draftId !== input.draftId) return yield* Effect.fail(failure("conflict", "The supplied draftId is not the persisted draft for this job."))
    if (active.state !== "uncertain") return yield* Effect.fail(failure("conflict", "Only an uncertain write can be reconciled."))
    yield* archive.renewLease(lease.jobId, lease.leaseToken, lease.fencingToken, LEASE_MILLIS)
    const currentRead = yield* readCurrent(active.context.recordingId, active.context.summarizationId).pipe(Effect.result)
    if (currentRead._tag === "Failure") {
      if (isSourceGone(currentRead.failure)) {
        yield* archive.finishSourceGone(lease, "Pocket no longer returns this recording.")
        return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "source_gone", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "source_gone", notesHash: null, retryAllowed: false })
      }
      return yield* Effect.fail(currentRead.failure)
    }
    const current = currentRead.success
    yield* archive.recordSnapshot(current.snapshot)
    const latestSelectionUnchanged = active.context.notesSelection === "explicit" || current.snapshot.notes[0]?.summarizationId === active.context.summarizationId
    if (normalizeMarkdown(current.notes.markdown) === normalizeMarkdown(active.markdown) && current.notes.summarizationId === active.context.summarizationId && current.notes.rowId === active.context.notesRowId) {
      return yield* finalize(lease, active.draftId, active.context.recordingId, current.notes)
    }
    if (latestSelectionUnchanged && current.notes.hash === active.context.notesHash && current.notes.rowId === active.context.notesRowId &&
      current.transcript.hash === active.context.transcriptHash && current.transcript.transcriptionId === active.context.transcriptionId &&
      current.transcript.rowId === active.context.transcript.rowId) {
      if (active.saveRetries >= 1) {
        yield* archive.setReconcileState(lease, "needs_review", "The only reconciled retry was already used; no further remote write is permitted.")
        return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "needs_review", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "retry_exhausted", notesHash: current.notes.hash, retryAllowed: false })
      }
      yield* archive.setReconcileState(lease, "retry_safe", "A fresh read confirms the draft has not been applied and both sources are unchanged.")
      return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "uncertain", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "unchanged_retry_safe", notesHash: current.notes.hash, retryAllowed: active.saveRetries < 1 })
    }
    yield* archive.setReconcileState(lease, "conflict", "A fresh read differs from both the persisted draft and its source version.")
    return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "conflict", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "concurrent_change", notesHash: current.notes.hash, retryAllowed: false })
  })

  const reconcile = (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly draftId: string }) => Effect.gen(function*() {
    const job = yield* archive.getJob(input.jobId)
    return yield* withRecordingLock(job.recordingId, reconcileUnlocked(input))
  })

  const saveUnlocked = (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly draftId: string }) => Effect.gen(function*() {
    const lease = leaseOf(input)
    const loaded = yield* loadBridge(settings.dataDir)
    if (!loaded.config?.writesEnabled) return yield* Effect.fail(failure("permission", "Archive Notes writes are disabled. Enable writesEnabled in the private bridge configuration after staged verification."))
    const active = yield* archive.getDraftContext(lease)
    if (active.draftId !== input.draftId) return yield* Effect.fail(failure("conflict", "The supplied draftId is not the persisted draft for this job."))
    if (active.state === "saving" || active.state === "uncertain" && active.reconcileState !== "retry_safe") {
      return yield* Effect.fail(failure("conflict", "Reconcile the previous save attempt before any retry."))
    }
    if (active.state !== "drafted" && active.state !== "uncertain") return yield* Effect.fail(failure("conflict", "A complete persisted draft is required before saving.") )
    yield* archive.renewLease(lease.jobId, lease.leaseToken, lease.fencingToken, LEASE_MILLIS)
    const current = yield* readCurrent(active.context.recordingId, active.context.summarizationId).pipe(Effect.result)
    if (current._tag === "Failure") {
      if (isSourceGone(current.failure)) {
        yield* archive.finishSourceGone(lease, "Pocket no longer returns this recording.")
        return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "source_gone", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "source_gone", notesHash: null, retryAllowed: false })
      }
      return yield* Effect.fail(current.failure)
    }
    yield* archive.recordSnapshot(current.success.snapshot)
    const latestSelectionUnchanged = active.context.notesSelection === "explicit" || current.success.snapshot.notes[0]?.summarizationId === active.context.summarizationId
    if (!latestSelectionUnchanged || current.success.transcript.hash !== active.context.transcriptHash || current.success.transcript.transcriptionId !== active.context.transcriptionId ||
      current.success.transcript.rowId !== active.context.transcript.rowId || current.success.notes.hash !== active.context.notesHash ||
      current.success.notes.rowId !== active.context.notesRowId) {
      yield* archive.setReconcileState(lease, "conflict", latestSelectionUnchanged ? "The transcript or Notes changed after the source pages were read." : "A newer Notes version appeared after the source pages were read.")
      return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "conflict", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: latestSelectionUnchanged ? "source_changed" : "latest_notes_changed", notesHash: current.success.notes.hash, retryAllowed: false })
    }
    return yield* Effect.uninterruptible(Effect.gen(function*() {
      yield* archive.markSaving(lease, active.draftId, active.contextId)
      yield* archive.assertExclusive
      const result = yield* pocket.updateNotes({
        recordingId: active.context.recordingId, summarizationId: active.context.summarizationId,
        expectedHash: active.context.notesHash, expectedRowId: active.context.notesRowId, markdown: active.markdown
      }).pipe(Effect.result)
      if (result._tag === "Failure") {
        if (result.failure.code !== "uncertain_write") {
          yield* archive.resetDrafted(lease)
          return yield* Effect.fail(result.failure)
        }
        return yield* reconcileAfterUncertain(lease, active)
      }
      const saved = yield* readCurrent(active.context.recordingId, active.context.summarizationId).pipe(Effect.result)
      if (saved._tag === "Failure") {
        if (isSourceGone(saved.failure)) {
          yield* archive.finishSourceGone(lease, "Pocket no longer returns this recording.")
          return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "source_gone", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "source_gone", notesHash: null, retryAllowed: false })
        }
        yield* archive.setReconcileState(lease, "pending", "The Pocket write was verified, but the final archive read is still pending.")
        return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "uncertain", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "read_pending", notesHash: null, retryAllowed: false })
      }
      yield* archive.recordSnapshot(saved.success.snapshot)
      if (normalizeMarkdown(saved.success.notes.markdown) !== normalizeMarkdown(active.markdown) || saved.success.notes.rowId !== active.context.notesRowId) {
        yield* archive.setReconcileState(lease, "conflict", "The final Notes reread differs from the persisted draft or source row.")
        return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "conflict", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "final_mismatch", notesHash: saved.success.notes.hash, retryAllowed: false })
      }
      return yield* finalize(lease, active.draftId, active.context.recordingId, saved.success.notes)
    }))
  })

  const save = (input: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number; readonly draftId: string }) => Effect.gen(function*() {
    const job = yield* archive.getJob(input.jobId)
    return yield* withRecordingLock(job.recordingId, saveUnlocked(input))
  })

  const reconcileAfterUncertain = (lease: { readonly jobId: string; readonly leaseToken: string; readonly fencingToken: number }, active: { readonly draftId: string; readonly markdown: string; readonly context: JobContextInput; readonly saveRetries: number }) => Effect.gen(function*() {
    const reread = yield* readCurrent(active.context.recordingId, active.context.summarizationId).pipe(Effect.result)
    if (reread._tag === "Failure") {
      if (isSourceGone(reread.failure)) {
        yield* archive.finishSourceGone(lease, "Pocket no longer returns this recording.")
        return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "source_gone", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "source_gone", notesHash: null, retryAllowed: false })
      }
      yield* archive.setReconcileState(lease, "pending", "The write outcome could not yet be reconciled by a fresh source read.")
      return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "uncertain", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "read_pending", notesHash: null, retryAllowed: false })
    }
    yield* archive.recordSnapshot(reread.success.snapshot)
    if (normalizeMarkdown(reread.success.notes.markdown) === normalizeMarkdown(active.markdown) && reread.success.notes.rowId === active.context.notesRowId) {
      return yield* finalize(lease, active.draftId, active.context.recordingId, reread.success.notes)
    }
    const latestSelectionUnchanged = active.context.notesSelection === "explicit" || reread.success.snapshot.notes[0]?.summarizationId === active.context.summarizationId
    if (latestSelectionUnchanged && reread.success.notes.hash === active.context.notesHash && reread.success.notes.rowId === active.context.notesRowId &&
      reread.success.transcript.hash === active.context.transcriptHash && reread.success.transcript.transcriptionId === active.context.transcriptionId &&
      reread.success.transcript.rowId === active.context.transcript.rowId) {
      const latest = yield* archive.getDraftContext(lease)
      if (latest.saveRetries >= 1) {
        yield* archive.setReconcileState(lease, "needs_review", "The only reconciled retry was already used; no further remote write is permitted.")
        return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "needs_review", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "retry_exhausted", notesHash: reread.success.notes.hash, retryAllowed: false })
      }
      yield* archive.setReconcileState(lease, "retry_safe", "A fresh read confirms the draft has not been applied and both sources are unchanged.")
      return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "uncertain", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "unchanged_retry_safe", notesHash: reread.success.notes.hash, retryAllowed: latest.saveRetries < 1 })
    }
    yield* archive.setReconcileState(lease, "conflict", "A fresh read differs from both the persisted draft and its source version.")
    return Schema.decodeUnknownSync(ArchiveJobSaveResult)({ state: "conflict", jobId: lease.jobId, recordingId: active.context.recordingId, draftId: active.draftId, reconciliation: "concurrent_change", notesHash: reread.success.notes.hash, retryAllowed: false })
  })

  const poll = Effect.forever(Effect.gen(function*() {
    yield* syncBridge(DEFAULT_SYNC_PAGES).pipe(Effect.catch(() => Effect.void))
    yield* Effect.sleep(pollInterval)
  }))

  const service: ArchiveWorkflowService = {
    search: (input) => archive.search(input.query, input.limit, input.offset).pipe(Effect.flatMap((value) => Effect.try({ try: () => Schema.decodeUnknownSync(ArchiveSearchResult)(value), catch: () => failure("storage", "The archive search response is unsupported.") }))),
    read: (input) => archive.read(input.recordingId, input.limit).pipe(Effect.flatMap((value) => Effect.try({ try: () => Schema.decodeUnknownSync(ArchiveRecordingRead)(value), catch: () => failure("storage", "The archive read response is unsupported.") }))),
    readEvent: (eventId) => archive.readEvent(eventId).pipe(Effect.flatMap((value) => Effect.try({ try: () => Schema.decodeUnknownSync(ArchiveEventRead)(value), catch: () => failure("storage", "The archived event response is unsupported.") }))),
    status: status.pipe(Effect.map((value) => Schema.decodeUnknownSync(ArchiveStatus)(value))),
    backfill,
    syncBridge: (maxPages) => {
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) return Effect.fail(failure("validation", "Bridge sync page limits must be between 1 and 20."))
      return syncBridge(maxPages)
    },
    start: Effect.gen(function*() {
      yield* archive.recoverSaving
      yield* Effect.forkScoped(poll)
    }).pipe(Effect.asVoid),
    jobs: (input) => archive.listJobs(input.recordingId, input.limit),
    claimJob: Effect.gen(function*() {
      yield* syncBridge(DEFAULT_SYNC_PAGES).pipe(Effect.catch(() => Effect.void))
      const value = yield* archive.claimNext(LEASE_MILLIS)
      return Schema.decodeUnknownSync(ArchiveJobClaim)({
        job: value?.job ?? null, leaseToken: value?.leaseToken ?? null, fencingToken: value?.fencingToken ?? null, leaseUntil: value?.leaseUntil ?? null
      })
    }),
    renewJob: (input) => archive.renewLease(input.jobId, input.leaseToken, input.fencingToken, LEASE_MILLIS).pipe(Effect.map((value) =>
      Schema.decodeUnknownSync(ArchiveJobClaim)({ job: value.job, leaseToken: value.leaseToken, fencingToken: value.fencingToken, leaseUntil: value.leaseUntil }))),
    sources,
    prepareDraft,
    save,
    reconcile,
    finish: (input) => Effect.gen(function*() {
      yield* archive.renewLease(input.jobId, input.leaseToken, input.fencingToken, LEASE_MILLIS)
      yield* archive.finishJob(leaseOf(input), input.state, input.reason)
      return Schema.decodeUnknownSync(ArchiveJobFinishResult)({ jobId: input.jobId, state: input.state, eventsCompleted: true })
    }),
    retry: (jobId) => archive.retryJob(jobId).pipe(Effect.flatMap(() => archive.getJob(jobId)))
  }
  return service
}))

export const ArchiveWorkflowLive = makeArchiveWorkflowLive()
