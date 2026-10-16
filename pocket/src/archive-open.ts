import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Redacted } from "effect"
import { Settings, failure } from "./core.js"
import { readHttpToken } from "./http-auth.js"

const exec = promisify(execFile)

export const openArchive = Effect.gen(function*() {
  const settings = yield* Settings
  if (process.platform !== "darwin") return yield* Effect.fail(failure("configuration", "Open the archive using the host Mac command."))
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const origin = `http://127.0.0.1:${settings.port}`
      const token = await readHttpToken(settings.dataDir)
      const response = await fetch(`${origin}/archive/api/open`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: { authorization: `Bearer ${Redacted.value(token)}` }
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error("bootstrap unavailable") }
      const result: unknown = await response.json()
      if (typeof result !== "object" || result === null || !("code" in result) || typeof result.code !== "string" || !/^[a-f0-9]{64}$/.test(result.code)) throw new Error("invalid bootstrap")
      await exec("open", [`${origin}/archive/#code=${result.code}`], { timeout: 10000, signal })
      return { opened: true, url: `${origin}/archive/` }
    },
    catch: () => failure("configuration", "Could not open the local archive. Check that the Pocket Docker service is running.")
  })
})
