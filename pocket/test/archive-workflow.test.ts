import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Duration, Effect, Layer } from "effect"
import { test } from "node:test"
import { Archive, ArchiveLive } from "../src/archive.js"
import { ArchiveWorkflow, makeArchiveWorkflowLive } from "../src/archive-workflow.js"
import { contentHash } from "../src/backups.js"
import { Settings } from "../src/core.js"
import { Pocket } from "../src/pocket.js"
import { fixture } from "./fixture.js"

const makeEvent = (event: string, overrides: Record<string, unknown> = {}, seq = 1) => {
  const payload = {
    event, timestamp: "2026-10-16T12:00:00.000Z", user: { id: "user-1", email: "test@example.com" },
    recording: { id: "recording-1", title: "Test recording" }, ...overrides
  }
  const raw = Buffer.from(JSON.stringify(payload))
  return {
    id: createHash("sha256").update(raw).digest("hex"), seq, phase: "received", eventType: event,
    receivedAt: payload.timestamp, payload, rawBodyBase64: raw.toString("base64")
  }
}

const environment = (options: { readonly writesEnabled?: boolean; readonly fetcher?: typeof fetch; readonly pollInterval?: Duration.Input } = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pocket-archive-test-"))
  chmodSync(dataDir, 0o700)
  if (options.writesEnabled !== undefined) {
    writeFileSync(join(dataDir, "bridge-token"), "test-token\n", { mode: 0o600 })
    chmodSync(join(dataDir, "bridge-token"), 0o600)
    writeFileSync(join(dataDir, "bridge.json"), JSON.stringify({ url: "http://192.168.1.47:8084", tokenFile: "bridge-token", writesEnabled: options.writesEnabled }), { mode: 0o600 })
    chmodSync(join(dataDir, "bridge.json"), 0o600)
  }
  const sample = fixture()
  const settings = Layer.succeed(Settings, { dataDir, port: 9011 })
  const dependencies = Layer.merge(Layer.merge(sample.layer, settings), ArchiveLive.pipe(Layer.provide(settings)))
  const workflow = makeArchiveWorkflowLive(options.fetcher, options.pollInterval).pipe(Layer.provide(dependencies))
  const live = Layer.merge(dependencies, workflow)
  return { dataDir, sample, live, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

test("backfill stores every original Notes version in a private archive without creating jobs", async () => {
  const env = environment()
  env.sample.state.additionalRecordings = [{ id: "recording-malformed", title: "Old response" }, { id: "recording-missing", title: "Deleted before detail read" }]
  env.sample.state.malformedDetailIds.add("recording-malformed")
  env.sample.state.failDetailIds.add("recording-missing")
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      const backfill = yield* workflow.backfill({ maxPages: 1 })
      const read = yield* archive.read("recording-1", 20)
      const malformed = yield* archive.read("recording-malformed", 20)
      const jobs = yield* archive.listJobs(undefined, 20)
      const status = yield* workflow.status
      return { backfill, read, malformed, jobs, status }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.backfill.recordingsRead, 2)
    assert.equal(result.backfill.snapshotsWritten, 2)
    assert.equal(result.backfill.complete, true)
    assert.deepEqual(new Set(result.backfill.failedRecordings.map((item) => item.recordingId)), new Set(["recording-malformed", "recording-missing"]))
    assert.ok(result.backfill.failedRecordings.every((item) => item.code === "upstream"))
    assert.equal(result.jobs.length, 0)
    const notes = (result.read as { notesVersions: { source: string; notes: { markdown: string } }[] }).notesVersions
    assert.equal(notes.length, 2)
    assert.deepEqual(new Set(notes.map((item) => item.source)), new Set(["backfill"]))
    assert.ok(notes.some((item) => item.notes.markdown === "Old Notes"))
    assert.equal(result.status.writesEnabled, false)
    const malformed = result.malformed as { snapshots: { raw: unknown }[]; transcriptVersions: unknown[]; notesVersions: unknown[] }
    assert.deepEqual(malformed.snapshots[0]?.raw, { recording: { id: "recording-malformed", title: 42 } })
    assert.equal(malformed.transcriptVersions.length, 0)
    assert.equal(malformed.notesVersions.length, 0)
    assert.equal(result.status.backfill.failedRecordings.length, 2)
    assert.equal(statSync(join(env.dataDir, "archive.sqlite")).mode & 0o777, 0o600)
    env.sample.state.failDetailIds.clear()
    env.sample.state.malformedDetailIds.clear()
    const resumed = await Effect.runPromise(ArchiveWorkflow.use((workflow) => workflow.backfill({ maxPages: 1, startPage: 1 })).pipe(Effect.provide(env.live)))
    assert.equal(resumed.complete, true)
    assert.equal(resumed.failedRecordings.length, 0)
  } finally { env.cleanup() }
})

test("bridge sync pages past archived events, preserves raw bytes, and completes archive-only events", async () => {
  const first = makeEvent("summary.completed", { summarizations: { "summary-1": { id: "summary-row-1", summarizationId: "summary-1", v2: { summary: { markdown: "Original summary" } } } } }, 1)
  const second = makeEvent("summary.updated", { summarizations: { "summary-1": { id: "summary-row-1", summarizationId: "summary-1", v2: { summary: { markdown: "Manual edit" } } } } }, 2)
  const calls: { readonly method: string; readonly path: string; readonly phase?: string; readonly archivedCount?: number }[] = []
  let dataDir = ""
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    if (method === "GET") {
      const after = url.searchParams.get("after")
      calls.push({ method, path: `${url.pathname}${url.search}` })
      return new Response(JSON.stringify(after === "1"
        ? { events: [second], hasMore: false, nextCursor: null }
        : { events: [first], hasMore: true, nextCursor: "1" }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const body = JSON.parse(String(init?.body)) as { phase: string }
    const db = new DatabaseSync(join(dataDir, "archive.sqlite"))
    const archivedCount = Number((db.prepare("SELECT COUNT(*) AS count FROM webhook_events").get() as { count: number }).count)
    db.close()
    calls.push({ method, path: url.pathname, phase: body.phase, archivedCount })
    return new Response(JSON.stringify({ id: decodeURIComponent(url.pathname.split("/").at(-2) ?? ""), phase: body.phase }), { status: 200, headers: { "content-type": "application/json" } })
  }
  const env = environment({ writesEnabled: false, fetcher })
  dataDir = env.dataDir
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      const sync = yield* workflow.syncBridge(5)
      const firstStored = (yield* archive.readEvent(first.id)) as { readonly state: string; readonly rawBodyBase64: string }
      const secondStored = (yield* archive.readEvent(second.id)) as { readonly state: string; readonly rawBodyBase64: string }
      const jobs = yield* archive.listJobs(undefined, 20)
      const cursor = yield* archive.bridgeCursor
      return { sync, firstStored, secondStored, jobs, cursor }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.sync.pagesRead, 2)
    assert.equal(result.sync.eventsRead, 2)
    assert.equal(result.sync.jobsCreated, 1)
    assert.equal(result.jobs.length, 1)
    assert.equal(result.cursor, null)
    assert.equal(result.firstStored.state, "archived")
    assert.equal(result.secondStored.state, "complete")
    assert.equal(result.firstStored.rawBodyBase64, first.rawBodyBase64)
    assert.equal(result.secondStored.rawBodyBase64, second.rawBodyBase64)
    assert.deepEqual(calls.filter((call) => call.method === "GET").map((call) => call.path), ["/api/events?limit=20", "/api/events?limit=20&after=1"])
    assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.phase), ["archived", "complete"])
    assert.ok(calls.filter((call) => call.method === "POST").every((call) => (call.archivedCount ?? 0) > 0))
  } finally { env.cleanup() }
})

test("job source pages are hashed, complete coverage is required, and uncertain writes reconcile before one retry", async () => {
  const env = environment({ writesEnabled: true })
  env.sample.state.detail.transcription.transcription.segments[1]!.text = "x".repeat(15000)
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      const event = makeEvent("summary.completed")
      yield* archive.importWebhook(event, "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim?.job && claim.leaseToken && claim.fencingToken)
      const lease = { jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }
      const firstPage = yield* workflow.sources({ ...lease, source: "transcript", limit: 12000 })
      assert.equal(firstPage.content.length, 12000)
      assert.equal(firstPage.chunkHash, contentHash(firstPage.content))
      assert.notEqual(firstPage.nextCursor, null)
      const incomplete = yield* workflow.prepareDraft({ ...lease, contextId: firstPage.contextId, markdown: "Revised Notes", allowShorter: true }).pipe(Effect.result)
      assert.equal(incomplete._tag, "Failure")
      const transcriptPages = [firstPage.content]
      let cursor = firstPage.nextCursor
      while (cursor !== null) {
        const page: typeof firstPage = yield* workflow.sources({ ...lease, source: "transcript", contextId: firstPage.contextId, cursor, limit: 12000 })
        assert.equal(page.sourceHash, firstPage.sourceHash)
        assert.equal(page.chunkHash, contentHash(page.content))
        transcriptPages.push(page.content)
        cursor = page.nextCursor
      }
      const notesPage = yield* workflow.sources({ ...lease, source: "notes", contextId: firstPage.contextId, limit: 12000 })
      const draft = yield* workflow.prepareDraft({ ...lease, contextId: firstPage.contextId, markdown: "Revised Notes", allowShorter: true })
      env.sample.state.failBeforeWrite = true
      const uncertain = yield* workflow.save({ ...lease, draftId: draft.draftId })
      assert.equal(uncertain.state, "uncertain")
      assert.equal(uncertain.retryAllowed, true)
      const inspected = yield* workflow.reconcile({ ...lease, draftId: draft.draftId })
      assert.equal(inspected.reconciliation, "unchanged_retry_safe")
      env.sample.state.failBeforeWrite = false
      const saved = yield* workflow.save({ ...lease, draftId: draft.draftId })
      const job = yield* archive.getJob(claim.job.id)
      const read = yield* archive.read("recording-1", 50)
      const storedEvent = (yield* archive.readEvent(event.id)) as { readonly state: string }
      return { firstPage, transcriptPages, notesPage, draft, uncertain, saved, job, read, storedEvent }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.saved.state, "complete")
    assert.equal(result.job.state, "complete")
    assert.equal(result.storedEvent.state, "complete")
    assert.equal(result.notesPage.content, "# Original\n\nComplete Notes.")
    assert.equal(contentHash(result.transcriptPages.join("")), result.firstPage.sourceHash)
    const notes = (result.read as { notesVersions: { source: string; notes: { markdown: string } }[] }).notesVersions
    assert.ok(notes.some((item) => item.source === "draft" && item.notes.markdown === "Revised Notes"))
    assert.ok(notes.some((item) => item.source === "final" && item.notes.markdown === "Revised Notes"))
    assert.equal(env.sample.state.requests.filter((request) => request.method === "PATCH").length, 2)
  } finally { env.cleanup() }
})

test("the private write gate defaults off and prevents any remote mutation", async () => {
  const env = environment()
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      const event = makeEvent("summary.completed")
      yield* archive.importWebhook(event, "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim?.job && claim.leaseToken && claim.fencingToken)
      const lease = { jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }
      const transcript = yield* workflow.sources({ ...lease, source: "transcript", limit: 12000 })
      yield* workflow.sources({ ...lease, source: "notes", contextId: transcript.contextId, limit: 12000 })
      const draft = yield* workflow.prepareDraft({ ...lease, contextId: transcript.contextId, markdown: "Safe local draft", allowShorter: true })
      const write = yield* workflow.save({ ...lease, draftId: draft.draftId }).pipe(Effect.result)
      const status = yield* workflow.status
      return { write, status }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.write._tag, "Failure")
    if (result.write._tag === "Failure") assert.equal(result.write.failure.code, "permission")
    assert.equal(result.status.writesEnabled, false)
    assert.equal(env.sample.state.requests.filter((request) => request.method === "PATCH").length, 0)
  } finally { env.cleanup() }
})

test("lease renewal is fenced after an expired lease is reclaimed", async () => {
  const env = environment()
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      yield* archive.importWebhook(makeEvent("summary.completed"), "user-1")
      const first = yield* archive.claimNext(1800000)
      assert.ok(first)
      const whileActive = yield* archive.claimNext(1800000)
      const db = new DatabaseSync(join(env.dataDir, "archive.sqlite"))
      db.prepare("UPDATE jobs SET lease_until=0 WHERE job_id=?").run(first.job.id)
      db.close()
      const reclaimed = yield* archive.claimNext(1800000)
      assert.ok(reclaimed)
      const staleRenew = yield* archive.renewLease(first.job.id, first.leaseToken, first.fencingToken, 1800000).pipe(Effect.result)
      const renewed = yield* archive.renewLease(reclaimed.job.id, reclaimed.leaseToken, reclaimed.fencingToken, 1800000)
      return { first, whileActive, reclaimed, staleRenew, renewed }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.whileActive, null)
    assert.equal(result.reclaimed.fencingToken, result.first.fencingToken + 1)
    assert.equal(result.staleRenew._tag, "Failure")
    assert.equal(result.renewed.fencingToken, result.reclaimed.fencingToken)
  } finally { env.cleanup() }
})

test("latest-selected Notes changes block old-row writes while an explicit version remains deliberate", async () => {
  for (const selection of ["latest", "explicit"] as const) {
    const env = environment({ writesEnabled: true })
    try {
      const result = await Effect.runPromise(Effect.gen(function*() {
        const archive = yield* Archive
        const workflow = yield* ArchiveWorkflow
        const event = makeEvent("summary.completed")
        yield* archive.importWebhook(event, "user-1")
        const claim = yield* archive.claimNext(1800000)
        assert.ok(claim)
        const lease = { jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }
        const transcript = yield* workflow.sources({ ...lease, source: "transcript", limit: 12000, ...(selection === "explicit" ? { summarizationId: "summary-1" } : {}) })
        yield* workflow.sources({ ...lease, source: "notes", contextId: transcript.contextId, limit: 12000 })
        const draft = yield* workflow.prepareDraft({ ...lease, contextId: transcript.contextId, markdown: "Prepared draft", allowShorter: true })
        const summaries = env.sample.state.detail.summarizations as Record<string, unknown>
        summaries["summary-new"] = {
          id: "summary-row-new", summarizationId: "summary-new", version: 4, updatedAt: "2026-10-17T12:00:00Z",
          v2: { summary: { markdown: "Newer Notes", version: "4" } }
        }
        const saved = yield* workflow.save({ ...lease, draftId: draft.draftId }).pipe(Effect.result)
        const job = yield* archive.getJob(claim.job.id)
        return { saved, job, requests: env.sample.state.requests }
      }).pipe(Effect.provide(env.live)))
      if (selection === "latest") {
        assert.equal(result.saved._tag, "Success")
        if (result.saved._tag === "Success") {
          assert.equal(result.saved.success.state, "conflict")
          assert.equal(result.saved.success.reconciliation, "latest_notes_changed")
        }
        assert.equal(result.job.state, "conflict")
        assert.equal(result.requests.filter((request) => request.method === "PATCH").length, 0)
      } else {
        assert.equal(result.saved._tag, "Success")
        if (result.saved._tag === "Success") assert.equal(result.saved.success.state, "complete")
        assert.equal(result.job.state, "complete")
        assert.equal(result.requests.filter((request) => request.method === "PATCH").length, 1)
      }
    } finally { env.cleanup() }
  }
})

test("an unchanged uncertain result permits only one retry", async () => {
  const env = environment({ writesEnabled: true })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      yield* archive.importWebhook(makeEvent("summary.completed"), "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim)
      const lease = { jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }
      const transcript = yield* workflow.sources({ ...lease, source: "transcript", limit: 12000 })
      yield* workflow.sources({ ...lease, source: "notes", contextId: transcript.contextId, limit: 12000 })
      const draft = yield* workflow.prepareDraft({ ...lease, contextId: transcript.contextId, markdown: "Prepared draft", allowShorter: true })
      env.sample.state.failBeforeWrite = true
      const firstAttempt = yield* workflow.save({ ...lease, draftId: draft.draftId })
      const secondAttempt = yield* workflow.save({ ...lease, draftId: draft.draftId })
      const exhaustedAttempt = yield* workflow.save({ ...lease, draftId: draft.draftId }).pipe(Effect.result)
      const job = yield* archive.getJob(claim.job.id)
      const storedEvent = yield* archive.readEvent(makeEvent("summary.completed").id).pipe(Effect.result)
      return { firstAttempt, secondAttempt, exhaustedAttempt, job, storedEvent, requests: env.sample.state.requests }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.firstAttempt.state, "uncertain")
    assert.equal(result.firstAttempt.retryAllowed, true)
    assert.equal(result.secondAttempt.state, "needs_review")
    assert.equal(result.secondAttempt.retryAllowed, false)
    assert.equal(result.exhaustedAttempt._tag, "Failure")
    assert.equal(result.job.state, "needs_review")
    assert.equal(result.storedEvent._tag, "Success")
    if (result.storedEvent._tag === "Success") assert.equal((result.storedEvent.success as { state: string }).state, "complete")
    assert.equal(result.requests.filter((request) => request.method === "PATCH").length, 2)
  } finally { env.cleanup() }
})

test("latest-source completion supersedes older queued work and its events ack complete", async () => {
  const acknowledgements: { id: string; phase: string }[] = []
  const events = [1, 2, 3].map((index) => makeEvent("summary.completed", {
    timestamp: `2026-10-16T12:00:0${index}.000Z`,
    summarizations: { "summary-1": { id: "summary-row-1", summarizationId: "summary-1", v2: { summary: { markdown: `Trigger ${index}` } } } }
  }, index))
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { phase: string }
      const id = decodeURIComponent(new URL(String(_input)).pathname.split("/").at(-2) ?? "")
      acknowledgements.push({ id, phase: body.phase })
      return new Response(JSON.stringify({ id, phase: body.phase }), { status: 200 })
    }
    return new Response(JSON.stringify({ events, hasMore: false, nextCursor: null }), { status: 200 })
  }
  const env = environment({ writesEnabled: true, fetcher })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      const fullSnapshot = yield* Pocket.use((pocket) => pocket.archiveSnapshot("recording-1", "backfill"))
      yield* archive.recordSnapshot(fullSnapshot)
      for (const event of events) yield* archive.importWebhook(event, "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim)
      const lease = { jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }
      const transcript = yield* workflow.sources({ ...lease, source: "transcript", limit: 12000 })
      assert.ok(!transcript.content.includes("originalText"))
      yield* workflow.sources({ ...lease, source: "notes", contextId: transcript.contextId, limit: 12000 })
      const draft = yield* workflow.prepareDraft({ ...lease, contextId: transcript.contextId, markdown: "Final Notes", allowShorter: true })
      const saved = yield* workflow.save({ ...lease, draftId: draft.draftId })
      const jobs = yield* archive.listJobs("recording-1", 20)
      const states: unknown[] = []
      for (const event of events) states.push(yield* archive.readEvent(event.id))
      const sync = yield* workflow.syncBridge(2)
      const read = yield* archive.read("recording-1", 20)
      return { saved, jobs, states, sync, read }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.saved.state, "complete")
    assert.deepEqual(new Set(result.jobs.map((job) => job.state)), new Set(["complete", "skipped"]))
    assert.equal(result.jobs.filter((job) => job.state === "skipped").length, 2)
    assert.ok(result.states.every((event) => (event as { state: string }).state === "complete"))
    assert.equal(result.sync.completed, 3)
    assert.deepEqual(new Set(acknowledgements.map((item) => item.phase)), new Set(["complete"]))
    assert.equal((result.read as { metadata: { title: string } }).metadata.title, "Test recording")
  } finally { env.cleanup() }
})

test("recording deletion completes open work without rewriting finished job history", async () => {
  const acknowledgements: { id: string; phase: string }[] = []
  const older = makeEvent("summary.completed", { timestamp: "2026-10-16T12:00:01.000Z" }, 1)
  const newer = makeEvent("summary.regenerated", { timestamp: "2026-10-16T12:00:02.000Z" }, 2)
  const deleted = makeEvent("recording.deleted", { timestamp: "2026-10-16T12:00:03.000Z" }, 3)
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { phase: string }
      const id = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-2) ?? "")
      acknowledgements.push({ id, phase: body.phase })
      return new Response(JSON.stringify({ id, phase: body.phase }), { status: 200 })
    }
    return new Response(JSON.stringify({ events: [older, newer, deleted], hasMore: false, nextCursor: null }), { status: 200 })
  }
  const env = environment({ writesEnabled: false, fetcher })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      const fullSnapshot = yield* Pocket.use((pocket) => pocket.archiveSnapshot("recording-1", "backfill"))
      yield* archive.recordSnapshot(fullSnapshot)
      yield* archive.importWebhook(older, "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim)
      yield* archive.finishJob({ jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }, "needs_review", "reviewed")
      yield* archive.importWebhook(newer, "user-1")
      yield* archive.importWebhook(deleted, "user-1")
      const jobs = yield* archive.listJobs("recording-1", 20)
      const states: unknown[] = []
      for (const event of [older, newer, deleted]) states.push(yield* archive.readEvent(event.id))
      const sync = yield* workflow.syncBridge(2)
      const read = yield* archive.read("recording-1", 20)
      return { jobs, states, sync, read }
    }).pipe(Effect.provide(env.live)))
    const jobs = result.jobs
    assert.ok(jobs.some((job) => job.eventType === "summary.completed" && job.state === "needs_review"))
    assert.ok(jobs.some((job) => job.eventType === "summary.regenerated" && job.state === "source_gone"))
    assert.ok(result.states.every((event) => (event as { state: string }).state === "complete"))
    assert.equal(result.sync.completed, 3)
    assert.ok(acknowledgements.every((item) => item.phase === "complete"))
    assert.equal((result.read as { snapshots: unknown[] }).snapshots.length, 1)
    assert.equal((result.read as { metadata: { title: string } }).metadata.title, "Test recording")
  } finally { env.cleanup() }
})

test("a confirmed deletion after a possible write finishes saving as source_gone", async () => {
  const env = environment({ writesEnabled: true })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      const event = makeEvent("summary.completed")
      yield* archive.importWebhook(event, "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim)
      const lease = { jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }
      const transcript = yield* workflow.sources({ ...lease, source: "transcript", limit: 12000 })
      yield* workflow.sources({ ...lease, source: "notes", contextId: transcript.contextId, limit: 12000 })
      const draft = yield* workflow.prepareDraft({ ...lease, contextId: transcript.contextId, markdown: "Final Notes", allowShorter: true })
      env.sample.state.afterWrite = () => { env.sample.state.detailGone = true }
      const saved = yield* workflow.save({ ...lease, draftId: draft.draftId })
      const job = yield* archive.getJob(claim.job.id)
      const storedEvent = yield* archive.readEvent(event.id)
      return { saved, job, storedEvent }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.saved.state, "source_gone")
    assert.equal(result.job.state, "source_gone")
    assert.equal((result.storedEvent as { state: string }).state, "complete")
    assert.equal(env.sample.state.requests.filter((request) => request.method === "PATCH").length, 1)
  } finally { env.cleanup() }
})

test("source changes after page review stop the write and reconcile rejects a drafted job", async () => {
  const env = environment({ writesEnabled: true })
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const workflow = yield* ArchiveWorkflow
      const event = makeEvent("summary.completed")
      yield* archive.importWebhook(event, "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim)
      const lease = { jobId: claim.job.id, leaseToken: claim.leaseToken, fencingToken: claim.fencingToken }
      const transcript = yield* workflow.sources({ ...lease, source: "transcript", limit: 12000 })
      yield* workflow.sources({ ...lease, source: "notes", contextId: transcript.contextId, limit: 12000 })
      const draft = yield* workflow.prepareDraft({ ...lease, contextId: transcript.contextId, markdown: "Final Notes", allowShorter: true })
      const earlyReconcile = yield* workflow.reconcile({ ...lease, draftId: draft.draftId }).pipe(Effect.result)
      const segment = env.sample.state.detail.transcription.transcription.segments[1]!
      segment.text = "A transcript edit happened after review"
      segment.originalText = segment.text
      const saved = yield* workflow.save({ ...lease, draftId: draft.draftId })
      return { earlyReconcile, saved, job: yield* archive.getJob(claim.job.id) }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.earlyReconcile._tag, "Failure")
    assert.equal(result.saved.state, "conflict")
    assert.equal(result.job.state, "conflict")
    assert.equal(env.sample.state.requests.filter((request) => request.method === "PATCH").length, 0)
  } finally { env.cleanup() }
})

test("bridge event imports reject raw mismatches, noncanonical bytes, wrong owners and reused IDs", async () => {
  const env = environment()
  try {
    const results = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      const event = makeEvent("summary.updated")
      yield* archive.importWebhook(event, "user-1")
      const payloadMismatch = yield* archive.importWebhook({ ...event, payload: { ...event.payload, event: "summary.completed" } }, "user-1").pipe(Effect.result)
      const noncanonical = yield* archive.importWebhook({ ...event, rawBodyBase64: `${event.rawBodyBase64}=` }, "user-1").pipe(Effect.result)
      const wrongOwnerEvent = makeEvent("summary.updated", { user: { id: "other-user", email: "test@example.com" } }, 2)
      const wrongOwner = yield* archive.importWebhook(wrongOwnerEvent, "user-1").pipe(Effect.result)
      const reusedId = yield* archive.importWebhook({ ...event, receivedAt: "2026-10-16T13:00:00.000Z" }, "user-1").pipe(Effect.result)
      return { payloadMismatch, noncanonical, wrongOwner, reusedId }
    }).pipe(Effect.provide(env.live)))
    assert.equal(results.payloadMismatch._tag, "Failure")
    assert.equal(results.noncanonical._tag, "Failure")
    assert.equal(results.wrongOwner._tag, "Failure")
    assert.equal(results.reusedId._tag, "Failure")
  } finally { env.cleanup() }
})

test("expired saving leases recover to uncertainty while live saves stay fenced", async () => {
  const env = environment()
  try {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Archive
      yield* archive.importWebhook(makeEvent("summary.completed"), "user-1")
      const claim = yield* archive.claimNext(1800000)
      assert.ok(claim)
      const db = new DatabaseSync(join(env.dataDir, "archive.sqlite"))
      db.prepare("UPDATE jobs SET state='saving',lease_until=? WHERE job_id=?").run(Date.now() + 60000, claim.job.id)
      db.close()
      yield* archive.recoverSaving
      const whileLive = yield* archive.getJob(claim.job.id)
      const staleDb = new DatabaseSync(join(env.dataDir, "archive.sqlite"))
      staleDb.prepare("UPDATE jobs SET lease_until=0 WHERE job_id=?").run(claim.job.id)
      staleDb.close()
      const reclaimed = yield* archive.claimNext(1800000)
      return { whileLive, reclaimed }
    }).pipe(Effect.provide(env.live)))
    assert.equal(result.whileLive.state, "saving")
    assert.equal(result.reclaimed?.job.state, "uncertain")
    assert.equal(result.reclaimed?.fencingToken, 2)
  } finally { env.cleanup() }
})

test("separate Archive layers cannot open the same database concurrently", async () => {
  const env = environment()
  try {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const settings = Layer.succeed(Settings, { dataDir: env.dataDir, port: 9011 })
      yield* Layer.build(ArchiveLive.pipe(Layer.provide(settings)))
      return yield* Layer.build(Layer.fresh(ArchiveLive.pipe(Layer.provide(settings)))).pipe(Effect.result)
    })))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.equal(result.failure.code, "storage")
  } finally { env.cleanup() }
})

test("background polling notices a bridge config added after server start", async () => {
  const requests: string[] = []
  const fetcher: typeof fetch = async (input) => {
    requests.push(new URL(String(input)).pathname)
    return new Response(JSON.stringify({ events: [], hasMore: false, nextCursor: null }), { status: 200 })
  }
  const env = environment({ fetcher, pollInterval: "10 millis" })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const workflow = yield* ArchiveWorkflow
      yield* workflow.start
      yield* Effect.sleep("30 millis")
      writeFileSync(join(env.dataDir, "bridge-token"), "test-token\n", { mode: 0o600 })
      chmodSync(join(env.dataDir, "bridge-token"), 0o600)
      writeFileSync(join(env.dataDir, "bridge.json"), JSON.stringify({ url: "http://192.168.1.47:8084", tokenFile: "bridge-token", writesEnabled: false }), { mode: 0o600 })
      chmodSync(join(env.dataDir, "bridge.json"), 0o600)
      yield* Effect.sleep("80 millis")
    }).pipe(Effect.provide(env.live))))
    assert.ok(requests.includes("/api/events"))
  } finally { env.cleanup() }
})
