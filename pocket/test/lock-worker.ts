import { appendFile } from "node:fs/promises"
import { Effect } from "effect"
import { withSessionLock } from "../src/secrets.js"
const [directory, name] = process.argv.slice(2)
if (!directory || !name) throw new Error("missing test arguments")
const operation = withSessionLock(Effect.gen(function*() {
  yield* Effect.promise(() => appendFile(`${directory}/trace`, `${name}:start\n`))
  yield* Effect.sleep("100 millis")
  yield* Effect.promise(() => appendFile(`${directory}/trace`, `${name}:end\n`))
}), directory)
await Effect.runPromise(process.argv[4] === "masked" ? Effect.uninterruptible(operation) : operation)
