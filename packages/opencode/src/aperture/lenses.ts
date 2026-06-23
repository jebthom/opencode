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
export type DeterministicKind = "git-changed" | "mtime-buckets"

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
}

// --- palettes --------------------------------------------------------------

// Four predefined *categorical* palettes (qualitative, never ordinal/diverging),
// each a different tone so Lenses are partially visually distinctive at a
// glance: soft pastels, deep darks, vivid brights, muted earth tones. Six colours
// each caps a Lens at MAX_FACETS facets. Fixed hex (theme-independent) — the
// distinctiveness across palettes is the point and can't survive being remapped
// onto a theme's handful of roles.
export type PaletteId = "pastel" | "dark" | "bright" | "earthy"

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
  readonly colors: ReadonlyArray<string>
}

export const PALETTES: Record<PaletteId, Palette> = {
  pastel: {
    id: "pastel",
    label: "Pastel",
    colors: ["#A8D5BA", "#F7C8A0", "#B5C7EB", "#F4B8C4", "#E2C2E9", "#F5E1A4"],
  },
  dark: {
    id: "dark",
    label: "Dark",
    colors: ["#2E5266", "#6E4555", "#3B6B35", "#8C4843", "#4A4E69", "#7A5C2E"],
  },
  bright: {
    id: "bright",
    label: "Bright",
    colors: ["#4E79A7", "#F28E2B", "#59A14F", "#E15759", "#B07AA1", "#EDC948"],
  },
  earthy: {
    id: "earthy",
    label: "Earthy",
    colors: ["#8C7A5B", "#A65E2E", "#6B8E5A", "#C2A878", "#5B6C5D", "#9C6B4F"],
  },
}

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

// "Changed since last commit": a two-facet Lens painted from `git status` rather
// than the model. "changed" covers any working-tree change git reports (modified,
// staged, AND untracked/new files); everything else is "unchanged" and recedes to a
// muted theme grey so the changes pop. Colours: a fixed warm hex for changed, a
// theme-role key for unchanged (resolveColor accepts both).
export const GIT_CHANGED_ID = "git-changed"

export const GIT_CHANGED: Lens = {
  id: GIT_CHANGED_ID,
  name: "Changed since last commit",
  description: "Highlights files with uncommitted working-tree changes (modified, staged, or new) against the rest.",
  prompt: "",
  scope: "global",
  deterministic: "git-changed",
  facets: [
    { id: "changed", label: "Changed", description: "File has uncommitted working-tree changes.", color: "#F2A53A" },
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
// with the deterministic compute. Colours run cool→warm so newest = red.
export const RECENCY_FACET_IDS = ["recency-0", "recency-1", "recency-2", "recency-3", "recency-4", "recency-5"] as const
const RECENCY_COLORS = ["#4E5BA6", "#3AAFA9", "#59A14F", "#EDC948", "#F28E2B", "#E15759"] as const
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

// All built-in (globally-defined) Lenses — the protected group. Built-ins are
// immutable: they cannot be edited, have their facets merged, or be deleted (the
// create/edit/merge/delete flows and the UI all refuse them via `isBuiltinLens`
// / `BUILTIN_LENS_IDS`). They inherit that protection automatically from their
// global scope — no other code needs to change to add one. The two deterministic ones
// additionally carry a `deterministic` kind so the server paints them without the painter.
export const BUILTIN_LENSES: ReadonlyArray<Lens> = [ARCHITECTURE, GIT_CHANGED, MTIME_RECENCY]

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
export function buildSystemPrompt(lens: Lens): string {
  return [
    lens.prompt,
    "Facets:",
    ...lens.facets.map((t) => `- ${t.id}: ${t.description}`),
    `- ${NONE_FACET}: none of the above — the file is unrelated to every facet`,
    `Assign each source file exactly one facet, using "${NONE_FACET}" when it fits none rather than forcing a fit.`,
    "Infer the facet from the file path, its imports, and its leading comment.",
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
