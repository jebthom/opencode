// Tag *collections* for the code-graph semantic layer. A collection is a named
// vocabulary of semantic tags (each with a definition + a colour) plus the prompt
// handed to the tagging agent. The architectural-layer vocabulary in `semantics.ts`
// is now just one built-in, globally-defined collection (`ARCHITECTURE`); users can
// define their own per-project collections via the `/tag` flow.
//
// Deliberately dependency-free (no Effect/Schema/crypto) so it is safe to import
// from both the server-side tagger/payload and the TUI renderer without dragging
// server code into the TUI bundle. Durable storage + id minting live in
// `collection-store.ts`; this file is pure data + pure helpers.

import { LAYERS, LAYER_LABEL, LAYER_DESCRIPTION, LAYER_HUE } from "./semantics"

// A single semantic tag within a collection. `color` is resolved at definition
// time: a hex string (`#RRGGBB`) for user collections drawn from a palette, or a
// theme-role key (e.g. "info") for the built-in architecture collection. The
// renderer's `resolveColor` accepts both, so the painting path is uniform.
export interface TagDef {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly color: string
}

export type CollectionScope = "global" | "project"

export interface TagCollection {
  readonly id: string
  readonly name: string
  readonly description: string
  // The categorical palette user collections draw from. Absent for the built-in
  // architecture collection, whose colours are theme roles rather than a palette.
  readonly palette?: PaletteId
  // The role/instruction sentence(s) prepended to the generated tagger system
  // prompt (the tag list + echo instructions are appended by `buildSystemPrompt`).
  readonly prompt: string
  readonly tags: ReadonlyArray<TagDef>
  readonly scope: CollectionScope
  // Optional repo-relative directories the `/tag` flow surfaced as most relevant.
  // The background tagger front-loads files under these (in DFS order) before the
  // rest of the repo, so the targeted area lights up first — it never *restricts*
  // the sweep, which always covers the whole repo.
  readonly directories?: ReadonlyArray<string>
}

// --- palettes --------------------------------------------------------------

// Four predefined *categorical* palettes (qualitative, never ordinal/diverging),
// each a different tone so collections are partially visually distinctive at a
// glance: soft pastels, deep darks, vivid brights, muted earth tones. Six colours
// each caps a collection at MAX_TAGS tags. Fixed hex (theme-independent) — the
// distinctiveness across palettes is the point and can't survive being remapped
// onto a theme's handful of roles.
export type PaletteId = "pastel" | "dark" | "bright" | "earthy"

export const MAX_TAGS = 6

// Universal escape tag the model may assign to a file that fits none of a
// collection's tags (so a single-tag collection greys the rest of the repo instead
// of force-fitting every file). It is *not* a user-defined tag — it never appears in
// `collection.tags`/the legend and draws no palette colour — but it IS stored (with a
// content hash) so those files aren't re-tagged every sweep. The two greys below let
// the renderer tell it apart from genuinely untagged/non-code files.
export const NONE_TAG = "none"
// "Other — not this collection" (code the tagger judged unrelated). Theme role key,
// resolved client-side; deliberately the more *visible* grey since it's meaningful
// context you may still want to read.
export const NONE_HUE = "textMuted"
export const NONE_LABEL = "Other"
// Genuinely untagged / non-code (no store entry — specs, assets, not-yet-swept). The
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

// Pair each tag with the palette colour at its index. Tags beyond the palette
// length wrap (callers should enforce MAX_TAGS, but wrapping keeps it total).
export function assignColors(
  palette: PaletteId,
  tags: ReadonlyArray<Omit<TagDef, "color">>,
): TagDef[] {
  const colors = PALETTES[palette].colors
  return tags.map((tag, i) => ({ ...tag, color: colors[i % colors.length]! }))
}

// --- built-in architecture collection --------------------------------------

export const ARCHITECTURE_ID = "architecture"

// The original architectural-layer vocabulary, expressed as a collection. Its tag
// ids are the layer names and its colours are the theme-role keys (LAYER_HUE), so
// it keeps its existing theme-adaptive look. Global scope: shared across projects
// and the base we extend default schemas from later.
export const ARCHITECTURE: TagCollection = {
  id: ARCHITECTURE_ID,
  name: "Architectural layer",
  description: "Classifies each file by its architectural layer (interface, application, domain, data, infrastructure).",
  prompt: "You classify each source file by its architectural layer in a codebase.",
  scope: "global",
  tags: LAYERS.map((layer) => ({
    id: layer,
    label: LAYER_LABEL[layer],
    description: LAYER_DESCRIPTION[layer],
    color: LAYER_HUE[layer],
  })),
}

// All built-in (globally-defined) collections — the protected group. Built-ins are
// immutable: they cannot be edited, have their tags merged, or be deleted (the
// create/edit/merge/delete flows and the UI all refuse them via `isBuiltinCollection`
// / `BUILTIN_COLLECTION_IDS`). Architecture is the sole member today; add more here and
// they inherit the same protection automatically — no other code needs to change.
export const BUILTIN_COLLECTIONS: ReadonlyArray<TagCollection> = [ARCHITECTURE]

// The ids of the protected built-in group — for callers that only have an id (e.g. the
// renderer deciding whether to show a delete control).
export const BUILTIN_COLLECTION_IDS: ReadonlySet<string> = new Set(BUILTIN_COLLECTIONS.map((c) => c.id))

// Whether a collection belongs to the protected built-in group. Built-ins carry global
// scope (the marker every BUILTIN_COLLECTIONS member sets); user collections are always
// "project". This is the single source of truth for "is this collection immutable?".
export function isBuiltinCollection(collection: Pick<TagCollection, "scope">): boolean {
  return collection.scope === "global"
}

// --- helpers ---------------------------------------------------------------

export function isValidTag(collection: TagCollection, id: unknown): id is string {
  return typeof id === "string" && collection.tags.some((t) => t.id === id)
}

// A tag the tagger is allowed to store: one of the collection's tags or the universal
// NONE_TAG escape. Used to filter the model's structured output.
export function isAssignableTag(collection: TagCollection, id: unknown): id is string {
  return id === NONE_TAG || isValidTag(collection, id)
}

// The closed set of tag ids the model may echo back: the collection's tags plus the
// NONE_TAG escape. Drives the tagger's structured-output enum.
export function tagEnumIds(collection: TagCollection): [string, ...string[]] {
  // NONE_TAG first so the result types as a non-empty tuple; enum order is irrelevant.
  return [NONE_TAG, ...collection.tags.map((t) => t.id)]
}

// The renderer's legend: ordered tag → label + colour. Drives both the swatch row
// and the tag→colour map used to paint nodes/composition, so the TUI needs no
// hard-coded vocabulary.
export interface LegendEntry {
  readonly tag: string
  readonly label: string
  readonly color: string
}

export function legend(collection: TagCollection): LegendEntry[] {
  return collection.tags.map((t) => ({ tag: t.id, label: t.label, color: t.color }))
}

// System prompt handed to the tagger model: the collection's role sentence, the
// enumerated tag definitions, then the fixed echo/format instructions. Replaces the
// previously hard-coded architectural-layer prose so any collection can tag.
export function buildSystemPrompt(collection: TagCollection): string {
  return [
    collection.prompt,
    "Tags:",
    ...collection.tags.map((t) => `- ${t.id}: ${t.description}`),
    `- ${NONE_TAG}: none of the above — the file is unrelated to every tag`,
    `Assign each source file exactly one tag, using "${NONE_TAG}" when it fits none rather than forcing a fit.`,
    "Infer the tag from the file path, its imports, and its leading comment.",
    "Return one entry per input file, echoing its exact path.",
  ].join("\n")
}

// Lowercase kebab slug for minting collection ids from a user-supplied name.
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "collection"
  )
}

export * as CodeGraphCollections from "./collections"
