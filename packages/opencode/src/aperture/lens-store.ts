import { Effect, Semaphore } from "effect"
import { createHash } from "crypto"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  type Lens,
  type Facet,
  type Finder,
  type LensParent,
  type PaletteId,
  type Rule,
  ARCHITECTURE_ID,
  BUILTIN_LENSES,
  PALETTES,
  MAX_FACETS,
  MAX_RULES,
  assignColors,
  isSearch,
  isValidFinder,
  orderForest,
  paintedFacets,
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

// The same write, but reporting whether it landed. Used by `mark`/`unmark`, whose entire
// value is durability: telling an agent "14 lines marked as retry-path" after a failed write
// is the worst outcome available — it will move on, and the rule is gone. Every other
// mutation here keeps the swallowing `writeDoc`, where the caller has no way to act on a
// failure anyway.
function writeDocResult(file: string, content: unknown): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(file, JSON.stringify(content, null, 2))
    return true
  }).pipe(
    Effect.provide(FSUtil.defaultLayer),
    Effect.catchCause(() => Effect.succeed(false)),
  )
}

// Every mutation here is a read-modify-write over one `lenses.json`, and until S2 the
// comment on `create` was right that a plain RMW was fine: Lens creation is a rare,
// deliberate act. `lens_mark` breaks that assumption — marks are frequent, several land in
// one turn, and the `lens` subagent holds the tool too, so a primary marking while a
// subagent marks is reachable (tool calls serialize within a *session*, not within an
// instance). A lost rule would be silent, because the loser's write simply wins with stale
// content.
//
// One permit per directory, allocated on first use. In-process only: cross-process
// concurrency has never been in scope for this store (no lockfile, no atomic rename), and an
// in-process mutex is what closes the reachable hole — including the pre-existing
// create/update race.
const gates = new Map<string, Semaphore.Semaphore>()
function withDoc<A>(directory: string, body: Effect.Effect<A>): Effect.Effect<A> {
  let gate = gates.get(directory)
  if (!gate) gates.set(directory, (gate = Semaphore.makeUnsafe(1)))
  return gate.withPermits(1)(body)
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
function mintId(name: string, facetLabels: ReadonlyArray<string>): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ name, facets: facetLabels, at: Date.now() }))
    .digest("hex")
    .slice(0, 8)
  return `${slugify(name)}-${hash}`
}

// A rule's id: its facet's slug plus a content hash of the *finder*. Two consequences, both
// wanted. Re-marking an identical query is idempotent — it replaces in place rather than
// stacking a duplicate rule that would paint the same lines twice and double the hit count a
// Search Lens reports. And the id is legible in a committed `lenses.json`, so a human reading
// the diff can see which concern a rule belongs to without cross-referencing.
function mintRuleId(facet: string, find: Finder): string {
  const hash = createHash("sha256").update(JSON.stringify(find)).digest("hex").slice(0, 8)
  return `${slugify(facet)}-${hash}`
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
      id: mintId(
        input.name,
        input.facets.map((t) => t.label),
      ),
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
    // Lens, write back. Serialized per directory (see withDoc) so a concurrent
    // create/update/mark can't win with stale content.
    const project = yield* readProject(directory)
    project[lens.id] = lens
    yield* writeDoc(lensesFile(directory), project)

    return lens
  }).pipe((body) => withDoc(directory, body))

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
      // Carry `ruleOnly` forward with the id. `lens_edit` restates the whole facet list and
      // has no way to express the flag, so without this a single edit would silently hand a
      // marked concern to the painter — which would then assign it to files no rule matched.
      return { id, label: t.label, description: t.description, ...(carried?.ruleOnly ? { ruleOnly: true } : {}) }
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
    // `input.facets` is the complete replacement list for the *painter's* facets — but it can't
    // express a rule-owned one (lens_edit has no such parameter, and an agent editing the Lens
    // has no way to know a concern was marked on it). Restating the list therefore has to
    // preserve them, or a routine edit would silently delete every query lens_mark installed.
    // This is the same reasoning that makes mergeFacets rewrite `rule.facet` instead of
    // orphaning it: rules cost judgement to write, so they are the last thing to evaporate.
    //
    // Rule-owned facets go last so the painter's facets keep the low, stable palette indices.
    const reserved = prev.facets.filter((t) => t.ruleOnly)
    const facets = input.facets
      ? assignColors(palette, [
          ...resolveFacets(palette, input.facets, paintedFacets(prev)),
          ...reserved.map((t) => ({ id: t.id, label: t.label, description: t.description, ruleOnly: true as const })),
        ])
      : prev.facets
    // A Search Lens's facet set belongs to `mark`/`unmark`, and unmarking the last concern
    // legitimately empties it — so a zero-facet Search Lens is a reachable state, and dying
    // here would kill the fiber on something as innocent as renaming it. Every other Lens
    // still needs at least one facet or the painter has nothing to classify into.
    if (facets.length === 0 && !isSearch(prev)) return yield* Effect.die(new Error("a Lens needs at least one facet"))
    // Unreachable from the tools: aperture.editLens refuses over-cap first (counting the
    // reserved facets, which is what makes this reachable at all), so this stays the backstop
    // it has always been.
    if (facets.length > MAX_FACETS)
      return yield* Effect.die(new Error(`a Lens can have at most ${MAX_FACETS} facets (palette size)`))
    // Re-colour when the palette changed but the facet set didn't (so colours track the
    // new palette); when facets changed, resolveFacets already coloured them.
    const coloured = !input.facets && input.palette ? assignColors(palette, facets) : facets

    const prompt = input.prompt ?? prev.prompt
    const context = input.context ?? prev.context
    // `structural` means "the painter would classify files differently now", and the caller
    // answers it by wiping this Lens's facet stores and every descendant's — a whole-repo
    // repaint. So it must be computed over the *painter's* vocabulary only: a rule-owned
    // facet was never offered to the painter (facetEnumIds excludes it), so adding or
    // dropping one cannot change any judgement it already made. Charging a repaint for a
    // `lens_mark` would make marking a concern onto an Overview Lens cost real money.
    const prevPainted = paintedFacets(prev)
    const nextPainted = paintedFacets({ facets: coloured })
    const prevById = new Map(prevPainted.map((t) => [t.id, t]))
    const facetsAddedOrRemoved =
      nextPainted.length !== prevPainted.length || nextPainted.some((t) => !prevById.has(t.id))
    const definitionChanged = nextPainted.some(
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
  }).pipe((body) => withDoc(directory, body))

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
  }).pipe((body) => withDoc(directory, body))

// --- search rules: mark / unmark (S2) ---------------------------------------

// Persist a new Search Lens together with its first concern and rule, in one write.
//
// A Search Lens is a Lens whose facets come from *rules* rather than from the painter, so
// its base state is that every extent is NONE_FACET — deliberately unmarked "Other" grey
// rather than unpainted — and colour arrives only where a rule matches. Its `prompt` is
// empty because nothing will ever read it: `usesPainter` gates the painter off entirely.
//
// Creation and the first mark are the same call on purpose. The alternative — create empty,
// then mark — would persist a facet-less Lens between the two writes, and a `lens_mark` that
// then failed validation would leave a permanent empty Lens behind. (Zero facets is still a
// reachable state via `unmark`, which is why `update` tolerates it.)
export const createSearch = (
  directory: string,
  input: {
    readonly name: string
    readonly description: string
    readonly facet: { readonly label: string; readonly description: string }
    readonly rule: Omit<Rule, "id" | "facet">
  },
): Effect.Effect<{ readonly lens: Lens; readonly facet: Facet; readonly rule: Rule }> =>
  Effect.gen(function* () {
    const facet = assignColors("categorical", [
      {
        id: slugify(input.facet.label),
        label: input.facet.label,
        description: input.facet.description,
        ruleOnly: true,
      },
    ])[0]!
    const rule: Rule = { id: mintRuleId(facet.id, input.rule.find), facet: facet.id, ...input.rule }
    const lens: Lens = {
      id: mintId(input.name, [input.facet.label]),
      name: input.name,
      description: input.description,
      palette: "categorical",
      prompt: "",
      facets: [facet],
      scope: "project",
      search: true,
      rules: [rule],
    }
    const project = yield* readProject(directory)
    project[lens.id] = lens
    yield* writeDocResult(lensesFile(directory), project)
    return { lens, facet, rule }
  }).pipe((body) => withDoc(directory, body))

export interface MarkInput {
  // A facet id (add another rule to that concern), a facet label (same, case-insensitively),
  // or a new name — which mints a concern. The permissive id-or-label resolution is the same
  // convention `mergeFacets` uses.
  readonly facet: string
  // Legend definition for a newly-minted concern. Ignored when the facet already exists.
  readonly definition?: string
  readonly find: Finder
  readonly note?: string
  readonly createdBy?: string
}

export type MarkResult =
  | {
      readonly status: "ok"
      readonly lens: Lens
      readonly facet: Facet
      readonly rule: Rule
      readonly minted: boolean
      // Set when an identical finder was already on this concern: the rule id is a content
      // hash, so re-marking replaces rather than duplicates.
      readonly replaced?: Rule
      // False when the write itself failed (see writeDocResult) — the caller must not claim
      // the mark landed.
      readonly written: boolean
    }
  | { readonly status: "not-found" }
  | { readonly status: "builtin" }
  | { readonly status: "facet-cap"; readonly max: number }
  | { readonly status: "rule-cap"; readonly max: number }

// Attach a rule to a Lens, minting its concern if that concern is new. One atomic RMW —
// minting a facet and appending its rule cannot be two writes, or a failure between them
// leaves a concern with nothing to paint it.
//
// The finder is assumed already *evaluated* by the caller (aperture.markLens), which is what
// keeps a rule that cannot possibly paint — an uncompilable regex, a structural pattern with
// no backend — out of a committed file.
export const mark = (directory: string, id: string, input: MarkInput): Effect.Effect<MarkResult> =>
  Effect.gen(function* () {
    const project = yield* readProject(directory)
    const prev = project[id]
    // A built-in has to be refused explicitly, and this is the one guard whose absence
    // would be invisible rather than noisy: built-ins live in code, not in the project doc,
    // so the RMW below would happily write a project entry keyed `architecture`, `list()`
    // would then hold two Lenses with that id, and `get` returns the built-in — leaving the
    // rule persisted, unreachable and unexplainable.
    if (!prev)
      return BUILTIN_LENSES.some((l) => l.id === id) ? { status: "builtin" as const } : { status: "not-found" as const }

    const wanted = input.facet.trim()
    const existing =
      prev.facets.find((t) => t.id === wanted) ??
      prev.facets.find((t) => t.label.toLowerCase() === wanted.toLowerCase())
    if (!existing && prev.facets.length >= MAX_FACETS) return { status: "facet-cap" as const, max: MAX_FACETS }

    const palette = prev.palette ?? "categorical"
    const facets = existing
      ? prev.facets
      : assignColors(palette, [
          ...prev.facets,
          {
            id: uniqueFacetId(prev.facets, wanted),
            label: wanted,
            description: input.definition?.trim() || `Lines matched by the "${wanted}" search rules.`,
            // Minted facets are always rule-owned: excluded from the painter's vocabulary, so
            // this addition owes no repaint even on an Overview Lens. See Facet.ruleOnly.
            ruleOnly: true as const,
          },
        ])
    const facet = existing ?? facets[facets.length - 1]!

    const rule: Rule = {
      id: mintRuleId(facet.id, input.find),
      facet: facet.id,
      find: input.find,
      ...(input.note ? { note: input.note } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    }
    const rules = [...(prev.rules ?? [])]
    const at = rules.findIndex((r) => r.id === rule.id)
    const replaced = at >= 0 ? rules[at] : undefined
    // The cap is enforced here rather than left to `normalizeRules`, which *silently
    // truncates* past MAX_RULES on read — so an unchecked append would report success and
    // then vanish on the next payload.
    if (at >= 0) rules[at] = rule
    else if (rules.length >= MAX_RULES) return { status: "rule-cap" as const, max: MAX_RULES }
    else rules.push(rule)

    const next: Lens = { ...prev, facets, rules }
    project[id] = next
    const written = yield* writeDocResult(lensesFile(directory), project)
    return {
      status: "ok" as const,
      lens: next,
      facet,
      rule,
      minted: !existing,
      ...(replaced ? { replaced } : {}),
      written,
    }
  }).pipe((body) => withDoc(directory, body))

// A facet id unique within the Lens, mirroring `create`/`resolveFacets`' de-dup loop so a
// concern named the same as an existing facet can't collide with it.
function uniqueFacetId(existing: ReadonlyArray<Facet>, label: string): string {
  const taken = new Set(existing.map((t) => t.id))
  let id = slugify(label)
  let n = 2
  while (taken.has(id)) id = `${slugify(label)}-${n++}`
  return id
}

export type UnmarkResult =
  | {
      readonly status: "ok"
      readonly lens: Lens
      readonly removedRules: ReadonlyArray<Rule>
      readonly removedFacet?: Facet
      // Facets whose hue moved as a consequence. Facet colour is derived from array position
      // (see `migrate` -> `assignColors`), so removing anything but the last facet re-hues
      // every facet after it. Reported rather than prevented: a stored colour slot would be a
      // second source of truth and a wire change through payload.ts and the extension's
      // generated colour ids, for an event that is rare and always user- or agent-initiated.
      // O4's suppressed set is keyed by facet id, so an active legend filter survives.
      readonly recolored: ReadonlyArray<{
        readonly facet: string
        readonly label: string
        readonly from: string
        readonly to: string
      }>
      readonly written: boolean
    }
  | { readonly status: "not-found" }
  | { readonly status: "builtin" }
  | { readonly status: "unknown-rule"; readonly rule: string }
  | { readonly status: "unknown-facet"; readonly facet: string }

// Remove one rule by id, or a whole concern and every rule naming it.
//
// Removing a facet takes its rules with it deliberately: leaving them behind means
// `normalizeRules` drops them on the next read as naming a facet that no longer exists, so
// the choice is between deleting them visibly here and deleting them silently there.
export const unmark = (
  directory: string,
  id: string,
  input: { readonly rule?: string; readonly facet?: string },
): Effect.Effect<UnmarkResult> =>
  Effect.gen(function* () {
    const project = yield* readProject(directory)
    const prev = project[id]
    if (!prev)
      return BUILTIN_LENSES.some((l) => l.id === id) ? { status: "builtin" as const } : { status: "not-found" as const }

    const prevRules = prev.rules ?? []
    let removedRules: Rule[] = []
    let removedFacet: Facet | undefined
    let facets = prev.facets

    if (input.rule) {
      const victim = prevRules.find((r) => r.id === input.rule)
      if (!victim) return { status: "unknown-rule" as const, rule: input.rule }
      removedRules = [victim]
    } else if (input.facet) {
      const wanted = input.facet.trim()
      const target =
        prev.facets.find((t) => t.id === wanted) ??
        prev.facets.find((t) => t.label.toLowerCase() === wanted.toLowerCase())
      if (!target) return { status: "unknown-facet" as const, facet: wanted }
      removedFacet = target
      removedRules = prevRules.filter((r) => r.facet === target.id)
      facets = assignColors(
        prev.palette ?? "categorical",
        prev.facets.filter((t) => t.id !== target.id),
      )
    } else return { status: "unknown-rule" as const, rule: "" }

    const removedIds = new Set(removedRules.map((r) => r.id))
    const rules = prevRules.filter((r) => !removedIds.has(r.id))
    const before = new Map(prev.facets.map((t) => [t.id, t.color]))
    const recolored = facets
      .filter((t) => before.get(t.id) !== t.color)
      .map((t) => ({ facet: t.id, label: t.label, from: before.get(t.id)!, to: t.color }))

    const next: Lens = { ...prev, facets, ...(rules.length ? { rules } : { rules: undefined }) }
    project[id] = next
    const written = yield* writeDocResult(lensesFile(directory), project)
    return {
      status: "ok" as const,
      lens: next,
      removedRules,
      ...(removedFacet ? { removedFacet } : {}),
      recolored,
      written,
    }
  }).pipe((body) => withDoc(directory, body))

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
  }).pipe((body) => withDoc(directory, body))

// Convenience for the tools: a tiny summary of both palettes for the agent to pick from
// when proposing a schema. `kind` is the whole decision — the two hold the same six
// colours, so the only question is whether the facets have a rank worth encoding.
export const paletteSummary = () =>
  Object.values(PALETTES).map((p) => ({ id: p.id, label: p.label, kind: p.kind, swatches: p.colors.length }))

export * as ApertureLensStore from "./lens-store"
