#!/usr/bin/env bun
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ApertureExtract } from "./extract"

// Verification entrypoint (PLAN.md step 1). Runs the deterministic extractor
// against a directory and prints the payload as JSON. No services/storage —
// pure structure, so you can eyeball the output before any TUI work exists.
//
//   bun src/aperture/dump.ts [directory]

const root = path.resolve(process.argv[2] ?? process.cwd())

const program = Effect.gen(function* () {
  const payload = yield* ApertureExtract.extract(root)
  yield* Effect.sync(() => process.stdout.write(JSON.stringify(payload, null, 2) + "\n"))
}).pipe(Effect.provide(FSUtil.defaultLayer))

Effect.runPromise(program).catch((err) => {
  console.error(err)
  process.exit(1)
})
