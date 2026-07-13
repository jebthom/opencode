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

// A single semantic facet within a Lens. `color` is resolved at definition
// time: a hex string (`#RRGGBB`) for user Lenses drawn from a palette, or a
// theme-role key (e.g. "info") for the built-in architecture Lens. The
// renderer's `resolveColor` accepts both, so the painting path is uniform.
export interface Facet {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly color: string
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

export interface Lens {
  readonly id: string
  readonly name: string
  readonly description: string
  // The categorical palette user Lenses draw from. Absent for the built-in
  // architecture Lens, whose colours are theme roles rather than a palette.
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
}

// --- palettes --------------------------------------------------------------

// Predefined palettes, split by `kind`. CATEGORICAL palettes (qualitative — pastel, dark,
// bright, earthy) give each facet a maximally *distinct* hue for unordered categories; each
// is a different tone so Lenses are partially distinguishable at a glance. ORDINAL palettes
// (pastel/bright/dark-ordinal) instead run a *cool→warm spectral ramp* so a facet's colour
// encodes its rank — for facet sets that have a natural order (few→many, old→new, low→high).
// Six colours each caps a Lens at MAX_FACETS facets. Fixed hex (theme-independent) — the
// distinctiveness across palettes is the point and can't survive being remapped onto a
// theme's handful of roles.
export type PaletteId =
  | "pastel"
  | "dark"
  | "bright"
  | "earthy"
  | "pastel-ordinal"
  | "bright-ordinal"
  | "dark-ordinal"

export const MAX_FACETS = 6

// Universal escape facet the model may assign to a file that fits none of a
// Lens's facets (so a single-facet Lens greys the rest of the repo instead
// of force-fitting every file). It is *not* a user-defined facet — it never appears in
// `lens.facets`/the legend and draws no palette colour — but it IS stored (with a
// content hash) so those files aren't re-painted every sweep. The two greys below let
// the renderer tell it apart from genuinely unpainted/non-code files.
export const NONE_FACET = "none"
// "Other — not this Lens" (code the painter judged unrelated). Theme role key,
// resolved client-side; deliberately the more *visible* grey since it's meaningful
// context you may still want to read.
export const NONE_HUE = "textMuted"
export const NONE_LABEL = "Other"
// Genuinely unpainted / non-code (no store entry — specs, assets, not-yet-swept). The
// dimmer grey so it recedes furthest behind the feature you're exploring.
export const UNTAGGED_HUE = "border"
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

// Palette colours must stay legible in a 256-colour terminal (COLORTERM unset), not just
// truecolor: the renderer's RGB is quantised to the xterm-256 palette, and a colour that
// is both dark *and* low-saturation snaps onto the grey ramp — where it reads as (and
// collides with) the "Other"/Non-code greys (NONE_HUE/UNTAGGED_HUE). The safe move for a
// muted look is to sit each colour on an exact colour-*cube* entry (channels drawn from
// {0,95,135,175,215,255}) with at least two distinct levels, so it can never round to grey.
// The "no ... collapses to grey" test in lenses.test.ts guards this.
export const PALETTES: Record<PaletteId, Palette> = {
  pastel: {
    id: "pastel",
    label: "Pastel",
    kind: "categorical",
    colors: ["#A8D5BA", "#F7C8A0", "#B5C7EB", "#F4B8C4", "#E2C2E9", "#F5E1A4"],
  },
  // Muted-but-not-grey in 256-colour: every entry lands on an exact dark colour-cube cell
  // (idx 131/94/65/30/61/96), spanning a full hue wheel while staying low-luminance.
  dark: {
    id: "dark",
    label: "Dark",
    kind: "categorical",
    colors: ["#AF5F5F", "#875F00", "#5F875F", "#008787", "#5F5FAF", "#875F87"],
  },
  bright: {
    id: "bright",
    label: "Bright",
    kind: "categorical",
    colors: ["#4E79A7", "#F28E2B", "#59A14F", "#E15759", "#B07AA1", "#EDC948"],
  },
  // #5B6C5D (slot 5) previously quantised to grey rgb(98,98,98); replaced with a muted
  // slate that lands on an exact cube cell and stays clear of the other five earth tones.
  earthy: {
    id: "earthy",
    label: "Earthy",
    kind: "categorical",
    colors: ["#8C7A5B", "#A65E2E", "#6B8E5A", "#C2A878", "#5F5F87", "#9C6B4F"],
  },
  // Ordinal ramps — cool (indigo) → warm (red) so colour position reads as rank. Three tonal
  // registers mirroring the categorical trio. All 256-safe (no colour hits the grey ramp).
  "pastel-ordinal": {
    id: "pastel-ordinal",
    label: "Pastel (ordinal)",
    kind: "ordinal",
    colors: ["#8E9BD9", "#79C7C1", "#9BCF8F", "#EFE08F", "#F3C08A", "#EB9A9A"],
  },
  // Vivid cool→warm spectrum; the same ramp the built-in "Edit recency" heat-map Lens paints
  // (RECENCY_COLORS below is derived from this, so the two never drift).
  "bright-ordinal": {
    id: "bright-ordinal",
    label: "Bright (ordinal)",
    kind: "ordinal",
    colors: ["#4E5BA6", "#3AAFA9", "#59A14F", "#EDC948", "#F28E2B", "#E15759"],
  },
  // Dark cool→warm ramp on exact colour-cube cells (256-safe by construction).
  "dark-ordinal": {
    id: "dark-ordinal",
    label: "Dark (ordinal)",
    kind: "ordinal",
    colors: ["#5F5FAF", "#008787", "#5F875F", "#87875F", "#875F00", "#AF5F5F"],
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
export function assignColors(
  palette: PaletteId,
  facets: ReadonlyArray<Omit<Facet, "color">>,
): Facet[] {
  const colors = PALETTES[palette].colors
  return facets.map((facet, i) => ({ ...facet, color: colors[i % colors.length]! }))
}

// --- built-in architecture Lens --------------------------------------

export const ARCHITECTURE_ID = "architecture"

// The original architectural-layer vocabulary, expressed as a Lens. Its facet
// ids are the layer names and its colours are the theme-role keys (LAYER_HUE), so
// it keeps its existing theme-adaptive look. Global scope: shared across projects
// and the base we extend default schemas from later.
export const ARCHITECTURE: Lens = {
  id: ARCHITECTURE_ID,
  name: "Architectural layer",
  description: "Classifies each file by its architectural layer (interface, application, domain, data, infrastructure).",
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
// Warm heat ramp (NOT the cool→warm ordinal ramps): different warm shades of the original
// "Changed" amber, running pale gold → red as the change grows, so magnitude reads as heat.
// Every colour sits on an exact 256-colour cube cell (channels from {0,95,135,175,215,255})
// with ≥2 distinct levels, so none can quantise onto the grey ramp (see the PALETTES note).
const CHANGE_COLORS = ["#FFD787", "#FFAF5F", "#FF8700", "#FF5F00", "#D70000"] as const
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
  description: "Buckets files with uncommitted changes by how many lines changed (few = pale, many = hot); the rest recede.",
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
    { id: "unchanged", label: "Unchanged", description: "File matches the last commit.", color: "textMuted" },
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
// IS the shared "bright-ordinal" palette (kept in one place so the two can't drift).
export const RECENCY_FACET_IDS = ["recency-0", "recency-1", "recency-2", "recency-3", "recency-4", "recency-5"] as const
const RECENCY_COLORS = PALETTES["bright-ordinal"].colors
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
const BUS_FACTOR_COLORS = ["#E15759", "#F28E2B", "#59A14F", "#4E5BA6"] as const
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
  return facets.map((id) =>
    id === NONE_FACET ? NONE_LABEL : (parent.facets.find((f) => f.id === id)?.label ?? id),
  )
}

// --- helpers ---------------------------------------------------------------

export function isValidFacet(lens: Lens, id: unknown): id is string {
  return typeof id === "string" && lens.facets.some((t) => t.id === id)
}

// A facet the painter is allowed to store: one of the Lens's facets or the universal
// NONE_FACET escape. Used to filter the model's structured output.
export function isAssignableFacet(lens: Lens, id: unknown): id is string {
  return id === NONE_FACET || isValidFacet(lens, id)
}

// The closed set of facet ids the model may echo back: the Lens's facets plus the
// NONE_FACET escape. Drives the painter's structured-output enum.
export function facetEnumIds(lens: Lens): [string, ...string[]] {
  // NONE_FACET first so the result types as a non-empty tuple; enum order is irrelevant.
  return [NONE_FACET, ...lens.facets.map((t) => t.id)]
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
            .join(", ")} of the "${parent.name}" Lens. That judgement is already made and files outside it are never shown to you, so do not re-apply or second-guess it — classify each file by which facet below it belongs to *within* that set.`,
        ]
      : []
  return [
    lens.prompt,
    ...scope,
    "Facets:",
    ...lens.facets.map((t) => `- ${t.id}: ${t.description}`),
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
