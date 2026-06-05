import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import type { Layer } from "./semantics"

// Durable per-project semantic store for the code graph (PLAN.md step 4). Kept
// entirely separate from the structure cache so semantics update without ever
// touching (or invalidating) the deterministic structure. Keyed by node id —
// which is a content-independent path hash — so a file's layer is the same in
// every scope/window that contains it: tag once, paint everywhere.
//
// `hash` is a short content hash recorded when the entry was written. The tagger
// re-tags a node only when the file's current hash differs, which is what makes
// navigation/refresh of unchanged files cost zero tokens.
//
// We store only the *semantic* (the inferred layer) plus that staleness key —
// never the hue. Color is a pure interpretation of the layer (LAYER_HUE) applied
// at render/merge time, so the palette can change without rewriting the store and
// future semantics (free-form tags, metrics) extend this shape additively.

export interface Entry {
  readonly layer: Layer
  readonly hash: string
}

export type Store = Record<string, Entry>

// One small doc per project. Structure caches live under ["codegraph", id,
// "structure", ...]; semantics deliberately sit beside them under a sibling key.
function key(projectID: string) {
  return ["codegraph", projectID, "semantics"]
}

// Stored map, or empty when nothing has been tagged yet (missing file).
export const read = (storage: Storage.Interface, projectID: string): Effect.Effect<Store> =>
  storage.read<Store>(key(projectID)).pipe(Effect.catch(() => Effect.succeed<Store>({})))

// Merge `entries` into the stored map. Uses storage.update (atomic read-modify-
// write under a write lock) so concurrent tag passes for different scopes don't
// clobber each other; falls back to a fresh write the first time the doc doesn't
// exist yet.
export const upsert = (storage: Storage.Interface, projectID: string, entries: Store): Effect.Effect<void> =>
  storage
    .update<Store>(key(projectID), (draft) => {
      for (const [id, entry] of Object.entries(entries)) draft[id] = entry
    })
    .pipe(
      Effect.catch(() => storage.write(key(projectID), entries)),
      Effect.ignore,
    )

export * as CodeGraphSemanticStore from "./semantic-store"
