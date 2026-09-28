import { Effect } from "effect"
import type { Git } from "@/git"
import { ApertureExtents } from "./extents"
import type { ApertureRules } from "./rules"

// The git half of rule evaluation: the lines changed against a ref, and who last touched each
// line. Kept out of rules.ts so the evaluator stays free of the Git service (and testable with a
// plain object), and out of the Aperture service closure so the parsing is testable against a
// real repository.

// Ceilings on git output. A diff or blame past these is treated as a failure of that rule rather
// than silently truncated into a wrong answer.
const DIFF_MAX_BYTES = 64 * 1024 * 1024
const BLAME_MAX_BYTES = 16 * 1024 * 1024

// A lookup for one evaluation. Fresh per evaluation so its caches can never serve a stale diff
// across reads; within one evaluation every rule asking about the same ref shares one `git diff`.
export function make(git: Git.Interface, directory: string): ApertureRules.GitLookup {
  const changes = new Map<string, ReadonlyMap<string, ReadonlyArray<readonly [number, number]> | "all">>()
  return {
    changes: (ref) =>
      Effect.gen(function* () {
        const cached = changes.get(ref)
        if (cached) return cached
        const result = yield* changedLines(git, directory, ref)
        changes.set(ref, result)
        return result
      }),
    blame: (file, since) => blameOf(git, directory, file, since),
  }
}

// Changed line ranges per file against `ref`, in each file's current content. One `git diff` for
// the whole directory — `--relative` scopes it to, and makes paths relative to, the project
// directory, which may sit below the repo root — plus the untracked files when the comparison is
// against the working tree: `git diff` never reports those, and a brand-new file is the most
// changed file there is.
const changedLines = (git: Git.Interface, directory: string, ref: string) =>
  Effect.gen(function* () {
    const result = yield* git.run(["diff", "--unified=0", "--no-color", "--no-ext-diff", "--relative", ref, "--"], {
      cwd: directory,
      maxOutputBytes: DIFF_MAX_BYTES,
    })
    if (result.truncated) return yield* Effect.fail(new Error(`git diff ${ref} is too large to use`))
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        new Error(
          `git could not diff against "${ref}": ${result.stderr.toString().trim().split("\n")[0] || "unknown error"}`,
        ),
      )
    const out = new Map<string, ReadonlyArray<readonly [number, number]> | "all">()
    for (const chunk of result
      .text()
      .split(/^diff --git /m)
      .slice(1)) {
      // `+++ /dev/null` is a deletion: nothing left to mark.
      const target = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1]
      if (!target) continue
      const ranges = ApertureExtents.parseHunkRanges(chunk)
      if (ranges.length) out.set(target, ranges)
    }
    if (ref.includes("..")) return out
    const untracked = yield* git.run(["ls-files", "--others", "--exclude-standard"], { cwd: directory })
    if (untracked.exitCode === 0)
      for (const file of untracked.text().split("\n")) if (file.trim()) out.set(file.trim(), "all")
    return out
  })

// Per-line blame of a file's current contents, or undefined when git has no history for it.
// Porcelain output carries a header per line (`<sha> <orig> <final> [<count>]`) and prints a
// commit's author fields only the first time the commit appears, so they are remembered per sha.
// With `--since`, commits older than the cutoff are reported as `boundary`. Uncommitted lines
// (the all-zero sha) always count as recent.
const blameOf = (git: Git.Interface, directory: string, file: string, since?: string) =>
  Effect.gen(function* () {
    const result = yield* git.run(["blame", "--porcelain", ...(since ? [`--since=${since}`] : []), "--", file], {
      cwd: directory,
      maxOutputBytes: BLAME_MAX_BYTES,
    })
    if (result.exitCode !== 0 || result.truncated) return undefined
    const commits = new Map<string, { author: string; mail: string; boundary: boolean }>()
    const lines: ApertureRules.BlameLine[] = []
    let current: { sha: string; final: number } | undefined
    for (const line of result.text().split("\n")) {
      const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line)
      if (header) {
        current = { sha: header[1]!, final: Number(header[2]) }
        if (!commits.has(current.sha)) commits.set(current.sha, { author: "", mail: "", boundary: false })
        continue
      }
      if (!current) continue
      const commit = commits.get(current.sha)!
      if (line.startsWith("author ")) commit.author = line.slice("author ".length)
      else if (line.startsWith("author-mail ")) commit.mail = line.slice("author-mail ".length).replace(/^<|>$/g, "")
      else if (line === "boundary") commit.boundary = true
      else if (line.startsWith("\t"))
        lines[current.final - 1] = {
          author: commit.author,
          mail: commit.mail,
          recent: !commit.boundary || /^0+$/.test(current.sha),
        }
    }
    return lines
  })

export * as ApertureGitLookup from "./git-lookup"
