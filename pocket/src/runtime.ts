import { Layer } from "effect"
import { SettingsLive } from "./core.js"
import { SecretStorageLive } from "./secrets.js"
import { SessionLive } from "./session.js"
import { PocketTransportLive } from "./transport.js"
import { BackupsLive } from "./backups.js"
import { PocketLive } from "./pocket.js"
import { ArchiveLive } from "./archive.js"
import { ArchiveWorkflowLive } from "./archive-workflow.js"
import { MeetingQueryLive } from "./meeting-query.js"

export const base = Layer.provideMerge(SecretStorageLive, SettingsLive)
export const session = Layer.provideMerge(SessionLive, base)
const dependencies = Layer.mergeAll(Layer.provide(PocketTransportLive, session), Layer.provide(BackupsLive, SettingsLive), Layer.provide(MeetingQueryLive, session))
export const runtime = Layer.provideMerge(PocketLive, dependencies).pipe(Layer.provideMerge(session))
export const serverRuntime = Layer.provideMerge(ArchiveWorkflowLive, Layer.merge(runtime, Layer.provide(ArchiveLive, SettingsLive)))
