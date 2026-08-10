import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import type { FileComposition } from "./extents"

// Durable per-project, per-Lens store for *sub-file* (function-level) facets (A5).
// Kept separate from the file-level semantic store (semantic-store.ts) so drill-in
// refinement never touches the file-level lens, and from the structure cache so it
// updates without invalidating deterministic structure. Keyed by sub-node id —
// `subNodeID(relPath, name)` from extents.ts, a stable path+name hash — so a
// function's facet is the same wherever its file appears: paint once, show on
// re-drill.
//
// Stays in global durable KV (NOT the project directory): like the file-level
// results it is large, churny, and free to regenerate, so it is not committed.
// `hash` is the content hash of the extent's text — an unchanged function is
// stale-skipped, so re-drilling an unedited file costs zero tokens.

export interface Entry {
  readonly facet: string
  readonly hash: string
}

export type Store = Record<string, Entry>

// A function-painted file's *measured* facet mix: the byte-weighted spread of its
// function facets (extents.ts `fileComposition`), keyed by repo-relative path. It is a
// derived summary of the entries above, but it's persisted rather than recomputed at the
// read boundary because computing it needs the file's text — and directory composition
// tallies the whole repo's files on every payload read, which can't afford to re-read
// them. The drill-in painter has the content in hand anyway, so it writes this as it
// paints; composition then folds a file's function facets into its directory with a map
// lookup (see `attributeFileBytes`). Path-keyed, not node-id-keyed: composition already
// walks the subtree by path, and it keeps the doc readable.
export type Mix = FileComposition
export type Mixes = Record<string, Mix>

function key(projectID: string, lensID: string) {
  return ["aperture", projectID, "subfacets", lensID]
}

function mixKey(projectID: string, lensID: string) {
  return ["aperture", projectID, "subfacet-mix", lensID]
}

// Stored map, or empty when nothing has been painted yet (missing doc).
export const read = (storage: Storage.Interface, projectID: string, lensID: string): Effect.Effect<Store> =>
  storage.read<Store>(key(projectID, lensID)).pipe(Effect.catch(() => Effect.succeed<Store>({})))

// Merge `entries` into the stored map. Uses storage.update (atomic read-modify-
// write under a write lock) so concurrent drill-in passes don't clobber each
// other; falls back to a fresh write the first time the doc doesn't exist.
export const upsert = (
  storage: Storage.Interface,
  projectID: string,
  lensID: string,
  entries: Store,
): Effect.Effect<void> =>
  storage
    .update<Store>(key(projectID, lensID), (draft) => {
      for (const [id, entry] of Object.entries(entries)) draft[id] = entry
    })
    .pipe(
      Effect.catch(() => storage.write(key(projectID, lensID), entries)),
      Effect.ignore,
    )

// Every file's mix, or empty when nothing has been function-painted yet.
export const readMixes = (storage: Storage.Interface, projectID: string, lensID: string): Effect.Effect<Mixes> =>
  storage.read<Mixes>(mixKey(projectID, lensID)).pipe(Effect.catch(() => Effect.succeed<Mixes>({})))

// Store many files' mixes in ONE read-modify-write, reporting which paths actually
// changed. The caller uses that to decide whether to invalidate the view: the painter
// re-derives the mix for every file in a pass (cheap, no tokens) so a file painted before
// mixes existed heals itself, and publishing unconditionally would turn that into a
// paint→refetch→paint cycle.
//
// Batched because `storage.update` takes a write lock: one call per file meant N lock
// acquisitions per pass, which a whole-repo pass can't afford.
export const upsertMixes = (
  storage: Storage.Interface,
  projectID: string,
  lensID: string,
  mixes: Mixes,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const changed: string[] = []
    const apply = (draft: Mixes) => {
      for (const [relPath, mix] of Object.entries(mixes)) {
        if (JSON.stringify(draft[relPath]) === JSON.stringify(mix)) continue
        draft[relPath] = mix
        changed.push(relPath)
      }
    }
    yield* storage.update<Mixes>(mixKey(projectID, lensID), apply).pipe(
      Effect.catch(() => {
        // Missing doc: `apply` already ran against the (discarded) draft, so reset the
        // tally before rebuilding from scratch or a path would be reported twice.
        changed.length = 0
        const fresh: Mixes = {}
        apply(fresh)
        return storage.write(mixKey(projectID, lensID), fresh)
      }),
      Effect.ignore,
    )
    return changed
  })

// Deterministically fold one facet into another for a Lens (mirrors the file-level
// store) so a facet merge keeps sub-file colours consistent without a re-paint. The
// mixes are folded the same way, so directory composition follows the merge too.
export const mergeFacet = (
  storage: Storage.Interface,
  projectID: string,
  lensID: string,
  from: string,
  into: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* storage
      .update<Store>(key(projectID, lensID), (draft) => {
        for (const [id, entry] of Object.entries(draft)) {
          if (entry.facet === from) draft[id] = { facet: into, hash: entry.hash }
        }
      })
      .pipe(Effect.ignore)
    yield* storage
      .update<Mixes>(mixKey(projectID, lensID), (draft) => {
        for (const [path, mix] of Object.entries(draft)) {
          if (!mix.weights.some((w) => w.facet === from)) continue
          // Re-fold: the merged facet may collide with an existing weight, so sum them
          // and re-sort by facet id to keep the same stable shape `fileComposition` emits.
          const byFacet = new Map<string, { count: number; bytes: number }>()
          for (const w of mix.weights) {
            const facet = w.facet === from ? into : w.facet
            const acc = byFacet.get(facet) ?? { count: 0, bytes: 0 }
            acc.count += w.count
            acc.bytes += w.bytes
            byFacet.set(facet, acc)
          }
          const weights = [...byFacet.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([facet, w]) => ({ facet, count: w.count, bytes: w.bytes }))
          draft[path] = { ...mix, weights }
        }
      })
      .pipe(Effect.ignore)
  })

// Drop every sub-file facet for a Lens, forcing a from-scratch re-paint on the next
// drill-in. Used when a structural edit invalidates the Lens's inferred facets.
export const clear = (storage: Storage.Interface, projectID: string, lensID: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* storage.write(key(projectID, lensID), {} as Store).pipe(Effect.ignore)
    // Mixes are derived from those facets, so they go with them — otherwise composition
    // would keep attributing bytes to functions whose paint no longer exists.
    yield* storage.write(mixKey(projectID, lensID), {} as Mixes).pipe(Effect.ignore)
  })

export * as ApertureSubfacetStore from "./subfacet-store"
