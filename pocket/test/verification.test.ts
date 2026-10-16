import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Fiber } from "effect"
import { roundTrip } from "../src/verification.js"
import { failure } from "../src/core.js"

test("roundtrip reconciles applied writes with failed responses and restores the original", async () => {
  let content = "original"
  const writes: string[] = []
  const result = await Effect.runPromise(roundTrip({ original: "original", modified: "temporary", read: Effect.sync(() => content),
    write: (value) => Effect.suspend(() => { content = value; writes.push(value); return Effect.fail(failure("uncertain_write", "Response lost")) })
  }).pipe(Effect.result))
  assert.equal(result._tag, "Failure")
  assert.equal(content, "original")
  assert.deepEqual(writes, ["temporary", "original"])
})

test("recovery tolerates a transient reread failure and preserves concurrent edits", async () => {
  let content = "original"
  let reads = 0
  const result = await Effect.runPromise(roundTrip({ original: "original", modified: "temporary",
    read: Effect.suspend(() => ++reads === 3 ? Effect.fail(failure("network", "offline")) : Effect.succeed(content)),
    write: (value) => Effect.sync(() => { content = value })
  }))
  assert.equal(result.restored, true)
  assert.equal(content, "original")
  reads = 0
  const changed = await Effect.runPromise(roundTrip({ original: "original", modified: "temporary",
    read: Effect.sync(() => ++reads >= 3 ? "concurrent editor" : content), write: (value) => Effect.sync(() => { content = value })
  }).pipe(Effect.result))
  assert.equal(changed._tag, "Failure")
  if (changed._tag === "Failure") assert.equal(changed.failure.code, "conflict")
  assert.equal(content, "temporary")
})

test("interruption after a temporary write still runs restoration", async () => {
  let content = "original"
  await Effect.runPromise(Effect.gen(function*() {
    const fiber = yield* roundTrip({ original: "original", modified: "temporary", read: Effect.sync(() => content),
      write: (value) => Effect.gen(function*() { content = value; if (value === "temporary") yield* Effect.never })
    }).pipe(Effect.forkChild)
    yield* Effect.sleep("10 millis")
    yield* Fiber.interrupt(fiber)
  }))
  assert.equal(content, "original")
})
