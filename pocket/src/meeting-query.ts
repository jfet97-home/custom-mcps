import { Context, Deferred, Effect, Layer, Redacted, Schema } from "effect"
import { API_ORIGIN, failure, PocketError, Settings, type PocketError as PocketErrorType } from "./core.js"
import { Session } from "./session.js"
import {
  makeMeetingQueryJournal, MeetingQueryJournalEntrySchema, MeetingQueryOperationsSchema,
  MeetingQuerySourceSchema as SafeMeetingQuerySourceSchema,
  type MeetingQueryCreateResult,
  type MeetingQuerySource
} from "./meeting-query-journal.js"

const route = "/api/v1/global-chat/message/stream"
const maxQueryLength = 4000
const maxLanguageLength = 100
const defaultMaxResponseBytes = 2 * 1024 * 1024
const defaultTimeoutMs = 180_000
const defaultIdleTimeoutMs = 60_000
const defaultMaxEvents = 32_768
const defaultInitialWaitMs = 15_000
const maximumInitialWaitMs = 20_000
const staleQueryMarginMs = 60_000
const maximumStaleAfterMs = 15 * 60_000
const clientRequestIdSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
const lookupLimitSchema = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 20 }))

export const MeetingQueryInputSchema = Schema.Struct({
  query: Schema.NonEmptyString.check(Schema.isMaxLength(maxQueryLength)),
  language: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maxLanguageLength))),
  clientRequestId: Schema.optionalKey(clientRequestIdSchema),
  consumeQuota: Schema.Literal(true)
})
export type MeetingQueryInput = typeof MeetingQueryInputSchema.Type

export const MeetingQuerySourceSchema = SafeMeetingQuerySourceSchema
export type MeetingSourceRecording = MeetingQuerySource

const operationIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))
export const MeetingQueryCompleteResultSchema = Schema.Struct({
  operationId: operationIdSchema,
  clientRequestId: Schema.optionalKey(clientRequestIdSchema),
  answer: Schema.NonEmptyString,
  sourceRecordings: Schema.Array(MeetingQuerySourceSchema),
  sessionId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  engine: Schema.Literal("pocket"),
  createsRemoteChat: Schema.Literal(true)
})
export const MeetingQueryPendingResultSchema = Schema.Struct({
  operationId: operationIdSchema,
  clientRequestId: Schema.optionalKey(clientRequestIdSchema),
  status: Schema.Literal("running")
})
export const MeetingQueryResultSchema = Schema.Union([MeetingQueryCompleteResultSchema, MeetingQueryPendingResultSchema])
export type MeetingQueryCompleteResult = typeof MeetingQueryCompleteResultSchema.Type
export type MeetingQueryPendingResult = typeof MeetingQueryPendingResultSchema.Type
export type MeetingQueryResult = typeof MeetingQueryResultSchema.Type
export const MeetingQueryLookupInputSchema = Schema.Struct({
  operationId: Schema.optionalKey(operationIdSchema),
  clientRequestId: Schema.optionalKey(clientRequestIdSchema),
  limit: Schema.optionalKey(lookupLimitSchema)
})
export const MeetingQueryLookupResultSchema = Schema.Union([
  Schema.Struct({ operation: MeetingQueryJournalEntrySchema }),
  MeetingQueryOperationsSchema
])
export type MeetingQueryLookupInput = typeof MeetingQueryLookupInputSchema.Type
export type MeetingQueryLookupResult = typeof MeetingQueryLookupResultSchema.Type

export class MeetingQuery extends Context.Service<MeetingQuery, {
  readonly query: (input: MeetingQueryInput) => Effect.Effect<MeetingQueryResult, PocketErrorType>
  readonly lookup: (input: MeetingQueryLookupInput) => Effect.Effect<MeetingQueryLookupResult, PocketErrorType>
}>()("pocket/MeetingQuery") {}

type StreamState = {
  readonly chunks: string[]
  sessionId?: string
  sourceRecordings: ReadonlyArray<MeetingSourceRecording>
  completed: boolean
  fullText?: string
}

type ProgressSnapshot = {
  readonly answer: string
  readonly sourceRecordings: ReadonlyArray<MeetingSourceRecording>
  readonly sessionId?: string
}

type QueryOptions = {
  readonly timeoutMs: number
  readonly idleTimeoutMs: number
  readonly maxResponseBytes: number
  readonly maxEvents: number
  readonly initialWaitMs: number
  readonly staleAfterMs: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const safeString = (value: unknown, maxLength: number, field: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > maxLength) throw failure("upstream", `Pocket returned invalid ${field} metadata.`)
  return value
}

const decodeSources = (value: unknown): ReadonlyArray<MeetingSourceRecording> => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return []
  const decoded: MeetingSourceRecording[] = []
  for (const item of value.slice(0, 50)) {
    try {
      if (!isRecord(item)) continue
      const recordingId = safeString(item.recordingId ?? item.id, 256, "recording id")
      if (!recordingId || !/^[A-Za-z0-9_-]{1,256}$/.test(recordingId)) continue
      const title = safeString(item.title, 500, "recording title")
      const summary = safeString(item.summary ?? item.sectionSummary ?? item.section_summary, 20000, "source summary")
      const snippet = safeString(item.snippet, 20000, "source snippet")
      const date = safeString(item.date, 100, "source date")
      const speakers = item.speakers === null ? null : safeString(item.speakers, 2000, "source speakers")
      const relevanceScore = item.relevanceScore
      if (relevanceScore !== undefined && (typeof relevanceScore !== "number" || !Number.isFinite(relevanceScore))) continue
      decoded.push({
        recordingId,
        ...(title === undefined ? {} : { title }),
        ...(relevanceScore === undefined ? {} : { relevanceScore }),
        ...(summary === undefined ? {} : { summary }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(date === undefined ? {} : { date }),
        ...(speakers === undefined ? {} : { speakers })
      })
    } catch {
      continue
    }
  }
  return decoded
}

const quotaCodes = new Set([
  "TOKEN_LIMIT_EXCEEDED",
  "GLOBAL_CHAT_MESSAGE_LIMIT",
  "GLOBAL_CHAT_DAILY_LIMIT",
  "RECORDING_CHAT_MESSAGE_LIMIT",
  "RECORDING_CHAT_DAILY_LIMIT"
])

const permissionCodes = new Set(["PRO_REQUIRED", "PRO_TIER_REQUIRED", "SUBSCRIPTION_REQUIRED", "MODEL_TIER_PRO_REQUIRED"])

const streamFailure = (message = "Pocket did not finish the meeting query. The remote chat may exist; check Pocket chat history before retrying.") =>
  failure("uncertain_write", message)

const handleEvent = (state: StreamState, event: unknown): { readonly completed: boolean; readonly progress: boolean } => {
  if (!isRecord(event) || typeof event.type !== "string") return { completed: false, progress: false }
  switch (event.type) {
    case "connected":
    case "title_generated":
      return { completed: false, progress: false }
    case "session": {
      if (event.sessionId !== undefined) {
        if (typeof event.sessionId !== "string" || event.sessionId.length === 0 || event.sessionId.length > 256) throw streamFailure("Pocket returned an invalid session event. Check Pocket chat history before retrying.")
        state.sessionId = event.sessionId
      }
      return { completed: false, progress: true }
    }
    case "chunk":
      if (typeof event.content !== "string") throw streamFailure("Pocket returned an invalid answer chunk. Check Pocket chat history before retrying.")
      state.chunks.push(event.content)
      return { completed: false, progress: true }
    case "sources":
      state.sourceRecordings = decodeSources(event.sources)
      return { completed: false, progress: true }
    case "tool_started":
    case "tool_finished":
      if (event.invocation !== undefined && !isRecord(event.invocation)) throw streamFailure("Pocket returned an invalid tool event. Check Pocket chat history before retrying.")
      return { completed: false, progress: false }
    case "completed":
      if (event.fullText !== undefined && typeof event.fullText !== "string") throw streamFailure("Pocket returned an invalid completed answer. Check Pocket chat history before retrying.")
      state.fullText = event.fullText as string | undefined
      state.completed = true
      return { completed: true, progress: true }
    case "error": {
      const code = typeof event.errorCode === "string" ? event.errorCode : ""
      if (quotaCodes.has(code)) {
        const limit = typeof event.limit === "number" && Number.isFinite(event.limit) ? `; limit ${event.limit}` : ""
        const current = typeof event.currentUsage === "number" && Number.isFinite(event.currentUsage) ? `, usage ${event.currentUsage}` : ""
        throw failure("permission", `Pocket meeting-query quota reached (${code}${limit}${current}). No automatic retry was attempted.`)
      }
      if (permissionCodes.has(code)) throw failure("permission", "Pocket denied the requested meeting-query model tier. No alternate tier was attempted.")
      throw streamFailure("Pocket returned an error before completing the meeting query. Check Pocket chat history before retrying.")
    }
    default:
      return { completed: false, progress: false }
  }
}

const readEventStream = async (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: QueryOptions,
  operationId: string,
  onProgress: (snapshot: ProgressSnapshot) => Promise<void>
): Promise<MeetingQueryCompleteResult> => {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const state: StreamState = { chunks: [], sourceRecordings: [], completed: false }
  let buffered = ""
  let dataLines: string[] = []
  let receivedBytes = 0
  let eventCount = 0
  let stop = false
  let lastPersistedAt = Date.now()
  let lastPersistedCharacters = 0
  const snapshot = (): ProgressSnapshot => ({
    answer: state.chunks.join(""),
    sourceRecordings: state.sourceRecordings,
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId })
  })
  const saveProgress = async (force: boolean) => {
    const current = snapshot()
    const characterDelta = current.answer.length - lastPersistedCharacters
    if (!force && Date.now() - lastPersistedAt < 1000 && characterDelta < 16_000) return
    await onProgress(current)
    lastPersistedAt = Date.now()
    lastPersistedCharacters = current.answer.length
  }
  const dispatch = async () => {
    if (dataLines.length === 0) return
    eventCount++
    if (eventCount > options.maxEvents) throw streamFailure("Pocket's meeting-query stream exceeded the event limit. Check Pocket chat history before retrying.")
    const payload = dataLines.join("\n")
    dataLines = []
    let event: unknown
    try { event = JSON.parse(payload) }
    catch { throw streamFailure("Pocket returned invalid meeting-query event data. Check Pocket chat history before retrying.") }
    const outcome = handleEvent(state, event)
    if (outcome.progress) await saveProgress(isRecord(event) && (event.type === "session" || event.type === "sources" || event.type === "completed"))
    stop = outcome.completed
  }
  const processLine = async (line: string) => {
    if (line === "") { await dispatch(); return }
    if (line.startsWith(":")) return
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
  }
  const processAvailableLines = async (final = false) => {
    let start = 0
    let index = 0
    while (index < buffered.length && !stop) {
      const character = buffered[index]
      if (character === "\r" || character === "\n") {
        if (character === "\r" && index + 1 === buffered.length && !final) break
        await processLine(buffered.slice(start, index))
        if (character === "\r" && buffered[index + 1] === "\n") index++
        start = index + 1
      }
      index++
    }
    buffered = buffered.slice(start)
    if (final && buffered.length > 0) {
      await processLine(buffered)
      buffered = ""
    }
  }
  const readWithIdleTimeout = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(streamFailure("Pocket's meeting-query stream was idle. The remote chat may exist; check Pocket chat history before retrying.")), options.idleTimeoutMs)
        }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(streamFailure("Pocket meeting query timed out or was interrupted. Check Pocket chat history before retrying."))
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort)
    }
  }
  try {
    while (!stop) {
      if (signal.aborted) throw streamFailure("Pocket meeting query timed out or was interrupted. Check Pocket chat history before retrying.")
      const { done, value } = await readWithIdleTimeout()
      if (done) {
        buffered += decoder.decode()
        await processAvailableLines(true)
        await dispatch()
        break
      }
      receivedBytes += value.byteLength
      if (receivedBytes > options.maxResponseBytes) throw streamFailure(`Pocket's meeting-query response exceeded the ${Math.floor(options.maxResponseBytes / 1024 / 1024)} MiB limit. Check Pocket chat history before retrying.`)
      buffered += decoder.decode(value, { stream: true })
      await processAvailableLines()
    }
    if (!state.completed) throw streamFailure()
    const answer = (state.fullText ?? state.chunks.join("")).trim()
    if (!answer) throw streamFailure("Pocket completed without an answer. Check Pocket chat history before retrying.")
    await reader.cancel().catch(() => undefined)
    return {
      operationId,
      answer,
      sourceRecordings: state.sourceRecordings,
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      engine: "pocket",
      createsRemoteChat: true
    }
  } catch (error) {
    await saveProgress(true).catch(() => undefined)
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

const isRejected = (error: PocketErrorType) => error.code === "authentication" || error.code === "permission" ||
  error.code === "validation" || error.code === "upstream" && error.status !== undefined && error.status < 500

const withOperationId = (error: PocketErrorType, operationId: string) => new PocketError({
  ...error,
  message: `${error.message} operationId: ${operationId}.`
})

type CreatedOperation = Extract<MeetingQueryCreateResult, { readonly kind: "created" }>
type QueryExecutionOutcome =
  | { readonly _tag: "Success"; readonly success: MeetingQueryCompleteResult }
  | { readonly _tag: "Failure"; readonly failure: PocketErrorType }

const executeClaimedQuery = (
  token: string,
  input: { readonly query: string; readonly language: string; readonly clientRequestId?: string },
  operation: CreatedOperation,
  fetcher: typeof globalThis.fetch,
  options: QueryOptions
): Effect.Effect<MeetingQueryCompleteResult, PocketErrorType> => {
  const operationId = operation.entry.operationId
  let latestProgress: ProgressSnapshot = { answer: "", sourceRecordings: [] }
  let progressPersistenceFailed = false
  let locallyComplete = false
  let progressClosed = false
  let progressWrites = Promise.resolve()
  const onProgress = async (progress: ProgressSnapshot) => {
    if (progressClosed) return
    latestProgress = progress
    const write = progressWrites.then(async () => {
      if (progressClosed) return
      try {
        await operation.update({
          status: "streaming",
          answer: progress.answer,
          sourceRecordings: [...progress.sourceRecordings],
          ...(progress.sessionId === undefined ? {} : { sessionId: progress.sessionId })
        })
        progressPersistenceFailed = false
      } catch { progressPersistenceFailed = true }
    })
    progressWrites = write
    await write
  }
  const run = Effect.tryPromise({
    try: async (signal) => {
      let remoteCompleted = false
      let completedResult: MeetingQueryCompleteResult | undefined
      try {
        const result = await requestMeetingQuery(token, input, fetcher, options, signal, operationId, onProgress)
        if (signal.aborted) throw streamFailure("Pocket meeting query was interrupted. Check Pocket chat history before retrying.")
        remoteCompleted = true
        completedResult = {
          ...result,
          ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId })
        }
        latestProgress = {
          answer: result.answer,
          sourceRecordings: result.sourceRecordings,
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId })
        }
        try {
          await operation.update({
            status: "complete",
            answer: result.answer,
            sourceRecordings: [...result.sourceRecordings],
            ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId })
          })
          progressPersistenceFailed = false
          locallyComplete = true
        } catch {
          progressPersistenceFailed = true
        }
        if (!progressPersistenceFailed) return completedResult
        throw streamFailure(`Pocket completed the query, but local result persistence is uncertain. Check Pocket chat history before retrying. operationId: ${operationId}.`)
      } catch (error) {
        const safeError = error instanceof PocketError ? error : streamFailure()
        if (remoteCompleted && completedResult) {
          try {
            await operation.update({
              status: "complete",
              answer: completedResult.answer,
              sourceRecordings: [...completedResult.sourceRecordings],
              ...(completedResult.sessionId === undefined ? {} : { sessionId: completedResult.sessionId })
            })
            locallyComplete = true
            return completedResult
          } catch { progressPersistenceFailed = true }
        }
        const recoveryWarning = progressPersistenceFailed ? " Local journal state may be stale; use operationId to inspect it." : ""
        const finalError = remoteCompleted
          ? streamFailure(`Pocket completed the query, but local result recovery failed.${recoveryWarning} Check Pocket chat history before retrying.`)
          : progressPersistenceFailed
            ? new PocketError({ ...safeError, message: `${safeError.message}${recoveryWarning}` })
            : safeError
        const outcome = !isRejected(finalError) ? "uncertain" : "rejected"
        try {
          await operation.update({
            status: outcome,
            answer: latestProgress.answer,
            sourceRecordings: [...latestProgress.sourceRecordings],
            ...(latestProgress.sessionId === undefined ? {} : { sessionId: latestProgress.sessionId }),
            errorCode: finalError.code
          })
          progressPersistenceFailed = false
        } catch { progressPersistenceFailed = true }
        const persistedError = progressPersistenceFailed && !finalError.message.includes("journal state")
          ? new PocketError({ ...finalError, message: `${finalError.message} Local journal state may be stale; operationId: ${operationId}.` })
          : finalError
        throw withOperationId(persistedError, operationId)
      }
    },
    catch: (error) => error instanceof PocketError ? error : streamFailure("Pocket meeting query did not finish; its remote chat outcome is uncertain.")
  })
  return Effect.onInterrupt(run, () => {
    progressClosed = true
    if (locallyComplete) return Effect.void
    return Effect.tryPromise({
      try: async () => {
        await progressWrites
        if (locallyComplete) return
        await operation.update({
          status: "uncertain",
          answer: latestProgress.answer,
          sourceRecordings: [...latestProgress.sourceRecordings],
          ...(latestProgress.sessionId === undefined ? {} : { sessionId: latestProgress.sessionId }),
          errorCode: "uncertain_write"
        })
      },
      catch: () => failure("storage", "Could not persist the interrupted meeting-query state.")
    }).pipe(Effect.catch(() => Effect.void))
  })
}

const requestMeetingQuery = async (
  token: string,
  input: { query: string; language: string },
  fetcher: typeof globalThis.fetch,
  options: QueryOptions,
  operationSignal: AbortSignal,
  operationId: string,
  onProgress: (snapshot: ProgressSnapshot) => Promise<void>
): Promise<MeetingQueryCompleteResult> => {
  const timeout = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; timeout.abort() }, options.timeoutMs)
  const signal = AbortSignal.any([operationSignal, timeout.signal])
  try {
    let response: Response
    try {
      response = await fetcher(new URL(route, API_ORIGIN), {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "text/event-stream"
        },
        body: JSON.stringify({
          message: input.query,
          language: input.language,
          modelTier: "thinking",
          structuredXmlCards: true
        })
      })
    } catch {
      throw streamFailure(timedOut
        ? "Pocket meeting query timed out before a complete response. Check Pocket chat history before retrying."
        : "Pocket meeting query did not return a response. Check Pocket chat history before retrying.")
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 401) throw failure("authentication", "Pocket rejected the session. Run pocket-mcp auth status or login again.", 401)
      if (response.status === 403) throw failure("permission", "Pocket denied the meeting query for this account or model tier.", 403)
      if (response.status === 429) throw failure("permission", "Pocket rejected the meeting query because an account quota or rate limit was reached. No automatic retry was attempted.", 429)
      if (response.status >= 500) throw streamFailure(`Pocket returned HTTP ${response.status} before completing the meeting query. Check Pocket chat history before retrying.`)
      throw failure("upstream", `Pocket rejected the meeting query (HTTP ${response.status}).`, response.status)
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (!contentType.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined)
      throw streamFailure("Pocket returned an unsupported meeting-query response. Check Pocket chat history before retrying.")
    }
    if (!response.body) throw streamFailure("Pocket returned an empty meeting-query stream. Check Pocket chat history before retrying.")
    let result: MeetingQueryCompleteResult
    try { result = await readEventStream(response.body, signal, options, operationId, onProgress) }
    catch (error) {
      if (error instanceof PocketError) throw error
      throw streamFailure("Pocket's meeting-query stream failed before completion. Check Pocket chat history before retrying.")
    }
    return { ...result, operationId }
  } finally {
    clearTimeout(timer)
  }
}

export const makeMeetingQueryLive = (
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  options: Partial<QueryOptions> = {}
) => Layer.effect(MeetingQuery, Effect.gen(function*() {
  const session = yield* Session
  const settings = yield* Settings
  const serviceScope = yield* Effect.scope
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const limits: QueryOptions = {
    timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs ?? defaultIdleTimeoutMs,
    maxResponseBytes: options.maxResponseBytes ?? defaultMaxResponseBytes,
    maxEvents: options.maxEvents ?? defaultMaxEvents,
    initialWaitMs: Math.max(0, Math.min(maximumInitialWaitMs, options.initialWaitMs ?? defaultInitialWaitMs)),
    staleAfterMs: Math.max(0, Math.min(maximumStaleAfterMs, options.staleAfterMs ?? timeoutMs + staleQueryMarginMs))
  }
  const journal = makeMeetingQueryJournal(settings.dataDir, limits.staleAfterMs)
  return {
    query: (input: MeetingQueryInput) => {
      const query = typeof input?.query === "string" ? input.query.trim() : ""
      const languageInput = typeof input?.language === "string" ? input.language.trim() : ""
      const clientRequestId = input?.clientRequestId
      if (input?.consumeQuota !== true) return Effect.fail(failure("validation", "Set consumeQuota=true to acknowledge that Pocket may store a chat and consume account quota."))
      if (!query) return Effect.fail(failure("validation", "Provide a nonempty meeting query."))
      if (query.length > maxQueryLength) return Effect.fail(failure("validation", "Meeting queries can contain at most 4000 characters."))
      if (languageInput.length > maxLanguageLength) return Effect.fail(failure("validation", "The requested language is too long."))
      if (clientRequestId !== undefined && (typeof clientRequestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(clientRequestId))) return Effect.fail(failure("validation", "clientRequestId must contain 1 to 64 letters, numbers, underscores, or dashes."))
      const language = languageInput || "English (US)"
      return Effect.gen(function*() {
        const token = yield* session.token
        const claimed = yield* Effect.tryPromise({
          try: () => journal.create({ query, language, ...(clientRequestId === undefined ? {} : { clientRequestId }) }),
          catch: (error) => error instanceof PocketError ? error : failure("storage", "Could not safely create the private meeting-query journal entry.")
        })
        if (claimed.kind === "duplicate") {
          if (!claimed.matchesRequest) {
            return yield* Effect.fail(failure("conflict", `clientRequestId was already used for a different query; state: ${claimed.status}. No new Pocket request was sent. operationId: ${claimed.operationId}.`))
          }
          if (claimed.entry?.status === "complete" && typeof claimed.entry.answer === "string" && claimed.entry.answer.trim()) {
            return {
              operationId: claimed.operationId,
              ...(clientRequestId === undefined ? {} : { clientRequestId }),
              answer: claimed.entry.answer,
              sourceRecordings: claimed.entry.sourceRecordings ?? [],
              ...(claimed.entry.sessionId === undefined ? {} : { sessionId: claimed.entry.sessionId }),
              engine: "pocket" as const,
              createsRemoteChat: true as const
            }
          }
          if (claimed.status === "streaming") {
            return {
              operationId: claimed.operationId,
              ...(clientRequestId === undefined ? {} : { clientRequestId }),
              status: "running" as const
            }
          }
          const code = claimed.status === "rejected" ? claimed.entry?.errorCode === "permission" ? "permission" : "conflict" : "uncertain_write"
          return yield* Effect.fail(failure(code, `clientRequestId was already used; state: ${claimed.status}. No new Pocket request was sent. Check Pocket chat history before retrying. operationId: ${claimed.operationId}.`))
        }
        const operation = claimed
        const operationId = operation.entry.operationId
        yield* Effect.tryPromise({
          try: () => operation.update({ status: "streaming" }),
          catch: (error) => withOperationId(error instanceof PocketError ? error : failure("storage", "Could not persist the meeting-query running state."), operationId)
        })
        const completed = yield* Deferred.make<QueryExecutionOutcome>()
        const execution = executeClaimedQuery(
          Redacted.value(token),
          { query, language, ...(clientRequestId === undefined ? {} : { clientRequestId }) },
          operation,
          fetcher,
          limits
        ).pipe(Effect.tapError((error) => error.code === "authentication" ? session.invalidate : Effect.void))
        const task = Effect.result(execution).pipe(Effect.flatMap((outcome) => Deferred.succeed(completed, outcome)))
        yield* Effect.forkIn(task, serviceScope)
        const outcome = yield* Effect.race(Effect.sleep(limits.initialWaitMs).pipe(Effect.as(null)))(Deferred.await(completed))
        if (outcome === null) return {
          operationId,
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
          status: "running" as const
        }
        if (outcome._tag === "Failure") return yield* Effect.fail(outcome.failure)
        return outcome.success
      }).pipe(Effect.tapError((error) => error.code === "authentication" ? session.invalidate : Effect.void))
    },
    lookup: (input: MeetingQueryLookupInput) => {
      const operationId = input?.operationId
      const clientId = input?.clientRequestId
      const hasOperationId = typeof operationId === "string"
      const hasClientRequestId = typeof clientId === "string"
      if (hasOperationId && hasClientRequestId) return Effect.fail(failure("validation", "Look up a meeting query by operationId or clientRequestId, not both."))
      if ((hasOperationId || hasClientRequestId) && input.limit !== undefined) return Effect.fail(failure("validation", "A history limit only applies when listing recent meeting queries."))
      if (!hasOperationId && !hasClientRequestId) return Effect.tryPromise({
        try: async () => ({ operations: await journal.listRecent(input.limit ?? 10) }),
        catch: (error) => error instanceof PocketError ? error : failure("storage", "Could not read the private meeting-query journal.")
      })
      return Effect.tryPromise({
        try: async () => ({ operation: hasOperationId ? await journal.lookup(operationId!) : await journal.lookupByClientRequestId(clientId!) }),
        catch: (error) => error instanceof PocketError ? error : failure("storage", "Could not read the private meeting-query journal.")
      })
    }
  }
}))

export const MeetingQueryLive = makeMeetingQueryLive()
