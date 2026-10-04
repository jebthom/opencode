// *Lenses* for the Aperture view. A Lens is a named collection of *facets* — each a concern
// with a label, a what, a why and a colour — plus the *rules* that decide, deterministically,
// which lines of the repo carry each facet.
//
// v3 retired the LLM painter: every facet is rule-owned, so a Lens's paint is a pure function of
// its rules and the files on disk. Nothing is inferred, nothing is persisted but the rules, and a
// hit can always be explained by the query that produced it.
//
// Deliberately dependency-free (no Effect/Schema/crypto) so it is safe to import from both the
// server and the TUI renderer without dragging server code into the TUI bundle. Durable storage
// and id minting live in `lens-store.ts`; this file is pure data + pure helpers.

// Who a Lens or facet belongs to. A `user` facet was asked for by the person driving the session
// (from the TUI, or by an agent acting on an explicit request); an `agent` facet was chosen by the
// agent while curating the view. The distinction is enforced by the store: an agent acting on its
// own initiative may change only agent-owned Lenses, and needs consent to touch a user's.
export type Owner = "user" | "agent"

// A single facet within a Lens. `color` is a literal hex string (`#RRGGBB`) from the Lens's
// palette, pinned when the facet is minted (see `assignColors`) so it never moves while the facet
// lives.
export interface Facet {
  readonly id: string
  readonly label: string
  // WHAT the marked lines are, as a phrase a newcomer can picture. This is the facet's identity:
  // it is corrected when it misdescribes the lines, never repurposed — a new intent is a new facet
  // (new id, new colour), so "the amber lines" never quietly changes meaning.
  readonly what: string
  // WHY to look at them for the task right now. Task-relative, so it is the half that goes stale
  // and is rewritten as the work moves from understanding to changing to verifying.
  // Both are shown on every hover surface; "" when nobody gave one.
  readonly why: string
  readonly color: string
  readonly owner: Owner
  // The agent that minted the facet, when an agent did.
  readonly createdBy?: string
}

// --- search rules ---------------------------------------------------------

// A *finder*: the persisted half of a line-level facet assignment. A line tag is not a location
// — it is a query. Nothing about a hit is stored; the finder is stored and the lines are
// re-derived from disk at every read, so a deleted usage silently loses its paint and a new one
// gains it, with no anchoring, no edit-tracking and no "lost" state to render.
//
//   pattern    — a ripgrep regex. Language-agnostic (config, YAML, markup), over-matches
//                comments and strings. Span = the matched line.
//   symbol     — a top-level declaration by NAME, via extentsOf's column-0 regex. Coarse (the
//                whole declaration) but idiom-blind: it finds a const-arrow, a generator and a
//                function declaration alike.
//   structural — an ast-grep pattern. Precise and exact-ranged; the backend is not installed
//                yet (PLAN.md S1b), so such a rule is stored but reported as unsupported.
//   diff       — the lines git reports as changed against `ref` (default HEAD, i.e. the
//                uncommitted working-tree changes; "A..B" compares two commits). This is what
//                replaced the old "Changed since last commit" built-in Lens.
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
  | { readonly kind: "diff"; readonly ref?: string; readonly glob?: ReadonlyArray<string> }

// Git-history filters that narrow a finder's hits at LINE level: a hit survives only on the lines
// that also pass every filter set here. "Calls to x() changed in the last commit" is a `pattern`
// finder plus `changed: "HEAD~1..HEAD"`.
//
//   changed — a git ref ("HEAD" = uncommitted changes, "main" = changed since main) or a range
//             ("HEAD~1..HEAD" = the last commit). Intersects with `git diff --unified=0` hunks.
//   author  — case-insensitive substring of the blamed author's name or email.
//   since   — anything `git blame --since` accepts ("2 weeks ago", "2026-09-01"); lines last
//             touched before it are dropped. Uncommitted lines always count as recent.
export interface GitFilter {
  readonly changed?: string
  readonly author?: string
  readonly since?: string
}

export interface Rule {
  readonly id: string
  // A facet id on THIS Lens.
  readonly facet: string
  readonly find: Finder
  readonly where?: GitFilter
  // The authoring agent's reason. Shown on hover; never re-evaluated. This is what carries the
  // judgement a rule-only model otherwise can't express ("this is the retry path"), pinned to
  // something the finder *can* name.
  readonly note?: string
  // Agent name, for the history and the study log.
  readonly createdBy?: string
}

// A Lens is meant to be *sparse*, and the failure mode is a loose regex silently painting a third
// of the repo. Over the hit cap a rule is stored and reported as too broad rather than painted,
// so the agent (or the user reading lenses.json) can see and narrow it.
//
// The caps and the error paths are kept in full despite this being a research prototype — the
// opposite of the usual prototype trade. A flooded view or a crashed pass during an unattended
// participant session is a lost session, not a bug report.
export const MAX_RULES = 32
export const MAX_RULE_HITS = 500
// A `diff` rule is the one finder whose breadth is the point: a feature branch legitimately
// changes thousands of lines, and capping it at the grep cap would blank the view exactly when
// it matters. It still has a ceiling, so a rewritten lockfile cannot flood every surface.
export const MAX_DIFF_HITS = 5000

// Whether a rule's hits depend on git state rather than on file content alone. Such a rule must
// be re-evaluated when HEAD moves, which the per-file content memo cannot see.
export function isGitRule(rule: Pick<Rule, "find" | "where">): boolean {
  return rule.find.kind === "diff" || whereFilters(rule.where) > 0
}

function whereFilters(where: GitFilter | undefined): number {
  if (!where) return 0
  return [where.changed, where.author, where.since].filter((v) => typeof v === "string" && v.length > 0).length
}

// Shape predicate for a stored finder. Total and pure: `lenses.json` is hand-editable and
// committable, so a malformed entry must be *droppable* rather than throwing.
//
// Shape only. Whether the regex compiles, the ref exists, or the rule matched 4,000 lines are the
// evaluator's questions, because those need to be *reported* back to the agent and the store has
// nowhere to report.
export function isValidFinder(value: unknown): value is Finder {
  return finderProblem(value) === undefined
}

// Why a finder is unusable, as prose that names the fix — or `undefined` when it is well-formed.
//
// The message matters as much as the verdict: `lens_mark` takes a flat struct precisely so that
// a malformed finder reaches this function instead of failing schema decode upstream with a
// generic "rewrite the input" error that tells the agent nothing.
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
    case "diff":
      if (find["ref"] !== undefined && !nonEmpty("ref"))
        return '"ref" must be a non-empty git ref or range, e.g. "HEAD", "main" or "HEAD~1..HEAD"'
      return globProblem()
    default:
      return `"kind" must be "pattern", "symbol", "structural" or "diff"${
        typeof find["kind"] === "string" ? `; you passed "${find["kind"]}"` : ""
      }`
  }
}

// Why a git filter is unusable, or `undefined` when it is well-formed (including absent).
export function whereProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null) return '"where" must be an object'
  const where = value as Record<string, unknown>
  for (const key of ["changed", "author", "since"]) {
    const v = where[key]
    if (v === undefined) continue
    if (typeof v !== "string" || v.trim().length === 0) return `"${key}" must be a non-empty string`
    // A leading dash would be read by git as an option rather than a ref or a date.
    if (v.trim().startsWith("-")) return `"${key}" must not start with "-"`
  }
  return undefined
}

export interface Lens {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly palette: PaletteId
  readonly facets: ReadonlyArray<Facet>
  readonly owner: Owner
  // Persisted line-level finders. They live on the Lens rather than in a store of their own
  // because a rule is small, readable, diffable, committable and shareable — and because the rule
  // is the thing worth keeping: its *hits* are free to regenerate.
  readonly rules?: ReadonlyArray<Rule>
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

// The "unmarked" pseudo-facet: never in `lens.facets` or the legend and never assigned by a
// rule. It survives as the id of the "Other" grey that the surfaces paint unmarked code with,
// which is deliberately distinct from the darker "Non-code" grey below.
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
// Non-code / nothing to show. The
// dimmer grey so it recedes furthest behind the feature you're exploring (ramp idx 238).
export const UNTAGGED_HUE = "#444444"
export const UNTAGGED_LABEL = "Non-code"

export interface Palette {
  readonly id: PaletteId
  readonly label: string
  // "categorical" — distinct hues for unordered facets; "ordinal" — a cool→warm ramp whose
  // position encodes rank, for facet sets with a natural order.
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

// The ids of the ordinal (ranked) palettes — a Lens uses one of these only when
// a Lens's facets have a natural order. The rest are categorical.
export const ORDINAL_PALETTE_IDS = (Object.values(PALETTES) as Palette[])
  .filter((p) => p.kind === "ordinal")
  .map((p) => p.id)

export const PALETTE_IDS = Object.keys(PALETTES) as PaletteId[]

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && value in PALETTES
}

// Give each facet a palette colour, keeping the one it already has. A facet without a usable
// colour (none yet, not in this palette, or already taken by an earlier facet) gets the lowest
// free slot. Colour is pinned rather than derived from position because the chat, the legend and
// the gutter all name a concern by its colour: re-hueing the survivors when one is removed would
// make every earlier "the amber lines" point at a different concern. Facets beyond the palette
// length wrap (callers enforce MAX_FACETS, but wrapping keeps it total).
export function assignColors(
  palette: PaletteId,
  facets: ReadonlyArray<Omit<Facet, "color"> & { readonly color?: string }>,
): Facet[] {
  const colors = PALETTES[palette].colors
  const taken = new Set<string>()
  const kept = facets.map((facet) => {
    if (!facet.color || !colors.includes(facet.color) || taken.has(facet.color)) return undefined
    taken.add(facet.color)
    return facet.color
  })
  const free = colors.filter((c) => !taken.has(c))
  const unpinned = kept.flatMap((color, i) => (color ? [] : [i]))
  return facets.map((facet, i) => ({
    ...facet,
    color: kept[i] ?? free[unpinned.indexOf(i)] ?? colors[i % colors.length]!,
  }))
}

// The same slots under another palette — a palette switch re-hues every facet by the slot it
// holds, which for the two current palettes is "reverse the ramp". Deliberate and user-visible,
// unlike the silent re-hue a removal used to cause.
export function repaletteColors(from: PaletteId, to: PaletteId, facets: ReadonlyArray<Facet>): Facet[] {
  const source = PALETTES[from].colors
  const target = PALETTES[to].colors
  return assignColors(
    to,
    facets.map((facet) => {
      const slot = source.indexOf(facet.color)
      return { ...facet, color: slot >= 0 ? target[slot] : undefined }
    }),
  )
}

// --- helpers ---------------------------------------------------------------

export function isValidFacet(lens: Lens, id: unknown): id is string {
  return typeof id === "string" && lens.facets.some((t) => t.id === id)
}

// Resolve a facet by id, or by label case-insensitively — the permissive convention every
// Lens-editing entry point uses, so an agent can name a concern either way.
export function findFacet(lens: Pick<Lens, "facets">, ref: string): Facet | undefined {
  const wanted = ref.trim()
  return (
    lens.facets.find((t) => t.id === wanted) ?? lens.facets.find((t) => t.label.toLowerCase() === wanted.toLowerCase())
  )
}

// One facet as an agent needs to see it: its id, its hue *by name*, who owns it, and how many
// rules point at it. Used by `lens_mark`/`lens_unmark`, which ship the whole roster on every call
// (success or refusal), and by the build/plan system prompt.
//
// Shipping it everywhere is deliberate: the roster is what stops an agent minting `retry-path-2`
// beside `retry-path`, tells it how close it is to MAX_FACETS, which facets it may not touch
// without asking, and gives it a colour word to narrate to the user ("the crimson lines").
export interface ConcernSummary {
  readonly facet: string
  readonly label: string
  readonly color: string
  readonly colorName: string
  readonly owner: Owner
  readonly rules: number
  readonly what: string
  readonly why: string
}

// A finder (and its git filter) as one readable line. Lives here so `lens_mark` (echoing back
// what it stored) and `lens_list` (showing what is installed) cannot describe the same rule two
// ways — the agent compares the two to decide whether to reuse a concern.
export function describeFinder(find: Finder, where?: GitFilter): string {
  return describeFind(find) + describeWhere(where)
}

function describeFind(find: Finder): string {
  const glob = (g?: ReadonlyArray<string>) => (g?.length ? ` glob ${g.join(", ")}` : "")
  switch (find.kind) {
    case "pattern":
      return `pattern /${find.pattern}/` + glob(find.glob) + (find.caseSensitive === false ? " (case-insensitive)" : "")
    case "symbol":
      return `symbol ${find.name}` + (find.path ? ` in ${find.path}` : "")
    case "structural":
      return `structural /${find.pattern}/ (${find.language})` + glob(find.glob)
    case "diff":
      return `lines changed vs ${find.ref ?? "HEAD"}` + glob(find.glob)
  }
}

export function describeWhere(where?: GitFilter): string {
  if (!where) return ""
  return [
    where.changed ? ` changed in ${where.changed}` : "",
    where.author ? ` by ${where.author}` : "",
    where.since ? ` since ${where.since}` : "",
  ].join("")
}

export function concernRoster(lens: Pick<Lens, "facets" | "rules">): ConcernSummary[] {
  const counts = new Map<string, number>()
  for (const rule of lens.rules ?? []) counts.set(rule.facet, (counts.get(rule.facet) ?? 0) + 1)
  return lens.facets.map((t) => ({
    facet: t.id,
    label: t.label,
    color: t.color,
    colorName: COLOR_NAMES[t.color] ?? t.color,
    owner: t.owner,
    rules: counts.get(t.id) ?? 0,
    what: t.what,
    why: t.why,
  }))
}

// The renderer's legend: ordered facet → label + colour, plus what a hover explains — the
// facet's what and why, and its rules as readable queries. Drives the swatch row, the facet→colour map
// every surface paints with, and the hover detail, so no client needs a hard-coded vocabulary.
export interface LegendEntry {
  readonly facet: string
  readonly label: string
  readonly color: string
  readonly what: string
  readonly why: string
  readonly queries: ReadonlyArray<string>
}

export function legend(lens: Pick<Lens, "facets" | "rules">): LegendEntry[] {
  return lens.facets.map((t) => ({
    facet: t.id,
    label: t.label,
    color: t.color,
    what: t.what,
    why: t.why,
    queries: (lens.rules ?? []).filter((r) => r.facet === t.id).map((r) => describeFinder(r.find, r.where)),
  }))
}

// Narrow a set of facet ids to those this Lens actually has. Order and duplicates are dropped;
// the result is a set.
//
// This is the guard on the legend filter (O4). Facet ids are slugs, so two unrelated Lenses can
// easily share one: a filter left over from a previous vocabulary would sit inert until a Lens
// reusing that id came round, and then grey out something the user never turned off.
export function facetsWithin(lens: Pick<Lens, "facets">, facets: ReadonlyArray<string>): Set<string> {
  const known = new Set(lens.facets.map((t) => t.id))
  return new Set(facets.filter((f) => known.has(f)))
}

// Lowercase kebab slug for minting ids from a user-supplied name.
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
