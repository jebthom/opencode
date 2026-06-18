import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import { ARCHITECTURE_ID } from "./collections"

// Durable per-project, per-collection semantic store for the code graph. Kept
// entirely separate from the structure cache so semantics update without ever
// touching (or invalidating) the deterministic structure. Keyed by node id —
// which is a content-independent path hash — so a file's tag is the same in
// every scope/window that contains it: tag once, paint everywhere.
//
// Each collection gets its own doc (keyed by collection id) so switching the
// active collection never overwrites or loses another collection's work — tagging
// costs tokens, so a previously-tagged collection is reused for free on switch-back.
//
// `hash` is a short content hash recorded when the entry was written. The tagger
// re-tags a node only when the file's current hash differs, which is what makes
// navigation/refresh of unchanged files cost zero tokens.
//
// We store only the *semantic* (the inferred tag) plus that staleness key — never
// the colour. Colour is a pure interpretation of the tag (the collection legend)
// applied at render/merge time, so the palette can change without rewriting the
// store and future semantics (metrics, multiple tags) extend this shape additively.

export interface Entry {
  readonly tag: string
  readonly hash: string
}

export type Store = Record<string, Entry>

// One small doc per project *and collection*. Structure caches live under
// ["codegraph", id, "structure", ...]; semantics sit beside them, now namespaced by
// collection id so each collection keeps an independent tag set.
function key(projectID: string, collectionID: string) {
  return ["codegraph", projectID, "semantics", collectionID]
}

// The original (pre-collections) single-collection key. Holds the architecture
// collection's tags written before this change; read-through below so existing work
// isn't re-tagged. Entries there used `{ layer, hash }` — structurally compatible
// after we read `layer` as the generic `tag`.
function legacyKey(projectID: string) {
  return ["codegraph", projectID, "semantics"]
}

function normalizeLegacy(raw: Record<string, { tag?: string; layer?: string; hash: string }>): Store {
  const out: Store = {}
  for (const [id, entry] of Object.entries(raw)) {
    const tag = entry.tag ?? entry.layer
    if (typeof tag === "string") out[id] = { tag, hash: entry.hash }
  }
  return out
}

// Stored map, or empty when nothing has been tagged yet (missing file). For the
// architecture collection the legacy single-collection doc is merged *beneath* the
// namespaced one (namespaced wins) so tags written before per-collection storage are
// reused — both for painting and for the tagger's stale check — without ever being
// re-tagged, even after the namespaced doc starts filling in. New writes go to the
// namespaced key.
export const read = (storage: Storage.Interface, projectID: string, collectionID: string): Effect.Effect<Store> =>
  Effect.gen(function* () {
    const current = yield* storage.read<Store>(key(projectID, collectionID)).pipe(Effect.catch(() => Effect.succeed<Store>({})))
    if (collectionID !== ARCHITECTURE_ID) return current
    const legacy = yield* storage
      .read<Record<string, { tag?: string; layer?: string; hash: string }>>(legacyKey(projectID))
      .pipe(Effect.catch(() => Effect.succeed<Record<string, { hash: string }>>({})))
    return { ...normalizeLegacy(legacy), ...current }
  })

// Merge `entries` into the stored map. Uses storage.update (atomic read-modify-
// write under a write lock) so concurrent tag passes for different scopes don't
// clobber each other; falls back to a fresh write the first time the doc doesn't
// exist yet.
export const upsert = (
  storage: Storage.Interface,
  projectID: string,
  collectionID: string,
  entries: Store,
): Effect.Effect<void> =>
  storage
    .update<Store>(key(projectID, collectionID), (draft) => {
      for (const [id, entry] of Object.entries(entries)) draft[id] = entry
    })
    .pipe(
      Effect.catch(() => storage.write(key(projectID, collectionID), entries)),
      Effect.ignore,
    )

export * as CodeGraphSemanticStore from "./semantic-store"
