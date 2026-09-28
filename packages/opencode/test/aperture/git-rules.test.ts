import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Git } from "@/git"
import { ApertureGitLookup } from "@/aperture/git-lookup"
import { ApertureRules } from "@/aperture/rules"
import type { Rule } from "@/aperture/lenses"

// The git-shaped half of the rule model: the `diff` finder and the `where` filters, evaluated
// against a real repository so the diff/blame parsing is exercised end to end.

let dir: string

const git = (args: string[], env: Record<string, string> = {}) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
}

const commit = (message: string, author: string, date = "2026-09-01T12:00:00Z") =>
  git(["commit", "-qam", message], {
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: `${author.toLowerCase()}@example.com`,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  })

const write = (rel: string, lines: string[]) => fs.writeFile(path.join(dir, rel), lines.join("\n") + "\n")

const evaluate = (rules: Rule[], withGit = true) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Git.Service
      return yield* ApertureRules.evaluate(
        dir,
        rules,
        undefined,
        withGit ? ApertureGitLookup.make(service, dir) : undefined,
      )
    }).pipe(Effect.provide(Git.defaultLayer)),
  )

const rangesOf = (result: ApertureRules.RuleResult) =>
  Object.fromEntries([...result.byFile].map(([file, hits]) => [file, hits.flatMap((h) => h.ranges)]))

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aperture-git-rules-")))
  git(["init", "-q"])
  await write("a.ts", ["call(1)", "const two = 2", "call(3)", "const four = 4"])
  git(["add", "."])
  commit("first", "Ada", "2020-01-01T12:00:00Z")
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("aperture git rules — diff finder", () => {
  test("marks uncommitted changes, and a new untracked file end to end", async () => {
    await write("a.ts", ["call(1)", "const two = 2", "call(3) // edited", "const four = 4"])
    await write("b.ts", ["export const b = 1", "export const c = 2"])
    const result = await evaluate([{ id: "r", facet: "changed", find: { kind: "diff" } }])
    // A trailing newline counts as a final (empty) line, the same convention `extentsOf` tiles by.
    expect(rangesOf(result)).toEqual({ "a.ts": [[3, 3]], "b.ts": [[1, 3]] })
  })

  test("a range compares two commits and ignores untracked files", async () => {
    await write("a.ts", ["call(1)", "const two = 22", "call(3)", "const four = 4"])
    commit("second", "Bob")
    await write("b.ts", ["untracked"])
    const result = await evaluate([{ id: "r", facet: "changed", find: { kind: "diff", ref: "HEAD~1..HEAD" } }])
    expect(rangesOf(result)).toEqual({ "a.ts": [[2, 2]] })
  })

  test("an unknown ref is reported, not treated as no changes", async () => {
    const result = await evaluate([{ id: "r", facet: "changed", find: { kind: "diff", ref: "no-such-ref" } }])
    expect(result.diagnostics[0]!.error).toContain("no-such-ref")
  })

  test("without a git repository a git-shaped rule reports an error", async () => {
    const result = await evaluate([{ id: "r", facet: "changed", find: { kind: "diff" } }], false)
    expect(result.diagnostics[0]!.error).toContain("git")
  })
})

describe("aperture git rules — where filters", () => {
  const calls: Rule["find"] = { kind: "pattern", pattern: "call\\(" }

  test("changed: keeps only the hits on lines the last commit touched", async () => {
    await write("a.ts", ["call(1)", "const two = 2", "call(3) // edited", "const four = 4"])
    commit("second", "Bob")
    const result = await evaluate([{ id: "r", facet: "touched", find: calls, where: { changed: "HEAD~1..HEAD" } }])
    expect(rangesOf(result)).toEqual({ "a.ts": [[3, 3]] })
  })

  test("author: keeps only lines last changed by that author", async () => {
    await write("a.ts", ["call(1)", "const two = 2", "call(3) // bob", "const four = 4"])
    commit("second", "Bob")
    const result = await evaluate([{ id: "r", facet: "bobs", find: calls, where: { author: "BOB" } }])
    expect(rangesOf(result)).toEqual({ "a.ts": [[3, 3]] })
  })

  test("since: drops lines last changed before the cutoff, keeps uncommitted ones", async () => {
    await write("a.ts", ["call(1)", "const two = 2", "call(3) // recent", "const four = 4", "call(5)"])
    commit("second", "Bob", "2026-09-01T12:00:00Z")
    await write("a.ts", ["call(1)", "const two = 2", "call(3) // recent", "const four = 4", "call(5)", "call(6)"])
    const result = await evaluate([{ id: "r", facet: "recent", find: calls, where: { since: "2025-01-01" } }])
    expect(rangesOf(result)).toEqual({
      "a.ts": [
        [3, 3],
        [5, 6],
      ],
    })
  })

  test("filters combine: changed narrows first, then author", async () => {
    await write("a.ts", ["call(1) // bob", "const two = 2", "call(3) // bob", "const four = 4"])
    commit("second", "Bob")
    await write("a.ts", ["call(1) // bob", "const two = 2", "call(3) // mine", "const four = 4"])
    const result = await evaluate([
      { id: "r", facet: "x", find: calls, where: { changed: "HEAD~1..HEAD", author: "bob" } },
    ])
    // Line 3 changed in the last commit but is no longer Bob's; line 1 is Bob's and changed.
    expect(rangesOf(result)).toEqual({ "a.ts": [[1, 1]] })
  })
})
