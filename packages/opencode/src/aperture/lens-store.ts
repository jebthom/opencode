import { Effect, Semaphore } from "effect"
import { createHash } from "crypto"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  type Facet,
  type Finder,
  type GitFilter,
  type Lens,
  type Owner,
  type PaletteId,
  type Rule,
  PALETTES,
  MAX_FACETS,
  MAX_RULES,
  assignColors,
  findFacet,
  repaletteColors,
  isValidFinder,
  slugify,
  whereProblem,
} from "./lenses"
import { ApertureLensHistory, type Actor } from "./lens-history"

// Per-project store for Lenses plus the pointer to the active one, persisted under
// `.opencode/aperture/` so a Lens is shareable, committable, and readable by an agent directly.
//
// Every mutation takes an `Actor` and does two things beyond the write:
//
//  - **Ownership.** An agent acting on its own initiative may change only agent-owned Lenses and
//    facets. Touching a user's needs consent, so the call returns `needs-consent` and the tool
//    layer asks the user before retrying with `consented: true`. Enforced here rather than in the
//    tools so the rule cannot be forgotten by the next entry point.
//  - **History.** Each successful change appends to `lens-history.jsonl` (see lens-history.ts)
//    from inside the same mutex, so the log and the definitions can never disagree about order.

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

function readDoc<T>(file: string, fallback: T): Effect.Effect<T> {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return (yield* fs.readJson(file).pipe(Effect.catch(() => Effect.succeed(fallback)))) as T
  }).pipe(Effect.provide(FSUtil.defaultLayer))
}

// Write a JSON doc, reporting whether it landed. Durability is the whole value of a mark:
// telling an agent "14 lines marked" after a failed write is the worst outcome available — it
// moves on and the rule is gone — so every caller surfaces `false`.
function writeDoc(file: string, content: unknown): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(file, JSON.stringify(content, null, 2))
    return true
  }).pipe(
    Effect.provide(FSUtil.defaultLayer),
    Effect.catchCause(() => Effect.succeed(false)),
  )
}

// Every mutation is a read-modify-write over one `lenses.json`, and marks are frequent — several
// land in one turn, from the primary agent and from the TUI at once. One permit per directory
// closes the in-process race (a lost rule would be silent: the loser's write simply wins with
// stale content). Cross-process concurrency has never been in scope for this store.
const gates = new Map<string, Semaphore.Semaphore>()
function withDoc<A>(directory: string, body: Effect.Effect<A>): Effect.Effect<A> {
  let gate = gates.get(directory)
  if (!gate) gates.set(directory, (gate = Semaphore.makeUnsafe(1)))
  return gate.withPermits(1)(body)
}

// --- read-time migration ---------------------------------------------------

// Palettes that existed before C1 collapsed the set to two. Mapped forward on read rather than
// migrating files, which also covers a hand-edited lenses.json.
const LEGACY_PALETTES: Record<string, PaletteId> = {
  pastel: "categorical",
  dark: "categorical",
  bright: "categorical",
  earthy: "categorical",
  "pastel-ordinal": "ordinal",
  "bright-ordinal": "ordinal",
  "dark-ordinal": "ordinal",
}

function resolvePalette(stored: unknown): PaletteId {
  if (typeof stored !== "string") return "categorical"
  if (stored in PALETTES) return stored as PaletteId
  return LEGACY_PALETTES[stored] ?? "categorical"
}

function resolveOwner(stored: unknown): Owner {
  return stored === "agent" ? "agent" : "user"
}

// Normalise a stored Lens into the v3 shape. Total, because `lenses.json` is committable and
// hand-editable: a malformed entry must cost that one field, never the Lens.
//
// v2 Lenses carried painter fields (`prompt`, `context`, `directories`, `parent`, `search`,
// `scope`) and painter-owned facets that no rule ever pointed at. The painter is gone, so those
// facets could never be coloured again; they are dropped here and their fields ignored. A facet
// minted by `lens_mark` (v2's `ruleOnly`) survives even with no rules, since it was a concern
// someone chose. Anything without an explicit owner predates ownership and is conservatively the
// user's.
//
// A stored facet colour is kept when it belongs to the palette and no earlier facet holds it;
// anything else (a hand-edit, a pre-pinning file whose colours were positional anyway) gets the
// lowest free slot. So PALETTES still decides every colour, but a facet keeps its own.
function migrate(raw: Record<string, unknown>): Lens {
  const palette = resolvePalette(raw["palette"])
  const rawRules = Array.isArray(raw["rules"]) ? (raw["rules"] as Array<Record<string, unknown>>) : []
  // Only a rule that can actually paint keeps its facet alive; a malformed one is dropped below.
  const ruled = new Set(rawRules.filter((r) => isValidFinder(r?.["find"])).map((r) => r["facet"]))
  const rawFacets = Array.isArray(raw["facets"]) ? (raw["facets"] as Array<Record<string, unknown>>) : []
  const facets = assignColors(
    palette,
    rawFacets
      .filter((f) => typeof f?.["id"] === "string" && (f["ruleOnly"] === true || f["owner"] || ruled.has(f["id"])))
      .slice(0, MAX_FACETS)
      .map((f) => ({
        id: f["id"] as string,
        label: typeof f["label"] === "string" ? f["label"] : (f["id"] as string),
        // v3.1 facets carried one `reason`; it described what the lines are far more often than
        // why they mattered, so it becomes the `what` and the `why` starts empty (and is flagged
        // as missing in <aperture-state>).
        what: typeof f["what"] === "string" ? f["what"] : typeof f["reason"] === "string" ? f["reason"] : "",
        why: typeof f["why"] === "string" ? f["why"] : "",
        ...(typeof f["color"] === "string" ? { color: f["color"] } : {}),
        owner: resolveOwner(f["owner"]),
        ...(typeof f["createdBy"] === "string" ? { createdBy: f["createdBy"] } : {}),
      })),
  )
  const rules = normalizeRules(rawRules, facets)
  return {
    id: String(raw["id"]),
    name: typeof raw["name"] === "string" ? raw["name"] : String(raw["id"]),
    description: typeof raw["description"] === "string" ? raw["description"] : "",
    palette,
    facets,
    owner: resolveOwner(raw["owner"]),
    ...(rules.length ? { rules } : {}),
  }
}

// Drop stored rules that can't paint. Three ways a rule dies here, all of them *shape*: it isn't
// an object with an id and a well-formed finder/filter; its facet isn't on this Lens; or it is
// past MAX_RULES. A regex that won't compile or a rule matching 4,000 lines is the evaluator's to
// report — the store has nowhere to report to.
function normalizeRules(rules: ReadonlyArray<Record<string, unknown>>, facets: ReadonlyArray<Facet>): Rule[] {
  const known = new Set(facets.map((f) => f.id))
  return rules
    .filter(
      (raw) =>
        typeof raw === "object" &&
        raw !== null &&
        typeof raw["id"] === "string" &&
        raw["id"].length > 0 &&
        typeof raw["facet"] === "string" &&
        known.has(raw["facet"]) &&
        isValidFinder(raw["find"]) &&
        whereProblem(raw["where"]) === undefined,
    )
    .slice(0, MAX_RULES)
    .map((raw) => raw as unknown as Rule)
}

// A v2 Overview Lens whose every facet was painter-owned migrates to an empty shell that can never
// show anything; it is dropped rather than left to clutter the picker. (It disappears from disk on
// the next write, and survives in git history.) A Lens left empty by unmarking is a different
// thing — someone's, and about to be marked again — and is kept.
const readProject = (directory: string): Effect.Effect<StoredLenses> =>
  readDoc<Record<string, Record<string, unknown>>>(lensesFile(directory), {}).pipe(
    Effect.map((project) =>
      Object.fromEntries(
        Object.entries(project)
          .filter(([, lens]) => typeof lens === "object" && lens !== null)
          .map(([id, lens]) => [id, lens, migrate({ ...lens, id })] as const)
          .filter(([, raw, lens]) => lens.facets.length > 0 || !(typeof raw["prompt"] === "string" && raw["prompt"]))
          .map(([id, , lens]) => [id, lens]),
      ),
    ),
  )

// --- reads -----------------------------------------------------------------

// Every Lens, in the order it was created (lenses.json key order).
export const list = (directory: string): Effect.Effect<Lens[]> =>
  readProject(directory).pipe(Effect.map((project) => Object.values(project)))

export const get = (directory: string, id: string): Effect.Effect<Lens | undefined> =>
  readProject(directory).pipe(Effect.map((project) => project[id]))

// Resolve a Lens by id or (case-insensitive) name.
export function resolve(all: ReadonlyArray<Lens>, idOrName: string): Lens | undefined {
  const needle = idOrName.trim().toLowerCase()
  return all.find((c) => c.id === idOrName) ?? all.find((c) => c.name.toLowerCase() === needle)
}

// The stored active id, or undefined when none has ever been chosen.
export const getActiveId = (directory: string): Effect.Effect<string | undefined> =>
  readDoc<{ id?: unknown } | undefined>(activeFile(directory), undefined).pipe(
    Effect.map((doc) => (typeof doc?.id === "string" ? doc.id : undefined)),
  )

// The active Lens: the stored one when it still exists, else the first Lens, else none. The
// fallback matters for a v2 project, whose active.json usually names a built-in that no longer
// exists — the view should land on a real Lens rather than render nothing.
export const getActive = (directory: string): Effect.Effect<Lens | undefined> =>
  Effect.gen(function* () {
    const all = yield* list(directory)
    const id = yield* getActiveId(directory)
    return all.find((l) => l.id === id) ?? all[0]
  })

// --- mutations -------------------------------------------------------------

type Refusal =
  | { readonly status: "not-found" }
  // An agent acting on its own initiative tried to change something the user owns. Nothing was
  // written; the caller asks the user and retries with `consented: true`.
  | { readonly status: "needs-consent"; readonly lens: Lens; readonly facet?: Facet }

// Whether `actor` may change `lens` (and, when given, `facet`) without asking.
function consentNeeded(actor: Actor, lens: Lens, facet?: Facet): boolean {
  if (actor.kind === "user" || actor.consented) return false
  return lens.owner === "user" || facet?.owner === "user"
}

export const setActive = (directory: string, lens: Lens | undefined, actor: Actor): Effect.Effect<void> =>
  withDoc(
    directory,
    Effect.gen(function* () {
      yield* writeDoc(activeFile(directory), lens ? { id: lens.id } : {})
      if (lens) yield* ApertureLensHistory.append(directory, [{ op: "lens.select", actor, lens: ref(lens) }])
    }),
  )

// Checkpoint the active Lens for each completed todo. Taken inside the mutex so the snapshot and
// its `seq` agree with the changes around it. With no Lens active, the entry still marks the
// boundary (an empty lens ref) so a later "no change since the milestone" check sees it.
export const milestone = (
  directory: string,
  todos: ReadonlyArray<{ readonly todo: string; readonly index: number }>,
  actor: Actor,
): Effect.Effect<void> =>
  withDoc(
    directory,
    Effect.gen(function* () {
      if (todos.length === 0) return
      const active = yield* getActive(directory)
      yield* ApertureLensHistory.append(
        directory,
        todos.map((m) => ({
          op: "milestone",
          actor,
          lens: active ? ref(active) : { id: "", name: "" },
          milestone: m,
          ...(active ? { after: { view: active } } : {}),
        })),
      )
    }),
  )

// Mint a unique Lens id: name slug + a short hash so two Lenses with the same name never collide
// and ids stay legible in a committed lenses.json.
function mintId(name: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ name, at: Date.now(), r: Math.random() }))
    .digest("hex")
    .slice(0, 8)
  return `${slugify(name)}-${hash}`
}

// A rule's id: its facet's slug plus a content hash of the finder and filter. Re-marking an
// identical query is therefore idempotent — it replaces in place rather than stacking a duplicate
// that would paint the same lines twice and double the hit count.
function mintRuleId(facet: string, find: Finder, where?: GitFilter): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(where ? { find, where } : find))
    .digest("hex")
    .slice(0, 8)
  return `${slugify(facet)}-${hash}`
}

function uniqueFacetId(existing: ReadonlyArray<Facet>, label: string): string {
  const taken = new Set(existing.map((t) => t.id))
  const base = slugify(label)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

function ref(lens: Lens) {
  return { id: lens.id, name: lens.name }
}

export interface MarkInput {
  // A facet id or label (add another rule to that concern), or a new name (mint it).
  readonly facet: string
  // What the marked lines are, and why they matter for the task now (`Facet.what` / `Facet.why`).
  // Both are required when an agent mints a concern. Given for an existing one, `why` replaces the
  // why, and `what` corrects the what (which then needs the actor's `reason`).
  readonly what?: string
  readonly why?: string
  readonly find: Finder
  readonly where?: GitFilter
  readonly note?: string
  // What the finder matched when it was evaluated, recorded in the history.
  readonly hits?: { readonly lines: number; readonly files: number; readonly overCap?: boolean }
}

export interface CreateInput extends MarkInput {
  readonly name: string
  readonly description: string
}

export type MarkResult =
  | {
      readonly status: "ok"
      readonly lens: Lens
      readonly facet: Facet
      readonly rule: Rule
      readonly createdLens: boolean
      readonly minted: boolean
      // Set when an identical finder was already on this concern.
      readonly replaced?: Rule
      readonly written: boolean
    }
  | Refusal
  | { readonly status: "facet-cap"; readonly lens: Lens; readonly max: number }
  | { readonly status: "rule-cap"; readonly lens: Lens; readonly max: number }
  // An agent tried to mint a concern without saying what it marks and why. Nothing was written.
  | { readonly status: "needs-what-why"; readonly facet: string; readonly missing: ReadonlyArray<"what" | "why"> }
  // An agent added a second (or later) rule to a concern without a `note` saying which part of the
  // concern it marks — the only thing that tells two lines of one facet apart. Nothing was written.
  | { readonly status: "needs-note"; readonly lens: Lens; readonly facet: Facet }
  | Unjustified

// An agent corrected a concern's identity (its `what` or `label`) without saying why. A correction
// is legitimate, but rare and consequential enough that the history must carry a reason for it.
type Unjustified = {
  readonly status: "needs-justification"
  readonly facet: string
  readonly fields: ReadonlyArray<"label" | "what">
}

// An agent must say what a concern it mints marks and why it is worth the user's attention: both
// are what every hover surface shows beside the query. A user marking from the TUI is not asked.
function whatWhyMissing(actor: Actor, input: MarkInput): Array<"what" | "why"> {
  if (actor.agent === undefined) return []
  return [...(input.what?.trim() ? [] : ["what" as const]), ...(input.why?.trim() ? [] : ["why" as const])]
}

// A concern's identity fields an agent changed without giving a `reason`.
function unjustified(actor: Actor, fields: ReadonlyArray<Revised>): Array<"label" | "what"> {
  if (actor.agent === undefined || actor.reason) return []
  return fields.filter((f): f is "label" | "what" => f === "label" || f === "what")
}

type Revised = "label" | "what" | "why"

// Apply an edit to a facet, reporting which fields actually changed. Blank values keep the old one.
function revise(facet: Facet, edit: { readonly label?: string; readonly what?: string; readonly why?: string }) {
  const next: Facet = {
    ...facet,
    label: edit.label?.trim() || facet.label,
    what: edit.what?.trim() || facet.what,
    why: edit.why?.trim() || facet.why,
  }
  const fields = (["label", "what", "why"] as const).filter((k) => next[k] !== facet[k])
  return { facet: next, fields }
}

function facetEdit(actor: Actor, lens: Lens, before: Facet, after: Facet, fields: ReadonlyArray<Revised>) {
  return {
    op: "facet.edit" as const,
    actor,
    lens: ref(lens),
    facet: after.id,
    fields,
    before: { facet: before },
    after: { facet: after },
  }
}

// Create a Lens together with its first concern and rule, in one write. Creation and the first
// mark are the same call on purpose: create-then-mark would persist a facet-less Lens between the
// two writes, and a mark that then failed validation would leave an empty Lens behind.
export const create = (directory: string, input: CreateInput, actor: Actor): Effect.Effect<MarkResult> =>
  withDoc(
    directory,
    Effect.gen(function* () {
      const missing = whatWhyMissing(actor, input)
      if (missing.length) return { status: "needs-what-why" as const, facet: input.facet.trim(), missing }
      const facet = assignColors("categorical", [
        {
          id: slugify(input.facet),
          label: input.facet.trim(),
          what: input.what?.trim() ?? "",
          why: input.why?.trim() ?? "",
          owner: actor.kind,
          ...(actor.agent ? { createdBy: actor.agent } : {}),
        },
      ])[0]!
      const rule = buildRule(facet.id, input, actor)
      const lens: Lens = {
        id: mintId(input.name),
        name: input.name.trim(),
        description: input.description,
        palette: "categorical",
        facets: [facet],
        owner: actor.kind,
        rules: [rule],
      }
      const project = yield* readProject(directory)
      project[lens.id] = lens
      const written = yield* writeDoc(lensesFile(directory), project)
      if (written)
        yield* ApertureLensHistory.append(directory, [
          { op: "lens.create", actor, lens: ref(lens), after: { lens: pickLens(lens) } },
          { op: "facet.add", actor, lens: ref(lens), facet: facet.id, after: { facet } },
          ruleEntry("rule.add", actor, lens, rule, input.hits),
        ])
      return { status: "ok" as const, lens, facet, rule, createdLens: true, minted: true, written }
    }),
  )

// Attach a rule to a Lens, minting its concern if that concern is new. One atomic RMW — minting a
// facet and appending its rule cannot be two writes, or a failure between them leaves a concern
// with nothing to paint it.
//
// The finder is assumed already *evaluated* by the caller (aperture.markLens), which is what
// keeps a rule that cannot possibly paint out of a committed file.
export const mark = (directory: string, id: string, input: MarkInput, actor: Actor): Effect.Effect<MarkResult> =>
  withDoc(
    directory,
    Effect.gen(function* () {
      const project = yield* readProject(directory)
      const prev = project[id]
      if (!prev) return { status: "not-found" as const }

      const existing = findFacet(prev, input.facet)
      if (consentNeeded(actor, prev, existing)) return { status: "needs-consent" as const, lens: prev, facet: existing }
      if (!existing && prev.facets.length >= MAX_FACETS)
        return { status: "facet-cap" as const, lens: prev, max: MAX_FACETS }
      const missing = existing ? [] : whatWhyMissing(actor, input)
      if (missing.length) return { status: "needs-what-why" as const, facet: input.facet.trim(), missing }

      const label = input.facet.trim()
      // A what or why given for an existing concern is an edit to it, recorded as one below.
      const revision = existing ? revise(existing, { what: input.what, why: input.why }) : undefined
      const fields = unjustified(actor, revision?.fields ?? [])
      if (fields.length) return { status: "needs-justification" as const, facet: existing!.id, fields }
      const revised = revision?.fields.length ? revision.facet : undefined
      const facets = existing
        ? prev.facets.map((t) => (t.id === revised?.id ? revised : t))
        : assignColors(prev.palette, [
            ...prev.facets,
            {
              id: uniqueFacetId(prev.facets, label),
              label,
              what: input.what?.trim() ?? "",
              why: input.why?.trim() ?? "",
              owner: actor.kind,
              ...(actor.agent ? { createdBy: actor.agent } : {}),
            },
          ])
      const facet = revised ?? existing ?? facets[facets.length - 1]!
      const rule = buildRule(facet.id, input, actor)
      const rules = [...(prev.rules ?? [])]
      const at = rules.findIndex((r) => r.id === rule.id)
      const replaced = at >= 0 ? rules[at] : undefined
      // A second rule on a concern needs a note saying which part of the concern it marks. Replacing
      // a rule in place adds nothing to tell apart, so it is exempt.
      if (
        actor.agent !== undefined &&
        at < 0 &&
        !input.note?.trim() &&
        rules.some((r) => r.facet === facet.id)
      )
        return { status: "needs-note" as const, lens: prev, facet }
      // Enforced here rather than left to `normalizeRules`, which silently truncates on read —
      // an unchecked append would report success and then vanish on the next read.
      if (at < 0 && rules.length >= MAX_RULES) return { status: "rule-cap" as const, lens: prev, max: MAX_RULES }
      if (at >= 0) rules[at] = rule
      else rules.push(rule)

      const next: Lens = { ...prev, facets, rules }
      project[id] = next
      const written = yield* writeDoc(lensesFile(directory), project)
      if (written)
        yield* ApertureLensHistory.append(directory, [
          ...(existing
            ? []
            : [{ op: "facet.add" as const, actor, lens: ref(next), facet: facet.id, after: { facet } }]),
          ...(revised ? [facetEdit(actor, next, existing!, revised, revision!.fields)] : []),
          ruleEntry(replaced ? "rule.replace" : "rule.add", actor, next, rule, input.hits, replaced),
        ])
      return {
        status: "ok" as const,
        lens: next,
        facet,
        rule,
        createdLens: false,
        minted: !existing,
        ...(replaced ? { replaced } : {}),
        written,
      }
    }),
  )

function buildRule(facet: string, input: MarkInput, actor: Actor): Rule {
  return {
    id: mintRuleId(facet, input.find, input.where),
    facet,
    find: input.find,
    ...(input.where ? { where: input.where } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(actor.agent ? { createdBy: actor.agent } : {}),
  }
}

function ruleEntry(
  op: "rule.add" | "rule.replace",
  actor: Actor,
  lens: Lens,
  rule: Rule,
  hits: MarkInput["hits"],
  replaced?: Rule,
): ApertureLensHistory.Draft {
  return {
    op,
    actor,
    lens: ref(lens),
    facet: rule.facet,
    rule: rule.id,
    ...(replaced ? { before: { rule: replaced } } : {}),
    after: { rule },
    ...(hits ? { hits } : {}),
  }
}

function pickLens(lens: Lens) {
  return { name: lens.name, description: lens.description, owner: lens.owner }
}

export type UnmarkResult =
  | {
      readonly status: "ok"
      readonly lens: Lens
      readonly removedRules: ReadonlyArray<Rule>
      readonly removedFacet?: Facet
      readonly written: boolean
    }
  | Refusal
  | { readonly status: "unknown-rule"; readonly lens: Lens; readonly rule: string }
  | { readonly status: "unknown-facet"; readonly lens: Lens; readonly facet: string }

// Remove one rule by id, or a whole concern and every rule naming it. Removing a facet takes its
// rules with it deliberately: left behind, `normalizeRules` would drop them silently on the next
// read as naming a facet that no longer exists.
export const unmark = (
  directory: string,
  id: string,
  input: { readonly rule?: string; readonly facet?: string },
  actor: Actor,
): Effect.Effect<UnmarkResult> =>
  withDoc(
    directory,
    Effect.gen(function* () {
      const project = yield* readProject(directory)
      const prev = project[id]
      if (!prev) return { status: "not-found" as const }
      const prevRules = prev.rules ?? []

      const victim = input.rule ? prevRules.find((r) => r.id === input.rule) : undefined
      if (input.rule && !victim) return { status: "unknown-rule" as const, lens: prev, rule: input.rule }
      const target = input.facet ? findFacet(prev, input.facet) : undefined
      if (input.facet && !target) return { status: "unknown-facet" as const, lens: prev, facet: input.facet.trim() }
      if (!victim && !target) return { status: "unknown-rule" as const, lens: prev, rule: "" }

      const owning = target ?? prev.facets.find((t) => t.id === victim!.facet)
      if (consentNeeded(actor, prev, owning)) return { status: "needs-consent" as const, lens: prev, facet: owning }

      const removedRules = target ? prevRules.filter((r) => r.facet === target.id) : [victim!]
      // The survivors keep their colours; the removed facet's slot is free for the next mint.
      const facets = target ? prev.facets.filter((t) => t.id !== target.id) : prev.facets
      const removedIds = new Set(removedRules.map((r) => r.id))
      const rules = prevRules.filter((r) => !removedIds.has(r.id))

      const next: Lens = { ...prev, facets, rules: rules.length ? rules : undefined }
      project[id] = next
      const written = yield* writeDoc(lensesFile(directory), project)
      if (written)
        yield* ApertureLensHistory.append(
          directory,
          target
            ? [
                {
                  op: "facet.remove",
                  actor,
                  lens: ref(next),
                  facet: target.id,
                  before: { facet: target, rules: removedRules },
                },
              ]
            : removedRules.map((rule) => ({
                op: "rule.remove" as const,
                actor,
                lens: ref(next),
                facet: rule.facet,
                rule: rule.id,
                before: { rule },
              })),
        )
      return {
        status: "ok" as const,
        lens: next,
        removedRules,
        ...(target ? { removedFacet: target } : {}),
        written,
      }
    }),
  )

export interface UpdateInput {
  readonly name?: string
  readonly description?: string
  readonly palette?: PaletteId
  // Relabel existing facets, rewrite their why, or correct their what, by id or label. Facets are added and removed only by
  // mark/unmark, which is what keeps every facet backed by at least one rule.
  readonly facets?: ReadonlyArray<{
    readonly ref: string
    readonly label?: string
    readonly what?: string
    readonly why?: string
  }>
}

export type UpdateResult =
  | { readonly status: "ok"; readonly lens: Lens; readonly written: boolean }
  | Refusal
  | { readonly status: "unknown-facet"; readonly lens: Lens; readonly facet: string }
  | Unjustified

// Edit a Lens's metadata in place: its name, description and palette, and its facets' labels,
// whats and whys. Nothing here changes what any rule matches, so no hit is re-derived.
export const update = (directory: string, id: string, input: UpdateInput, actor: Actor): Effect.Effect<UpdateResult> =>
  withDoc(
    directory,
    Effect.gen(function* () {
      const project = yield* readProject(directory)
      const prev = project[id]
      if (!prev) return { status: "not-found" as const }

      const edits = (input.facets ?? []).map((edit) => ({ edit, facet: findFacet(prev, edit.ref) }))
      const unknown = edits.find((e) => !e.facet)
      if (unknown) return { status: "unknown-facet" as const, lens: prev, facet: unknown.edit.ref }
      const lensEdited = input.name !== undefined || input.description !== undefined || input.palette !== undefined
      // Renaming a user's Lens is as much a change to it as editing one of its facets.
      const needsConsent = lensEdited
        ? consentNeeded(actor, prev)
        : edits.some((e) => consentNeeded(actor, prev, e.facet))
      if (needsConsent) return { status: "needs-consent" as const, lens: prev }

      const revisions = edits.map((e) => ({ before: e.facet!, ...revise(e.facet!, e.edit) }))
      const offending = revisions
        .map((r) => ({ facet: r.before.id, fields: unjustified(actor, r.fields) }))
        .find((r) => r.fields.length)
      if (offending) return { status: "needs-justification" as const, ...offending }
      const byId = new Map(revisions.map((r) => [r.before.id, r.facet]))
      const palette = input.palette ?? prev.palette
      const facets = repaletteColors(
        prev.palette,
        palette,
        prev.facets.map((t) => byId.get(t.id) ?? t),
      )
      const next: Lens = {
        ...prev,
        name: input.name?.trim() || prev.name,
        description: input.description ?? prev.description,
        palette,
        facets,
      }
      project[id] = next
      const written = yield* writeDoc(lensesFile(directory), project)
      if (written)
        yield* ApertureLensHistory.append(directory, [
          ...(lensEdited
            ? [
                {
                  op: "lens.edit" as const,
                  actor,
                  lens: ref(next),
                  before: { lens: pickLens(prev) },
                  after: { lens: pickLens(next) },
                },
              ]
            : []),
          ...revisions
            .filter((r) => r.fields.length)
            .map((r) => facetEdit(actor, next, r.before, facets.find((t) => t.id === r.before.id)!, r.fields)),
        ])
      return { status: "ok" as const, lens: next, written }
    }),
  )

export type RemoveResult = { readonly status: "ok"; readonly lens: Lens; readonly written: boolean } | Refusal

// Remove a Lens. The caller resets the active pointer if it was the active one.
export const remove = (directory: string, id: string, actor: Actor): Effect.Effect<RemoveResult> =>
  withDoc(
    directory,
    Effect.gen(function* () {
      const project = yield* readProject(directory)
      const prev = project[id]
      if (!prev) return { status: "not-found" as const }
      if (consentNeeded(actor, prev)) return { status: "needs-consent" as const, lens: prev }
      delete project[id]
      const written = yield* writeDoc(lensesFile(directory), project)
      if (written)
        yield* ApertureLensHistory.append(directory, [
          {
            op: "lens.delete",
            actor,
            lens: ref(prev),
            before: { lens: pickLens(prev) },
          },
        ])
      return { status: "ok" as const, lens: prev, written }
    }),
  )

export * as ApertureLensStore from "./lens-store"
