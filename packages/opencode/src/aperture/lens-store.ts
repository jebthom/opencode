import { Effect } from "effect"
import { createHash } from "crypto"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  type Lens,
  type Facet,
  type PaletteId,
  ARCHITECTURE_ID,
  BUILTIN_LENSES,
  PALETTES,
  MAX_FACETS,
  assignColors,
  slugify,
} from "./lenses"

// Per-project store for *user-defined* Lenses plus the pointer to the currently
// active Lens, persisted in the project directory under `.opencode/aperture/`
// (A3) so a Lens is shareable/committable and an agent can read it directly.
// Built-in Lenses (architecture) are global and live in code (`BUILTIN_LENSES`);
// only user Lenses are persisted here. Creation is strictly additive — a new
// Lens always gets a fresh id and no existing Lens is ever mutated or removed —
// because each Lens's facet results cost tokens and must never be lost.
//
// Painted Facet *results* deliberately stay in global durable KV (see
// semantic-store.ts): they are large (~200KB/Lens), rewritten on every sweep,
// and free to regenerate, so they are not committed alongside the definitions.

function apertureDir(directory: string) {
  return path.join(directory, ".opencode", "aperture")
}

// The committable Lens definitions (Record<lensID, Lens>).
function lensesFile(directory: string) {
  return path.join(apertureDir(directory), "lenses.json")
}

// The active-lens pointer ({ id }).
function activeFile(directory: string) {
  return path.join(apertureDir(directory), "active.json")
}

type StoredLenses = Record<string, Lens>

// Read a JSON doc from disk, falling back to `fallback` when the file is missing
// or unreadable. Self-provides the FS layer so callers keep R = never (the store
// previously took a Storage value arg; the project directory replaces it).
function readDoc<T>(file: string, fallback: T): Effect.Effect<T> {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return (yield* fs.readJson(file).pipe(Effect.catch(() => Effect.succeed(fallback)))) as T
  }).pipe(Effect.provide(FSUtil.defaultLayer))
}

// Write a JSON doc to disk (creating `.opencode/aperture/` as needed). Best-effort:
// a write failure is swallowed so a flaky disk never breaks a Lens mutation's caller.
function writeDoc(file: string, content: unknown): Effect.Effect<void> {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(file, JSON.stringify(content, null, 2))
  }).pipe(Effect.provide(FSUtil.defaultLayer), Effect.ignore)
}

// All user-defined Lenses for a project (empty when none defined yet).
const readProject = (directory: string): Effect.Effect<StoredLenses> => readDoc<StoredLenses>(lensesFile(directory), {})

// Built-in (global) Lenses first, then the project's user-defined ones.
export const list = (directory: string): Effect.Effect<Lens[]> =>
  readProject(directory).pipe(Effect.map((project) => [...BUILTIN_LENSES, ...Object.values(project)]))

// Resolve a Lens by id, checking built-ins then the project store. Returns
// undefined when unknown.
export const get = (directory: string, id: string): Effect.Effect<Lens | undefined> =>
  list(directory).pipe(Effect.map((all) => all.find((c) => c.id === id)))

// The active Lens id, defaulting to architecture when unset.
export const getActiveId = (directory: string): Effect.Effect<string> =>
  readDoc<{ id: string } | undefined>(activeFile(directory), undefined).pipe(
    Effect.map((doc) => doc?.id ?? ARCHITECTURE_ID),
  )

// The active Lens, falling back to architecture if the stored id no longer
// resolves (e.g. a deleted/edited store) so the view always has something to paint.
export const getActive = (directory: string): Effect.Effect<Lens> =>
  Effect.gen(function* () {
    const id = yield* getActiveId(directory)
    const found = yield* get(directory, id)
    return found ?? BUILTIN_LENSES[0]!
  })

// Set the active Lens. No validation here (callers resolve the id first);
// kept minimal so the tools can flip it cheaply.
export const setActive = (directory: string, id: string): Effect.Effect<void> =>
  writeDoc(activeFile(directory), { id })

export interface CreateInput {
  readonly name: string
  readonly description: string
  readonly palette: PaletteId
  readonly prompt: string
  readonly facets: ReadonlyArray<{ readonly id?: string; readonly label: string; readonly description: string }>
  // Optional repo-relative directories the painter front-loads (see Lens).
  readonly directories?: ReadonlyArray<string>
  // How much per-file context the painter sends for this Lens (see Lens.context). Only
  // persisted when "medium" — absent means the default "minimal".
  readonly context?: "minimal" | "medium"
}

// Mint a unique project Lens id: name slug + a short content hash so two
// Lenses with the same name never collide and ids stay stable/inspectable.
function mintId(input: CreateInput): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ name: input.name, facets: input.facets.map((t) => t.label), at: Date.now() }))
    .digest("hex")
    .slice(0, 8)
  return `${slugify(input.name)}-${hash}`
}

// Persist a new user-defined Lens (additive: a fresh id, existing Lenses
// untouched) and return it. Facet ids default to a slug of the label; colours are
// assigned from the chosen palette in order. Throws if the facet count exceeds the
// palette size (MAX_FACETS) — the tools validate first, this is the backstop.
export const create = (directory: string, input: CreateInput): Effect.Effect<Lens> =>
  Effect.gen(function* () {
    if (input.facets.length === 0) return yield* Effect.die(new Error("a Lens needs at least one facet"))
    if (input.facets.length > MAX_FACETS)
      return yield* Effect.die(new Error(`a Lens can have at most ${MAX_FACETS} facets (palette size)`))

    const seen = new Set<string>()
    const withColors: Facet[] = assignColors(
      input.palette,
      input.facets.map((t) => {
        let id = t.id?.trim() || slugify(t.label)
        // Keep facet ids unique within the Lens (the model echoes ids back).
        let n = 2
        while (seen.has(id)) id = `${slugify(t.label)}-${n++}`
        seen.add(id)
        return { id, label: t.label, description: t.description }
      }),
    )

    const lens: Lens = {
      id: mintId(input),
      name: input.name,
      description: input.description,
      palette: input.palette,
      prompt: input.prompt,
      facets: withColors,
      scope: "project",
      ...(input.directories?.length ? { directories: normalizeDirectories(input.directories) } : {}),
      // Only persist a non-default mode so existing minimal Lenses' JSON is unchanged.
      ...(input.context === "medium" ? { context: "medium" as const } : {}),
    }

    // Additive read-modify-write: load the existing project doc, add the fresh
    // Lens, write back. Lens mutations are infrequent and single-user, so the
    // plain RMW (vs. the old storage.update write-lock) is fine.
    const project = yield* readProject(directory)
    project[lens.id] = lens
    yield* writeDoc(lensesFile(directory), project)

    return lens
  })

// Trim, drop empties, and strip leading/trailing slashes so directory prefixes match
// the repo-relative paths the painter walks (which never start with "/").
function normalizeDirectories(dirs: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  for (const raw of dirs) {
    const d = raw.trim().replace(/^\/+|\/+$/g, "")
    if (d) seen.add(d)
  }
  return [...seen]
}

// Assign facet ids + palette colours, carrying an existing facet's id forward so its
// stored semantics survive an edit. A raw facet keeps its id when one is given and
// matches an existing facet, else when its label matches an existing facet's label;
// otherwise a fresh unique slug id is minted. Colours follow palette order.
function resolveFacets(
  palette: PaletteId,
  rawFacets: ReadonlyArray<{ readonly id?: string; readonly label: string; readonly description: string }>,
  existing: ReadonlyArray<Facet> = [],
): Facet[] {
  const byId = new Map(existing.map((t) => [t.id, t]))
  const byLabel = new Map(existing.map((t) => [t.label.toLowerCase(), t]))
  const seen = new Set<string>()
  return assignColors(
    palette,
    rawFacets.map((t) => {
      const carried = (t.id && byId.get(t.id)) || byLabel.get(t.label.toLowerCase())
      let id = t.id?.trim() || carried?.id || slugify(t.label)
      let n = 2
      while (seen.has(id)) id = `${slugify(t.label)}-${n++}`
      seen.add(id)
      return { id, label: t.label, description: t.description }
    }),
  )
}

export interface UpdateInput {
  readonly name?: string
  readonly description?: string
  readonly palette?: PaletteId
  readonly prompt?: string
  readonly facets?: ReadonlyArray<{ readonly id?: string; readonly label: string; readonly description: string }>
  readonly directories?: ReadonlyArray<string>
  // New per-file context mode (see Lens.context). Changing it re-classifies every file,
  // so the caller treats it as a structural change and re-paints from scratch.
  readonly context?: "minimal" | "medium"
}

export interface UpdateResult {
  readonly lens: Lens
  // Whether the edit changed how files are classified (facets added/removed, a facet's
  // definition changed, or the prompt changed) — the caller re-paints from scratch.
  // Cosmetic changes (name, label text, palette, directories) leave facets intact.
  readonly structural: boolean
}

// Update an existing *user* Lens in place (built-ins live in code and are not
// in the project doc, so they're untouched). Returns the updated Lens plus a
// flag telling the caller whether the previously-inferred facets are now invalid.
// Returns undefined when the id isn't a project Lens.
export const update = (
  directory: string,
  id: string,
  input: UpdateInput,
): Effect.Effect<UpdateResult | undefined> =>
  Effect.gen(function* () {
    const project = yield* readProject(directory)
    const prev = project[id]
    if (!prev) return undefined

    const palette = input.palette ?? prev.palette ?? "pastel"
    const facets = input.facets ? resolveFacets(palette, input.facets, prev.facets) : prev.facets
    if (facets.length === 0) return yield* Effect.die(new Error("a Lens needs at least one facet"))
    if (facets.length > MAX_FACETS)
      return yield* Effect.die(new Error(`a Lens can have at most ${MAX_FACETS} facets (palette size)`))
    // Re-colour when the palette changed but the facet set didn't (so colours track the
    // new palette); when facets changed, resolveFacets already coloured them.
    const coloured = !input.facets && input.palette ? assignColors(palette, facets) : facets

    const prompt = input.prompt ?? prev.prompt
    const context = input.context ?? prev.context
    const prevById = new Map(prev.facets.map((t) => [t.id, t]))
    const facetsAddedOrRemoved =
      coloured.length !== prev.facets.length || coloured.some((t) => !prevById.has(t.id))
    const definitionChanged = coloured.some((t) => prevById.get(t.id) && prevById.get(t.id)!.description !== t.description)
    const structural = facetsAddedOrRemoved || definitionChanged || prompt !== prev.prompt || context !== prev.context

    const directories = input.directories ? normalizeDirectories(input.directories) : prev.directories
    const next: Lens = {
      ...prev,
      name: input.name ?? prev.name,
      description: input.description ?? prev.description,
      palette,
      prompt,
      facets: coloured,
      ...(directories?.length ? { directories } : {}),
      // Explicit (overrides the ...prev spread) so a downgrade to minimal clears the
      // field: undefined is dropped by JSON.stringify, keeping the "only present when
      // medium" convention rather than persisting "minimal".
      context: context === "medium" ? ("medium" as const) : undefined,
    }

    project[id] = next
    yield* writeDoc(lensesFile(directory), project)

    return { lens: next, structural }
  })

// Deterministically combine two facets of a *user* Lens: drop `from` from the
// facet list (keeping `into` and all other facets with their existing ids/colours). The
// caller folds the stored semantics (ApertureSemanticStore.mergeFacet) so no re-paint is
// needed. Returns the updated Lens, or undefined when the id/facets don't resolve.
export const mergeFacets = (
  directory: string,
  id: string,
  from: string,
  into: string,
): Effect.Effect<Lens | undefined> =>
  Effect.gen(function* () {
    const project = yield* readProject(directory)
    const prev = project[id]
    if (!prev) return undefined
    if (from === into) return prev
    if (!prev.facets.some((t) => t.id === from) || !prev.facets.some((t) => t.id === into)) return undefined
    const next: Lens = { ...prev, facets: prev.facets.filter((t) => t.id !== from) }
    project[id] = next
    yield* writeDoc(lensesFile(directory), project)
    return next
  })

// Remove a *user* Lens from the project doc. Returns true when something was
// removed (built-ins aren't in the doc, so they return false). The caller resets the
// active pointer and clears the Lens's semantics.
export const remove = (directory: string, id: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const project = yield* readProject(directory)
    if (!project[id]) return false
    delete project[id]
    yield* writeDoc(lensesFile(directory), project)
    return true
  })

// Convenience for the tools: a tiny summary of every palette for the agent to pick
// from when proposing a schema.
export const paletteSummary = () =>
  Object.values(PALETTES).map((p) => ({ id: p.id, label: p.label, swatches: p.colors.length }))

export * as ApertureLensStore from "./lens-store"
