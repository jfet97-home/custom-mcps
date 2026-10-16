#!/usr/bin/env node
import { Effect, Logger } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Settings, type PocketError } from "./core.js"
import { migrateKeychainSession, SecretStorage } from "./secrets.js"
import { Session } from "./session.js"
import { login } from "./login.js"
import { runtime } from "./runtime.js"
import { Pocket } from "./pocket.js"
import { serverProgram } from "./server.js"

process.once("SIGHUP", () => { process.kill(process.pid, "SIGTERM") })

const args = process.argv.slice(2)
const serving = args[0] === "serve" || args[0] === "stdio"
const program: Effect.Effect<unknown, PocketError, Settings | SecretStorage | Session | Pocket> = serving ? serverProgram(args[0] === "stdio")
  : args[0] === "login" ? login
  : args[0] === "auth" && args[1] === "migrate-keychain" ? migrateKeychainSession
  : args[0] === "auth" && args[1] === "status" ? Effect.gen(function*() { return yield* (yield* Session).status })
  : args[0] === "logout" ? Effect.gen(function*() { const secrets = yield* SecretStorage; yield* secrets.withLock(secrets.remove); return { authenticated: false } })
  : Effect.succeed({ usage: "pocket-mcp login | auth status | auth migrate-keychain | logout | serve | stdio" })

NodeRuntime.runMain(program.pipe(
  Effect.provide(runtime),
  Effect.provideService(Logger.LogToStderr, true),
  Effect.match({
    onSuccess: (value) => { if (!serving) process.stdout.write(`${JSON.stringify(value)}\n`) },
    onFailure: (error) => { process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1 }
  }),
  Effect.catchCause(() => Effect.sync(() => { process.stderr.write("Pocket command failed. No diagnostic payload was logged.\n"); process.exitCode = 1 }))
), { disableErrorReporting: true })
