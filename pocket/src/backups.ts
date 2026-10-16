import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { Settings, attempt, privateDirectory, type PocketError } from "./core.js"

export const contentHash = (value: string | unknown): string => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(value))
  .digest("hex")

export class Backups extends Context.Service<Backups, {
  readonly save: (kind: "notes" | "transcript" | "action_item", recordingId: string, content: unknown, summarizationId?: string) => Effect.Effect<{ backupId: string }, PocketError>
}>()("pocket/Backups") {}

export const BackupsLive = Layer.effect(Backups, Effect.gen(function*() {
  const settings = yield* Settings
  const directory = join(settings.dataDir, "backups")
  return {
    save: (kind, recordingId, content, summarizationId) => attempt(async () => {
      await privateDirectory(settings.dataDir)
      await privateDirectory(directory)
      const backupId = randomUUID()
      await writeFile(join(directory, `${backupId}.json`), JSON.stringify({
        kind, recordingId, ...(summarizationId === undefined ? {} : { summarizationId }),
        createdAt: new Date().toISOString(), sha256: contentHash(content), content
      }), { mode: 0o600, flag: "wx" })
      return { backupId }
    }, "storage", "Could not save a private backup. No content was overwritten.")
  }
}))
