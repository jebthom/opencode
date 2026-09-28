import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"

// The repo's source-file set, as Aperture sees it. Used to settle what an activity entry points
// at (a file, a directory, or neither) — see Aperture.activity.

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,py}"

// Directories that never carry useful structure. Pruned during the walk so trees like
// node_modules never appear.
const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv"]
const IGNORE_GLOBS = IGNORED_DIRS.map((dir) => `**/${dir}/**`)
const IGNORED_DIR_SET = new Set(IGNORED_DIRS)

// Hard cap so a pathological repo can never exhaust memory.
const MAX_FILES = 20000

// Every non-ignored source file under `root`, repo-relative, POSIX, sorted and capped.
export const listFiles = Effect.fn("Aperture.listFiles")(function* (root: string) {
  const fs = yield* FSUtil.Service
  const found = yield* fs.glob(SOURCE_GLOB, { cwd: root, include: "file", dot: false, ignore: IGNORE_GLOBS })
  return [...new Set(found.map((p) => toPosix(path.relative(root, path.isAbsolute(p) ? p : path.join(root, p)))))]
    .filter((rel) => rel !== "" && !rel.startsWith("..") && !isIgnoredPath(rel))
    .toSorted()
    .slice(0, MAX_FILES)
})

// True if any path segment is an always-ignored directory. Exported so Aperture.activity can ask
// the same question about a path outside the source glob — a second copy of this list is exactly
// how two surfaces end up disagreeing about what is in the repo.
export function isIgnoredPath(rel: string) {
  return rel.split("/").some((seg) => IGNORED_DIR_SET.has(seg))
}

// Canonical repo-relative form: POSIX separators, no leading/trailing slashes, no "." or empty
// segments. "" means the repo root.
export function normalizePath(rel: string) {
  return toPosix(rel)
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/")
}

function toPosix(p: string) {
  return p.split(path.sep).join("/")
}

export * as ApertureFiles from "./files"
