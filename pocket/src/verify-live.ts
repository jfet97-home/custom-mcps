import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Backups, canonicalJson } from "./backups.js"
import { failure } from "./core.js"
import { PocketTransport } from "./transport.js"
import { notesFrom, transcriptFrom } from "./recording.js"
import { checked } from "./pocket.js"
import { runtime } from "./runtime.js"
import { roundTrip } from "./verification.js"

const program = Effect.gen(function*() {
  const recordingId = process.argv[2]
  if (!recordingId || !/^[A-Za-z0-9_-]{1,256}$/.test(recordingId)) return yield* Effect.fail(failure("validation", "Pass the exact recording ID authorized for reversible verification."))
  const api = yield* PocketTransport
  const backups = yield* Backups
  const read = api.request("GET", `/api/v1/recordings/${recordingId}?include=all`)
  const initial = yield* read
  const notes = yield* checked(() => notesFrom(initial))
  const transcript = yield* checked(() => transcriptFrom(initial))
  const segment = transcript.segments.find((entry) => (entry.text ?? "").length > 0 && entry.text === entry.originalText)
  if (!segment) return yield* Effect.fail(failure("validation", "The selected recording has no text segment to verify."))
  const notesBackup = yield* backups.save("notes", recordingId, { document: notes, rawRecording: initial }, notes.summarizationId)
  const transcriptBackup = yield* backups.save("transcript", recordingId, { document: transcript, rawRecording: initial })
  process.stdout.write(`${JSON.stringify({ recordingId, summarizationId: notes.summarizationId, notesCharacters: notes.markdown.length, transcriptSegments: transcript.segments.length, notesBackup, transcriptBackup })}\n`)
  const marker = `[Pocket MCP reversible verification ${randomUUID()}]`
  const notesResult = yield* roundTrip({
    original: notes.markdown, modified: `${notes.markdown}\n\n${marker}`,
    read: read.pipe(Effect.flatMap((raw) => checked(() => notesFrom(raw, notes.summarizationId).markdown))),
    write: (markdown) => api.request("PATCH", `/api/v1/summarize/${notes.summarizationId}/markdown`, { markdown })
  })
  process.stdout.write(`${JSON.stringify({ notes: notesResult })}\n`)
  const snapshot = (value: ReturnType<typeof transcriptFrom>) => canonicalJson({ transcriptionId: value.transcriptionId, segments: value.segments })
  const original = snapshot(transcript)
  const modified = snapshot({ ...transcript, segments: transcript.segments.map((s) => s.segmentIndex === segment.segmentIndex ? { ...s, text: `${s.text} ${marker}`, originalText: `${s.text} ${marker}` } : s) })
  const transcriptResult = yield* roundTrip({
    original, modified,
    read: read.pipe(Effect.flatMap((raw) => checked(() => snapshot(transcriptFrom(raw))))),
    write: (value) => Effect.gen(function*() {
      const text = value === original ? segment.text ?? segment.originalText ?? "" : `${segment.text ?? segment.originalText ?? ""} ${marker}`
      yield* api.request("POST", `/api/v1/transcript-edit/${recordingId}/batch`, { actions: [{ type: "edit_text", segmentIndex: segment.segmentIndex, text }] })
    })
  })
  process.stdout.write(`${JSON.stringify({ transcript: transcriptResult })}\n`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(runtime), Effect.catch((error) => Effect.sync(() => {
  process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1
})), Effect.catchCause(() => Effect.sync(() => { process.stderr.write("Live verification failed. Inspect the private backup and server state.\n"); process.exitCode = 1 }))), { disableErrorReporting: true })
