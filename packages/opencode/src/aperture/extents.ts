import { createHash } from "crypto"

// Sub-file resolution (A5): line-delimited extents for the top-level declarations
// of a file. No parsing — we regex the START lines of top-level declarations; a
// declaration's span runs from its start line to the line before the next one,
// and everything before the first declaration is a "preamble" unit (imports /
// top-level code). This partition tiles the file *exhaustively* (no gaps, no
// overlaps), which is the byte contract the treemap composition relies on, and it
// stays deterministic and offline. Top-level only: a class/function is one unit
// and nesting never needs brace logic. Known skew: interstitial top-level code
// folds into the preceding declaration — acceptable, because declaration-sparse
// files are exactly where file-level tagging was already adequate.

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

// The exact text of an extent (1-based inclusive lines), used as the per-function
// staleness key so an unchanged function spends nothing on re-drill.
export function extentText(content: string, extent: Extent): string {
  return content
    .split("\n")
    .slice(extent.startLine - 1, extent.endLine)
    .join("\n")
}

// A file's facet *mix*, measured from the spread of its function facets weighted by
// byte extent — the same upward aggregation as dir→file, one level deeper, so a
// file's "mixedness" is measured from its functions rather than asked of the model.
// Returns the directory-`Composition` shape (weights + totals) so it slots into the
// existing treemap machinery. `facetByName` maps an extent's (file-unique) name to
// its painted facet id; unpainted extents count toward `subtree*` only.
export interface FileComposition {
  readonly weights: ReadonlyArray<{ readonly facet: string; readonly count: number; readonly bytes: number }>
  readonly totalCount: number
  readonly totalBytes: number
  readonly subtreeCount: number
  readonly subtreeBytes: number
}

export function fileComposition(
  content: string,
  facetByName: ReadonlyMap<string, string>,
  // Must match the granularity `facetByName` was keyed at, or no extent name will match
  // and the mix comes out empty.
  granularity: Granularity = "declaration",
): FileComposition {
  const extents = extentsOf(content, granularity)
  // Per-line byte length *including* its line terminator (all lines but the last,
  // which has none when the file lacks a trailing newline). Summing an extent's
  // lines this way attributes every byte of the file exactly once, so the extents
  // tile the file at the byte level as well as the line level.
  const rawLines = content.split("\n")
  const lineBytes = rawLines.map((l, i) => Buffer.byteLength(l) + (i < rawLines.length - 1 ? 1 : 0))
  const extentBytes = (e: Extent) => {
    let sum = 0
    for (let i = e.startLine - 1; i <= e.endLine - 1; i++) sum += lineBytes[i] ?? 0
    return sum
  }

  const byFacet = new Map<string, { count: number; bytes: number }>()
  let totalCount = 0
  let totalBytes = 0
  let subtreeCount = 0
  let subtreeBytes = 0
  for (const e of extents) {
    const bytes = extentBytes(e)
    subtreeCount += 1
    subtreeBytes += bytes
    const facet = facetByName.get(e.name)
    if (!facet) continue
    const w = byFacet.get(facet) ?? { count: 0, bytes: 0 }
    w.count += 1
    w.bytes += bytes
    byFacet.set(facet, w)
    totalCount += 1
    totalBytes += bytes
  }
  // Stable order (by facet id) so identical input yields identical output.
  const weights = [...byFacet.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([facet, w]) => ({ facet, count: w.count, bytes: w.bytes }))
  return { weights, totalCount, totalBytes, subtreeCount, subtreeBytes }
}

// How one file's bytes are attributed to facets when its *directory's* composition is
// tallied. A file that has been function-painted is no longer one indivisible byte mass:
// its painted extents carry a facet assigned with the code in view, which supersedes the
// file-level facet the coarse painter inferred from the path/imports alone. So those bytes
// go to the function facets, and the file-level facet keeps only the remainder — the
// preamble and any extent the drill-in painter hasn't reached — which keeps a half-painted
// file fully covered instead of dropping it to grey mid-paint.
//
// `size` is the file's size on disk *now*; `mix.subtreeBytes` is what it was when the
// functions were last painted. They drift when the file is edited before the repaint
// lands, so the mix's proportions are scaled onto the current size — a directory's facet
// weights then always sum to at most the file's real bytes (the `total*` ≤ `subtree*`
// partition contract the treemap relies on).
export interface FileAttribution {
  readonly weights: ReadonlyArray<{ readonly facet: string; readonly bytes: number }>
  // The facet this file counts as one *file* toward: composition's `count` metric stays
  // whole-file (a file is one file, however many facets its functions span), so the byte
  // plurality wins it. Undefined when nothing about the file is painted at all.
  readonly dominant: string | undefined
}

export function attributeFileBytes(
  size: number,
  mix: FileComposition | undefined,
  fileFacet: string | undefined,
): FileAttribution {
  const unmixed: FileAttribution = fileFacet
    ? { weights: [{ facet: fileFacet, bytes: size }], dominant: fileFacet }
    : { weights: [], dominant: undefined }
  if (!mix || mix.subtreeBytes <= 0 || mix.weights.length === 0) return unmixed

  const scale = size / mix.subtreeBytes
  const bytesByFacet = new Map<string, number>()
  let assigned = 0
  for (const w of mix.weights) {
    // Clamp against the running total, not just `size`: rounding each share up can
    // otherwise overrun the file's bytes and leave a negative remainder.
    const bytes = Math.min(Math.round(w.bytes * scale), size - assigned)
    if (bytes <= 0) continue
    assigned += bytes
    bytesByFacet.set(w.facet, (bytesByFacet.get(w.facet) ?? 0) + bytes)
  }
  const remainder = size - assigned
  if (remainder > 0 && fileFacet) bytesByFacet.set(fileFacet, (bytesByFacet.get(fileFacet) ?? 0) + remainder)
  if (bytesByFacet.size === 0) return unmixed

  // Facet-id order, and a tie on bytes goes to the first of them, so the same inputs
  // always produce the same weights and the same dominant facet.
  const weights = [...bytesByFacet.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([facet, bytes]) => ({ facet, bytes }))
  const dominant = weights.reduce((max, w) => (w.bytes > max.bytes ? w : max)).facet
  return { weights, dominant }
}

// Map each extent to changed/unchanged from a set of changed line ranges (1-based,
// inclusive, in the *current* file) — the deterministic git-changed Lens at function
// granularity (A5). An extent is "changed" if any of its lines overlap a changed
// range. When there are no ranges (e.g. an untracked/new file that `git diff HEAD`
// can't show) `fileChangedFallback` decides the whole file — reusing the file-level
// git-changed result so no prefix/diff edge cases are re-derived here. Returns
// name → facet id for every extent, so the file tiles fully (no grey).
export function extentChangeFacets(
  content: string,
  changedRanges: ReadonlyArray<readonly [number, number]>,
  fileChangedFallback: boolean,
  ids: { readonly changed: string; readonly unchanged: string } = { changed: "changed", unchanged: "unchanged" },
): Map<string, string> {
  const anyRanges = changedRanges.length > 0
  const overlaps = (s: number, e: number) => changedRanges.some(([a, b]) => s <= b && e >= a)
  const map = new Map<string, string>()
  for (const ex of extentsOf(content)) {
    const changed = anyRanges ? overlaps(ex.startLine, ex.endLine) : fileChangedFallback
    map.set(ex.name, changed ? ids.changed : ids.unchanged)
  }
  return map
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

// Stable id for a sub-file (function-level) node: the file's repo-relative path
// plus the (file-unique) declaration name. The "#" keeps it from colliding with
// the file's own node id (which hashes the bare path). Stable across edits that
// move the declaration's lines, so its painted facet survives reformatting.
export function subNodeID(relPath: string, name: string): string {
  return (
    "n_" +
    createHash("sha256")
      .update(relPath + "#" + name)
      .digest("hex")
      .slice(0, 16)
  )
}

export * as ApertureExtents from "./extents"
