import { tmpdir } from "node:os"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Redacted } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Settings } from "../src/core.js"
import { serverProgram } from "../src/server.js"
import { HttpAuthorization } from "../src/http-auth.js"
import { ArchiveLive } from "../src/archive.js"
import { ArchiveWorkflowLive } from "../src/archive-workflow.js"
import { fixture } from "./fixture.js"
import { MeetingQuery } from "../src/meeting-query.js"
import { failure } from "../src/core.js"

const dataDir = mkdtempSync(join(tmpdir(), "pocket-mcp-test-"))
chmodSync(dataDir, 0o700)
process.once("exit", () => rmSync(dataDir, { recursive: true, force: true }))
const settings = Layer.succeed(Settings, { dataDir, port: Number(process.env.POCKET_PORT ?? 19011), host: process.env.POCKET_HOST ?? "127.0.0.1" })
const pocketAndSettings = Layer.merge(fixture().layer, settings)
const archive = ArchiveLive.pipe(Layer.provide(settings))
const services = Layer.merge(pocketAndSettings, archive)
const workflow = ArchiveWorkflowLive.pipe(Layer.provide(services))
const query = Layer.succeed(MeetingQuery, {
  query: () => Effect.fail(failure("permission", "Fixture queries do not create remote chats.")),
  lookup: () => Effect.fail(failure("validation", "No fixture query exists."))
})
const live = Layer.mergeAll(services, workflow, query)
NodeRuntime.runMain(serverProgram(process.argv[2] !== "http", Layer.succeed(HttpAuthorization, { token: Redacted.make("test-http-secret") })).pipe(Effect.provide(live)), { disableErrorReporting: true })
