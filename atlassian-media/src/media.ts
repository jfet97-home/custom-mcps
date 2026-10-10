import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { Config, ConfigProvider, Data, Effect, Redacted, Schema, Semaphore } from "effect"

export class MediaError extends Data.TaggedError("MediaError")<{
  readonly code: string
  readonly message: string
  readonly status?: number
}> {}

export interface ImageInfo {
  readonly imageId: string
  readonly fileId: string
  readonly contentId: string
  readonly mimeType: string
  readonly byteLength: number
  readonly base64Length: number
  readonly sha256: string
}

export interface ImageChunk {
  readonly imageId: string
  readonly offset: number
  readonly base64: string
  readonly totalLength: number
  readonly sha256: string
}

export interface MediaStatus {
  readonly configured: boolean
  readonly site: string | null
  readonly authMode: "scoped" | null
  readonly tokenExpiry: string | null
  readonly cachedImageCount: number
}

export interface MediaClient {
  status(): Effect.Effect<MediaStatus, MediaError>
  downloadImages(contentId: string, fileIds: readonly string[], collectionId?: string): Effect.Effect<ImageInfo[], MediaError>
  readChunk(imageId: string, offset: number, length: number): Effect.Effect<ImageChunk, MediaError>
}

export interface MediaClientOptions {
  readonly configFile?: string
  readonly fetch?: typeof globalThis.fetch
  readonly minIntervalMs?: number
}

interface MediaConfig {
  readonly site: URL
  readonly cloudId: string
  readonly email: string
  readonly apiToken: Redacted.Redacted<string>
  readonly tokenExpiry: string | null
}

interface CacheEntry {
  readonly info: ImageInfo
  readonly bytes: Uint8Array
  readonly expiresAt: number
}

const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX_BYTES = 64 * 1024 * 1024
const IMAGE_MAX_BYTES = 20 * 1024 * 1024
const CHUNK_MAX_BASE64 = 8192
const MEDIA_HOSTS = new Set(["api.media.atlassian.com", "media-cdn.atlassian.com"])
const CONFIG_KEYS = [
  "ATLASSIAN_SITE_URL",
  "ATLASSIAN_CLOUD_ID",
  "ATLASSIAN_AUTH_MODE",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
  "ATLASSIAN_API_TOKEN_EXPIRES_ON"
] as const

const failure = (code: string, message: string, status?: number) => new MediaError({ code, message, ...(status === undefined ? {} : { status }) })

const configEffect = (provider: ConfigProvider.ConfigProvider): Effect.Effect<MediaConfig, MediaError> => {
  const config = Config.all({
    site: Config.String("ATLASSIAN_SITE_URL"),
    cloudId: Config.String("ATLASSIAN_CLOUD_ID"),
    authMode: Config.String("ATLASSIAN_AUTH_MODE"),
    email: Config.String("ATLASSIAN_EMAIL"),
    apiToken: Config.schema(Schema.Redacted(Schema.NonEmptyString), "ATLASSIAN_API_TOKEN"),
    tokenExpiry: Config.withDefault(Config.String("ATLASSIAN_API_TOKEN_EXPIRES_ON"), "")
  })
  return Effect.provideService(config, ConfigProvider.ConfigProvider, provider).pipe(
    Effect.mapError(() => failure("CONFIG", "Required Atlassian configuration is missing or invalid")),
    Effect.flatMap((value) => {
      let site: URL
      try {
        site = new URL(value.site)
      } catch {
        return Effect.fail(failure("CONFIG", "Atlassian site URL is invalid"))
      }
      if (site.protocol !== "https:" || site.hostname !== "atlassian.net" && !site.hostname.endsWith(".atlassian.net") || site.username || site.password || site.port || site.pathname !== "/" || site.search || site.hash) {
        return Effect.fail(failure("CONFIG", "Atlassian site URL must be an HTTPS *.atlassian.net origin"))
      }
      if (value.authMode !== "scoped") return Effect.fail(failure("CONFIG", "ATLASSIAN_AUTH_MODE must be scoped"))
      if (!value.email.trim()) return Effect.fail(failure("CONFIG", "ATLASSIAN_EMAIL must not be empty"))
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.cloudId)) {
        return Effect.fail(failure("CONFIG", "Atlassian cloud ID must be a UUID"))
      }
      return Effect.succeed({ site, cloudId: value.cloudId, email: value.email, apiToken: value.apiToken, tokenExpiry: value.tokenExpiry || null })
    })
  )
}

const mimeFromBytes = (bytes: Uint8Array, contentType: string): string | null => {
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase()
  const signature = bytes
  if (signature.length >= 8 && signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47 && signature[4] === 0x0d && signature[5] === 0x0a && signature[6] === 0x1a && signature[7] === 0x0a && type === "image/png") return type
  if (signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff && type === "image/jpeg") return type
  if (signature.length >= 6 && new TextDecoder().decode(signature.subarray(0, 6)).match(/^GIF8[79]a$/) && type === "image/gif") return type
  if (signature.length >= 12 && new TextDecoder().decode(signature.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(signature.subarray(8, 12)) === "WEBP" && type === "image/webp") return type
  return null
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const reader = response.body?.getReader()
  if (!reader) throw failure("UPSTREAM", "Atlassian returned an empty response")
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 1024 * 1024) { await reader.cancel(); throw failure("TOO_LARGE", "Atlassian response exceeds the 1 MiB limit") }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw failure("UPSTREAM", "Atlassian returned an invalid response") }
  if (!isRecord(value)) throw failure("UPSTREAM", "Atlassian returned an invalid response")
  return value
}

export const createMediaClient = (options: MediaClientOptions = {}): Effect.Effect<MediaClient, MediaError> => {
  const fetcher = options.fetch ?? globalThis.fetch
  const interval = Math.max(0, options.minIntervalMs ?? 1000)
  const cache = new Map<string, CacheEntry>()
  let cacheBytes = 0
  let lastRequest = 0
  let credentialFingerprint = ""

  const loadConfig = (): Effect.Effect<MediaConfig, MediaError> => Effect.tryPromise({
    try: async () => {
      let provider: ConfigProvider.ConfigProvider
      if (options.configFile === undefined) {
        provider = ConfigProvider.fromEnv()
      } else {
        const metadata = await stat(options.configFile)
        if (!metadata.isFile()) throw failure("CONFIG", "Atlassian config must be a regular file")
        if ((metadata.mode & 0o077) !== 0) throw failure("CONFIG", "Atlassian config file permissions must be 0600 or stricter")
        let contents = await readFile(options.configFile, "utf8")
        for (const key of CONFIG_KEYS) {
          const value = process.env[key]
          if (value !== undefined) contents += `\n${key}=${JSON.stringify(value)}`
        }
        provider = ConfigProvider.fromDotEnvContents(contents)
      }
      const result = await Effect.runPromise(configEffect(provider))
      return result
    },
    catch: (error) => {
      clearCache()
      return error instanceof MediaError ? error : failure("CONFIG", "Unable to load Atlassian configuration")
    }
  })

  const pace = async (signal: AbortSignal): Promise<void> => {
    const remaining = lastRequest + interval - Date.now()
    if (remaining > 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, remaining)
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
    })
    if (signal.aborted) throw signal.reason
    lastRequest = Date.now()
  }

  const request = async (url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> => {
    let target = url
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (target.protocol !== "https:" || !MEDIA_HOSTS.has(target.hostname) && target.hostname !== "api.atlassian.com") throw failure("UPSTREAM", "Atlassian returned a disallowed URL")
      await pace(signal)
      let response: Response
      try {
        response = await fetcher(target, { ...init, signal, redirect: "manual" })
      } catch {
        throw failure("NETWORK", "Atlassian request failed")
      }
      if (response.status === 429) throw failure("RATE_LIMITED", "Atlassian rate limit reached", 429)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location || redirects === 3) throw failure("UPSTREAM", "Atlassian redirect could not be followed", response.status)
        const redirected = new URL(location, target)
        const sameOrigin = redirected.origin === target.origin
        const headers = new Headers(init.headers)
        if (!sameOrigin) {
          headers.delete("authorization")
          headers.delete("x-client-id")
        }
        target = redirected
        init = { ...init, headers }
        continue
      }
      if (!response.ok) throw failure("UPSTREAM", "Atlassian request failed", response.status)
      return response
    }
    throw failure("UPSTREAM", "Atlassian redirect could not be followed")
  }

  const withTimeout = <A>(effect: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, MediaError> => Effect.tryPromise({
    try: (parentSignal) => new Promise<A>((resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort(); reject(failure("TIMEOUT", "Atlassian request timed out")) }, 20_000)
      const abort = () => { clearTimeout(timer); controller.abort(parentSignal.reason); reject(failure("CANCELLED", "Atlassian request was cancelled")) }
      parentSignal.addEventListener("abort", abort, { once: true })
      effect(controller.signal).then(resolve, reject).finally(() => {
        clearTimeout(timer)
        parentSignal.removeEventListener("abort", abort)
      })
    }),
    catch: (error) => error instanceof MediaError ? error : failure("UPSTREAM", "Atlassian request failed")
  })

  const bootstrap = async (config: MediaConfig, contentId: string, signal: AbortSignal) => {
    const api = new URL(`/ex/confluence/${encodeURIComponent(config.cloudId)}/wiki/rest/api/content/${encodeURIComponent(contentId)}?expand=body.view,body.view.mediaToken`, "https://api.atlassian.com")
    const auth = Buffer.from(`${config.email}:${Redacted.value(config.apiToken)}`).toString("base64")
    const response = await request(api, { headers: { authorization: `Basic ${auth}`, accept: "application/json" } }, signal)
    const json = await parseJson(response)
    const body = json.body
    const view = isRecord(body) ? body.view : undefined
    const media = isRecord(view) ? view.mediaToken : undefined
    if (!isRecord(media) || typeof media.token !== "string" || typeof media.clientId !== "string" || !Array.isArray(media.collectionIds) || !media.collectionIds.every((id) => typeof id === "string")) throw failure("UPSTREAM", "Atlassian media token was unavailable")
    return { token: media.token, clientId: media.clientId, collectionIds: media.collectionIds as string[] }
  }

  const apiTokenFingerprint = (config: MediaConfig): string => createHash("sha256").update(`${config.site.origin}\0${config.cloudId}\0${config.email}\0${Redacted.value(config.apiToken)}`).digest("hex")
  const syncFingerprint = (config: MediaConfig) => {
    const fingerprint = apiTokenFingerprint(config)
    if (credentialFingerprint && credentialFingerprint !== fingerprint) clearCache()
    credentialFingerprint = fingerprint
  }
  const clearCache = () => { cache.clear(); cacheBytes = 0 }
  const cached = (id: string) => {
    const entry = cache.get(id)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) { cache.delete(id); cacheBytes -= entry.bytes.byteLength; return undefined }
    return entry
  }

  return Semaphore.make(1).pipe(Effect.map((downloadSemaphore) => {
  const client: MediaClient = {
    status: () => loadConfig().pipe(
      Effect.map((config) => {
        syncFingerprint(config)
        return { configured: true, site: config.site.hostname, authMode: "scoped" as const, tokenExpiry: config.tokenExpiry, cachedImageCount: cache.size }
      }),
      Effect.match({
        onFailure: () => { clearCache(); return { configured: false, site: null, authMode: null, tokenExpiry: null, cachedImageCount: 0 } },
        onSuccess: (status) => status
      })
    ),
    downloadImages: (contentId, fileIds, collectionId) => downloadSemaphore.withPermit(loadConfig().pipe(Effect.flatMap((config) => withTimeout(async (signal) => {
      syncFingerprint(config)
      if (!/^\d{1,20}$/.test(contentId) || fileIds.length < 1 || fileIds.length > 5 || fileIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw failure("INPUT", "Content ID must be numeric and file IDs must be one to five UUIDs")
      const media = await bootstrap(config, contentId, signal)
      if (media.collectionIds.length > 1 && !collectionId) throw failure("INPUT", "A collection ID is required for this content")
      const selectedCollection = collectionId ?? media.collectionIds[0]
      if (!selectedCollection || !media.collectionIds.includes(selectedCollection)) throw failure("INPUT", "Collection ID does not belong to this content")
      const results: ImageInfo[] = []
      for (const fileId of fileIds) {
        const imageId = `${contentId}:${fileId}`
        if (cached(imageId)) { results.push(cached(imageId)!.info); continue }
        const url = new URL(`/file/${encodeURIComponent(fileId)}/binary`, "https://api.media.atlassian.com")
        url.searchParams.set("collection", selectedCollection)
        const response = await request(url, { headers: { authorization: `Bearer ${media.token}`, "x-client-id": media.clientId, accept: "image/png,image/jpeg,image/gif,image/webp" } }, signal)
        const declaredLength = Number(response.headers.get("content-length") ?? 0)
        if (declaredLength > IMAGE_MAX_BYTES) throw failure("TOO_LARGE", "Image exceeds the 20 MiB limit")
        const reader = response.body?.getReader()
        if (!reader) throw failure("UPSTREAM", "Atlassian returned an empty image")
        const parts: Uint8Array[] = []
        let total = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > IMAGE_MAX_BYTES) { await reader.cancel(); throw failure("TOO_LARGE", "Image exceeds the 20 MiB limit") }
          parts.push(value)
        }
        const bytes = new Uint8Array(total)
        let cursor = 0
        for (const part of parts) { bytes.set(part, cursor); cursor += part.byteLength }
        const mimeType = mimeFromBytes(bytes, response.headers.get("content-type") ?? "")
        if (!mimeType) throw failure("INVALID_IMAGE", "Atlassian response is not a supported image")
        const info: ImageInfo = { imageId, fileId, contentId, mimeType, byteLength: total, base64Length: Math.ceil(total / 3) * 4, sha256: createHash("sha256").update(bytes).digest("hex") }
        while (cacheBytes + total > CACHE_MAX_BYTES && cache.size) {
          const oldestKey = cache.keys().next().value as string | undefined
          if (!oldestKey) break
          const oldest = cache.get(oldestKey)!
          cache.delete(oldestKey)
          cacheBytes -= oldest.bytes.byteLength
        }
        if (total <= CACHE_MAX_BYTES) { cache.set(imageId, { info, bytes, expiresAt: Date.now() + CACHE_TTL_MS }); cacheBytes += total }
        results.push(info)
      }
      return results
    })))),
    readChunk: (imageId, offset, length) => loadConfig().pipe(Effect.flatMap((config) => {
      syncFingerprint(config)
      return withTimeout(async () => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > CHUNK_MAX_BASE64 || !/^\d{1,20}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(imageId)) throw failure("INPUT", "Chunk bounds or image ID are invalid")
        const entry = cached(imageId)
        if (!entry) throw failure("NOT_FOUND", "Image is not in the local cache")
        const base64 = Buffer.from(entry.bytes).toString("base64")
        if (offset > base64.length) throw failure("INPUT", "Chunk offset is past the end of the image")
        return { imageId, offset, base64: base64.slice(offset, offset + length), totalLength: base64.length, sha256: entry.info.sha256 }
      })
    }))
  }
  return client
  }))
}
