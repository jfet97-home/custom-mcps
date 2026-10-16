import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import { Cause, Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Archive } from "./archive.js"
import { PocketError, failure } from "./core.js"
import { HttpAuthorization } from "./http-auth.js"
import {
  archiveUiRequestAccess, archiveUiSessionCookie, archiveUiSessionTtlMs,
  archiveUiSessions, type ArchiveUiRequestLike
} from "./archive-ui-model.js"
import { Pocket } from "./pocket.js"

const contentHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
}

const withSecurityHeaders = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(response, contentHeaders)

const json = (value: unknown, status = 200) =>
  withSecurityHeaders(HttpServerResponse.jsonUnsafe(value, { status }))

const errorStatus = (error: PocketError): number => error.status ?? ({
  authentication: 401, permission: 403, conflict: 409, validation: 400,
  network: 502, uncertain_write: 409, upstream: 502, storage: 500, configuration: 500
} satisfies Record<PocketError["code"], number>)[error.code]

const failureResponse = (cause: Cause.Cause<unknown>): HttpServerResponse.HttpServerResponse => {
  const failureOption = Cause.findErrorOption(cause)
  if (Option.isSome(failureOption) && failureOption.value instanceof PocketError) {
    return json({ error: failureOption.value.message }, errorStatus(failureOption.value))
  }
  return json({ error: "The local archive request failed." }, 500)
}

const fileAsset = (name: string, mediaType: string) => Effect.tryPromise({
  try: () => readFile(new URL(`../ui/${name}`, import.meta.url), "utf8"),
  catch: () => failure("storage", "The local archive page assets are unavailable.")
}).pipe(Effect.map((body) => withSecurityHeaders(HttpServerResponse.text(body, { contentType: mediaType }))))

const safeId = (value: string | undefined): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value)

const parsePath = (request: HttpServerRequest.HttpServerRequest): { readonly pathname: string; readonly segments: ReadonlyArray<string>; readonly url: URL } => {
  const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`)
  let segments: string[]
  try {
    segments = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part))
  } catch {
    throw failure("validation", "The local archive path is invalid.")
  }
  return { pathname: url.pathname, segments, url }
}

const readJsonBody = (request: HttpServerRequest.HttpServerRequest, maximumBytes: number) => Effect.gen(function*() {
  const body = yield* request.text
  if (Buffer.byteLength(body, "utf8") > maximumBytes) return yield* Effect.fail(failure("validation", "The local archive request body is too large."))
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid object")
    return parsed as Record<string, unknown>
  } catch {
    return yield* Effect.fail(failure("validation", "The local archive request body must be a JSON object."))
  }
})

const numberParam = (url: URL, name: string, fallback: number, maximum: number): number => {
  const value = url.searchParams.get(name)
  if (value === null) return fallback
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw failure("validation", "The local archive page request is invalid.")
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number > maximum) throw failure("validation", "The local archive page request is outside its allowed range.")
  return number
}

const pageQuery = (url: URL, defaultLimit = 20, maximumLimit = 100) => ({
  limit: numberParam(url, "limit", defaultLimit, maximumLimit),
  offset: numberParam(url, "offset", 0, 1000000)
})

const archiveApi = (request: HttpServerRequest.HttpServerRequest) => Effect.gen(function*() {
  const archive = yield* Archive
  const pocket = yield* Pocket
  const { segments, url } = parsePath(request)
  const method = request.method.toUpperCase()

  if (method === "GET" && segments.length === 3 && segments[2] === "recordings") {
    const page = pageQuery(url)
    const query = url.searchParams.get("q") ?? ""
    return json(yield* archive.uiBrowse(query, page.limit, page.offset))
  }

  if (segments.length >= 4 && segments[2] === "recordings") {
    const recordingId = segments[3]
    if (!safeId(recordingId)) return json({ error: "The local archive recording ID is invalid." }, 400)

    if (method === "GET" && segments.length === 4) return json(yield* archive.uiReadRecording(recordingId))

    if (method === "GET" && segments.length === 5 && segments[4] === "transcripts") {
      const page = pageQuery(url)
      return json(yield* archive.uiListTranscriptVersions(recordingId, page.limit, page.offset))
    }
    if (method === "GET" && segments.length === 6 && segments[4] === "transcripts") {
      const versionId = Number(segments[5])
      if (!Number.isSafeInteger(versionId) || versionId < 1) return json({ error: "The transcript version ID is invalid." }, 400)
      const offset = numberParam(url, "offset", 0, 100000000)
      const limit = numberParam(url, "limit", 12000, 20000)
      return json(yield* archive.uiReadTranscriptPage(recordingId, versionId, offset, limit))
    }
    if (method === "GET" && segments.length === 5 && segments[4] === "notes") {
      const page = pageQuery(url)
      return json(yield* archive.uiListNotesVersions(recordingId, page.limit, page.offset))
    }
    if (method === "GET" && segments.length === 6 && segments[4] === "notes") {
      const versionId = Number(segments[5])
      if (!Number.isSafeInteger(versionId) || versionId < 1) return json({ error: "The Notes version ID is invalid." }, 400)
      const offset = numberParam(url, "offset", 0, 100000000)
      const limit = numberParam(url, "limit", 12000, 20000)
      return json(yield* archive.uiReadNotesPage(recordingId, versionId, offset, limit))
    }
    if (segments.length >= 6 && segments[4] === "local-notes") {
      const summarizationId = segments[5]
      if (!safeId(summarizationId)) return json({ error: "The Notes ID is invalid." }, 400)
      if (method === "GET" && segments.length === 6) return json(yield* archive.uiReadLocalNotesEditor(recordingId, summarizationId))
      if (method === "PUT" && segments.length === 6) {
        const body = yield* readJsonBody(request, 3 * 1024 * 1024)
        if (typeof body.expectedHash !== "string" || typeof body.markdown !== "string") {
          return json({ error: "Provide the current Notes hash and Markdown text." }, 400)
        }
        return json(yield* archive.uiSaveLocalNotes(recordingId, summarizationId, body.expectedHash, body.markdown))
      }
      if (method === "GET" && segments.length === 7 && segments[6] === "history") {
        const page = pageQuery(url)
        return json(yield* archive.uiListLocalNotesHistory(recordingId, summarizationId, page.limit, page.offset))
      }
      if (method === "GET" && segments.length === 8 && segments[6] === "history") {
        const revisionId = Number(segments[7])
        if (!Number.isSafeInteger(revisionId) || revisionId < 1) return json({ error: "The local Notes revision ID is invalid." }, 400)
        const offset = numberParam(url, "offset", 0, 100000000)
        const limit = numberParam(url, "limit", 12000, 20000)
        return json(yield* archive.uiReadLocalNotesPage(recordingId, revisionId, offset, limit))
      }
    }

    if (method === "POST" && segments.length === 5 && segments[4] === "refresh") {
      const snapshot = yield* pocket.archiveSnapshot(recordingId, "backfill")
      yield* archive.recordSnapshot(snapshot)
      if (snapshot.decodeError) {
        return json({ refreshed: false, rawCaptured: true, message: "Pocket data was captured locally, but its response shape could not be fully read. Existing transcript and Notes versions were kept." }, 200)
      }
      return json({ refreshed: true, rawCaptured: true, capturedAt: snapshot.capturedAt })
    }
  }

  return json({ error: "The local archive route was not found." }, 404)
})

const handleArchiveRequest = (request: HttpServerRequest.HttpServerRequest) => Effect.gen(function*() {
  const authorization = yield* HttpAuthorization
  const requestLike: ArchiveUiRequestLike = {
    url: request.url, method: request.method,
    headers: {
      host: request.headers.host, origin: request.headers.origin, authorization: request.headers.authorization,
      "x-pocket-ui": request.headers["x-pocket-ui"]
    },
    cookies: request.cookies
  }
  const access = archiveUiRequestAccess(requestLike, authorization.token)
  if (access.kind === "outside") return withSecurityHeaders(HttpServerResponse.empty({ status: 404 }))
  if (access.kind === "denied") return json({ error: access.status === 401 ? "The local archive session is missing or expired." : "This local archive request is not allowed." }, access.status)

  if (access.kind === "public") {
    const path = request.url.split("?", 1)[0]
    if (path === "/archive" || path === "/archive/") return yield* fileAsset("index.html", "text/html; charset=utf-8")
    if (path === "/archive/assets/archive-ui.js") return yield* fileAsset("archive-ui.js", "text/javascript; charset=utf-8")
    if (path === "/archive/assets/archive-ui.css") return yield* fileAsset("archive-ui.css", "text/css; charset=utf-8")
    return json({ error: "The local archive route was not found." }, 404)
  }

  if (access.kind === "open") {
    const host = request.headers.host!
    const code = archiveUiSessions.issueBootstrapCode(host)
    if (!code) return json({ error: "A local archive session could not be opened right now." }, 503)
    return json({ code, expiresAt: new Date(Date.now() + 60 * 1000).toISOString() })
  }

  if (access.kind === "session-bootstrap") {
    const body = yield* readJsonBody(request, 1024)
    const code = typeof body.code === "string" ? body.code : ""
    const host = request.headers.host!
    const sessionToken = archiveUiSessions.redeemBootstrapCode(code, host)
    if (!sessionToken) return json({ error: "The local archive link is invalid or expired. Open the archive again from the Pocket CLI." }, 401)
    const response = json({ authenticated: true, expiresAt: new Date(Date.now() + archiveUiSessionTtlMs).toISOString() })
    return HttpServerResponse.setHeader(response, "set-cookie", `${archiveUiSessionCookie}=${sessionToken}; Path=/archive; HttpOnly; SameSite=Strict; Max-Age=900`)
  }

  if (access.kind === "session-check") return json({ authenticated: true })

  if (access.kind === "logout") {
    archiveUiSessions.revokeSession(access.sessionToken)
    const response = json({ authenticated: false })
    return HttpServerResponse.setHeader(response, "set-cookie", `${archiveUiSessionCookie}=; Path=/archive; HttpOnly; SameSite=Strict; Max-Age=0`)
  }

  if (access.kind === "data") return yield* archiveApi(request)
  return withSecurityHeaders(HttpServerResponse.empty({ status: 404 }))
}).pipe(Effect.catchCause((cause) => Effect.succeed(failureResponse(cause))))

export const ArchiveUiRoutes = HttpRouter.add("*", "/archive/*", handleArchiveRequest)

export { archiveUiRequestAccess, isArchiveUiPath } from "./archive-ui-model.js"
