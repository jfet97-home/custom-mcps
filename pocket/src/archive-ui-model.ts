import { randomBytes } from "node:crypto"
import type { Redacted } from "effect"
import { authorized } from "./http-auth.js"

export const archiveUiSessionCookie = "pocket_archive_session"
export const archiveUiSessionTtlMs = 15 * 60 * 1000
export const archiveUiBootstrapTtlMs = 60 * 1000

export interface ArchiveUiRequestLike {
  readonly url: string
  readonly method: string
  readonly headers: {
    readonly host?: string
    readonly origin?: string
    readonly authorization?: string
    readonly "x-pocket-ui"?: string
  }
  readonly cookies?: Readonly<Record<string, string>>
}

export type ArchiveUiAccess =
  | { readonly kind: "outside" }
  | { readonly kind: "public" }
  | { readonly kind: "open" }
  | { readonly kind: "session-bootstrap" }
  | { readonly kind: "session-check" }
  | { readonly kind: "logout"; readonly sessionToken: string }
  | { readonly kind: "data"; readonly sessionToken: string }
  | { readonly kind: "denied"; readonly status: 401 | 403 | 404 | 405 }

interface ExpiringHostToken {
  readonly host: string
  readonly expiresAt: number
}

export class ArchiveUiSessions {
  private readonly bootstrapCodes = new Map<string, ExpiringHostToken>()
  private readonly sessions = new Map<string, ExpiringHostToken>()
  private readonly now: () => number
  private readonly makeToken: () => string

  constructor(options: { readonly now?: () => number; readonly makeToken?: () => string } = {}) {
    this.now = options.now ?? Date.now
    this.makeToken = options.makeToken ?? (() => randomBytes(32).toString("hex"))
  }

  issueBootstrapCode(host: string): string | null {
    if (!isArchiveUiHostAllowed(host)) return null
    this.prune()
    if (this.bootstrapCodes.size >= 128) return null
    const code = this.uniqueToken(this.bootstrapCodes)
    this.bootstrapCodes.set(code, { host: host.toLowerCase(), expiresAt: this.now() + archiveUiBootstrapTtlMs })
    return code
  }

  redeemBootstrapCode(code: string, host: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(code) || !isArchiveUiHostAllowed(host)) return null
    this.prune()
    const issued = this.bootstrapCodes.get(code)
    if (!issued || issued.host !== host.toLowerCase()) return null
    this.bootstrapCodes.delete(code)
    if (this.sessions.size >= 64) return null
    const sessionToken = this.uniqueToken(this.sessions)
    this.sessions.set(sessionToken, { host: host.toLowerCase(), expiresAt: this.now() + archiveUiSessionTtlMs })
    return sessionToken
  }

  hasSession(sessionToken: string | undefined, host: string): sessionToken is string {
    if (!sessionToken || !/^[a-f0-9]{64}$/.test(sessionToken) || !isArchiveUiHostAllowed(host)) return false
    this.prune()
    const session = this.sessions.get(sessionToken)
    return session !== undefined && session.host === host.toLowerCase()
  }

  revokeSession(sessionToken: string): void {
    this.sessions.delete(sessionToken)
  }

  private uniqueToken(existing: Map<string, ExpiringHostToken>): string {
    let token = this.makeToken()
    while (existing.has(token)) token = this.makeToken()
    return token
  }

  private prune(): void {
    const now = this.now()
    for (const [code, value] of this.bootstrapCodes) if (value.expiresAt <= now) this.bootstrapCodes.delete(code)
    for (const [token, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(token)
  }
}

export const archiveUiSessions = new ArchiveUiSessions()

export const isArchiveUiPath = (url: string): boolean => {
  const pathname = url.split("?", 1)[0] ?? ""
  if (!(pathname === "/archive" || pathname.startsWith("/archive/")) || pathname.includes("\\") || /%(?:2f|5c)/i.test(pathname)) return false
  try {
    return new URL(pathname, "http://127.0.0.1").pathname === pathname
  } catch {
    return false
  }
}

export const isArchiveUiHostAllowed = (host: string | undefined): host is string => {
  if (!host || host !== host.trim()) return false
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host)
  if (!match) return false
  if (match[1] === undefined) return true
  const port = Number(match[1])
  return port >= 1 && port <= 65535
}

export const archiveUiSameOrigin = (host: string | undefined, origin: string | undefined): boolean => {
  if (!isArchiveUiHostAllowed(host) || !origin) return false
  try {
    const parsed = new URL(origin)
    const expected = new URL(`http://${host}`)
    return parsed.protocol === "http:" && parsed.origin === expected.origin && parsed.pathname === "/" &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash
  } catch {
    return false
  }
}

const isPublicAssetPath = (path: string): boolean =>
  path === "/archive" || path === "/archive/" || path === "/archive/assets/archive-ui.js" || path === "/archive/assets/archive-ui.css"

export const archiveUiRequestAccess = (
  request: ArchiveUiRequestLike,
  bearerToken: Redacted.Redacted<string>,
  sessions: ArchiveUiSessions = archiveUiSessions
): ArchiveUiAccess => {
  const path = request.url.split("?", 1)[0] ?? ""
  if (!isArchiveUiPath(path)) return { kind: "outside" }
  if (!isArchiveUiHostAllowed(request.headers.host)) return { kind: "denied", status: 403 }
  const method = request.method.toUpperCase()
  if (isPublicAssetPath(path)) return method === "GET" || method === "HEAD" ? { kind: "public" } : { kind: "denied", status: 405 }

  if (path === "/archive/api/open") {
    if (method !== "POST") return { kind: "denied", status: 405 }
    if (request.headers.origin !== undefined) return { kind: "denied", status: 403 }
    return authorized(request.headers.authorization, bearerToken) ? { kind: "open" } : { kind: "denied", status: 401 }
  }

  if (path === "/archive/api/session") {
    if (request.headers["x-pocket-ui"] !== "1") return { kind: "denied", status: 403 }
    if (method === "GET") {
      const token = request.cookies?.[archiveUiSessionCookie]
      return sessions.hasSession(token, request.headers.host)
        ? { kind: "session-check" }
        : { kind: "denied", status: 401 }
    }
    if (method !== "POST") return { kind: "denied", status: 405 }
    return archiveUiSameOrigin(request.headers.host, request.headers.origin)
      ? { kind: "session-bootstrap" }
      : { kind: "denied", status: 403 }
  }

  const token = request.cookies?.[archiveUiSessionCookie]
  if (path === "/archive/api/logout") {
    if (method !== "POST") return { kind: "denied", status: 405 }
    if (request.headers["x-pocket-ui"] !== "1") return { kind: "denied", status: 403 }
    if (!archiveUiSameOrigin(request.headers.host, request.headers.origin)) return { kind: "denied", status: 403 }
    return sessions.hasSession(token, request.headers.host) ? { kind: "logout", sessionToken: token } : { kind: "denied", status: 401 }
  }

  if (!path.startsWith("/archive/api/")) return { kind: "denied", status: 404 }
  if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).has(method)) return { kind: "denied", status: 405 }
  if (request.headers["x-pocket-ui"] !== "1") return { kind: "denied", status: 403 }
  if (request.headers.origin !== undefined && !archiveUiSameOrigin(request.headers.host, request.headers.origin)) return { kind: "denied", status: 403 }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !archiveUiSameOrigin(request.headers.host, request.headers.origin)) {
    return { kind: "denied", status: 403 }
  }
  return sessions.hasSession(token, request.headers.host)
    ? { kind: "data", sessionToken: token }
    : { kind: "denied", status: 401 }
}
