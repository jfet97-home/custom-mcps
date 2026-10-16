import { Layer } from "effect"
import { SettingsLive } from "./core.js"
import { SecretStorageLive } from "./secrets.js"
import { SessionLive } from "./session.js"
import { PocketTransportLive } from "./transport.js"
import { BackupsLive } from "./backups.js"
import { PocketLive } from "./pocket.js"

export const base = Layer.provideMerge(SecretStorageLive, SettingsLive)
export const session = Layer.provideMerge(SessionLive, base)
const dependencies = Layer.merge(Layer.provide(PocketTransportLive, session), Layer.provide(BackupsLive, SettingsLive))
export const runtime = Layer.provideMerge(PocketLive, dependencies).pipe(Layer.provideMerge(session))
