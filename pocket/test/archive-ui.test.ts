import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect, Layer, Redacted, Result } from "effect"
import { test } from "node:test"
import { Archive, ArchiveLive } from "../src/archive.js"
import { ArchiveWorkflow, makeArchiveWorkflowLive } from "../src/archive-workflow.js"
import { contentHash } from "../src/backups.js"
import { Settings } from "../src/core.js"
import { archiveUiRequestAccess, archiveUiSameOrigin, ArchiveUiSessions, isArchiveUiPath } from "../src/archive-ui-model.js"
import { Pocket } from "../src/pocket.js"
import { fixture } from "./fixture.js"

const bearer = Redacted.make("a".repeat(64))
const host = "127.0.0.1:9011"
const origin = "http://127.0.0.1:9011"

test("archive UI keeps static browsing public and requires bearer authorization to mint a one-use code", () => {
  const sessions = new ArchiveUiSessions({ makeToken: () => "b".repeat(64) })
  assert.equal(archiveUiRequestAccess({ url: "/archive/", method: "GET", headers: { host } }, bearer, sessions).kind, "public")
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/open", method: "POST", headers: { host } }, bearer, sessions), { kind: "denied", status: 401 })
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/open", method: "POST", headers: { host, authorization: "Bearer wrong" } }, bearer, sessions), { kind: "denied", status: 401 })
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/open", method: "POST", headers: { host, origin, authorization: `Bearer ${"a".repeat(64)}` } }, bearer, sessions), { kind: "denied", status: 403 })
  assert.equal(archiveUiRequestAccess({ url: "/archive/api/open", method: "POST", headers: { host, authorization: `Bearer ${"a".repeat(64)}` } }, bearer, sessions).kind, "open")
})

test("archive UI sessions reject invalid origins, cross-port use, expired codes and replay", () => {
  let now = 1000
  const tokens = ["b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)]
  const sessions = new ArchiveUiSessions({ now: () => now, makeToken: () => tokens.shift() ?? "f".repeat(64) })
  const code = sessions.issueBootstrapCode(host)!
  assert.equal(sessions.redeemBootstrapCode(code, "localhost:9011"), null)
  assert.equal(archiveUiRequestAccess({ url: "/archive/api/session", method: "POST", headers: { host, origin: "http://127.0.0.1:9012", "x-pocket-ui": "1" } }, bearer, sessions).kind, "denied")
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/session", method: "POST", headers: { host, origin, "x-pocket-ui": "1" } }, bearer, sessions), { kind: "session-bootstrap" })
  const sessionToken = sessions.redeemBootstrapCode(code, host)
  assert.equal(sessionToken, "c".repeat(64))
  assert.equal(sessions.redeemBootstrapCode(code, host), null)
  assert.equal(sessions.hasSession(sessionToken ?? undefined, host), true)
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/recordings", method: "GET", headers: { host, "x-pocket-ui": "1" } }, bearer, sessions), { kind: "denied", status: 401 })
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/recordings", method: "GET", headers: { host, origin: "http://127.0.0.1:9012", "x-pocket-ui": "1" }, cookies: { pocket_archive_session: sessionToken! } }, bearer, sessions), { kind: "denied", status: 403 })
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/recordings", method: "GET", headers: { host }, cookies: { pocket_archive_session: sessionToken! } }, bearer, sessions), { kind: "denied", status: 403 })
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/recordings", method: "GET", headers: { host, "x-pocket-ui": "1" }, cookies: { pocket_archive_session: sessionToken! } }, bearer, sessions), { kind: "data", sessionToken: sessionToken! })
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/recordings/one/local-notes/summary-1", method: "PUT", headers: { host, origin, "x-pocket-ui": "1" }, cookies: { pocket_archive_session: sessionToken! } }, bearer, sessions), { kind: "data", sessionToken: sessionToken! })
  assert.deepEqual(archiveUiRequestAccess({ url: "/archive/api/recordings/one/local-notes/summary-1", method: "PUT", headers: { host, "x-pocket-ui": "1" }, cookies: { pocket_archive_session: sessionToken! } }, bearer, sessions), { kind: "denied", status: 403 })
  assert.equal(archiveUiRequestAccess({ url: "/mcp", method: "POST", headers: { host }, cookies: { pocket_archive_session: sessionToken! } }, bearer, sessions).kind, "outside")
  assert.equal(isArchiveUiPath("/archive/../mcp"), false)
  assert.equal(isArchiveUiPath("/archive/%2e%2e/mcp"), false)
  assert.equal(isArchiveUiPath("/archive/api/recordings/one%2Ftwo"), false)
  assert.equal(archiveUiSameOrigin(host, origin), true)
  assert.equal(archiveUiSameOrigin(host, "https://127.0.0.1:9011"), false)
  assert.equal(archiveUiSameOrigin("pocket-mcp:9011", "http://pocket-mcp:9011"), false)
  now += 15 * 60 * 1000
  assert.equal(sessions.hasSession(sessionToken ?? undefined, host), false)

  const expired = sessions.issueBootstrapCode(host)!
  now += 60 * 1000
  assert.equal(sessions.redeemBootstrapCode(expired, host), null)
})

test("browser archive reads stay local and local Notes revisions use CAS without changing Pocket snapshots", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pocket-archive-ui-test-"))
  chmodSync(dataDir, 0o700)
  const sample = fixture()
  const settings = Layer.succeed(Settings, { dataDir, port: 9011 })
  const live = Layer.merge(Layer.merge(sample.layer, settings), ArchiveLive.pipe(Layer.provide(settings)))
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const pocket = yield* Pocket
      const firstSnapshot = yield* pocket.archiveSnapshot("recording-1", "backfill")
      yield* archive.recordSnapshot(firstSnapshot)
      const remoteCallCount = sample.state.requests.length
      const listing = yield* archive.uiBrowse("", 20, 0)
      const detail = yield* archive.uiReadRecording("recording-1")
      const transcriptVersions = yield* archive.uiListTranscriptVersions("recording-1", 20, 0)
      const transcriptPage = yield* archive.uiReadTranscriptPage("recording-1", transcriptVersions.versions[0]!.versionId, 1, 8)
      const notesVersions = yield* archive.uiListNotesVersions("recording-1", 20, 0)
      assert.equal(notesVersions.versions[0]?.summarizationId, "summary-1")
      const firstNotes = notesVersions.versions.find((item) => item.summarizationId === "summary-1")!
      const notesPage = yield* archive.uiReadNotesPage("recording-1", firstNotes.versionId, 0, 8)
      const editor = yield* archive.uiReadLocalNotesEditor("recording-1", "summary-1")
      const saved = yield* archive.uiSaveLocalNotes("recording-1", "summary-1", editor.expectedHash, "Local-only Notes phrase")
      const conflict = yield* Effect.result(archive.uiSaveLocalNotes("recording-1", "summary-1", editor.expectedHash, "stale edit"))
      const localEditor = yield* archive.uiReadLocalNotesEditor("recording-1", "summary-1")
      const history = yield* archive.uiListLocalNotesHistory("recording-1", "summary-1", 20, 0)
      const localPage = yield* archive.uiReadLocalNotesPage("recording-1", saved.revisionId, 0, 9)
      const search = yield* archive.search("Local-only Notes phrase", 20, 0)
      const read = yield* archive.read("recording-1", 20)
      const requestCountAfterBrowsing = sample.state.requests.length
      const noChangeSnapshot = yield* pocket.archiveSnapshot("recording-1", "backfill")
      yield* archive.recordSnapshot(noChangeSnapshot)
      const afterNoChangeRefresh = yield* archive.uiReadLocalNotesEditor("recording-1", "summary-1")
      sample.state.detail.summarizations["summary-map-key"]!.v2!.summary!.markdown = "Updated Pocket Notes"
      const updatedSnapshot = yield* pocket.archiveSnapshot("recording-1", "backfill")
      yield* archive.recordSnapshot(updatedSnapshot)
      const editorAfterRefresh = yield* archive.uiReadLocalNotesEditor("recording-1", "summary-1")
      const nextRevision = yield* archive.uiSaveLocalNotes("recording-1", "summary-1", editorAfterRefresh.expectedHash, "Local revision after remote refresh")
      return {
        listing, detail, transcriptVersions, transcriptPage, notesVersions, notesPage, editor, saved, conflict,
        localEditor, history, localPage, search, read, remoteCallCount,
        requestCountAfterBrowsing, afterNoChangeRefresh, editorAfterRefresh, nextRevision
      }
    }).pipe(Effect.provide(live)))

    assert.equal(result.listing.pagination.total, 1)
    assert.equal(result.listing.recordings[0]?.recordingId, "recording-1")
    assert.equal(result.detail.recording.title, "Test recording")
    assert.equal("raw" in result.detail, false)
    assert.equal("events" in result.detail, false)
    assert.equal(result.transcriptVersions.pagination.total, 1)
    assert.equal(result.transcriptPage.text, "First wo")
    assert.equal(result.notesVersions.pagination.total, 2)
    assert.equal(result.notesPage.markdown, "# Origin")
    assert.equal(result.editor.markdown, "# Original\n\nComplete Notes.")
    assert.equal(Result.isFailure(result.conflict), true)
    if (Result.isFailure(result.conflict)) assert.equal(result.conflict.failure.code, "conflict")
    assert.equal(result.localEditor.markdown, "Local-only Notes phrase")
    assert.equal(result.localEditor.expectedHash, result.saved.hash)
    assert.equal(result.history.pagination.total, 1)
    assert.equal(result.localPage.markdown, "Local-onl")
    assert.equal((result.search as { pagination: { total: number } }).pagination.total, 1)
    assert.equal((result.read as { localNotesVersions: { markdown: string }[] }).localNotesVersions[0]?.markdown, "Local-only Notes phrase")
    assert.equal(result.requestCountAfterBrowsing, result.remoteCallCount)
    assert.equal(result.afterNoChangeRefresh.markdown, "Local-only Notes phrase")
    assert.equal(result.afterNoChangeRefresh.changedRemotely, false)
    assert.equal(result.editorAfterRefresh.changedRemotely, true)
    assert.equal(result.nextRevision.baseRemoteHash, result.saved.baseRemoteHash)
    assert.equal(statSync(join(dataDir, "archive.sqlite")).mode & 0o777, 0o600)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test("an unsent workflow draft is not a Pocket Notes editor base or accepted CAS hash", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pocket-archive-ui-draft-test-"))
  chmodSync(dataDir, 0o700)
  const sample = fixture()
  const settings = Layer.succeed(Settings, { dataDir, port: 9011 })
  const dependencies = Layer.merge(Layer.merge(sample.layer, settings), ArchiveLive.pipe(Layer.provide(settings)))
  const workflow = makeArchiveWorkflowLive(undefined, "1 hour").pipe(Layer.provide(dependencies))
  const live = Layer.merge(dependencies, workflow)
  const timestamp = "2026-10-16T12:00:00.000Z"
  const payload = {
    event: "summary.completed", timestamp,
    user: { id: "user-1", email: "test@example.com" },
    recording: { id: "recording-1", title: "Test recording" },
    summarizations: { "summary-map-key": { id: "summary-row-1", summarizationId: "summary-1", v2: { summary: { markdown: "# Original\n\nComplete Notes." } } } }
  }
  const raw = Buffer.from(JSON.stringify(payload))
  const event = {
    id: createHash("sha256").update(raw).digest("hex"), receivedAt: timestamp, eventType: "summary.completed",
    phase: "received", seq: 1, payload, rawBodyBase64: raw.toString("base64")
  }
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const pocket = yield* Pocket
      const workflowService = yield* ArchiveWorkflow
      const snapshot = yield* pocket.archiveSnapshot("recording-1", "backfill")
      yield* archive.recordSnapshot(snapshot)
      yield* archive.importWebhook(event, "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim)
      const lease = { jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }
      const transcript = yield* workflowService.sources({ ...lease, source: "transcript", limit: 12000 })
      let cursor = transcript.nextCursor
      while (cursor !== null) {
        const page = yield* workflowService.sources({ ...lease, source: "transcript", contextId: transcript.contextId, cursor, limit: 12000 })
        cursor = page.nextCursor
      }
      yield* workflowService.sources({ ...lease, source: "notes", contextId: transcript.contextId, limit: 12000 })
      const draft = yield* workflowService.prepareDraft({ ...lease, contextId: transcript.contextId, markdown: "Unsent workflow draft", allowShorter: true })
      const versions = yield* archive.uiListNotesVersions("recording-1", 20, 0)
      const editor = yield* archive.uiReadLocalNotesEditor("recording-1", "summary-1")
      const draftHash = contentHash("Unsent workflow draft")
      const draftSave = yield* Effect.result(archive.uiSaveLocalNotes("recording-1", "summary-1", draftHash, "Incorrect draft-based edit"))
      const save = yield* archive.uiSaveLocalNotes("recording-1", "summary-1", editor.expectedHash, "Local edit based on Pocket")
      return { versions, editor, draftHash, draftSave, save, draft }
    }).pipe(Effect.provide(live)))
    assert.ok(result.versions.versions.some((version) => version.source === "draft" && version.hash === result.draftHash))
    assert.equal(result.editor.source, "pocket")
    assert.notEqual(result.editor.expectedHash, result.draftHash)
    assert.equal(result.editor.markdown, "# Original\n\nComplete Notes.")
    assert.equal(Result.isFailure(result.draftSave), true)
    if (Result.isFailure(result.draftSave)) assert.equal(result.draftSave.failure.code, "conflict")
    assert.notEqual(result.save.hash, result.draftHash)
    assert.ok(result.draft.draftId)
    assert.equal(sample.state.requests.some((request) => request.method !== "GET"), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test("archive schema migration makes a private SQLite backup before adding local revision storage", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pocket-archive-migration-test-"))
  chmodSync(dataDir, 0o700)
  const archivePath = join(dataDir, "archive.sqlite")
  const legacy = new DatabaseSync(archivePath)
  legacy.exec("CREATE TABLE legacy_marker(value TEXT NOT NULL) STRICT; INSERT INTO legacy_marker(value) VALUES('preserved')")
  legacy.close()
  chmodSync(archivePath, 0o600)
  const settings = Layer.succeed(Settings, { dataDir, port: 9011 })
  try {
    await Effect.runPromise(Archive.use((archive) => archive.assertExclusive).pipe(Effect.provide(ArchiveLive.pipe(Layer.provide(settings)))))
    const backupFiles = readdirSync(join(dataDir, "backups"))
    assert.equal(backupFiles.length, 1)
    const backupPath = join(dataDir, "backups", backupFiles[0]!)
    assert.equal(statSync(backupPath).mode & 0o777, 0o600)
    const backup = new DatabaseSync(backupPath, { readOnly: true })
    assert.equal((backup.prepare("SELECT value FROM legacy_marker").get() as { value: string }).value, "preserved")
    backup.close()
    const migrated = new DatabaseSync(archivePath, { readOnly: true })
    assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_notes_revisions'").get())
    assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2)
    migrated.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
