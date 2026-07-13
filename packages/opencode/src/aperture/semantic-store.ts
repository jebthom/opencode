import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import { ARCHITECTURE_ID } from "./lenses"

// Durable per-project, per-Lens semantic store for Aperture. Kept
// entirely separate from the structure cache so semantics update without ever
// touching (or invalidating) the deterministic structure. Keyed by node id —
// which is a content-independent path hash — so a file's facet is the same in
// every scope/window that contains it: paint once, show everywhere.
//
// Each Lens gets its own doc (keyed by Lens id) so switching the
// active Lens never overwrites or loses another Lens's work — painting
// costs tokens, so a previously-painted Lens is reused for free on switch-back.
//
// `hash` is a short content hash recorded when the entry was written. The painter
// re-paints a node only when the file's current hash differs, which is what makes
// navigation/refresh of unchanged files cost zero tokens.
//
// We store only the *semantic* (the inferred facet) plus that staleness key — never
// the colour. Colour is a pure interpretation of the facet (the Lens legend)
// applied at render/merge time, so the palette can change without rewriting the
// store and future semantics (metrics, multiple facets) extend this shape additively.

export interface Entry {
  readonly facet: string
  readonly hash: string
  // Drill-down Lenses only: the *parent* facet this file carried when it was painted (its
  // "witness"). Two jobs, neither of which the content hash can do:
  //
  //  1. Staleness. When the parent re-paints a file into a different facet its content is
  //     unchanged, so the hash still matches and the child would never re-evaluate it.
  //     The painter's stale check compares `via` as well, so a parent-facet flip re-opens
  //     the file.
  //  2. Disambiguating the child's two kinds of NONE_FACET — "outside my domain" vs "inside
  //     it but fits none of my facets". They are stored identically; `via` tells them apart,
  //     which is what lets a drill-down be scoped to its parent's own "Other" bucket.
  //
  // Absent on every root Lens's entries (and on entries written before drill-downs existed).
  readonly via?: string
}

export type Store = Record<string, Entry>

// One small doc per project *and Lens*. Structure caches live under
// ["aperture", id, "structure", ...]; semantics sit beside them, now namespaced by
// Lens id so each Lens keeps an independent facet set.
function key(projectID: string, lensID: string) {
  return ["aperture", projectID, "semantics", lensID]
}

// The original (pre-Lens) single-Lens key. Holds the architecture
// Lens's facets written before this change; read-through below so existing work
// isn't re-painted. Entries there used `{ layer, hash }` — structurally compatible
// after we read `layer` as the generic `facet`.
function legacyKey(projectID: string) {
  return ["aperture", projectID, "semantics"]
}

function normalizeLegacy(raw: Record<string, { facet?: string; tag?: string; layer?: string; hash: string }>): Store {
  const out: Store = {}
  for (const [id, entry] of Object.entries(raw)) {
    const facet = entry.facet ?? entry.tag ?? entry.layer
    if (typeof facet === "string") out[id] = { facet, hash: entry.hash }
  }
  return out
}

// Stored map, or empty when nothing has been painted yet (missing file). For the
// architecture Lens the legacy single-Lens doc is merged *beneath* the
// namespaced one (namespaced wins) so facets written before per-Lens storage are
// reused — both for painting and for the painter's stale check — without ever being
// re-painted, even after the namespaced doc starts filling in. New writes go to the
// namespaced key.
export const read = (storage: Storage.Interface, projectID: string, lensID: string): Effect.Effect<Store> =>
  Effect.gen(function* () {
    const current = yield* storage.read<Store>(key(projectID, lensID)).pipe(Effect.catch(() => Effect.succeed<Store>({})))
    if (lensID !== ARCHITECTURE_ID) return current
    const legacy = yield* storage
      .read<Record<string, { facet?: string; tag?: string; layer?: string; hash: string }>>(legacyKey(projectID))
      .pipe(Effect.catch(() => Effect.succeed<Record<string, { hash: string }>>({})))
    return { ...normalizeLegacy(legacy), ...current }
  })

// Merge `entries` into the stored map. Uses storage.update (atomic read-modify-
// write under a write lock) so concurrent paint passes for different scopes don't
// clobber each other; falls back to a fresh write the first time the doc doesn't
// exist yet.
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

// Deterministically fold one facet into another for a Lens: rewrite every entry
// painted `from` to `into`, leaving the content hash untouched (the file's content
// didn't change, only its label). Costs no tokens — the combine is a pure rewrite of
// the stored map. A no-op when the doc doesn't exist yet.
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
        if (entry.facet === from) draft[id] = { ...entry, facet: into }
      }
    })
    .pipe(Effect.ignore)

// The drill-down half of a parent's facet merge. When a parent folds `from` into `into`, a
// child scoped to either one still holds entries witnessed by the now-gone `from`; rewriting
// them to `into` keeps every child entry's `via` pointing at a facet that still exists. The
// files' own facets and hashes are untouched, so — when the child's domain is unchanged by
// the merge — this costs no tokens and re-paints nothing, exactly like `mergeFacet` itself.
export const remapVia = (
  storage: Storage.Interface,
  projectID: string,
  lensID: string,
  from: string,
  into: string,
): Effect.Effect<void> =>
  storage
    .update<Store>(key(projectID, lensID), (draft) => {
      for (const [id, entry] of Object.entries(draft)) {
        if (entry.via === from) draft[id] = { ...entry, via: into }
      }
    })
    .pipe(Effect.ignore)

// Drop every entry witnessed by `facet`, so the next sweep re-decides those files from
// scratch. Used when a parent's merge *expands* a child's domain: files the child had
// bucketed out (stored NONE_FACET, `via` = the newly-admitted facet) must be re-opened, and
// they are the only ones — every other NONE_FACET entry is a genuine "fits no facet" and is
// left alone. Deleting the entry (rather than rewriting it) is what re-opens it: the
// painter's stale check re-paints any node with no entry at all.
export const dropWhereVia = (
  storage: Storage.Interface,
  projectID: string,
  lensID: string,
  facet: string,
): Effect.Effect<void> =>
  storage
    .update<Store>(key(projectID, lensID), (draft) => {
      for (const [id, entry] of Object.entries(draft)) {
        if (entry.via === facet) delete draft[id]
      }
    })
    .pipe(Effect.ignore)

// Replace a Lens's entire facet store in one atomic write (vs upsert's merge). Used by the
// bus-factor built-in, whose store is fully recomputed from git history on each HEAD change:
// a merge would leave stale entries for since-deleted files, so we overwrite wholesale.
export const replace = (
  storage: Storage.Interface,
  projectID: string,
  lensID: string,
  store: Store,
): Effect.Effect<void> => storage.write(key(projectID, lensID), store).pipe(Effect.ignore)

// Drop every facet for a Lens, forcing a from-scratch re-paint on the next sweep.
// Used when a *structural* edit (facets added/removed/redefined, or the prompt changed)
// invalidates the previously-inferred facets.
export const clear = (
  storage: Storage.Interface,
  projectID: string,
  lensID: string,
): Effect.Effect<void> => storage.write(key(projectID, lensID), {} as Store).pipe(Effect.ignore)

export * as ApertureSemanticStore from "./semantic-store"
