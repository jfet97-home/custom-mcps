import { Context, Effect, Layer, Redacted, Schedule } from "effect"
import { API_ORIGIN, attempt, failure, PocketError } from "./core.js"
import { Session } from "./session.js"

export class PocketTransport extends Context.Service<PocketTransport, {
  readonly request: (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => Effect.Effect<unknown, PocketError>
}>()("pocket/Transport") {}

export const makePocketTransportLive = (fetcher = globalThis.fetch) => Layer.effect(PocketTransport, Effect.gen(function*() {
  const session = yield* Session
  return {
    request: (method, path, body) => Effect.gen(function*() {
      if (!path.startsWith("/api/v1/") || path.includes("..") || path.includes("\\")) return yield* Effect.fail(failure("validation", "Invalid Pocket API operation."))
      const token = yield* session.token
      const request = attempt(async (signal) => {
        const response = await fetcher(new URL(path, API_ORIGIN), {
          method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          headers: { authorization: `Bearer ${Redacted.value(token)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          if (response.status === 401) throw failure("authentication", "Pocket rejected the session. Run pocket-mcp auth status or login again.", 401)
          if (response.status === 403) throw failure("permission", "This Pocket account cannot perform the requested operation.", 403)
          if (response.status === 409 || response.status === 412) throw failure("conflict", "Pocket reported a concurrent edit. Read the content again.", response.status)
          if (method !== "GET" && response.status >= 500) throw failure("uncertain_write", "The write outcome is uncertain. Read the content before attempting another write.", response.status)
          throw failure("upstream", "Pocket rejected the requested operation.", response.status)
        }
        const reader = response.body?.getReader()
        if (!reader) return null
        const chunks: Uint8Array[] = []
        let length = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > 25 * 1024 * 1024) { await reader.cancel(); throw failure("upstream", "Pocket response exceeded the 25 MiB limit.") }
          chunks.push(value)
        }
        if (length === 0) return null
        try {
          const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          if (typeof decoded === "object" && decoded !== null && "success" in decoded && decoded.success === false) throw failure("upstream", "Pocket reported that the operation failed.")
          return decoded
        }
        catch (error) { if (error instanceof PocketError) throw error; throw failure(method === "GET" ? "upstream" : "uncertain_write", method === "GET" ? "Pocket returned invalid JSON." : "The write response could not be decoded. Read the content before writing again.") }
      }, method === "GET" ? "network" : "uncertain_write", method === "GET" ? "Pocket could not be reached." : "The write outcome is uncertain. Read the content before attempting another write.")
      const operation = method === "GET" ? request.pipe(Effect.retry({ times: 1, schedule: Schedule.spaced("500 millis"), while: (error) => error.code === "network" || error.status === 429 || error.status !== undefined && error.status >= 500 })) : request
      return yield* operation.pipe(Effect.tapError((error) => error.code === "authentication" ? session.invalidate : Effect.void))
    })
  }
}))

export const PocketTransportLive = makePocketTransportLive()
