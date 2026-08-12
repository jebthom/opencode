import { Effect } from "effect"
import { createHash } from "crypto"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  type Lens,
  type Facet,
  type LensParent,
  type PaletteId,
  type Rule,
  ARCHITECTURE_ID,
  BUILTIN_LENSES,
  PALETTES,
  MAX_FACETS,
  MAX_RULES,
  assignColors,
  isValidFinder,
  orderForest,
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

// Palettes that existed before C1 collapsed the set to two. A stored Lens still names one,
// so map it forward on read rather than migrating the files: the mapping is total, the
// colours are re-derived below anyway, and a read-time fix also covers a hand-edited
// lenses.json. Anything unrecognised falls to "categorical".
const LEGACY_PALETTES: Record<string, PaletteId> = {
  pastel: "categorical",
  dark: "categorical",
  bright: "categorical",
  earthy: "categorical",
  "pastel-ordinal": "ordinal",
  "bright-ordinal": "ordinal",
  "dark-ordinal": "ordinal",
}

function resolvePalette(stored: string | undefined): PaletteId {
  if (!stored) return "categorical"
  if (stored in PALETTES) return stored as PaletteId
  return LEGACY_PALETTES[stored] ?? "categorical"
}

// Normalise a stored Lens: resolve its palette id, then re-derive every facet colour from
// (palette, index).
//
// Facet colour is *stored* — it was materialised when the Lens was created — which made it
// a second source of truth that silently went stale whenever the palettes changed. Deriving
// it on every read makes PALETTES the only place a colour is decided, so a palette edit can
// never leave an old Lens painting hexes that no longer exist (which is what a straight
// swap of the palette table would otherwise have done to every Lens on disk).
function migrate(lens: Lens): Lens {
  const palette = resolvePalette(lens.palette)
  const facets = assignColors(palette, lens.facets)
  const rules = normalizeRules(lens.rules, facets)
  return { ...lens, palette, facets, ...(rules.length ? { rules } : { rules: undefined }) }
}

// Drop stored rules that can't paint, on the same read-time pass that re-derives facet
// colour. `lenses.json` is committable and hand-editable, so this has to be total — a
// mistyped finder must cost that one rule, never the Lens.
//
// Three ways a rule dies here, all of them *shape*: it isn't an object with an id and a
// well-formed finder; its facet isn't on this Lens (facet ids are slugs, and mergeFacets
// can retire one out from under a rule — the same hazard `facetsWithin` guards for the O4
// legend filter); or it is past MAX_RULES.
//
// Everything else a rule can be wrong about — a regex that won't compile, an ast-grep
// pattern that won't parse, a pattern that matches 4,000 lines — is deliberately NOT
// checked here. Those must be *reported* so the authoring agent can narrow them, and the
// store has nowhere to report to; they belong to the evaluator (`rules.ts`), which returns
// a diagnostic per rule.
function normalizeRules(rules: ReadonlyArray<Rule> | undefined, facets: ReadonlyArray<Facet>): Rule[] {
  if (!Array.isArray(rules)) return []
  const known = new Set(facets.map((f) => f.id))
  const out: Rule[] = []
  for (const raw of rules) {
    if (out.length >= MAX_RULES) break
    if (typeof raw !== "object" || raw === null) continue
    if (typeof raw.id !== "string" || !raw.id) continue
    if (typeof raw.facet !== "string" || !known.has(raw.facet)) continue
    if (!isValidFinder(raw.find)) continue
    out.push(raw)
  }
  return out
}

// All user-defined Lenses for a project (empty when none defined yet).
const readProject = (directory: string): Effect.Effect<StoredLenses> =>
  readDoc<StoredLenses>(lensesFile(directory), {}).pipe(
    Effect.map((project) => Object.fromEntries(Object.entries(project).map(([id, lens]) => [id, migrate(lens)]))),
  )

// Built-in (global) Lenses first, then the project's user-defined ones — but arranged as a
// DFS forest (orderForest), so a drill-down always sits immediately after the Lens it is
// scoped to. That single ordering is what makes the picker render children indented under
// their parent *and* the ◀ ▶ cycle walk parent → children, with no ordering logic of their
// own. A drill-down of a *built-in* therefore appears inside the built-in run; it is still
// a project Lens (scope: "project"), so it stays editable and deletable.
export const list = (directory: string): Effect.Effect<Lens[]> =>
  readProject(directory).pipe(
    Effect.map((project) => orderForest([...BUILTIN_LENSES, ...Object.values(project)]).map((e) => e.lens)),
  )

// The forest with each Lens's depth + root scope, for the picker (which needs the depth to
// indent and the root's scope to group a child with its parent rather than tearing it into
// another section).
export const forest = (directory: string) =>
  readProject(directory).pipe(Effect.map((project) => orderForest([...BUILTIN_LENSES, ...Object.values(project)])))

// Only project Lenses can be drill-downs (built-ins live in code and declare no parent), so
// the project doc alone answers every hierarchy question below.

// The Lenses scoped directly to `id`.
export const childrenOf = (directory: string, id: string): Effect.Effect<Lens[]> =>
  readProject(directory).pipe(Effect.map((project) => Object.values(project).filter((l) => l.parent?.lens === id)))

// Every Lens scoped to `id` directly or transitively, nearest first. Cycle-safe (a
// hand-edited lenses.json could contain a loop, and this must not hang).
export const descendantsOf = (directory: string, id: string): Effect.Effect<Lens[]> =>
  readProject(directory).pipe(Effect.map((project) => descendants(Object.values(project), id)))

function descendants(all: ReadonlyArray<Lens>, id: string): Lens[] {
  const out: Lens[] = []
  const frontier = [id]
  const seen = new Set([id])
  while (frontier.length) {
    const parent = frontier.shift()!
    for (const lens of all) {
      if (lens.parent?.lens !== parent || seen.has(lens.id)) continue
      seen.add(lens.id)
      out.push(lens)
      frontier.push(lens.id)
    }
  }
  return out
}

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
export const setActive = (directory: string, id: string): Effect.Effect<void> => writeDoc(activeFile(directory), { id })

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
  // Drill-down scope (see Lens.parent). The caller (aperture.createLens) has already
  // resolved the parent id and validated that every facet id exists on it.
  readonly parent?: LensParent
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
      ...(input.parent ? { parent: input.parent } : {}),
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
export const update = (directory: string, id: string, input: UpdateInput): Effect.Effect<UpdateResult | undefined> =>
  Effect.gen(function* () {
    const project = yield* readProject(directory)
    const prev = project[id]
    if (!prev) return undefined

    // `prev` came through readProject, so its palette is already normalised.
    const palette = input.palette ?? prev.palette ?? "categorical"
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
    const facetsAddedOrRemoved = coloured.length !== prev.facets.length || coloured.some((t) => !prevById.has(t.id))
    const definitionChanged = coloured.some(
      (t) => prevById.get(t.id) && prevById.get(t.id)!.description !== t.description,
    )
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
    // A rule naming the retired facet has to follow it, for the same reason a drill-down
    // scoped to it does (below): otherwise normalizeRules drops the rule on the next read
    // as naming a facet that no longer exists, and a query the agent wrote is silently lost
    // by a *cosmetic* merge. Rules are the one thing here that cost judgement rather than
    // tokens, so they are the last thing that should evaporate.
    const rules = prev.rules?.map((r) => (r.facet === from ? { ...r, facet: into } : r))
    const next: Lens = {
      ...prev,
      facets: prev.facets.filter((t) => t.id !== from),
      ...(rules?.length ? { rules } : {}),
    }
    project[id] = next
    // A drill-down scoped to the facet that just went away has to follow it, or its domain
    // would name a facet that no longer exists and it would paint nothing at all. (The
    // caller does the matching rewrite of those Lenses' painted stores.)
    for (const child of Object.values(project)) {
      if (child.parent?.lens !== id || !child.parent.facets.includes(from)) continue
      const facets = [...new Set(child.parent.facets.map((f) => (f === from ? into : f)))]
      project[child.id] = { ...child, parent: { ...child.parent, facets } }
    }
    yield* writeDoc(lensesFile(directory), project)
    return next
  })

// Remove a *user* Lens and every drill-down scoped to it, transitively: a drill-down's
// domain is defined by its parent's facets, so without the parent it has no meaning and
// could never repaint. Returns the ids actually removed (empty for a built-in / unknown id,
// neither of which is in the doc). The caller clears each removed Lens's painted stores and
// resets the active pointer if it was one of them.
export const remove = (directory: string, id: string): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const project = yield* readProject(directory)
    if (!project[id]) return []
    const removed = [id, ...descendants(Object.values(project), id).map((l) => l.id)]
    for (const victim of removed) delete project[victim]
    yield* writeDoc(lensesFile(directory), project)
    return removed
  })

// Convenience for the tools: a tiny summary of both palettes for the agent to pick from
// when proposing a schema. `kind` is the whole decision — the two hold the same six
// colours, so the only question is whether the facets have a rank worth encoding.
export const paletteSummary = () =>
  Object.values(PALETTES).map((p) => ({ id: p.id, label: p.label, kind: p.kind, swatches: p.colors.length }))

export * as ApertureLensStore from "./lens-store"
