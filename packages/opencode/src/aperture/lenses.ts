// *Lenses* for the Aperture semantic layer. A Lens is a named vocabulary of
// semantic *facets* (each with a definition + a colour) plus the prompt handed to
// the painter agent. The architectural-layer vocabulary in `semantics.ts` is now
// just one built-in, globally-defined Lens (`ARCHITECTURE`); users can define their
// own per-project Lenses via the `/lens` flow.
//
// Deliberately dependency-free (no Effect/Schema/crypto) so it is safe to import
// from both the server-side painter/payload and the TUI renderer without dragging
// server code into the TUI bundle. Durable storage + id minting live in
// `lens-store.ts`; this file is pure data + pure helpers.

import { LAYERS, LAYER_LABEL, LAYER_DESCRIPTION, LAYER_HUE } from "./semantics"

// A single semantic facet within a Lens. `color` is always a literal hex string
// (`#RRGGBB`), including for the built-in architecture Lens and the two greys —
// see the note on PALETTES for why no facet colour is a theme-role key any more.
// The renderer's `resolveColor` still accepts both, so the painting path is uniform.
export interface Facet {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly color: string
  // Set when this facet is defined by *rules* rather than by the painter — i.e. it was
  // minted by `lens_mark` (S2). The distinction is not cosmetic: a rule-owned facet is
  // excluded from `facetEnumIds`/`buildSystemPrompt`, so the painter's vocabulary is
  // literally unchanged by minting one. That is what makes marking a concern onto an
  // *Overview* Lens free — `lens_edit`'s `structural` flag (which wipes both facet stores
  // for the Lens and every descendant, i.e. a whole-repo repaint) is not owed, because no
  // already-painted file was classified without an option it should have had. It also stops
  // the painter assigning "any-casts" to a file by judgement, which would quietly break the
  // rule's meaning: a rule-owned facet appears exactly where its rules match, nowhere else.
  //
  // It IS in the legend, the palette and O4's filter set — the user must see and be able to
  // filter it like any other facet.
  readonly ruleOnly?: true
}

export type LensScope = "global" | "project"

// A built-in Lens whose facets are computed *deterministically* from the repo
// (git state / filesystem mtime) instead of by the LLM painter. The server branches on
// this in `finalize` to synthesize the facet store directly; the painter and background
// sweep are skipped entirely (no tokens, always fresh). Absent on every semantic
// Lens (architecture + all user Lenses).
export type DeterministicKind = "git-changed" | "mtime-buckets" | "bus-factor"

// A *drill-down* Lens's scope: the parent Lens it refines, plus the subset of that
// parent's facets whose files form this Lens's domain. The painter only ever classifies
// in-domain files; every other file in the repo is bucketed into NONE_FACET
// deterministically (no model call), so a drill-down can never confusingly include a file
// that wasn't in the facet it drilled into. `facets` may name NONE_FACET — "show me what
// the parent Lens *didn't* cover" is a legitimate drill-down.
export interface LensParent {
  readonly lens: string
  readonly facets: ReadonlyArray<string>
}

// How deep a drill-down chain may go (a root Lens is depth 0). Each level costs the
// painter another gate pass per batch (an unpainted ancestor must be filled before the
// child can be placed), so the chain is capped rather than unbounded.
export const MAX_LENS_DEPTH = 3

// --- search rules (S1) ------------------------------------------------------

// A *finder*: the persisted half of a line-level facet assignment. The key move (S0) is
// that a line tag is NOT a location — it is a query. Nothing about a hit is stored; the
// finder is stored and the lines are re-derived from disk at every payload read, exactly
// as `extentsOf` re-cuts a file's extents. So a deleted usage silently loses its paint and
// a new one gains it, with no anchoring, no edit-tracking and no "lost" state to render.
//
// Three kinds, and none subsumes the others:
//   pattern    — a ripgrep regex. Language-agnostic (config, YAML, markup), over-matches
//                comments and strings. Span = the matched line.
//   symbol     — a top-level declaration by NAME, via extentsOf's column-0 regex. Coarse
//                (the whole declaration) but *idiom-blind*: it finds `paintStale` whether
//                it is a const-arrow, a generator or a declaration, because it never looks
//                at the right-hand side. This repo is Effect-shaped — aperture.ts has 265
//                callables and only 8 `function_declaration` nodes — so the obvious
//                structural pattern for "all the functions" silently finds 3% of them.
//   structural — an ast-grep pattern. Precise and exact-ranged, but requires knowing the
//                idiom. (Backend lands in S1b; until then it reports rather than paints.)
//
// There is deliberately no `span` field. Widening a point hit to its enclosing region was
// measured against this repo and rejected: `extentsOf`'s next-declaration arithmetic
// over-painted 87×, and even the smallest enclosing structural callable over-painted 8.7×.
// Each finder instead *chooses its own extent* — match a `catch` clause and you paint the
// clause, match a call and you paint the call.
export type Finder =
  | {
      readonly kind: "pattern"
      readonly pattern: string
      readonly glob?: ReadonlyArray<string>
      readonly caseSensitive?: boolean
    }
  | { readonly kind: "symbol"; readonly name: string; readonly path?: string }
  | {
      readonly kind: "structural"
      readonly pattern: string
      readonly language: string
      readonly glob?: ReadonlyArray<string>
    }

export interface Rule {
  readonly id: string
  // A facet id on THIS Lens. Rules are orthogonal to `search`: every Lens has facets, so a
  // rule can contribute to an Overview Lens too.
  readonly facet: string
  readonly find: Finder
  // The authoring agent's reason. Shown on hover; never re-evaluated. This is what carries
  // the judgement a rule-only model otherwise can't express ("this is the retry path"),
  // pinned to a declaration the finder *can* name.
  readonly note?: string
  // Agent name, for the study log — the evidence for whether widening the tool injection to
  // Explore actually changed authoring behaviour.
  readonly createdBy?: string
}

// A Search Lens is meant to be *sparse*, and the failure mode is a loose regex silently
// painting a third of the repo. Over the hit cap a rule is stored and reported as too broad
// rather than painted, so the agent (or the user reading lenses.json) can see and narrow it.
//
// The caps and the error paths are kept in full despite this being a research prototype —
// the opposite of the usual prototype trade. A flooded view or a crashed pass during an
// unattended participant session is a lost session, not a bug report.
export const MAX_RULES = 32
export const MAX_RULE_HITS = 500

// Whether a Lens renders as a *probe* (hit density, sparse gutter) rather than as a
// partition of the codebase. Rendering policy only — it says nothing about where the facets
// come from, which is why it is a separate field from `rules`. Deliberately the same shape
// as `isDeterministic` below, whose `deterministic?: DeterministicKind` idiom already
// delivers everything a distinct Lens *type* was wanted for: a different paint policy,
// different persistence, picker grouping and a wire flag — without forking lens
// list/select/cycle/edit, the legend or the O4 filter.
export function isSearch(lens: Pick<Lens, "search">): boolean {
  return lens.search === true
}

// Does the LLM painter own this Lens's facets? False for the deterministic built-ins
// (computed from git/mtime) and for a Search Lens (computed from rules) — the two ways a
// Lens gets its colour without spending a token.
//
// This is the predicate every painter *gate* asks, and it exists as one function because the
// alternative is what shipped: eleven sites each testing `isDeterministic` and therefore
// each an independent chance to miss the new case. `isSearch` was added in S1 as a wire flag
// with no gate behind it, so before S2 an active Search Lens would have triggered a
// whole-repo model sweep to classify every file into a vocabulary that means nothing.
//
// Keep using `isDeterministic`/`isSearch` directly where the branch cares *which*
// alternative source it is (git hunks vs rule hits); use this only for "should the model
// run".
export function usesPainter(lens: Pick<Lens, "deterministic" | "search">): boolean {
  return !isDeterministic(lens) && !isSearch(lens)
}

// Shape predicate for a stored finder. Total and pure: `lenses.json` is hand-editable and
// committable, so a malformed entry must be *droppable* rather than throwing — the same
// posture that makes `orderForest` cycle-safe.
//
// Shape only. Whether the regex compiles, the ast-grep pattern parses, or the rule matched
// 4,000 lines are all the evaluator's questions, because those need to be *reported* back
// to the agent and the store has nowhere to report.
export function isValidFinder(value: unknown): value is Finder {
  return finderProblem(value) === undefined
}

// Why a finder is unusable, as prose that names the fix — or `undefined` when it is
// well-formed. `isValidFinder` delegates here so the guard and the message can never drift.
//
// The message matters as much as the verdict, and that is a consequence of how `lens_mark`
// takes its parameters. A `Schema.Union` over the three finder kinds would reject a
// malformed one during *decode*, upstream of the tool's `execute`, where the harness turns it
// into `InvalidArgumentsError`'s generic "Please rewrite the input so it satisfies the
// expected schema" — uninterceptable and telling the agent nothing. So the tool takes a flat
// struct and validates here instead, where "you gave kind:symbol a pattern" can be said out
// loud. Same reason the store can't do this job: it has nowhere to report to.
export function finderProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "the finder must be an object"
  const find = value as Record<string, unknown>
  const nonEmpty = (key: string) => typeof find[key] === "string" && (find[key] as string).length > 0
  const globProblem = () =>
    find["glob"] !== undefined &&
    !(Array.isArray(find["glob"]) && (find["glob"] as unknown[]).every((g) => typeof g === "string"))
      ? '"glob" must be an array of strings, e.g. ["packages/*/src/**/*.ts"]'
      : undefined
  switch (find["kind"]) {
    case "pattern":
      if (!nonEmpty("pattern")) return 'kind "pattern" needs a non-empty "pattern" (a ripgrep/rust-regex)'
      return globProblem()
    case "symbol":
      if (!nonEmpty("name"))
        return 'kind "symbol" needs a non-empty "name" — the exact top-level declaration name. For a regex, use kind "pattern" instead'
      if (find["path"] !== undefined && typeof find["path"] !== "string")
        return '"path" must be a string (a repo-relative file or directory prefix)'
      return undefined
    case "structural":
      if (!nonEmpty("pattern")) return 'kind "structural" needs a non-empty "pattern" (an ast-grep pattern)'
      if (!nonEmpty("language")) return 'kind "structural" needs a "language", e.g. "ts", "tsx", "js", "py"'
      return globProblem()
    default:
      return `"kind" must be "pattern", "symbol" or "structural"${
        typeof find["kind"] === "string" ? `; you passed "${find["kind"]}"` : ""
      }`
  }
}

export interface Lens {
  readonly id: string
  readonly name: string
  readonly description: string
  // The palette user Lenses draw from. Absent for the built-in architecture
  // Lens, which carries its own fixed slice of the same colours.
  readonly palette?: PaletteId
  // The role/instruction sentence(s) prepended to the generated painter system
  // prompt (the facet list + echo instructions are appended by `buildSystemPrompt`).
  readonly prompt: string
  readonly facets: ReadonlyArray<Facet>
  readonly scope: LensScope
  // Optional repo-relative directories the `/lens` flow surfaced as most relevant.
  // The background painter front-loads files under these (in DFS order) before the
  // rest of the repo, so the targeted area lights up first — it never *restricts*
  // the sweep, which always covers the whole repo.
  readonly directories?: ReadonlyArray<string>
  // Present only on the deterministic built-ins (see DeterministicKind). When set, the
  // server computes this Lens's facets from the repo rather than running the painter.
  readonly deterministic?: DeterministicKind
  // How much per-file context the painter sends the model for THIS Lens (painter.ts
  // `describe`). "minimal" (default, absent) = path + imports + leading comment — enough
  // to place a file by what it *is*. "medium" additionally sends a cheap structural
  // skeleton (exported names, file line count, and each top-level declaration's signature
  // + length) so a Lens that needs to judge the *shape* of the code — e.g. "code smells",
  // "god files", complexity — has real signal without ever shipping a function body. Opt
  // into "medium" only when the facets genuinely require it; it costs more input tokens
  // per file. A global config override (aperture.painter.context) can force one mode across
  // all Lenses for experimentation.
  readonly context?: "minimal" | "medium"
  // Present only on a *drill-down* Lens: the parent Lens + the subset of its facets this
  // Lens is scoped to (see LensParent). Absent on every root Lens, including all built-ins.
  readonly parent?: LensParent
  // Persisted line-level finders (S1). Lives on the Lens rather than in a store of its own
  // because a rule is small, hand-authored, readable, diffable, committable and shareable —
  // and because the rule is the thing worth keeping: its *hits* are free to regenerate.
  readonly rules?: ReadonlyArray<Rule>
  // Renders as a probe rather than a partition (see isSearch). Orthogonal to `rules`.
  readonly search?: true
}

// --- palettes --------------------------------------------------------------

// There are exactly two palettes, and they are the *same six colours* in two orders.
// CATEGORICAL gives each facet a maximally distinct hue for unordered categories;
// ORDINAL runs the identical set as a cool→warm ramp so a facet's colour encodes its
// rank (few→many, old→new, low→high). Six colours caps a Lens at MAX_FACETS facets.
//
// One set, not seven, because hue *is* the encoding and it has to mean the same thing on
// every surface — the TUI legend, the VSCode gutter, the Explorer pips, the tree chips.
// Every extra palette was another chance for two colours to collide (the old `pastel` had
// two that were literally identical in a 256-colour terminal) and another 6 hexes for the
// extension to mirror. See the note below PALETTES for the rule that keeps this honest.
export type PaletteId = "categorical" | "ordinal"

export const MAX_FACETS = 6

// Universal escape facet the model may assign to a file that fits none of a
// Lens's facets (so a single-facet Lens greys the rest of the repo instead
// of force-fitting every file). It is *not* a user-defined facet — it never appears in
// `lens.facets`/the legend and draws no palette colour — but it IS stored (with a
// content hash) so those files aren't re-painted every sweep. The two greys below let
// the renderer tell it apart from genuinely unpainted/non-code files.
export const NONE_FACET = "none"
// "Other — not this Lens" (code the painter judged unrelated). Deliberately the more
// *visible* grey since it's meaningful context you may still want to read. Literal hex
// (xterm-256 grey-ramp idx 245), not a theme role: these two were the worst offenders for
// cross-surface drift — the TUI resolved them against the opencode theme while VSCode
// collapsed *both* onto `descriptionForeground`, so "Other" and "Non-code" were the same
// colour in the gutter and different in the TUI.
//
// Note this is #8A8A8A and not the obvious mid-grey #808080. #808080 appears *twice* in the
// xterm-256 table — grey-ramp idx 244 and system idx 8 — and a quantiser picking the lower
// index lands it in the system range, which is precisely the range a terminal colour theme
// overrides (Solarized paints idx 8 a slate blue). "Other" would then not be grey at all,
// and would not match VSCode. One ramp step up is unambiguous, and happens to sit further
// from UNTAGGED_HUE as well (ΔE 26.4 rather than 22.1).
export const NONE_HUE = "#8A8A8A"
export const NONE_LABEL = "Other"
// Genuinely unpainted / non-code (no store entry — specs, assets, not-yet-swept). The
// dimmer grey so it recedes furthest behind the feature you're exploring (ramp idx 238).
export const UNTAGGED_HUE = "#444444"
export const UNTAGGED_LABEL = "Non-code"

export interface Palette {
  readonly id: PaletteId
  readonly label: string
  // "categorical" — distinct hues for unordered facets; "ordinal" — a cool→warm ramp whose
  // position encodes rank, for facet sets with a natural order. The Lens designer picks a
  // kind to match its facets (see the palette guidance in prompt/lens.txt).
  readonly kind: "categorical" | "ordinal"
  readonly colors: ReadonlyArray<string>
}

// THE RULE: every colour Aperture can ever paint — these six, both greys, and every
// built-in ramp entry below — must be an *exact* xterm-256 palette entry. Cube cells have
// all three channels drawn from {0,95,135,175,215,255}; grey-ramp cells are 8+10k.
//
// Why exactness and not merely "distinct enough": a non-truecolor terminal quantises our
// RGB to its nearest palette entry, and a colour that already *is* an entry quantises to
// itself — distance zero. So the colour a 256-colour terminal shows is bit-identical to
// the colour a truecolor terminal shows, which is bit-identical to the hex VSCode paints
// in the gutter, the Explorer pip and the tree chip. Hue means one thing everywhere, with
// no capability detection and nothing to reconcile at render time.
//
// It also makes the terminal's own colour theme irrelevant. OpenTUI queries only indices
// 0-15 over OSC 4 (NATIVE_PALETTE_QUERY_SIZE = 16) and fills 16-255 from the standard cube
// regardless, so a Solarized/Nord/Dracula user only ever perturbs the 16 system slots —
// and an exact cube cell is at distance 0 from itself, which no perturbed slot can beat.
//
// The old rule ("don't land on the grey ramp") was too weak: it checked each colour against
// grey but never against the *other five*, and `pastel`'s #F7C8A0 and #F5E1A4 both
// quantised to idx 223 — the same colour, on any 256-colour terminal. That was the hue
// collapse participants reported. lenses.test.ts now guards exactness *and* a minimum
// pairwise CIEDE2000 across the palette plus both greys.
//
// Changing a colour here means re-running `bun sdks/aperture-vscode/script/gen-colors.ts`.
const CATEGORICAL = [
  "#D7005F", // 161 crimson
  "#AF5F00", // 130 amber
  "#AFAF00", // 142 chartreuse
  "#00875F", //  29 emerald
  "#00AFD7", //  38 cyan
  "#5F5FD7", //  62 indigo
] as const

// The six hues by name, so a tool can hand an agent a word the user can act on ("the
// crimson lines") instead of a hex it would have to describe itself. Keyed by exact hex, so
// it covers both palettes — they are the same six colours in two orders. The two greys are
// included because NONE_FACET is a real, reportable facet value.
export const COLOR_NAMES: Record<string, string> = {
  "#D7005F": "crimson",
  "#AF5F00": "amber",
  "#AFAF00": "chartreuse",
  "#00875F": "emerald",
  "#00AFD7": "cyan",
  "#5F5FD7": "indigo",
  [NONE_HUE]: "grey",
  [UNTAGGED_HUE]: "dark grey",
}

export const PALETTES: Record<PaletteId, Palette> = {
  // Min pairwise CIEDE2000 among the six = 32.3, and ≥24.5 from either grey. Chosen by
  // max-min dispersion search over the 216 cube cells, constrained to L* 45-75 and C* 30-75
  // so no colour is so dark it reads as background or so pale it reads as the "Other" grey.
  categorical: {
    id: "categorical",
    label: "Categorical",
    kind: "categorical",
    colors: [...CATEGORICAL],
  },
  // The same six reversed: Lab hue rotates monotonically 299° → 233° → 163° → 103° → 64° → 8°,
  // a clean cool→warm ramp, so a facet's *position* in the ramp reads as its rank. Sharing
  // the categorical set keeps the whole product down to eight hexes, which is what lets the
  // VSCode extension contribute one colour id per hue instead of approximating.
  ordinal: {
    id: "ordinal",
    label: "Ordinal (ranked)",
    kind: "ordinal",
    colors: [...CATEGORICAL].reverse(),
  },
}

// The ids of the ordinal (ranked) palettes — the Lens designer picks one of these only when
// a Lens's facets have a natural order. The rest are categorical.
export const ORDINAL_PALETTE_IDS = (Object.values(PALETTES) as Palette[])
  .filter((p) => p.kind === "ordinal")
  .map((p) => p.id)

export const PALETTE_IDS = Object.keys(PALETTES) as PaletteId[]

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && value in PALETTES
}

// Pair each facet with the palette colour at its index. Facets beyond the palette
// length wrap (callers should enforce MAX_FACETS, but wrapping keeps it total).
export function assignColors(palette: PaletteId, facets: ReadonlyArray<Omit<Facet, "color">>): Facet[] {
  const colors = PALETTES[palette].colors
  return facets.map((facet, i) => ({ ...facet, color: colors[i % colors.length]! }))
}

// --- built-in architecture Lens --------------------------------------

export const ARCHITECTURE_ID = "architecture"

// The original architectural-layer vocabulary, expressed as a Lens. Its facet ids are the
// layer names and its colours are five of the six categorical palette hues (LAYER_HUE) —
// literal hex like every other Lens, so it renders the same in the TUI and in VSCode.
// Global scope: shared across projects and the base we extend default schemas from later.
export const ARCHITECTURE: Lens = {
  id: ARCHITECTURE_ID,
  name: "Architectural layer",
  description:
    "Classifies each file by its architectural layer (interface, application, domain, data, infrastructure).",
  prompt: "You classify each source file by its architectural layer in a codebase.",
  scope: "global",
  facets: LAYERS.map((layer) => ({
    id: layer,
    label: LAYER_LABEL[layer],
    description: LAYER_DESCRIPTION[layer],
    color: LAYER_HUE[layer],
  })),
}

// --- built-in deterministic Lenses ------------------------------------

// "Changed since last commit": painted from `git status` + `git diff --numstat` rather
// than the model. A changed file (any working-tree change git reports — modified, staged,
// OR untracked/new) is bucketed by its *magnitude* of change — total lines added + deleted
// vs HEAD (a new file counts its whole size) — into five bands; everything else is
// "unchanged" and recedes to a muted theme grey so the changes pop.
export const GIT_CHANGED_ID = "git-changed"

// Change-magnitude buckets, smallest→largest, naming each band's lower bound (change-1 =
// 1–9 lines, and also the home of a 0-churn change like a mode-only edit). The single
// source of truth for the index↔id mapping shared with the deterministic compute. Five
// bands + "unchanged" = MAX_FACETS facets exactly.
export const CHANGE_FACET_IDS = ["change-1", "change-10", "change-25", "change-50", "change-100"] as const
// Upper edges of the first four buckets; a churn below edge `i` lands in bucket `i`, and
// anything at/above the last edge lands in the final (100+) bucket.
const CHANGE_EDGES = [10, 25, 50, 100] as const
// Heat ramp, cold→hot as the change grows, so magnitude reads as temperature. Taken as the
// warm five sixths of the ordinal palette rather than invented: keeping every ramp inside
// the one eight-colour universe is what lets the VSCode extension contribute a colour id
// per hue (see the PALETTES note), and it can't drift from the palette it's sliced from.
const CHANGE_COLORS = PALETTES.ordinal.colors.slice(1) as ReadonlyArray<string>
const CHANGE_LABELS = ["< 10 lines", "10–24 lines", "25–49 lines", "50–99 lines", "100+ lines"] as const

// Bucket a changed file's line churn (additions + deletions vs HEAD) into a CHANGE_FACET_IDS
// index. Pure + total: churn 0 (e.g. a mode-only change) falls into the smallest band.
export function changeBucketIndex(lines: number): number {
  for (let i = 0; i < CHANGE_EDGES.length; i++) if (lines < CHANGE_EDGES[i]!) return i
  return CHANGE_EDGES.length
}

export const GIT_CHANGED: Lens = {
  id: GIT_CHANGED_ID,
  name: "Changed since last commit",
  description:
    "Buckets files with uncommitted changes by how many lines changed (few = pale, many = hot); the rest recede.",
  prompt: "",
  scope: "global",
  deterministic: "git-changed",
  facets: [
    ...CHANGE_FACET_IDS.map((id, i) => ({
      id,
      label: CHANGE_LABELS[i]!,
      description: `File has ${CHANGE_LABELS[i]!.toLowerCase()} of uncommitted working-tree changes.`,
      color: CHANGE_COLORS[i]!,
    })),
    { id: "unchanged", label: "Unchanged", description: "File matches the last commit.", color: NONE_HUE },
  ],
}

// "Edit recency": six ordinal buckets by local filesystem mtime, split into equal time
// spans across the repo's oldest→newest range. Ordered oldest (index 0) → newest, with a
// cool→warm spectrum so the most recently edited files glow warm (red) — a heat map of
// where work is happening. Equal spans (not quantiles) is deliberate: when most files
// share a checkout mtime, the bulk all land in bucket 0 (one colour) and only recent
// edits climb into the warm end.
export const MTIME_RECENCY_ID = "edit-recency"

// Facet ids in oldest→newest order; the single source of truth for index↔id mapping shared
// with the deterministic compute. Colours run cool→warm so newest = red — this heat-map ramp
// IS the shared ordinal palette (kept in one place so the two can't drift).
export const RECENCY_FACET_IDS = ["recency-0", "recency-1", "recency-2", "recency-3", "recency-4", "recency-5"] as const
const RECENCY_COLORS = PALETTES.ordinal.colors
const RECENCY_LABELS = ["Oldest", "Older", "Mid-age", "Recent", "Newer", "Newest"] as const

export const MTIME_RECENCY: Lens = {
  id: MTIME_RECENCY_ID,
  name: "Edit recency",
  description: "Buckets files into six bands by last local edit time, oldest (cool) to newest (warm).",
  prompt: "",
  scope: "global",
  deterministic: "mtime-buckets",
  facets: RECENCY_FACET_IDS.map((id, i) => ({
    id,
    label: RECENCY_LABELS[i]!,
    description: `Edit-time band ${i + 1} of ${RECENCY_FACET_IDS.length} (${RECENCY_LABELS[i]!.toLowerCase()}).`,
    color: RECENCY_COLORS[i]!,
  })),
}

// Map a file's mtime to a bucket index over the [min, max] range, split into `count`
// equal time spans. Pure + total: a degenerate range (max <= min, e.g. every file shares
// one mtime, or a single file) collapses to bucket 0, which is exactly the "everything is
// one colour" case. The top edge (mtime === max) clamps into the last bucket.
export function bucketIndex(mtime: number, min: number, max: number, count = RECENCY_FACET_IDS.length): number {
  if (max <= min) return 0
  return Math.min(count - 1, Math.floor(((mtime - min) / (max - min)) * count))
}

// --- built-in bus-factor Lens -----------------------------------------

// "Bus factor": a knowledge-silo heat map. Each file is bucketed by how many distinct
// *significant* authors have ever touched it in git history (mailmap-normalised author,
// not committer/pusher), so warm = few owners = high risk if they leave. Deterministic —
// computed from `git log --numstat` in the server, no model call. Files with no history
// (untracked/new) fall to the universal NONE_FACET grey. Colours run warm→cool so a
// single-author file glows red. Availability-gated to a git work tree (like git-changed).
export const BUS_FACTOR_ID = "bus-factor"

// Facet ids in fewest→most-authors order (the single source of truth for the index↔id
// mapping shared with the deterministic compute). Note the ids are not contiguous: they
// name the *lower bound* of each bucket (bus-3 covers 3–4, bus-5 covers 5+).
export const BUS_FACTOR_FACET_IDS = ["bus-1", "bus-2", "bus-3", "bus-5"] as const
// Warm→cool, so a single-author file glows and a well-shared one recedes. Four picks out of
// the six-step ordinal ramp (crimson, amber, emerald, cyan) rather than four fresh hexes —
// same reason as CHANGE_COLORS: one closed colour universe across every Lens.
const BUS_FACTOR_COLORS = [5, 4, 2, 1].map((i) => PALETTES.ordinal.colors[i]!)
const BUS_FACTOR_LABELS = ["1 author", "2 authors", "3–4 authors", "5+ authors"] as const
const BUS_FACTOR_DESCRIPTIONS = [
  "Only one author has ever touched this file — highest bus-factor risk.",
  "Two authors have touched this file.",
  "Three or four authors have touched this file.",
  "Five or more authors have touched this file — knowledge is well spread.",
] as const

export const BUS_FACTOR: Lens = {
  id: BUS_FACTOR_ID,
  name: "Bus factor",
  description: "Buckets files by how many distinct authors have ever touched them (few = warm = risk).",
  prompt: "",
  scope: "global",
  deterministic: "bus-factor",
  facets: BUS_FACTOR_FACET_IDS.map((id, i) => ({
    id,
    label: BUS_FACTOR_LABELS[i]!,
    description: BUS_FACTOR_DESCRIPTIONS[i]!,
    color: BUS_FACTOR_COLORS[i]!,
  })),
}

// All built-in (globally-defined) Lenses — the protected group. Built-ins are
// immutable: they cannot be edited, have their facets merged, or be deleted (the
// create/edit/merge/delete flows and the UI all refuse them via `isBuiltinLens`
// / `BUILTIN_LENS_IDS`). They inherit that protection automatically from their
// global scope — no other code needs to change to add one. The two deterministic ones
// additionally carry a `deterministic` kind so the server paints them without the painter.
export const BUILTIN_LENSES: ReadonlyArray<Lens> = [ARCHITECTURE, GIT_CHANGED, MTIME_RECENCY, BUS_FACTOR]

// The ids of the protected built-in group — for callers that only have an id (e.g. the
// renderer deciding whether to show a delete control).
export const BUILTIN_LENS_IDS: ReadonlySet<string> = new Set(BUILTIN_LENSES.map((c) => c.id))

// Whether a Lens belongs to the protected built-in group. Built-ins carry global
// scope (the marker every BUILTIN_LENSES member sets); user Lenses are always
// "project". This is the single source of truth for "is this Lens immutable?".
export function isBuiltinLens(lens: Pick<Lens, "scope">): boolean {
  return lens.scope === "global"
}

// Whether a Lens's facets are computed deterministically from the repo (git/mtime)
// rather than by the painter. Drives the server's `finalize` branch and lets the
// background sweep skip these Lenses entirely.
export function isDeterministic(lens: Pick<Lens, "deterministic">): boolean {
  return lens.deterministic !== undefined
}

// Whether a Lens's painted view depends on LIVE repo state (git status / filesystem
// membership) rather than only on the persisted facet store: it is either deterministic
// itself, or it drills into a chain that bottoms out in a deterministic Lens. A drill-down
// is never `deterministic` itself — it is painted by the model — but its domain gate reads
// its parent's store, and for a deterministic parent that store is recomputed from the repo
// on every pass (see witnessStoreFor). So the caches feeding that computation must be
// dropped before a fetch for such a child too, or it paints against a git state that has
// moved on (e.g. an out-of-band `git commit`, which fires no file event).
//
// Cycle-safe and total, like orderForest: `lenses.json` is committable and hand-editable, so
// a missing parent or a hand-written loop must never hang this. Broken ancestry stops the
// walk and reports what was found so far — which is also the fail-safe direction, since such
// a Lens can't paint a domain anyway.
export function dependsOnDeterministic(lens: Lens, byId: ReadonlyMap<string, Lens>): boolean {
  const seen = new Set([lens.id])
  let cur: Lens = lens
  let depth = 0
  while (true) {
    if (isDeterministic(cur)) return true
    if (!cur.parent || ++depth > MAX_LENS_DEPTH) return false
    const up = byId.get(cur.parent.lens)
    if (!up || seen.has(up.id)) return false
    seen.add(up.id)
    cur = up
  }
}

// --- drill-down hierarchy ---------------------------------------------------

export interface ForestEntry {
  readonly lens: Lens
  readonly depth: number
  // The scope of the entry's *root* ancestor, not its own: a project drill-down of a
  // built-in parent must group with that parent in the picker, or it gets torn out of the
  // DFS order into a different section and rendered indented under nothing.
  readonly rootScope: LensScope
}

// Order Lenses as a DFS forest: every Lens immediately followed by the drill-downs scoped
// to it, so the picker and the ◀ ▶ cycle both walk parent → children.
//
// Total and cycle-safe. `lenses.json` is committable and hand-editable, so a Lens whose
// parent is missing, loops, or exceeds MAX_LENS_DEPTH is emitted as a *root* rather than
// dropped or recursed into — it stays visible so it can still be inspected and deleted, and
// a hand-written cycle can never hang this. (Hiding an unusable Lens is `listAvailable`'s
// job; this function must never lose one.)
export function orderForest(lenses: ReadonlyArray<Lens>): ForestEntry[] {
  const byId = new Map(lenses.map((l) => [l.id, l]))
  // Walk up to the root. undefined = broken ancestry (missing parent / cycle / too deep).
  const depthOf = (lens: Lens): number | undefined => {
    const seen = new Set([lens.id])
    let depth = 0
    let cur = lens
    while (cur.parent) {
      const up = byId.get(cur.parent.lens)
      if (!up || seen.has(up.id) || ++depth > MAX_LENS_DEPTH) return undefined
      seen.add(up.id)
      cur = up
    }
    return depth
  }

  const childrenOf = new Map<string, Lens[]>()
  const roots: Lens[] = []
  for (const lens of lenses) {
    const depth = depthOf(lens)
    if (lens.parent && depth !== undefined && depth > 0) {
      const siblings = childrenOf.get(lens.parent.lens) ?? []
      siblings.push(lens)
      childrenOf.set(lens.parent.lens, siblings)
      continue
    }
    roots.push(lens)
  }

  // Every child has a resolvable finite depth and exactly one parent, and the roots are
  // precisely the Lenses with no usable parent — so the child graph is a forest and this
  // terminates.
  const out: ForestEntry[] = []
  const walk = (lens: Lens, depth: number, rootScope: LensScope) => {
    out.push({ lens, depth, rootScope })
    for (const child of childrenOf.get(lens.id) ?? []) walk(child, depth + 1, rootScope)
  }
  for (const root of roots) walk(root, 0, root.scope)
  return out
}

// Whether a file falls inside a drill-down's domain, given the file's entry in the PARENT's
// facet store. `scope` is the drill-down's scoped parent-facet ids; `parentScope` is the
// *parent's own* scope, present only when the parent is itself a drill-down.
//
// The second clause is what upholds the invariant that a drill-down only ever reads its
// immediate parent's store. A parent's store greys two different populations into the same
// NONE_FACET — "outside my domain" and "inside it but fits none of my facets" — and a
// grandchild scoped to the parent's "Other" means only the second. Without `via` to tell
// them apart, that grandchild would silently re-admit every file its grandparent excluded.
// (Redundant, but harmless, when scoped to a real facet: those are never NONE_FACET.)
export function inDomain(
  entry: { readonly facet: string; readonly via?: string } | undefined,
  scope: ReadonlySet<string>,
  parentScope?: ReadonlySet<string>,
): boolean {
  if (!entry || !scope.has(entry.facet)) return false
  if (!parentScope) return true
  return entry.via !== undefined && parentScope.has(entry.via)
}

// The human labels of the parent facets a drill-down is scoped to (NONE_FACET reads as
// "Other"). Used in the painter's domain note and in the Lens listing.
export function scopeLabels(parent: Lens, facets: ReadonlyArray<string>): string[] {
  return facets.map((id) => (id === NONE_FACET ? NONE_LABEL : (parent.facets.find((f) => f.id === id)?.label ?? id)))
}

// --- helpers ---------------------------------------------------------------

export function isValidFacet(lens: Lens, id: unknown): id is string {
  return typeof id === "string" && lens.facets.some((t) => t.id === id)
}

// A facet the painter is allowed to store: one of the Lens's painter-owned facets or the
// universal NONE_FACET escape. Used to filter the model's structured output.
//
// Rule-owned facets are excluded here as well as from `facetEnumIds`. The enum should make
// one unreachable, but this is the write path — belt and braces is cheap, and a rule-owned
// facet landing in the painted store would put a concern's colour on files no rule matched.
export function isAssignableFacet(lens: Lens, id: unknown): id is string {
  return id === NONE_FACET || (isValidFacet(lens, id) && !lens.facets.find((t) => t.id === id)?.ruleOnly)
}

// The closed set of facet ids the model may echo back: the Lens's *painter-owned* facets
// plus the NONE_FACET escape. Drives the painter's structured-output enum.
//
// `ruleOnly` facets are excluded — they belong to their rules, and offering one to the
// painter would let it appear on files no rule matches. Excluding them here is also what
// makes minting one cost no repaint (see Facet.ruleOnly). A Search Lens has only rule-owned
// facets, so this returns just [NONE_FACET] for one — consistent with `usesPainter` gating
// its painter off entirely.
export function facetEnumIds(lens: Lens): [string, ...string[]] {
  // NONE_FACET first so the result types as a non-empty tuple; enum order is irrelevant.
  return [NONE_FACET, ...lens.facets.filter((t) => !t.ruleOnly).map((t) => t.id)]
}

// The facets the painter classifies into: everything except the rule-owned ones. Kept
// beside `facetEnumIds` so the two can't disagree about what the painter's vocabulary is.
export function paintedFacets(lens: Pick<Lens, "facets">): Facet[] {
  return lens.facets.filter((t) => !t.ruleOnly)
}

// One facet as an agent needs to see it: its id, its hue *by name*, and how many rules point
// at it. Used by `lens_mark`/`lens_unmark`, which ship the whole roster on every call (success
// or refusal), and by the build/plan system prompt, which injects it so the main agent knows
// which concerns already exist without a lens_list round trip.
//
// Shipping it everywhere is deliberate: the roster is what stops an agent minting
// `retry-path-2` beside `retry-path`, tells it how close it is to MAX_FACETS, and gives it a
// colour word to narrate to the user ("the crimson lines"). Deriving it here rather than in
// each caller is what keeps those three readings identical.
export interface ConcernSummary {
  readonly facet: string
  readonly label: string
  readonly color: string
  readonly colorName: string
  readonly ruleOnly: boolean
  readonly rules: number
}

// A finder as one readable line. Lives here so `lens_mark` (echoing back what it stored) and
// `lens_list` (showing what is already installed) cannot describe the same rule two ways —
// which matters because the agent compares the two to decide whether to reuse a concern.
export function describeFinder(find: Finder): string {
  switch (find.kind) {
    case "pattern":
      return (
        `pattern /${find.pattern}/` +
        (find.glob?.length ? ` glob ${find.glob.join(", ")}` : "") +
        (find.caseSensitive === false ? " (case-insensitive)" : "")
      )
    case "symbol":
      return `symbol ${find.name}` + (find.path ? ` in ${find.path}` : "")
    case "structural":
      return (
        `structural /${find.pattern}/ (${find.language})` + (find.glob?.length ? ` glob ${find.glob.join(", ")}` : "")
      )
  }
}

export function concernRoster(lens: Pick<Lens, "facets" | "rules">): ConcernSummary[] {
  const counts = new Map<string, number>()
  for (const rule of lens.rules ?? []) counts.set(rule.facet, (counts.get(rule.facet) ?? 0) + 1)
  return lens.facets.map((t) => ({
    facet: t.id,
    label: t.label,
    color: t.color,
    colorName: COLOR_NAMES[t.color] ?? t.color,
    ruleOnly: t.ruleOnly === true,
    rules: counts.get(t.id) ?? 0,
  }))
}

// The renderer's legend: ordered facet → label + colour. Drives both the swatch row
// and the facet→colour map used to paint nodes/composition, so the TUI needs no
// hard-coded vocabulary.
export interface LegendEntry {
  readonly facet: string
  readonly label: string
  readonly color: string
}

export function legend(lens: Lens): LegendEntry[] {
  return lens.facets.map((t) => ({ facet: t.id, label: t.label, color: t.color }))
}

// Narrow a set of facet ids to those this Lens actually paints with — its own facets plus
// NONE_FACET, which is a real stored value ("Other") even though it is never in the legend.
// Order and duplicates are dropped; the result is a set.
//
// This is the guard on the legend filter (O4). Facet ids are slugs, so two unrelated Lenses
// can easily share one ("core", "ui"): a filter left over from a previous vocabulary would
// sit inert until a Lens reusing that id came round, and then grey out something the user
// never turned off. Filtering the ids in — rather than trusting the caller — is what keeps
// a filter meaningful only in the Lens it was expressed against.
export function facetsWithin(lens: Lens, facets: ReadonlyArray<string>): Set<string> {
  const known = new Set([...lens.facets.map((t) => t.id), NONE_FACET])
  return new Set(facets.filter((f) => known.has(f)))
}

// System prompt handed to the painter model: the Lens's role sentence, the
// enumerated facet definitions, then the fixed echo/format instructions. Replaces the
// previously hard-coded architectural-layer prose so any Lens can paint.
//
// `parent` is the resolved parent Lens of a drill-down (pass it whenever `lens.parent` is
// set). It adds a note telling the model that the files it is being shown are *already*
// filtered to the parent's facets — the gate never sends it an out-of-domain file — so it
// classifies *within* that set instead of re-litigating the parent's judgement.
export function buildSystemPrompt(lens: Lens, parent?: Lens): string {
  const scope =
    lens.parent && parent
      ? [
          `Every file below already falls under ${scopeLabels(parent, lens.parent.facets)
            .map((l) => `"${l}"`)
            .join(
              ", ",
            )} of the "${parent.name}" Lens. That judgement is already made and files outside it are never shown to you, so do not re-apply or second-guess it — classify each file by which facet below it belongs to *within* that set.`,
        ]
      : []
  return [
    lens.prompt,
    ...scope,
    "Facets:",
    // Rule-owned facets are deliberately absent: the painter must not be able to assign one
    // (see Facet.ruleOnly). facetEnumIds applies the same filter to the output schema.
    ...paintedFacets(lens).map((t) => `- ${t.id}: ${t.description}`),
    `- ${NONE_FACET}: none of the above — the file is unrelated to every facet`,
    `Assign each source file exactly one facet, using "${NONE_FACET}" when it fits none rather than forcing a fit.`,
    lens.context === "medium"
      ? "Infer the facet from the file path, its imports, leading comment, exported names, and the declaration skeleton — the file's line count plus each top-level declaration's signature and length in lines (a proxy for the code's size and shape)."
      : "Infer the facet from the file path, its imports, and its leading comment.",
    "Return one entry per input file, echoing its exact path.",
  ].join("\n")
}

// Lowercase kebab slug for minting Lens ids from a user-supplied name.
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "lens"
  )
}

export * as ApertureLenses from "./lenses"
