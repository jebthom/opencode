import { Effect } from "effect"
import type { Storage } from "@/storage/storage"

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

function key(projectID: string, lensID: string) {
  return ["aperture", projectID, "subfacets", lensID]
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
    .pipe(Effect.catch(() => storage.write(key(projectID, lensID), entries)), Effect.ignore)

// Deterministically fold one facet into another for a Lens (mirrors the file-level
// store) so a facet merge keeps sub-file colours consistent without a re-paint.
export const mergeFacet = (
  storage: Storage.Interface,
  projectID: string,
  lensID: string,
  from: string,
  into: string,
): Effect.Effect<void> =>
  storage
    .update<Store>(key(projectID, lensID), (draft) => {
      for (const [id, entry] of Object.entries(draft)) {
        if (entry.facet === from) draft[id] = { facet: into, hash: entry.hash }
      }
    })
    .pipe(Effect.ignore)

// Drop every sub-file facet for a Lens, forcing a from-scratch re-paint on the next
// drill-in. Used when a structural edit invalidates the Lens's inferred facets.
export const clear = (storage: Storage.Interface, projectID: string, lensID: string): Effect.Effect<void> =>
  storage.write(key(projectID, lensID), {} as Store).pipe(Effect.ignore)

export * as ApertureSubfacetStore from "./subfacet-store"
