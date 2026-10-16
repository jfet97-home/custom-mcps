import { tmpdir } from "node:os"
import { Effect, Layer, Redacted } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Settings } from "../src/core.js"
import { serverProgram } from "../src/server.js"
import { HttpAuthorization } from "../src/http-auth.js"
import { fixture } from "./fixture.js"

const live = Layer.merge(fixture().layer, Layer.succeed(Settings, { dataDir: tmpdir(), port: Number(process.env.POCKET_PORT ?? 19011), host: process.env.POCKET_HOST ?? "127.0.0.1" }))
NodeRuntime.runMain(serverProgram(process.argv[2] !== "http", Layer.succeed(HttpAuthorization, { token: Redacted.make("test-http-secret") })).pipe(Effect.provide(live)), { disableErrorReporting: true })
