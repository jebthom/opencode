// Line-range helpers for rule evaluation.
//
// `extentsOf` cuts a file into line-delimited extents for its top-level declarations — the unit
// the `symbol` finder paints. No parsing: we regex the START lines of top-level declarations; a
// declaration's span runs from its start line to the line before the next one, and everything
// before the first declaration is a "preamble". Top-level only, so a class/function is one unit
// and nesting never needs brace logic. Known skew: interstitial top-level code folds into the
// preceding declaration.

export interface Extent {
  // Display name: the declaration identifier, or "(preamble)" for the residual
  // head before the first declaration. Unique within a file (duplicates are
  // suffixed) so it can key a stable sub-node id.
  readonly name: string
  // 1-based inclusive line range.
  readonly startLine: number
  readonly endLine: number
}

// Residual head before the first declaration (imports, top-level statements).
export const PREAMBLE = "(preamble)"

// The whole file as a single extent — the *coarse* granularity, and what a file's
// facet used to be before painting was unified (O3). A cold file is cut this way and
// costs exactly what file-level painting cost; an interesting one is re-cut per
// declaration. Distinct from PREAMBLE, which is only ever the head of a file that has
// declarations after it.
export const WHOLE = "(file)"

// How finely to cut a file. "file" is the cheap floor (one extent, one classification);
// "declaration" is the refinement the interest heuristics promote a file to. Both are
// edit-stable: WHOLE has no line dependence at all, and a declaration's name survives
// edits above it. See PLAN.md O3.
export type Granularity = "file" | "declaration"

// A top-level declaration is one whose keyword sits at column 0 (no indentation),
// exported or not. Covers TS/JS (function/const/let/var/class/interface/type/enum)
// and Python (def/class). We only need the *name* and the start line, never the
// closing brace — function granularity, not a real parse.
const TOPLEVEL_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|def)\s+([A-Za-z0-9_$]+)/

// Line count of `content` (1 line for a non-empty file with no newline; 0 for "").
function lineCount(content: string): number {
  if (content.length === 0) return 0
  return content.split("\n").length
}

// The extents of `content` at `granularity`, in file order, tiling [1, lineCount]
// exactly. Returns [] for an empty file.
//
// At "declaration" granularity the result collapses back to the single WHOLE extent
// whenever the cut would yield fewer than two — a file with no top-level declaration,
// or one whose only declaration starts at line 1. That makes the two granularities
// *coincide exactly* on such files rather than naming the same span two different
// ways, so promoting a file to declaration granularity can never repaint it for no
// gain, and demoting can never happen at all.
export function extentsOf(content: string, granularity: Granularity = "declaration"): Extent[] {
  const total = lineCount(content)
  if (total === 0) return []
  const whole = [{ name: WHOLE, startLine: 1, endLine: total }]
  if (granularity === "file") return whole

  // Collect (1-based start line, name) for every top-level declaration, keeping
  // names unique within the file so each maps to a distinct sub-node id.
  const starts: { line: number; name: string }[] = []
  const seen = new Map<string, number>()
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const m = TOPLEVEL_DECL.exec(lines[i]!)
    if (!m) continue
    let name = m[1]!
    const prior = seen.get(name)
    if (prior !== undefined) name = `${name}~${seen.get(name)! + 1}`
    seen.set(m[1]!, (prior ?? 0) + 1)
    starts.push({ line: i + 1, name })
  }

  if (starts.length === 0) return whole

  const extents: Extent[] = []
  // Preamble: everything before the first declaration (omitted when a declaration
  // is the very first line).
  if (starts[0]!.line > 1) extents.push({ name: PREAMBLE, startLine: 1, endLine: starts[0]!.line - 1 })
  for (let i = 0; i < starts.length; i++) {
    const startLine = starts[i]!.line
    const endLine = i + 1 < starts.length ? starts[i + 1]!.line - 1 : total
    extents.push({ name: starts[i]!.name, startLine, endLine })
  }
  // A single declaration spanning the whole file is the same span as WHOLE; name it
  // that way so the two granularities agree (see the note above).
  return extents.length < 2 ? whole : extents
}

// Parse the changed line ranges (in the new file) from a `git diff --unified=0`
// patch: each hunk header `@@ -a,b +c,d @@` contributes [c, c+max(d,1)-1]. A pure
// deletion (d=0) is recorded as the single adjacent line [c, c] so it still flags
// the function it sat in. Deterministic and offline.
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm
export function parseHunkRanges(patch: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const m of patch.matchAll(HUNK)) {
    const start = Number(m[1])
    const len = m[2] === undefined ? 1 : Number(m[2])
    if (!Number.isFinite(start) || start < 1) continue
    ranges.push(len === 0 ? [start, start] : [start, start + len - 1])
  }
  return ranges
}

// Normalize raw line ranges (1-based inclusive) against the file they refer to, for use as
// *sparse* line tags rather than as a tiling of the file. Clamps to [1, lineCount], drops
// ranges that fall entirely outside it, then sorts and merges overlapping or adjacent ones.
//
// Clamping matters because a range's source and the content can disagree: `git diff` reports
// hunks against the file git sees, and finalize re-reads from disk, so a write landing
// between the two yields a range past the end. Painting that is a decoration on a line the
// buffer doesn't have. Merging matters because two ranges that touch (`[4,6]` and `[7,9]`)
// are one visual strip, and emitting them separately makes the client paint the same lines
// twice — harmless for colour, but it doubles the tag count that a Search Lens reports as
// its hit total.
export function clampRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  content: string,
): Array<[number, number]> {
  const total = lineCount(content)
  if (total === 0) return []
  const kept: Array<[number, number]> = []
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(1, Math.min(rawStart, rawEnd))
    const end = Math.min(total, Math.max(rawStart, rawEnd))
    if (start > total || end < start) continue
    kept.push([start, end])
  }
  if (kept.length === 0) return []
  kept.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = [kept[0]!]
  for (const [start, end] of kept.slice(1)) {
    const last = merged[merged.length - 1]!
    // `start <= last[1] + 1` merges adjacency as well as overlap.
    if (start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

export * as ApertureExtents from "./extents"
