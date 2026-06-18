import { Effect } from "effect"
import { createHash } from "crypto"
import type { Storage } from "@/storage/storage"
import {
  type TagCollection,
  type TagDef,
  type PaletteId,
  ARCHITECTURE_ID,
  BUILTIN_COLLECTIONS,
  PALETTES,
  MAX_TAGS,
  assignColors,
  slugify,
} from "./collections"

// Durable per-project store for *user-defined* tag collections plus the pointer to
// the currently active collection. Built-in collections (architecture) are global
// and live in code (`BUILTIN_COLLECTIONS`); only user collections are persisted
// here. Creation is strictly additive — a new collection always gets a fresh id and
// no existing collection is ever mutated or removed — because each collection's tag
// results cost tokens and must never be lost.

function collectionsKey(projectID: string) {
  return ["codegraph", projectID, "collections"]
}

function activeKey(projectID: string) {
  return ["codegraph", projectID, "active-collection"]
}

type StoredCollections = Record<string, TagCollection>

// All user-defined collections for a project (empty when none defined yet).
const readProject = (storage: Storage.Interface, projectID: string): Effect.Effect<StoredCollections> =>
  storage.read<StoredCollections>(collectionsKey(projectID)).pipe(Effect.catch(() => Effect.succeed<StoredCollections>({})))

// Built-in (global) collections first, then the project's user-defined ones.
export const list = (storage: Storage.Interface, projectID: string): Effect.Effect<TagCollection[]> =>
  readProject(storage, projectID).pipe(Effect.map((project) => [...BUILTIN_COLLECTIONS, ...Object.values(project)]))

// Resolve a collection by id, checking built-ins then the project store. Returns
// undefined when unknown.
export const get = (
  storage: Storage.Interface,
  projectID: string,
  id: string,
): Effect.Effect<TagCollection | undefined> =>
  list(storage, projectID).pipe(Effect.map((all) => all.find((c) => c.id === id)))

// The active collection id, defaulting to architecture when unset.
export const getActiveId = (storage: Storage.Interface, projectID: string): Effect.Effect<string> =>
  storage
    .read<{ id: string }>(activeKey(projectID))
    .pipe(Effect.map((doc) => doc.id), Effect.catch(() => Effect.succeed(ARCHITECTURE_ID)))

// The active collection, falling back to architecture if the stored id no longer
// resolves (e.g. a deleted/edited store) so the view always has something to paint.
export const getActive = (storage: Storage.Interface, projectID: string): Effect.Effect<TagCollection> =>
  Effect.gen(function* () {
    const id = yield* getActiveId(storage, projectID)
    const found = yield* get(storage, projectID, id)
    return found ?? BUILTIN_COLLECTIONS[0]!
  })

// Set the active collection. No validation here (callers resolve the id first);
// kept minimal so the tools can flip it cheaply.
export const setActive = (storage: Storage.Interface, projectID: string, id: string): Effect.Effect<void> =>
  storage.write(activeKey(projectID), { id }).pipe(Effect.ignore)

export interface CreateInput {
  readonly name: string
  readonly description: string
  readonly palette: PaletteId
  readonly prompt: string
  readonly tags: ReadonlyArray<{ readonly id?: string; readonly label: string; readonly description: string }>
}

// Mint a unique project collection id: name slug + a short content hash so two
// collections with the same name never collide and ids stay stable/inspectable.
function mintId(input: CreateInput): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ name: input.name, tags: input.tags.map((t) => t.label), at: Date.now() }))
    .digest("hex")
    .slice(0, 8)
  return `${slugify(input.name)}-${hash}`
}

// Persist a new user-defined collection (additive: a fresh id, existing collections
// untouched) and return it. Tag ids default to a slug of the label; colours are
// assigned from the chosen palette in order. Throws if the tag count exceeds the
// palette size (MAX_TAGS) — the tools validate first, this is the backstop.
export const create = (
  storage: Storage.Interface,
  projectID: string,
  input: CreateInput,
): Effect.Effect<TagCollection> =>
  Effect.gen(function* () {
    if (input.tags.length === 0) return yield* Effect.die(new Error("a collection needs at least one tag"))
    if (input.tags.length > MAX_TAGS)
      return yield* Effect.die(new Error(`a collection can have at most ${MAX_TAGS} tags (palette size)`))

    const seen = new Set<string>()
    const withColors: TagDef[] = assignColors(
      input.palette,
      input.tags.map((t) => {
        let id = t.id?.trim() || slugify(t.label)
        // Keep tag ids unique within the collection (the model echoes ids back).
        let n = 2
        while (seen.has(id)) id = `${slugify(t.label)}-${n++}`
        seen.add(id)
        return { id, label: t.label, description: t.description }
      }),
    )

    const collection: TagCollection = {
      id: mintId(input),
      name: input.name,
      description: input.description,
      palette: input.palette,
      prompt: input.prompt,
      tags: withColors,
      scope: "project",
    }

    yield* storage
      .update<StoredCollections>(collectionsKey(projectID), (draft) => {
        draft[collection.id] = collection
      })
      .pipe(Effect.catch(() => storage.write(collectionsKey(projectID), { [collection.id]: collection })), Effect.ignore)

    return collection
  })

// Convenience for the tools: a tiny summary of every palette for the agent to pick
// from when proposing a schema.
export const paletteSummary = () =>
  Object.values(PALETTES).map((p) => ({ id: p.id, label: p.label, swatches: p.colors.length }))

export * as CodeGraphCollectionStore from "./collection-store"
