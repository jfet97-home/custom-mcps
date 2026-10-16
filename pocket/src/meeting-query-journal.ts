import { createHash, randomUUID } from "node:crypto"
import { chmod, link, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { failure, PocketError, privateDirectory } from "./core.js"

const operationIdPattern = /^[a-f0-9-]{36}$/
const clientRequestIdPattern = /^[A-Za-z0-9_-]{1,64}$/
const operationIdSchema = Schema.String.check(Schema.isPattern(operationIdPattern))
const clientRequestIdSchema = Schema.String.check(Schema.isPattern(clientRequestIdPattern))

export const MeetingQuerySourceSchema = Schema.Struct({
  recordingId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,256}$/)),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  relevanceScore: Schema.optionalKey(Schema.Number),
  summary: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20000))),
  snippet: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20000))),
  date: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  speakers: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))))
})
export type MeetingQuerySource = typeof MeetingQuerySourceSchema.Type

export const MeetingQueryJournalEntrySchema = Schema.Struct({
  version: Schema.Literal(1),
  operationId: operationIdSchema,
  clientRequestId: Schema.optionalKey(clientRequestIdSchema),
  status: Schema.Literals(["intent", "streaming", "complete", "uncertain", "rejected"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  query: Schema.String.check(Schema.isMaxLength(4000)),
  language: Schema.String.check(Schema.isMaxLength(100)),
  modelTier: Schema.Literal("thinking"),
  answer: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024))),
  sourceRecordings: Schema.optionalKey(Schema.Array(MeetingQuerySourceSchema)),
  sessionId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  errorCode: Schema.optionalKey(Schema.Literals(["authentication", "permission", "conflict", "validation", "network", "uncertain_write", "upstream", "storage", "configuration"]))
})
export type MeetingQueryJournalEntry = typeof MeetingQueryJournalEntrySchema.Type

export const MeetingQueryOperationMetadataSchema = Schema.Struct({
  operationId: operationIdSchema,
  clientRequestId: Schema.optionalKey(clientRequestIdSchema),
  status: MeetingQueryJournalEntrySchema.fields.status,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  queryPreview: Schema.String.check(Schema.isMaxLength(160)),
  errorCode: Schema.optionalKey(MeetingQueryJournalEntrySchema.fields.errorCode)
})
export type MeetingQueryOperationMetadata = typeof MeetingQueryOperationMetadataSchema.Type

export const MeetingQueryOperationsSchema = Schema.Struct({ operations: Schema.Array(MeetingQueryOperationMetadataSchema) })
export type MeetingQueryJournalPatch = Partial<Pick<MeetingQueryJournalEntry,
  "status" | "answer" | "sourceRecordings" | "sessionId" | "errorCode"
>>

const claimSchema = Schema.Struct({
  version: Schema.Literal(1),
  clientRequestId: clientRequestIdSchema,
  operationId: operationIdSchema,
  requestHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  createdAt: Schema.String
})
type Claim = typeof claimSchema.Type

export type MeetingQueryCreateResult =
  | { readonly kind: "created"; readonly entry: MeetingQueryJournalEntry; readonly update: (patch: MeetingQueryJournalPatch) => Promise<MeetingQueryJournalEntry> }
  | { readonly kind: "duplicate"; readonly entry?: MeetingQueryJournalEntry; readonly operationId: string; readonly status: MeetingQueryJournalEntry["status"]; readonly matchesRequest: boolean }

const storageFailure = () => failure("storage", "Could not safely save or read the private Pocket meeting-query journal.")

export const makeMeetingQueryJournal = (dataDir: string, staleAfterMs = 4 * 60 * 1000) => {
  const staleThresholdMs = Number.isFinite(staleAfterMs) ? Math.max(0, Math.min(15 * 60 * 1000, staleAfterMs)) : 4 * 60 * 1000
  const directory = join(dataDir, "meeting-queries")
  let directoryReady: Promise<void> | undefined
  const ensureDirectory = () => directoryReady ??= (async () => {
    await privateDirectory(dataDir)
    await privateDirectory(directory)
  })()
  const operationPath = (operationId: string) => {
    if (!operationIdPattern.test(operationId)) throw failure("validation", "Provide a valid meeting-query operationId.")
    return join(directory, `${operationId}.json`)
  }
  const claimPath = (clientRequestId: string) => {
    if (!clientRequestIdPattern.test(clientRequestId)) throw failure("validation", "Provide a clientRequestId of 1 to 64 letters, numbers, underscores, or dashes.")
    return join(directory, `client-${clientRequestId}.claim`)
  }
  const checkFile = async (path: string, missingAllowed: boolean): Promise<boolean> => {
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw storageFailure()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && missingAllowed) return false
      if (error instanceof PocketError) throw error
      throw storageFailure()
    }
  }
  const createExclusive = async (path: string, content: string): Promise<boolean> => {
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" })
      await chmod(temporary, 0o600)
      try {
        await link(temporary, path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
        throw error
      }
    } catch (error) {
      if (error instanceof PocketError) throw error
      throw storageFailure()
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  const writeAtomic = async (entry: MeetingQueryJournalEntry): Promise<void> => {
    await ensureDirectory()
    const target = operationPath(entry.operationId)
    if (!await checkFile(target, false)) throw storageFailure()
    const temporary = join(directory, `.${entry.operationId}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: "wx" })
      await chmod(temporary, 0o600)
      await rename(temporary, target)
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw storageFailure()
    }
  }
  const readJson = async (path: string): Promise<unknown> => {
    if (!await checkFile(path, true)) return null
    try { return JSON.parse(await readFile(path, "utf8")) as unknown }
    catch { throw storageFailure() }
  }
  const readEntry = async (operationId: string): Promise<MeetingQueryJournalEntry> => {
    await ensureDirectory()
    const value = await readJson(operationPath(operationId))
    if (value === null) throw failure("validation", "No local Pocket meeting query exists for that operationId.")
    try {
      const entry = Schema.decodeUnknownSync(MeetingQueryJournalEntrySchema)(value)
      if (entry.operationId !== operationId) throw storageFailure()
      return normalizeStaleRunning(entry)
    } catch (error) {
      if (error instanceof PocketError) throw error
      throw storageFailure()
    }
  }
  const readClaim = async (clientRequestId: string): Promise<Claim | undefined> => {
    await ensureDirectory()
    const value = await readJson(claimPath(clientRequestId))
    if (value === null) return undefined
    try {
      const claim = Schema.decodeUnknownSync(claimSchema)(value)
      if (claim.clientRequestId !== clientRequestId) throw storageFailure()
      return claim
    } catch (error) {
      if (error instanceof PocketError) throw error
      throw storageFailure()
    }
  }
  const isClaimedEntry = (entry: MeetingQueryJournalEntry, claim: Claim) =>
    entry.operationId === claim.operationId && entry.clientRequestId === claim.clientRequestId &&
    createHash("sha256").update(JSON.stringify([entry.query, entry.language])).digest("hex") === claim.requestHash
  const normalizeStaleRunning = (entry: MeetingQueryJournalEntry): MeetingQueryJournalEntry => {
    if (entry.status !== "intent" && entry.status !== "streaming") return entry
    const ageMs = Date.now() - Date.parse(entry.updatedAt)
    if (Number.isFinite(ageMs) && ageMs <= staleThresholdMs && ageMs >= -60_000) return entry
    return { ...entry, status: "uncertain", errorCode: "uncertain_write" }
  }
  const makeHandle = (initial: MeetingQueryJournalEntry) => {
    let current = initial
    return {
      entry: initial,
      update: async (patch: MeetingQueryJournalPatch) => {
        current = Schema.decodeUnknownSync(MeetingQueryJournalEntrySchema)({ ...current, ...patch, updatedAt: new Date().toISOString() })
        await writeAtomic(current)
        return current
      }
    }
  }
  return {
    create: async (input: { readonly query: string; readonly language: string; readonly clientRequestId?: string }): Promise<MeetingQueryCreateResult> => {
      await ensureDirectory()
      const now = new Date().toISOString()
      const operationId = randomUUID()
      const requestHash = createHash("sha256").update(JSON.stringify([input.query, input.language])).digest("hex")
      if (input.clientRequestId !== undefined) {
        const path = claimPath(input.clientRequestId)
        const claim = Schema.decodeUnknownSync(claimSchema)({ version: 1, clientRequestId: input.clientRequestId, operationId, requestHash, createdAt: now })
        const claimed = await createExclusive(path, JSON.stringify(claim))
        if (!claimed) {
          const priorClaim = await readClaim(input.clientRequestId)
          if (!priorClaim) throw storageFailure()
          let value: unknown
          try { value = await readJson(operationPath(priorClaim.operationId)) }
          catch {
            return {
              kind: "duplicate",
              operationId: priorClaim.operationId,
              status: "uncertain",
              matchesRequest: priorClaim.requestHash === requestHash
            }
          }
          let entry: MeetingQueryJournalEntry | undefined
          if (value !== null) {
            try { entry = Schema.decodeUnknownSync(MeetingQueryJournalEntrySchema)(value) }
            catch { entry = undefined }
            if (entry && !isClaimedEntry(entry, priorClaim)) entry = undefined
          }
          if (entry !== undefined) entry = normalizeStaleRunning(entry)
          return {
            kind: "duplicate",
            ...(entry === undefined ? {} : { entry }),
            operationId: priorClaim.operationId,
            status: entry?.status ?? "uncertain",
            matchesRequest: priorClaim.requestHash === requestHash
          }
        }
      }
      const entry = Schema.decodeUnknownSync(MeetingQueryJournalEntrySchema)({
        version: 1,
        operationId,
        ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        status: "intent",
        createdAt: now,
        updatedAt: now,
        query: input.query,
        language: input.language,
        modelTier: "thinking"
      })
      if (!await createExclusive(operationPath(operationId), JSON.stringify(entry))) throw storageFailure()
      return { kind: "created", ...makeHandle(entry) }
    },
    lookup: readEntry,
    lookupByClientRequestId: async (clientRequestId: string) => {
      const claim = await readClaim(clientRequestId)
      if (!claim) throw failure("validation", "No local Pocket meeting query exists for that clientRequestId.")
      let value: unknown
      try { value = await readJson(operationPath(claim.operationId)) }
      catch { throw failure("uncertain_write", `The clientRequestId is claimed but its local journal record is unreadable. Check Pocket chat history. operationId: ${claim.operationId}.`) }
      if (value === null) throw failure("uncertain_write", `The clientRequestId is claimed but its local journal record is missing. Check Pocket chat history. operationId: ${claim.operationId}.`)
      try {
        const entry = Schema.decodeUnknownSync(MeetingQueryJournalEntrySchema)(value)
        if (!isClaimedEntry(entry, claim)) throw failure("uncertain_write", `The clientRequestId is claimed but its local journal record does not match the claim. Check Pocket chat history. operationId: ${claim.operationId}.`)
        return normalizeStaleRunning(entry)
      } catch (error) {
        if (error instanceof PocketError) throw error
        throw storageFailure()
      }
    },
    listRecent: async (limit = 10): Promise<ReadonlyArray<MeetingQueryOperationMetadata>> => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw failure("validation", "Meeting-query history limit must be between 1 and 20.")
      await ensureDirectory()
      let names: string[]
      try { names = await readdir(directory) }
      catch { throw storageFailure() }
      const operationIds = names.flatMap((name) => {
        const match = name.match(/^([a-f0-9-]{36})\.json$/)
        return match ? [match[1]!] : []
      })
      const entries = await Promise.all(operationIds.map((id) => readEntry(id)))
      return entries
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((entry) => Schema.decodeUnknownSync(MeetingQueryOperationMetadataSchema)({
          operationId: entry.operationId,
          ...(entry.clientRequestId === undefined ? {} : { clientRequestId: entry.clientRequestId }),
          status: entry.status,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          queryPreview: entry.query.slice(0, 160),
          ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode })
        }))
    }
  }
}
