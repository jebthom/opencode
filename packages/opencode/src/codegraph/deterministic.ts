import type { DeterministicKind } from "./collections"
import { RECENCY_TAG_IDS, bucketIndex } from "./collections"
import type { CodeGraphSemanticStore } from "./semantic-store"

// Deterministic tag computation for the built-in non-LLM collections. Each function
// synthesizes the same shape the tagger persists — a `Store` of `nodeId → {tag, hash}` —
// directly from the repo, so `finalize` can paint git/mtime collections without any model
// call, store read, or persistence. `hash` is left empty: it's only the tagger's staleness
// key, and these are recomputed from scratch every read (always fresh).
//
// Pure on purpose: the git status (an IO + cache concern) is resolved by the caller in
// codegraph.ts and handed in. Keyed over the *whole-repo* subtree membership (the same list
// finalize already caches for directory composition) so one pass covers in-window file
// nodes, one-hop boundary targets, and every directory's descendant tally at once.

// A repo source file with the metadata both built-ins need (mtime for recency, path for the
// git-changed lookup). Mirrors the element type of CodeGraphExtract.listSubtree.
export type SubtreeFile = {
  readonly id: string
  readonly path: string
  readonly size: number
  readonly mtime: number
}

// Pre-resolved working-tree change set for git-changed: `changed` holds repo-root-relative
// paths (as git reports them) and `prefix` is the directory's repo prefix (rev-parse
// --show-prefix; "" at the repo root, else "sub/dir/") so subtree paths can be matched.
export type GitChanged = {
  readonly prefix: string
  readonly changed: ReadonlySet<string>
}

export function computeStore(
  kind: DeterministicKind,
  subtree: ReadonlyArray<SubtreeFile>,
  git: GitChanged | undefined,
): CodeGraphSemanticStore.Store {
  return kind === "git-changed" ? gitChanged(subtree, git) : mtimeBuckets(subtree)
}

// "changed" = any working-tree change git reports for the file (modified, staged, or
// untracked/new); everything else is "unchanged". git emits repo-root-relative paths while
// the subtree is relative to the viewed directory, so we bridge with the repo prefix.
function gitChanged(subtree: ReadonlyArray<SubtreeFile>, git: GitChanged | undefined): CodeGraphSemanticStore.Store {
  const prefix = git?.prefix ?? ""
  const changed = git?.changed ?? new Set<string>()
  const store: Record<string, CodeGraphSemanticStore.Entry> = {}
  for (const file of subtree) {
    store[file.id] = { tag: changed.has(prefix + file.path) ? "changed" : "unchanged", hash: "" }
  }
  return store
}

// Bucket every file by local mtime into six equal time spans across the repo's
// oldest→newest range (bucketIndex). A repo where every file shares one mtime, or where no
// mtime is reported, collapses to bucket 0 (one colour) — the intended behaviour. Files with
// no reported mtime (0) are treated as oldest so they don't skew the range.
function mtimeBuckets(subtree: ReadonlyArray<SubtreeFile>): CodeGraphSemanticStore.Store {
  let min = Infinity
  let max = -Infinity
  for (const file of subtree) {
    if (file.mtime <= 0) continue
    if (file.mtime < min) min = file.mtime
    if (file.mtime > max) max = file.mtime
  }
  const floor = Number.isFinite(min) ? min : 0
  const store: Record<string, CodeGraphSemanticStore.Entry> = {}
  for (const file of subtree) {
    const mtime = file.mtime > 0 ? file.mtime : floor
    store[file.id] = { tag: RECENCY_TAG_IDS[bucketIndex(mtime, floor, max)]!, hash: "" }
  }
  return store
}

export * as CodeGraphDeterministic from "./deterministic"
