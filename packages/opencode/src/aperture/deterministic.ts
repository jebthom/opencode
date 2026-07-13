import type { DeterministicKind } from "./lenses"
import { RECENCY_FACET_IDS, BUS_FACTOR_FACET_IDS, CHANGE_FACET_IDS, NONE_FACET, bucketIndex, changeBucketIndex } from "./lenses"
import type { ApertureSemanticStore } from "./semantic-store"

// Deterministic facet computation for the built-in non-LLM Lenses. Each function
// synthesizes the same shape the painter persists — a `Store` of `nodeId → {facet, hash}` —
// directly from the repo, so `finalize` can paint git/mtime Lenses without any model
// call, store read, or persistence. `hash` is left empty: it's only the painter's staleness
// key, and these are recomputed from scratch every read (always fresh).
//
// Pure on purpose: the git status (an IO + cache concern) is resolved by the caller in
// aperture.ts and handed in. Keyed over the *whole-repo* subtree membership (the same list
// finalize already caches for directory composition) so one pass covers in-window file
// nodes, one-hop boundary targets, and every directory's descendant tally at once.

// A repo source file with the metadata both built-ins need (mtime for recency, path for the
// git-changed lookup). Mirrors the element type of ApertureExtract.listSubtree.
export type SubtreeFile = {
  readonly id: string
  readonly path: string
  readonly size: number
  readonly mtime: number
}

// Pre-resolved working-tree change set for git-changed: `changed` maps each changed file's
// repo-root-relative path (as git reports them) to its change magnitude — total lines
// added + deleted vs HEAD (a new/untracked file's whole size; 0 when git reports no line
// delta, e.g. a mode-only change). A file's *presence* as a key is the membership test
// (changed vs unchanged); the value drives its magnitude bucket. `prefix` is the directory's
// repo prefix (rev-parse --show-prefix; "" at the repo root, else "sub/dir/") so subtree
// paths can be matched.
export type GitChanged = {
  readonly prefix: string
  readonly changed: ReadonlyMap<string, number>
}

// Pre-resolved authorship for the bus-factor lens. `byPath` maps a repo-root-relative path
// (as `git log` emits them) to the per-author line-churn totals across all of HEAD's history;
// `prefix` is the directory's repo prefix (like GitChanged) so viewed-directory subtree paths
// can be matched. Resolved + cached in aperture.ts and handed in, keeping this module pure.
export type GitAuthorship = {
  readonly prefix: string
  readonly byPath: ReadonlyMap<string, ReadonlyMap<string, number>>
}

// An author counts toward a file's bus factor only once they've changed at least this many
// lines of it (summed over history) — so a drive-by typo fix doesn't inflate the count. An
// absolute floor (not a share of the file) on purpose: a relative threshold would wrongly
// collapse a file spread evenly across many small contributors down to bus-1. See busFacetFor
// for the fallback that protects that many-small-contributors case.
export const BUS_FACTOR_MIN_LINES = 3

// The `aux` bag carries whichever pre-resolved IO a deterministic kind needs (git-changed's
// working-tree set, bus-factor's authorship); mtime needs none. Kept optional so pure tests
// can call `computeStore(kind, subtree)`.
export function computeStore(
  kind: DeterministicKind,
  subtree: ReadonlyArray<SubtreeFile>,
  aux: { git?: GitChanged; authorship?: GitAuthorship } = {},
): ApertureSemanticStore.Store {
  switch (kind) {
    case "git-changed":
      return gitChanged(subtree, aux.git)
    case "bus-factor":
      return busFactor(subtree, aux.authorship)
    default:
      return mtimeBuckets(subtree)
  }
}

// A file present in the change set (any working-tree change git reports — modified, staged,
// or untracked/new) is bucketed by its change magnitude into one of CHANGE_FACET_IDS;
// everything else is "unchanged". git emits repo-root-relative paths while the subtree is
// relative to the viewed directory, so we bridge with the repo prefix.
function gitChanged(subtree: ReadonlyArray<SubtreeFile>, git: GitChanged | undefined): ApertureSemanticStore.Store {
  const prefix = git?.prefix ?? ""
  const changed = git?.changed ?? new Map<string, number>()
  const store: Record<string, ApertureSemanticStore.Entry> = {}
  for (const file of subtree) {
    const churn = changed.get(prefix + file.path)
    const facet = churn === undefined ? "unchanged" : CHANGE_FACET_IDS[changeBucketIndex(churn)]!
    store[file.id] = { facet, hash: "" }
  }
  return store
}

// Bucket every file by local mtime into six equal time spans across the repo's
// oldest→newest range (bucketIndex). A repo where every file shares one mtime, or where no
// mtime is reported, collapses to bucket 0 (one colour) — the intended behaviour. Files with
// no reported mtime (0) are treated as oldest so they don't skew the range.
function mtimeBuckets(subtree: ReadonlyArray<SubtreeFile>): ApertureSemanticStore.Store {
  let min = Infinity
  let max = -Infinity
  for (const file of subtree) {
    if (file.mtime <= 0) continue
    if (file.mtime < min) min = file.mtime
    if (file.mtime > max) max = file.mtime
  }
  const floor = Number.isFinite(min) ? min : 0
  const store: Record<string, ApertureSemanticStore.Entry> = {}
  for (const file of subtree) {
    const mtime = file.mtime > 0 ? file.mtime : floor
    store[file.id] = { facet: RECENCY_FACET_IDS[bucketIndex(mtime, floor, max)]!, hash: "" }
  }
  return store
}

// --- bus factor ------------------------------------------------------------

// Parse `git log --no-merges --use-mailmap --numstat --format=%x01%aN` output into per-file
// per-author line churn. A `\x01`-prefixed line sets the current commit's author; each
// following numstat row (`adds\tdels\tpath`) adds `adds+dels` (min 1, so binary/rename rows
// still register a touch) to that author's tally for the path. Pure + tolerant: blank lines
// and unparseable rows are skipped, and rename arrows (`{old => new}`, `old => new`) are
// collapsed to the resulting path. `prefix` is carried through onto the result unchanged.
export function parseAuthorship(logText: string, prefix: string): GitAuthorship {
  const byPath = new Map<string, Map<string, number>>()
  let author: string | undefined
  for (const raw of logText.split("\n")) {
    if (raw.startsWith("\x01")) {
      author = raw.slice(1)
      continue
    }
    if (author === undefined || raw === "") continue
    const a = raw.indexOf("\t")
    const b = raw.indexOf("\t", a + 1)
    if (a === -1 || b === -1) continue
    const adds = raw.slice(0, a)
    const dels = raw.slice(a + 1, b)
    const path = normalizeRenamePath(raw.slice(b + 1))
    if (!path) continue
    const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
    const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
    const churn = (Number.isFinite(additions) ? additions : 0) + (Number.isFinite(deletions) ? deletions : 0) || 1
    const authors = byPath.get(path) ?? new Map<string, number>()
    authors.set(author, (authors.get(author) ?? 0) + churn)
    byPath.set(path, authors)
  }
  return { prefix, byPath }
}

// Collapse a numstat rename path to its destination: `{old => new}` → `new`, an inner
// segment `pre/{old => new}/post` → `pre/new/post`, and a bare `old => new` → `new`.
// Returns non-rename paths unchanged.
function normalizeRenamePath(path: string): string {
  if (!path.includes("=>")) return path
  const braced = path.replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1").replace(/\/\//g, "/")
  if (!braced.includes("=>")) return braced.trim()
  const arrow = braced.lastIndexOf("=>")
  return braced.slice(arrow + 2).trim()
}

// Bucket every file by its distinct significant-author count. A file with no history
// (untracked/new — absent from `byPath`) gets NONE_FACET so it recedes to grey; otherwise the
// count maps to bus-1/2/3/5 (warm→cool). Keyed over the whole-repo subtree like the other
// built-ins, bridging viewed-directory paths to git's repo-root-relative paths with `prefix`.
function busFactor(subtree: ReadonlyArray<SubtreeFile>, authorship: GitAuthorship | undefined): ApertureSemanticStore.Store {
  const prefix = authorship?.prefix ?? ""
  const byPath = authorship?.byPath ?? new Map<string, ReadonlyMap<string, number>>()
  const store: Record<string, ApertureSemanticStore.Entry> = {}
  for (const file of subtree) {
    store[file.id] = { facet: busFacetFor(byPath.get(prefix + file.path)), hash: "" }
  }
  return store
}

// Facet id for a file's author tally: NONE_FACET when it has no history, else the bucket for
// its distinct significant-author count (authors past BUS_FACTOR_MIN_LINES). When *no* author
// clears that bar the file is many-small-contributors rather than a silo, so we fall back to
// the raw distinct count instead of collapsing to bus-1.
function busFacetFor(authors: ReadonlyMap<string, number> | undefined): string {
  if (!authors || authors.size === 0) return NONE_FACET
  let significant = 0
  for (const lines of authors.values()) if (lines >= BUS_FACTOR_MIN_LINES) significant++
  const count = significant > 0 ? significant : authors.size
  const idx = count <= 1 ? 0 : count === 2 ? 1 : count <= 4 ? 2 : 3
  return BUS_FACTOR_FACET_IDS[idx]!
}

export * as ApertureDeterministic from "./deterministic"
