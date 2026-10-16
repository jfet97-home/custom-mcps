import { Effect, Schedule } from "effect"
import { contentHash } from "./backups.js"
import { failure, type PocketError } from "./core.js"

export const roundTrip = <R>(options: {
  readonly read: Effect.Effect<string, PocketError, R>
  readonly write: (value: string) => Effect.Effect<unknown, PocketError, R>
  readonly original: string
  readonly modified: string
}) => {
  const { read, write, original, modified } = options
  return Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      if ((yield* restore(read)) !== original) return yield* Effect.fail(failure("conflict", "Content changed before verification; nothing was overwritten."))
      const outcome = yield* restore(Effect.gen(function*() {
      yield* write(modified)
      if ((yield* read) !== modified) return yield* Effect.fail(failure("upstream", "The temporary change was not returned by the server."))
      return { saved: true, restored: true, originalHash: contentHash(original) }
      })).pipe(Effect.exit)
      const reconcile = read.pipe(Effect.retry({ times: 2, schedule: Schedule.spaced("500 millis"), while: (error) => error.code === "network" || error.code === "upstream" }))
      const current = yield* reconcile.pipe(Effect.mapError(() => failure("uncertain_write", "Recovery reads failed. The temporary edit may remain; use the private backup to reconcile before further changes.")))
      if (current !== original && current !== modified) return yield* Effect.fail(failure("conflict", "Content changed during verification. The private original backup is retained; concurrent content was not overwritten."))
      if (current === modified) {
        // a failed restore response can still mean the server applied it; reconcile before any retry
        yield* write(original).pipe(Effect.result)
      }
      if ((yield* reconcile) !== original) return yield* Effect.fail(failure("uncertain_write", "Restoration could not be verified. Recover the private backup before making further changes."))
      if (outcome._tag === "Failure") return yield* Effect.failCause(outcome.cause)
      return outcome.value
  }))
}
