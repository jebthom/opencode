import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { DIRECTORY_HUE } from "@/aperture/semantics"
import { NONE_FACET, NONE_HUE, NONE_LABEL, UNTAGGED_HUE, UNTAGGED_LABEL, BUILTIN_LENS_IDS } from "@/aperture/lenses"
import { allocateCells, buildGrid, coalesce } from "@/aperture/treemap"
import { ACTION_GLYPH, ACTION_LABEL, ACTIONS, type Action, type ActivityEntry, type Fill, type Style } from "@/aperture/activity"
import { createActivityTracker } from "./aperture-activity"
import { apertureNavRequest } from "./aperture-nav"
import { openLensPicker } from "./aperture-lens-picker"

const id = "internal:aperture"

// Step 2.5 renderer (PLAN.md): a persistent top-bar that draws a 2-level window
// of the deterministic Aperture view and lets the user drill into directories.
//
// The bar is rooted at a `scope` (a repo-relative directory, "" = repo root). It
// shows the scope's direct children as bordered boxes (layer 0) and their
// children as smaller boxes (layer 1). Clicking a directory box re-roots the
// view at it; a root button, an up button, and a clickable breadcrumb walk back
// out. Data is fetched per scope from api.client.aperture.get({ scope }); when
// the server reports a file change inside the viewed scope (aperture.invalidated)
// we refetch just that scope, so the visible view stays live without recomputing
// graphs nobody is looking at.

type GraphNode = {
  id: string
  path: string
  kind: "file" | "directory"
  size: number
  position: { layer: number; index: number }
}

type GraphEdge = { from: string; to: string; kind: string }

// Per-directory recursive subtree composition (server-merged, see payload.ts). The
// treemap paints a directory from these per-layer weights; `count` and `bytes` are
// both carried so TREEMAP_METRIC can switch which one drives cell area.
type FacetWeight = { facet: string; count: number; bytes: number }
// `total*` cover only the painted files in `weights`; `subtree*` cover every descendant
// file. A fully-unpainted directory has zero `total*` but non-zero `subtree*`, so its
// grey block can still be sized by real size (see TreemapBlock's grey branch).
type Composition = {
  weights: readonly FacetWeight[]
  totalCount: number
  totalBytes: number
  subtreeCount: number
  subtreeBytes: number
}

// An out-of-window one-hop import target (step 6). No position/size — it isn't
// placed in the layer grid; the renderer draws it as a boundary tile under the
// importing node. An edge's `to` may reference a boundary id.
type GraphBoundary = { id: string; path: string; kind: "file" | "directory" }

// One sub-file (function-level) tile for a drilled-into file (A5): a top-level
// declaration's line span with its own facet/hue. `facet`/`hue` are absent until the
// drill-in painter colours the function. Present only for the drilled file.
type GraphExtent = { name: string; startLine: number; endLine: number; facet?: string; hue?: string }

type Graph = {
  version: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  boundaries?: GraphBoundary[]
  semantics: Record<string, { facets: readonly string[]; hue?: string }>
  composition?: Record<string, Composition>
  // The active Lens + legend (facet → label + colour), merged in server-side.
  lens?: { id: string; name: string; legend: readonly { facet: string; label: string; color: string }[] }
  // Function-level tiles keyed by *file* node id, present only for the drilled file.
  extents?: Record<string, readonly GraphExtent[]>
}

// Layout mode for the top bar. "grid" = the current wide block-over-child-grid
// layout; "column" = a narrow top-layer treemap with children stacked as a single
// borderless column beneath (see the COLUMN_* constants below). Defaults to "grid" so
// the current view is preserved; flip the constant (or set OPENCODE_APERTURE_LAYOUT=column)
// to try the alternative.
const APERTURE_LAYOUT: "grid" | "column" = process.env["OPENCODE_APERTURE_LAYOUT"] === "grid" ? "grid" : "column"

// +1 row over the graph's own budget so the horizontal scrollbar lives below the
// tiles without stealing a row of node detail. A directory header is a label row over
// an up-to-MAX_ROWS treemap *wrapped in a border* (so it's a legible box even when
// empty), over an up-to-CHILD_ROWS-tall child grid; bump this further if MAX_ROWS or
// CHILD_ROWS grows. Column mode used to run taller to fit more of its single child column
// before it clipped, but now that list scrolls in place (COLUMN_CHILD_WINDOW + the ↑/↓
// "+N" markers), so this is the base height for both layouts. Column mode then adds one
// row *only when the horizontal scrollbar is actually showing* (see scrollbarVisible): the
// column fills the whole height, so the scrollbar would otherwise paint over the last child
// / bottom "+N" marker — but when the bar fits without scrolling, that row is reclaimed.
const TOP_BAR_HEIGHT = 20
// Inter-column gap in the scroll strip (the scrollbox's contentOptions gap) and the bar's
// own horizontal padding — both feed the content-width vs viewport-width test that decides
// whether the horizontal scrollbar shows. Keep in sync with the JSX that uses them.
const SCROLL_GAP = 2
const BAR_PADDING_X = 2
// Cells moved per wheel notch when we redirect a vertical wheel into horizontal
// scroll. Tiles are ~CHILD_W wide, so 1 cell/notch (the raw terminal delta) feels
// sluggish; a small multiplier makes the bar pan at a comfortable speed.
const HSCROLL_STEP = 3
// How often (ms) to poll-refresh the view for changes nothing tells us about — files
// created/deleted in the user's IDE outside opencode emit no event the bar can see, so
// they'd otherwise only surface on navigation or a manual ⟳. Recompute is a cheap scoped
// walk, so a low-frequency poll keeps the view honest without meaningful cost.
const REFRESH_POLL_MS = 5000
// Children are drawn in a compact CHILD_COLS×CHILD_ROWS grid (filled left→right,
// top→bottom) rather than one long row, so a directory stays glanceable. MAX_CHILDREN
// is the grid's capacity; a directory with more than that collapses its extras into a
// single "…" tile pinned to the bottom-right cell.
const CHILD_COLS = 3
const CHILD_ROWS = 2
const MAX_CHILDREN = CHILD_COLS * CHILD_ROWS
const MAX_LABEL = 16
const MAX_CHILD_LABEL = 7
// Sentinel occupying the child grid's bottom-right cell when a directory holds more
// than MAX_CHILDREN children; rendered as the clickable "…" expander.
const OVERFLOW = Symbol("overflow")
// Fixed tile widths (step 6). Children and their containment drops share CHILD_W
// so a `│` drop always centers over its child regardless of label length; boundary
// tiles + their drops share TILE_W likewise. Fixed widths are what make the purely
// visual connector edges align without per-tile column math.
const CHILD_W = 10
const TILE_W = 3

// Treemap painting. A directory is drawn as a grid of layer-colored cells (wrapped
// in a border so it reads as a box even when empty) whose area approximates its
// subtree's composition. MAX_ROWS caps the layer-0 block height (it grows
// horizontally instead); switch it to 4 for a taller block (watch the
// TOP_BAR_HEIGHT budget). TREEMAP_METRIC picks whether file count or byte size
// drives cell area — both are carried in the payload, so flipping this is a
// one-line change. CELL_W is how many terminal columns one cell spans (2 reads as
// a roughly square block). A layer-0 block grows to the footprint of a full
// CHILD_COLS-wide child-grid row (minus its own border, so a directory and its grid
// line up); a
// layer-1 child directory paints a single-row composition bar *inside* the child
// tile's border, so CHILD_INNER_COLS is the child width less its two border cols.
const MAX_ROWS = 3
const TREEMAP_METRIC: "bytes" | "count" = "bytes"
const CELL_W = 2
// Widest a layer-0 treemap can get: the footprint of a full CHILD_COLS-wide child
// grid row, so the block lines up with the grid beneath it.
const TREEMAP_MAX_COLS = Math.floor((CHILD_COLS * CHILD_W + (CHILD_COLS - 1) - 2) / CELL_W)
// Inner treemap columns for a layer-0 block sitting over a child grid whose top row
// is `tiles` tiles wide. The block lines up with that row: each tile is CHILD_W wide
// with a 1-col gap between, the block adds a 2-col border, and one cell spans CELL_W
// cols — so inner cols = (footprint − border) / CELL_W. Floored at one tile so a
// directory whose children are all ignored (0 visible tiles) reads as a small box
// rather than a full-width grey bar, and capped at the full grid-row footprint so a
// normal directory is unchanged.
function treemapColsFor(tiles: number) {
  const t = Math.max(1, tiles)
  const footprint = t * CHILD_W + (t - 1) // tiles + inter-tile gaps
  return Math.max(1, Math.min(TREEMAP_MAX_COLS, Math.floor((footprint - 2) / CELL_W)))
}

// --- column-mode dimensions (APERTURE_LAYOUT === "column") -----------------
// A block's *width* encodes the directory's size: it scales between COLUMN_COLS_MIN and
// COLUMN_COLS_MAX treemap cells (each CELL_W terminal cols wide) by sqrt(subtree /
// biggest-sibling) — the same scaling the grid treemap uses for cell count. At CELL_W=2
// the outer width (cells*CELL_W + 2 border) runs 8 cols (3 cells) … 14 cols (6 cells).
// COLUMN_ROWS is the block height. All three are first-guess values meant to be tuned.
const COLUMN_COLS_MIN = 3 // → 8 terminal cols outer
const COLUMN_COLS_MAX = 6 // → 14 terminal cols outer
const COLUMN_ROWS = 6
// Visible child rows in a column before the list scrolls in place. Derived from the base
// budget so it tracks the constants it depends on: TOP_BAR_HEIGHT less the outer bottom
// border (1), the four header rows (title / nav / legend / actions), and the layer-0 block
// above the list (label 1 + border 2 + COLUMN_ROWS). The scrollbar row isn't subtracted
// here — it's added to the bar height only when the scrollbar shows, so the window stays
// fixed. A list longer than this captures the wheel and pages in place; a shorter one lets
// the wheel bubble out to the sideways pan.
const COLUMN_CHILD_WINDOW = TOP_BAR_HEIGHT - 1 - 4 - (1 + 2 + COLUMN_ROWS)
// When a layer has fewer than this many items there's plenty of horizontal room, so every
// block is drawn at max width instead of being shrunk by size (the fill still scales, so
// byte size stays legible). Tune to taste.
const COLUMN_FEW_THRESHOLD = 10
// Per-directory block width in cells: max when the layer is sparse (itemCount below the
// threshold), otherwise scaled by subtree size against the biggest sibling, clamped to the
// min/max.
function columnColsFor(subtree: number, maxSubtree: number, itemCount: number) {
  if (itemCount < COLUMN_FEW_THRESHOLD) return COLUMN_COLS_MAX
  if (maxSubtree <= 0 || subtree <= 0) return COLUMN_COLS_MIN
  return Math.max(COLUMN_COLS_MIN, Math.min(COLUMN_COLS_MAX, Math.round(COLUMN_COLS_MAX * Math.sqrt(subtree / maxSubtree))))
}
// Border-inclusive footprint of a `cols`-cell-wide block; child bars match it.
const columnOuterW = (cols: number) => cols * CELL_W + 2
// Layer-0 *files* have no subtree to size by, so they render at a fixed narrow width.
// Defaults to the min block width; change this one constant to widen file tiles.
const COLUMN_FILE_W = columnOuterW(COLUMN_COLS_MIN) // = 8 terminal cols

// Cell sentinel for an empty / fully-untagged directory: painted light grey so the
// bordered box reads as a real-but-uninhabited directory rather than a black void. The
// leading space is deliberate — it keeps this distinct from any real tag id (slugs are
// trimmed kebab-case and can never start with a space), so don't "tidy" it to "grey".
const GREY_CELL = " grey"

// Kind is encoded by corner shape only, leaving border/background colors free
// for the future semantic-painting layer: directories get square corners, files
// get rounded ones. Both stay full, paintable boxes.
const SQUARE_CORNERS = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  topT: "┬",
  bottomT: "┴",
  leftT: "├",
  rightT: "┤",
  cross: "┼",
}
const ROUNDED_CORNERS = { ...SQUARE_CORNERS, topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯" }
const cornersFor = (kind: GraphNode["kind"]) => (kind === "directory" ? SQUARE_CORNERS : ROUNDED_CORNERS)

// An ephemeral overlay glyph drawn on a node tile (Foundation A). Later steps
// fill these in: agent tracking (step 7) emits read/edit/write/create with an
// agent color; planning (step 8) emits the same with style "planned". `color` is
// resolved by the producer; the renderer only dims when style is "planned".
// `fill` is solid on the node actually touched, outline on an ancestor directory
// that contains it (the glyph propagated up the tree).
type Overlay = { action: Action; color: TuiThemeCurrent["text"]; style: Style; fill: Fill }

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  // Reactive terminal size: column mode reclaims the reserved scrollbar row when the strip
  // fits the viewport (see scrollbarVisible / barHeight below).
  const dimensions = useTerminalDimensions()
  const [scope, setScope] = createSignal("")
  // The file (repo-relative path) the user has drilled into for function-level paint
  // (A5), or undefined. Sent as `drill` on the fetch; the server returns the file's
  // `extents` and schedules the drill-in painter. Clicking a file toggles it.
  const [drilledFile, setDrilledFile] = createSignal<string | undefined>(undefined)
  const toggleDrill = (path: string) => setDrilledFile((cur) => (cur === path ? undefined : path))
  // Navigating the directory tree clears the drilled file (its tiles belong to the
  // view you left). Deferred so it doesn't fire on mount.
  createEffect(on(scope, () => setDrilledFile(undefined), { defer: true }))
  // Click-to-navigate from chat (A4): a file/dir reference clicked in the chat
  // publishes a re-root request on the shared nav bus; honour it by re-scoping.
  createEffect(
    on(
      apertureNavRequest,
      (req) => {
        if (req) setScope(req.scope)
      },
      { defer: true },
    ),
  )

  // Layer-0 directories whose child row is expanded past MAX_CHILDREN to show all
  // children (the unlimited horizontal strip makes this cheap). Keyed by node id.
  // Reset on every scope change so navigating the tree always lands on the compact
  // 4-children + "…" view; horizontal scrolling doesn't touch scope, so an expanded
  // directory stays expanded while you pan.
  const [expanded, setExpanded] = createSignal(new Set<string>())
  // Column mode (APERTURE_LAYOUT === "column"): per-layer-0 vertical scroll offset for
  // a child list taller than COLUMN_CHILD_WINDOW. Keyed by node id; a wheel over the list
  // shifts the visible window row-by-row in place rather than panning the bar sideways
  // (see onChildScroll). Reset on scope change like `expanded` so navigation always lands
  // at the top of each list; panning doesn't touch scope, so an offset survives a pan.
  const [childOffset, setChildOffset] = createSignal(new Map<string, number>())
  createEffect(() => {
    scope()
    setExpanded(new Set<string>())
    setChildOffset(new Map<string, number>())
  })
  const expand = (id: string) => setExpanded((prev) => new Set(prev).add(id))
  // Foundation A hover-info line: what a node tile / link shows when pointed at.
  // Cleared on mouse-out so the header falls back to the summary. Set as a plain
  // string so any feature (node detail, edge target, …) can drive it uniformly.
  const [hovered, setHovered] = createSignal<string | undefined>()

  // Foundation B: per-turn agent activity, fed by session.next.* events. Empty
  // unless the experimental event system is on (graceful no-op otherwise).
  const activity = createActivityTracker(props.api, props.session_id)

  // Map an agent name to a stable theme color so concurrent agents are
  // distinguishable. Cycles the status palette by a hash of the name; step 8 may
  // pin specific agents (e.g. plan → a fixed hue).
  const agentColor = (agent: string) => themeColor(theme(), AGENT_PALETTE[hashString(agent) % AGENT_PALETTE.length])

  // Recompute on display (refresh=true): every scope we show — on navigation, on
  // the manual refresh button, and on a live invalidation event — is recomputed
  // from disk rather than served from the server cache. The 2-level scoped walk
  // is cheap, and this keeps a drilled-into view consistent with its parent (a
  // child that changed/vanished is reflected the moment you open it). The server
  // cache + invalidation still spare recompute for scopes nobody is viewing.
  const [graph, { refetch }] = createResource(
    () => ({ directory: props.api.state.path.directory, scope: scope(), drill: drilledFile() }),
    async (key) => {
      const result = await props.api.client.aperture.get(
        // `drill` (when set) makes the server attach the file's function-level extents
        // and schedule the drill-in paint pass; it supersedes refresh server-side.
        { scope: key.scope, refresh: "true", ...(key.drill ? { drill: key.drill } : {}) },
        { throwOnError: true },
      )
      return result.data as Graph
    },
  )

  // Step the active Lens one forward/back, wrapping at the ends. The
  // server flips the active Lens and publishes aperture.invalidated for the
  // viewed scope, which the subscription below turns into a refetch — so the repaint
  // rides the same path a `/lens`-driven switch already uses.
  const cycleLens = (direction: "next" | "prev") => {
    // Fire-and-forget: the repaint arrives via aperture.invalidated, so we don't
    // throwOnError (an unhandled rejection on a click) — a failed switch just
    // leaves the current Lens painted.
    void props.api.client.aperture.cycleLens({ direction })
  }

  // Live update: refetch only when the change is inside the scope we're showing.
  const off = props.api.event.on("aperture.invalidated", (event) => {
    if (event.properties.scope === scope()) refetch()
  })
  onCleanup(() => off())

  // Shell commands (rm, mv, git, scaffolding, …) mutate the tree without firing
  // file.edited, so nothing else invalidates the view. Recompute is cheap, so we
  // just refetch the current scope whenever this session's agent finishes a shell
  // command. (session.next.* rides the experimental event system; when it's off
  // this is simply inert and the manual ⟳ / navigation refresh still cover it.)
  const offShell = props.api.event.on("session.next.shell.ended", (event) => {
    if (event.properties.sessionID === props.session_id) refetch()
  })
  onCleanup(() => offShell())

  // A turn boundary — the shown session, or a sub-agent (build/plan) it spawned, going
  // idle — is when shell-driven tree mutations that emit no file.edited (most notably
  // `rm`) have settled, so we recompute then. session.status is a core event (unlike the
  // experimental session.next.* family), so this fires even with the experimental event
  // system off, and a fresh user prompt flips the session busy→idle again, covering the
  // "user's turn begins" case too. Recompute is cheap, so an unconditional refetch is fine.
  const offIdle = props.api.event.on("session.status", (event) => {
    if (event.properties.status.type !== "idle") return
    const sid = event.properties.sessionID
    if (sid === props.session_id || props.api.state.session.get(sid)?.parentID === props.session_id) refetch()
  })
  onCleanup(() => offIdle())

  // Catch-all for changes nothing tells us about (manual IDE edits, external tools): a
  // low-frequency poll. Skipped while a fetch is already in flight so a slow walk can't
  // stack up refetches.
  const poll = setInterval(() => {
    if (!graph.loading) refetch()
  }, REFRESH_POLL_MS)
  onCleanup(() => clearInterval(poll))

  // Guarded reads — never call the resource accessor in its error state (the
  // documented render→catch→re-render leak, PLAN.md). The frame stays mounted.
  const nodes = () => (graph.error ? [] : (graph()?.nodes ?? []))
  const summary = () => {
    if (graph.error) return "fetch error"
    const g = graph()
    return g ? `${g.nodes.length} nodes · ${g.edges.length} edges` : "loading…"
  }
  const hueOf = (nodeID: string) => (graph.error ? undefined : graph()?.semantics[nodeID]?.hue)
  // The active Lens's legend (facet → label + colour) drives the swatch row and the
  // facet → colour map used to paint nodes/composition — no hard-coded vocabulary.
  const legendEntries = () => (graph.error ? [] : (graph()?.lens?.legend ?? []))
  const activeName = () => (graph.error ? "" : (graph()?.lens?.name ?? ""))
  const activeId = () => (graph.error ? "" : (graph()?.lens?.id ?? ""))
  // Built-in Lenses (the protected group, e.g. Architecture) are immutable — no
  // delete affordance for them. Gated on the group so new built-ins are covered too.
  const canDeleteActive = () => activeId() !== "" && !BUILTIN_LENS_IDS.has(activeId())

  // Delete the active Lens via the ✕ control. Two-step: the first click arms a
  // "confirm?" state, the second performs the delete. Fire-and-forget — the repaint
  // (and the fall-back to Architecture) rides aperture.invalidated like a cycle.
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const deleteActiveLens = () => {
    if (!canDeleteActive()) return
    if (!confirmingDelete()) {
      setConfirmingDelete(true)
      return
    }
    setConfirmingDelete(false)
    void props.api.client.aperture.deleteLens({ lens: activeId() })
  }
  // Disarm the confirm if the active Lens changes out from under us.
  createEffect(() => {
    activeId()
    setConfirmingDelete(false)
  })
  const colorByFacet = createMemo(() => new Map(legendEntries().map((e) => [e.facet, e.color])))
  // A facet id → colour: the NONE_FACET escape paints the "Other" grey; a real facet paints
  // its legend colour (hex palette or theme role).
  const facetColor = (key: string): TuiThemeCurrent["text"] =>
    key === NONE_FACET ? resolveColor(theme(), NONE_HUE) : resolveColor(theme(), colorByFacet().get(key))
  // Resolve a treemap cell key to a colour: the grey sentinel → the dimmer non-code
  // grey; a facet id (incl. NONE_FACET) → its facet colour; null padding → the panel bg.
  const colorFor = (key: string | null): TuiThemeCurrent["text"] => {
    if (key === GREY_CELL) return resolveColor(theme(), UNTAGGED_HUE)
    if (key) return facetColor(key)
    return theme().backgroundPanel
  }
  const boundaries = () => (graph.error ? [] : (graph()?.boundaries ?? []))
  const edgeList = () => (graph.error ? [] : (graph()?.edges ?? []))
  const compositionOf = (nodeID: string) => (graph.error ? undefined : graph()?.composition?.[nodeID])

  // A parent (layer-0) directory's multi-row treemap scales its cell count against the
  // biggest sibling at the same layer (by *whole-subtree* size, tagged or not), so the
  // largest block fills the grid and the rest read at their true proportion — a few
  // tagged files never inflate a directory to full size. (Child directories paint a
  // fixed-width bar that fills their tile, so they don't need this.)
  const maxDirSubtreeAt = (layer: number) => {
    let max = 0
    for (const n of nodes()) {
      if (n.kind !== "directory" || n.position.layer !== layer) continue
      const c = compositionOf(n.id)
      if (c) max = Math.max(max, metricSubtree(c))
    }
    return max
  }
  const maxDirSubtree0 = createMemo(() => maxDirSubtreeAt(0))

  // File tiles paint their layer color as the tile *background* with dark text/glyphs
  // (vs the old colored text). Untagged files keep the muted-text, no-background look
  // until the sweep tags them.
  const fileTagged = (id: string) => !!hueOf(id)
  const fileBg = (id: string) => {
    const hue = hueOf(id)
    return hue ? resolveColor(theme(), hue) : undefined
  }
  const fileFg = (id: string) => (fileTagged(id) ? theme().background : theme().textMuted)
  // Column-mode file row: the file's single layer color (or panel bg when untagged)
  // spread across `width` columns, so a file paints as a flat 1-row bar matching the
  // borderless child-directory bars beside it (childDirColors' file analogue).
  const fileRowColors = (id: string, width: number): (TuiThemeCurrent["text"] | undefined)[] => {
    // A drilled-into file (the only one the server sends extents for) paints as a
    // positional band of its functions; every other file is its single flat hue.
    const ex = extentsForId(id)
    if (ex && ex.length) return fileExtentColors(ex, width)
    return Array.from({ length: width }, () => fileBg(id))
  }
  // Guarded extents accessor — never call the resource in its error state (the
  // documented render→catch→re-render leak, PLAN.md).
  const extentsForId = (id: string) => (graph.error ? undefined : graph()?.extents?.[id])
  // Lay a drilled file's extents across `width` columns in file order: each segment
  // sized by its line span, coloured by its facet (grey until the function is painted),
  // so the bar reads as a left-to-right strip of where each concept lives in the file.
  const fileExtentColors = (
    extents: readonly GraphExtent[],
    width: number,
  ): (TuiThemeCurrent["text"] | undefined)[] => {
    const bands = extents.map((e) => ({ key: e.facet ?? GREY_CELL, value: Math.max(1, e.endLine - e.startLine + 1) }))
    const alloc = allocateCells(bands, width)
    const flat: TuiThemeCurrent["text"][] = []
    for (const a of alloc) for (let i = 0; i < a.n; i++) flat.push(colorFor(a.key))
    while (flat.length < width) flat.push(theme().backgroundPanel)
    return flat
  }
  // The extent band for a file id at `width`, or undefined when it isn't the drilled
  // file. Drives the grid FileTile's drilled-state strip.
  const bandForFile = (id: string, width: number) => {
    const ex = extentsForId(id)
    return ex && ex.length ? fileExtentColors(ex, width) : undefined
  }
  // Whole-subtree size of a node (0 when it has no composition yet), the metric the
  // column-mode block width scales by (same denominator as maxDirSubtree0).
  const subtreeOf = (id: string) => {
    const c = compositionOf(id)
    return c ? metricSubtree(c) : 0
  }
  // Parent directory blocks carry their name in a label row; it brightens on hover.
  const dirLabelFg = (node: GraphNode) => (hoveredId() === node.id ? theme().accent : theme().textMuted)

  // Per-character background colors for a child directory's name row: the *whole-subtree*
  // composition spread across `width` columns — each tag takes its byte-proportion and the
  // not-yet-tagged / non-code remainder fills the rest in grey, so the bar starts all grey
  // and tags only ever occupy their true share as the sweep fills in.
  const childDirColors = (id: string, width: number): (TuiThemeCurrent["text"] | undefined)[] => {
    const comp = compositionOf(id)
    const bands = comp ? compositionBands(comp) : []
    if (bands.length === 0) return Array.from({ length: width }, () => resolveColor(theme(), UNTAGGED_HUE))
    const alloc = allocateCells(bands, width)
    const flat: TuiThemeCurrent["text"][] = []
    for (const a of alloc) for (let i = 0; i < a.n; i++) flat.push(colorFor(a.key))
    while (flat.length < width) flat.push(theme().backgroundPanel)
    return flat
  }

  // Which node tile the mouse is over, for the in-window import highlight. Kept
  // separate from the `hovered` info-line string so the highlight survives when a
  // boundary tile (not a node) drives the info line.
  const [hoveredId, setHoveredId] = createSignal<string>()

  // id → boundary, for the out-of-window targets an edge can point at.
  const boundaryById = createMemo(() => new Map(boundaries().map((b) => [b.id, b] as const)))

  // Per node: its out-of-window import targets (edges from the node to a boundary).
  // Drives the boundary-tile strip and the hover line's "→ targets" list.
  const boundariesFor = createMemo(() => {
    const byId = boundaryById()
    const m = new Map<string, GraphBoundary[]>()
    for (const e of edgeList()) {
      const b = byId.get(e.to)
      if (!b) continue
      const arr = m.get(e.from) ?? []
      arr.push(b)
      m.set(e.from, arr)
    }
    return m
  })

  // In-window adjacency (both directions) so hovering a node lights up everything
  // it imports and everything that imports it. Boundary edges are excluded — those
  // are surfaced as tiles, not highlights.
  const adjacency = createMemo(() => {
    const byId = boundaryById()
    const m = new Map<string, Set<string>>()
    const link = (a: string, b: string) => (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b)
    for (const e of edgeList()) {
      if (byId.has(e.to)) continue
      link(e.from, e.to)
      link(e.to, e.from)
    }
    return m
  })

  // Border color for a node tile under the current hover: the hovered node itself
  // gets the bright foreground; its in-window neighbors are tinted by *their own*
  // layer hue (the dependency's semantics); everything else stays the plain border.
  const borderColorFor = (node: GraphNode) => {
    const hid = hoveredId()
    if (!hid) return theme().border
    if (node.id === hid) return theme().text
    if (adjacency().get(hid)?.has(node.id)) return hueColor(theme(), hueOf(node.id), node.kind)
    return theme().border
  }
  const enterNode = (node: GraphNode) => {
    setHovered(hoverNode(node))
    setHoveredId(node.id)
  }
  const leaveNode = () => {
    setHovered(undefined)
    setHoveredId(undefined)
  }

  // Overlay glyphs for a node tile: this turn's agent activity. One glyph per
  // distinct action, colored by the agent that most recently performed it. A file
  // shows *solid* glyphs for actions taken on it directly; a directory shows
  // *outline* glyphs for actions on any file it contains, so activity propagates up
  // to its parents and grandparents. A direct (solid) action always wins over a
  // containment (outline) one for the same action. Reactive via the activity index;
  // planned styling arrives with step 8.
  const overlaysFor = (node: GraphNode): Overlay[] => {
    const byAction = new Map<Action, Overlay>()
    // Scan newest→oldest so the first entry seen for an action carries the most
    // recent agent's color; a solid is never overwritten by a later outline.
    const consider = (entries: ActivityEntry[], fill: Fill) => {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!
        const prev = byAction.get(e.action)
        if (prev && (prev.fill === "solid" || prev.fill === fill)) continue
        byAction.set(e.action, { action: e.action, color: agentColor(e.agent), style: "actual", fill })
      }
    }
    consider(activity.entriesFor(node.path), "solid")
    if (node.kind === "directory") consider(activity.descendantsFor(node.path), "outline")
    return ACTIONS.filter((a) => byAction.has(a)).map((a) => byAction.get(a)!)
  }

  // Hover text for a node: its path/size, plus the latest action on it this turn.
  const hoverNode = (node: GraphNode) => {
    const base = describeNode(node)
    // List out-of-window import targets so a dependency that left the window is
    // still legible even though it can't be drawn as an in-window highlight.
    const outs = boundariesFor().get(node.id) ?? []
    const withOut = outs.length ? `${base} · →${outs.map((b) => basename(b.path)).join(" ")}` : base
    const entries = activity.entriesFor(node.path)
    const latest = entries[entries.length - 1]
    return latest
      ? `${withOut} · ${latest.agent} ${ACTION_LABEL[latest.action]} ${relTime(latest.timestamp)}`
      : withOut
  }

  // Layer-0 nodes are the squares; layer-1 nodes hang under their parent (grouped
  // by path prefix). Memoized on the node set so it recomputes only on new data.
  const tree = createMemo(() => {
    const all = nodes()
    const layer0 = all.filter((n) => n.position.layer === 0).toSorted((a, b) => a.position.index - b.position.index)
    const byParent = new Map<string, GraphNode[]>()
    for (const n of all) {
      if (n.position.layer !== 1) continue
      const bucket = byParent.get(posixDir(n.path)) ?? []
      bucket.push(n)
      byParent.set(posixDir(n.path), bucket)
    }
    for (const bucket of byParent.values()) bucket.sort((a, b) => a.position.index - b.position.index)
    // Full child list per layer-0 node; how many actually render is decided at draw
    // time from the per-directory expanded state (see the `shownChildren` accessor).
    return layer0.map((node) => ({ node, children: byParent.get(node.path) ?? [] }))
  })

  // One layer-0 column's terminal-width footprint (column mode), the single source shared by
  // the render below and the content-width sum that decides whether the horizontal scrollbar
  // shows. Directories take their size-scaled block width; files the fixed/sparse file width
  // — mirroring the cols()/fileW() the render uses, so the two never drift.
  const columnWidth = (node: GraphNode) =>
    node.kind === "directory"
      ? columnOuterW(columnColsFor(subtreeOf(node.id), maxDirSubtree0(), tree().length))
      : tree().length < COLUMN_FEW_THRESHOLD
        ? columnOuterW(COLUMN_COLS_MAX)
        : COLUMN_FILE_W

  // Whether the strip overflows the viewport horizontally — i.e. whether OpenTUI will draw
  // the horizontal scrollbar on the scrollbox's bottom row. Computed from data + terminal
  // width rather than read off the renderable (no per-frame polling, no layout-timing race):
  // the strip's width is the sum of the column footprints plus the inter-column gaps, and the
  // viewport is the full-width bar less its own horizontal padding. Column mode only.
  const contentWidth = createMemo(() => {
    const items = tree()
    if (items.length === 0) return 0
    return items.reduce((sum, it) => sum + columnWidth(it.node), 0) + SCROLL_GAP * (items.length - 1)
  })
  const scrollbarVisible = createMemo(
    () => APERTURE_LAYOUT === "column" && contentWidth() > dimensions().width - BAR_PADDING_X * 2,
  )
  // Bar height: the base budget, plus the one reserved scrollbar row only while the scrollbar
  // is actually showing — so a strip that fits gives the row back to the conversation below.
  const barHeight = () => TOP_BAR_HEIGHT + (scrollbarVisible() ? 1 : 0)

  const crumbs = () => {
    const s = scope()
    if (s === "") return []
    const segs = s.split("/")
    return segs.map((seg, i) => ({ label: seg, path: segs.slice(0, i + 1).join("/") }))
  }
  const upTarget = () => {
    const s = scope()
    const i = s.lastIndexOf("/")
    return i === -1 ? "" : s.slice(0, i)
  }

  // The bar lays its tiles out in a single horizontal strip that overflows the
  // viewport, so it scrolls sideways only. A native left/right wheel is handled by
  // the scrollbox itself; here we redirect a vertical (up/down) wheel into the same
  // horizontal motion so either gesture pans the strip. Shift+wheel is left alone —
  // the scrollbox already remaps that to horizontal, and double-handling it would
  // scroll twice as far.
  let scroll: ScrollBoxRenderable | undefined
  const onWheel = (event: MouseEvent) => {
    const dir = event.scroll?.direction
    if (!scroll || event.modifiers.shift || (dir !== "up" && dir !== "down")) return
    const cells = (event.scroll?.delta ?? 1) * HSCROLL_STEP
    scroll.scrollLeft += dir === "up" ? -cells : cells
  }

  return (
    <box
      flexShrink={0}
      height={barHeight()}
      flexDirection="column"
      backgroundColor={theme().backgroundPanel}
      paddingLeft={BAR_PADDING_X}
      paddingRight={BAR_PADDING_X}
      border={["bottom"]}
      borderColor={theme().border}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Aperture</b>
        </text>
        {/* Hover-info line (Foundation A): a node's path/size while pointed at,
            otherwise the node/edge count. Shared by all overlay features. */}
        <text fg={hovered() ? theme().text : theme().textMuted} wrapMode="none">
          {hovered() ?? summary()}
        </text>
      </box>

      {/* Navigation row: refresh + root + up + breadcrumb. Always present so the
          graph area below doesn't jump as the user drills in and out. */}
      <box flexDirection="row" gap={1} height={1} flexShrink={0}>
        <text fg={theme().accent} onMouseDown={() => refetch()}>
          ⟳
        </text>
        <Show when={scope() !== ""} fallback={<text fg={theme().textMuted}>/</text>}>
          <text fg={theme().accent} onMouseDown={() => setScope("")}>
            ⌂
          </text>
          <text fg={theme().accent} onMouseDown={() => setScope(upTarget())}>
            ◀
          </text>
          <For each={crumbs()}>
            {(crumb, i) => (
              <text fg={i() === crumbs().length - 1 ? theme().text : theme().textMuted} onMouseDown={() => setScope(crumb.path)}>
                {(i() === 0 ? "" : "/ ") + crumb.label}
              </text>
            )}
          </For>
        </Show>
      </box>

      {/* Legend: the fixed architectural-layer vocabulary the async painter paints
          with. Stable row so the swatches don't move as nodes get (re)tagged. */}
      <box flexDirection="row" gap={2} height={1} flexShrink={0}>
        {/* Active Lens name flanked by ◀/▶ arrows that step (and loop)
            through the available Lenses, the click-driven sibling of /lens. */}
        <Show when={activeName()}>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={theme().accent} onMouseDown={() => cycleLens("prev")} wrapMode="none">
              ◀
            </text>
            {/* Clicking the name advances like ▶, giving the forward step a bigger hit area. */}
            <text fg={theme().accent} onMouseDown={() => cycleLens("next")} wrapMode="none">
              {activeName()}
            </text>
            <text fg={theme().accent} onMouseDown={() => cycleLens("next")} wrapMode="none">
              ▶
            </text>
            {/* Open the searchable Lens picker (A2) — the scalable alternative to
                cycling once there are many Lenses. */}
            <text fg={theme().textMuted} onMouseDown={() => openLensPicker(props.api)} wrapMode="none">
              ⌄
            </text>
            {/* Delete the active (user) collection: click to arm, click again to
                confirm. Hidden for the immutable built-in Architecture collection. */}
            <Show when={canDeleteActive()}>
              <text
                fg={confirmingDelete() ? theme().error : theme().textMuted}
                onMouseDown={() => deleteActiveLens()}
                wrapMode="none"
              >
                {confirmingDelete() ? "✕ confirm?" : "✕"}
              </text>
            </Show>
          </box>
        </Show>
        <For each={legendEntries()}>
          {(entry) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={resolveColor(theme(), entry.color)} wrapMode="none">
                ■
              </text>
              <text fg={theme().textMuted} wrapMode="none">
                {" " + entry.label}
              </text>
            </box>
          )}
        </For>
        {/* "Other": code the painter judged unrelated to this Lens (NONE_FACET). */}
        <box flexDirection="row" flexShrink={0}>
          <text fg={resolveColor(theme(), NONE_HUE)} wrapMode="none">
            ■
          </text>
          <text fg={theme().textMuted} wrapMode="none">
            {" " + NONE_LABEL}
          </text>
        </box>
        {/* The dimmer grey: a subtree with nothing the painter sees as code (specs,
            fixtures, assets, …) or not yet swept. */}
        <box flexDirection="row" flexShrink={0}>
          <text fg={resolveColor(theme(), UNTAGGED_HUE)} wrapMode="none">
            ■
          </text>
          <text fg={theme().textMuted} wrapMode="none">
            {" " + UNTAGGED_LABEL}
          </text>
        </box>
      </box>

      {/* Agent-action glyphs, on their own row beneath the layer legend: the solid
          form (file touched) + the outline form (a directory containing it), per
          action. Drawn neutral here — at render time they take the acting agent's
          color. */}
      <box flexDirection="row" gap={2} height={1} flexShrink={0}>
        <For each={ACTIONS}>
          {(action) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={theme().text} wrapMode="none">
                {ACTION_GLYPH[action].solid + ACTION_GLYPH[action].outline}
              </text>
              <text fg={theme().textMuted} wrapMode="none">
                {" " + action}
              </text>
            </box>
          )}
        </For>
      </box>

      {/* Sideways-scrolling graph strip. The tiles lay out in a row that overflows
          the viewport and pans horizontally; a thin themed scrollbar marks the
          position and vertical-wheel panning is wired through onWheel above.

          NB: the scrollbox's `scrollX`/`scrollY` are *constructor-only* options, but
          the solid renderer builds every element with just `{ id }` and applies the
          rest as property assignments — which those two lack setters for, so passing
          them as props is silently inert. We instead configure the content box
          directly (it's what `scrollX`/`scrollY` ultimately size): clear its maxWidth
          so it can grow past the viewport (horizontal overflow → scroll), and pin
          maxHeight to 100% so the band can't scroll vertically. */}
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
        flexGrow={1}
        onMouseScroll={onWheel}
        contentOptions={{ flexDirection: "row", gap: SCROLL_GAP, maxWidth: undefined, maxHeight: "100%" }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{
          showArrows: false,
          trackOptions: { foregroundColor: theme().textMuted, backgroundColor: theme().backgroundPanel },
        }}
      >
        <For each={tree()}>
          {(item) => {
            // Column layout: only the top-layer directory is drawn richly, as a
            // size-scaled treemap block; its children hang beneath as a single borderless
            // column of 1-row composition bars (no drops, no grid, no separators). Children
            // past the bottom edge are clipped by the scrollbox.
            if (APERTURE_LAYOUT === "column") {
              const cols = () => columnColsFor(subtreeOf(item.node.id), maxDirSubtree0(), tree().length)
              // The column footprint comes from the shared columnWidth (kept under the outerW
              // / fileW names the markup already uses): for a directory it's the size-scaled
              // block width columnOuterW(cols()), for a file the fixed/sparse file width. Both
              // resolve item.node by kind, matching the Show that gates where each is used.
              const outerW = () => columnWidth(item.node)
              const fileW = () => columnWidth(item.node)
              // In-place vertical scroll for a child list taller than the window. When the
              // list overflows, a wheel over it pages the visible slice instead of panning
              // the bar; a "+N" marker stands in for the children hidden above / below. A
              // non-overflowing list keeps offset 0, shows everything, and lets the wheel
              // bubble out to the sideways pan (see onChildScroll).
              const total = item.children.length
              const overflow = total > COLUMN_CHILD_WINDOW
              // Largest offset that still fills the window: at the bottom a top marker eats
              // one row, so the last page shows COLUMN_CHILD_WINDOW-1 children ending on the
              // final child. Clamped so a refetch that shrinks the list can't strand it.
              const maxOffset = Math.max(0, total - COLUMN_CHILD_WINDOW + 1)
              const offset = () => (overflow ? Math.min(childOffset().get(item.node.id) ?? 0, maxOffset) : 0)
              // A top marker costs a row when scrolled; the rest hold children, less one more
              // for a bottom marker whenever the remaining children don't all fit.
              const aboveHidden = () => offset()
              const capacity = () => COLUMN_CHILD_WINDOW - (offset() > 0 ? 1 : 0)
              const childrenShown = () => {
                const remaining = total - offset()
                return remaining <= capacity() ? remaining : capacity() - 1
              }
              const visibleChildren = () => item.children.slice(offset(), offset() + childrenShown())
              const belowHidden = () => total - (offset() + childrenShown())
              const onChildScroll = (event: MouseEvent) => {
                const dir = event.scroll?.direction
                if (dir !== "up" && dir !== "down") return
                if (!overflow) return // let the wheel bubble out to the horizontal pan
                event.stopPropagation()
                const step = event.scroll?.delta ?? 1
                const next = Math.max(0, Math.min(maxOffset, offset() + (dir === "down" ? step : -step)))
                setChildOffset(new Map(childOffset()).set(item.node.id, next))
              }
              return (
                <box flexDirection="column" flexShrink={0}>
                  <Show
                    when={item.node.kind === "directory"}
                    fallback={
                      <FileTile
                        label={truncate(basename(item.node.path), fileW())}
                        kind={item.node.kind}
                        width={fileW()}
                        bg={() => fileBg(item.node.id)}
                        fg={() => fileFg(item.node.id)}
                        borderColor={() => borderColorFor(item.node)}
                        overlays={() => overlaysFor(item.node)}
                        theme={theme}
                        onEnter={() => enterNode(item.node)}
                        onLeave={() => leaveNode()}
                        onDrill={() => toggleDrill(item.node.path)}
                        bandColors={(w) => bandForFile(item.node.id, w)}
                      />
                    }
                  >
                    <DirBlock
                      label={truncate(basename(item.node.path), outerW())}
                      labelFg={() => dirLabelFg(item.node)}
                      showLabel={true}
                      rows={COLUMN_ROWS}
                      maxCols={cols()}
                      width={outerW()}
                      borderColor={() => borderColorFor(item.node)}
                      composition={() => compositionOf(item.node.id)}
                      colorFor={colorFor}
                      // Fill scales by byte size against the biggest sibling (like the grid
                      // treemap): a smaller directory paints fewer cells (bottom-aligned,
                      // the rest left empty) rather than filling its whole box.
                      maxSubtree={maxDirSubtree0}
                      overlays={() => overlaysFor(item.node)}
                      theme={theme}
                      onDrill={() => setScope(item.node.path)}
                      onEnter={() => enterNode(item.node)}
                      onLeave={() => leaveNode()}
                    />
                  </Show>
                  <box flexDirection="column" flexShrink={0} onMouseScroll={onChildScroll}>
                    {/* "↑ +N" stand-in for children scrolled off the top of the window: the
                        arrow points to where the hidden children are, the count says how
                        many. Same idea (pointing down) at the bottom for children below. */}
                    <Show when={aboveHidden() > 0}>
                      <box width={outerW()} height={1} flexShrink={0}>
                        <text fg={theme().textMuted} wrapMode="none">
                          {"↑ +" + aboveHidden()}
                        </text>
                      </box>
                    </Show>
                    <For each={visibleChildren()}>
                      {(cell) => {
                        // Agent-action glyphs (read/create/edit) ride the end of the row, as
                        // they do on the grid layout's ChildDirTile/FileTile. The name bar
                        // shrinks by the glyph count so the composition fill stays put and the
                        // glyphs sit flush at the right edge of the column's footprint.
                        const overlays = () => overlaysFor(cell)
                        const nameWidth = () => Math.max(0, outerW() - overlays().length)
                        return (
                          <box
                            width={outerW()}
                            flexDirection="row"
                            flexShrink={0}
                            onMouseDown={() => (cell.kind === "directory" ? setScope(cell.path) : toggleDrill(cell.path))}
                            onMouseOver={() => enterNode(cell)}
                            onMouseOut={() => leaveNode()}
                          >
                            <Show
                              when={cell.kind === "directory"}
                              fallback={
                                <NameRow
                                  name={truncate(basename(cell.path), nameWidth())}
                                  width={nameWidth()}
                                  colors={() => fileRowColors(cell.id, nameWidth())}
                                  textColor={() => fileFg(cell.id)}
                                  theme={theme}
                                />
                              }
                            >
                              <NameRow
                                name={truncate(basename(cell.path), nameWidth())}
                                width={nameWidth()}
                                colors={() => childDirColors(cell.id, nameWidth())}
                                textColor={() => theme().background}
                                theme={theme}
                              />
                            </Show>
                            <OverlayRow overlays={overlays} theme={theme} />
                          </box>
                        )
                      }}
                    </For>
                    <Show when={belowHidden() > 0}>
                      <box width={outerW()} height={1} flexShrink={0}>
                        <text fg={theme().textMuted} wrapMode="none">
                          {"↓ +" + belowHidden()}
                        </text>
                      </box>
                    </Show>
                  </box>
                </box>
              )
            }
            const bnds = boundariesFor().get(item.node.id) ?? []
            const shownBnds = bnds.slice(0, MAX_CHILDREN)
            const bndOverflow = bnds.length - MAX_CHILDREN
            const hasChildren = item.children.length > 0
            // A "…" tile only appears once there are *more* than MAX_CHILDREN children
            // (so a directory with exactly a full grid shows every child), and clicking
            // it expands the grid in place. When collapsed past capacity we surrender
            // the grid's last cell to "…", so only MAX_CHILDREN-1 real children show.
            const collapsed = () => !expanded().has(item.node.id) && item.children.length > MAX_CHILDREN
            const shownChildren = () => (collapsed() ? item.children.slice(0, MAX_CHILDREN - 1) : item.children)
            const overflow = () => item.children.length - shownChildren().length
            // Grid cells: the shown children, plus the "…" sentinel pinned last
            // (bottom-right) when collapsed, chunked into CHILD_COLS-wide rows.
            const cells = (): (GraphNode | typeof OVERFLOW)[] =>
              collapsed() ? [...shownChildren(), OVERFLOW] : [...shownChildren()]
            const childRows = () => {
              const all = cells()
              const rows: (GraphNode | typeof OVERFLOW)[][] = []
              for (let i = 0; i < all.length; i += CHILD_COLS) rows.push(all.slice(i, i + CHILD_COLS))
              return rows
            }
            // Only the top grid row carries containment drops; the block lines up with
            // the grid's width (its top row), not the directory's full child count — so
            // an all-ignored directory shrinks to a small box.
            const topRow = () => childRows()[0] ?? []
            const dirMaxCols = () => treemapColsFor(topRow().length)
            return (
              <box flexDirection="column" flexShrink={0} gap={0}>
                <Show
                  when={item.node.kind === "directory"}
                  fallback={
                    <FileTile
                      label={truncate(basename(item.node.path), MAX_LABEL)}
                      kind={item.node.kind}
                      topSpacer={2}
                      bg={() => fileBg(item.node.id)}
                      fg={() => fileFg(item.node.id)}
                      borderColor={() => borderColorFor(item.node)}
                      overlays={() => overlaysFor(item.node)}
                      theme={theme}
                      onEnter={() => enterNode(item.node)}
                      onLeave={() => leaveNode()}
                      onDrill={() => toggleDrill(item.node.path)}
                      bandColors={(w) => bandForFile(item.node.id, w)}
                    />
                  }
                >
                  <DirBlock
                    label={truncate(basename(item.node.path), MAX_LABEL)}
                    labelFg={() => dirLabelFg(item.node)}
                    showLabel={true}
                    rows={MAX_ROWS}
                    maxCols={dirMaxCols()}
                    borderColor={() => borderColorFor(item.node)}
                    composition={() => compositionOf(item.node.id)}
                    colorFor={colorFor}
                    maxSubtree={maxDirSubtree0}
                    overlays={() => overlaysFor(item.node)}
                    theme={theme}
                    onDrill={() => setScope(item.node.path)}
                    onEnter={() => enterNode(item.node)}
                    onLeave={() => leaveNode()}
                  />
                </Show>

                {/* Containment edges: one white │ drop per *top-row* child only. The
                    lower grid row hangs directly beneath with no drop, so its tiles
                    read as the parent's children (siblings of the top row) rather than
                    grandchildren. Drops mirror the grid's fixed CHILD_W + gap so each
                    aligns to its child regardless of label length. */}
                <Show when={hasChildren}>
                  <box flexDirection="row" gap={1} height={1} flexShrink={0}>
                    <For each={topRow()}>
                      {() => (
                        <box width={CHILD_W} alignItems="center" flexShrink={0}>
                          <text fg={theme().text} wrapMode="none">
                            │
                          </text>
                        </box>
                      )}
                    </For>
                  </box>
                </Show>

                {/* Child grid: CHILD_COLS-wide rows stacked top→bottom. Clicking the
                    bottom-right "…" expands every child into the grid in place (extra
                    rows). No collapse affordance by design — navigating away resets
                    every directory to compact. */}
                <box flexDirection="column" flexShrink={0}>
                  <For each={childRows()}>
                    {(row) => (
                      <box flexDirection="row" gap={1} flexShrink={0}>
                        <For each={row}>
                          {(cell) =>
                            cell === OVERFLOW ? (
                              <box
                                width={CHILD_W}
                                border
                                customBorderChars={SQUARE_CORNERS}
                                borderColor={theme().border}
                                flexShrink={0}
                                onMouseDown={() => expand(item.node.id)}
                                onMouseOver={() => setHovered(`+${overflow()} more in ${basename(item.node.path)}/`)}
                                onMouseOut={() => setHovered(undefined)}
                              >
                                <text fg={theme().accent} wrapMode="none">
                                  …
                                </text>
                              </box>
                            ) : (
                              <box width={CHILD_W} flexShrink={0}>
                                <Show
                                  when={cell.kind === "directory"}
                                  fallback={
                                    <FileTile
                                      label={truncate(basename(cell.path), MAX_CHILD_LABEL)}
                                      kind={cell.kind}
                                      width={CHILD_W}
                                      bg={() => fileBg(cell.id)}
                                      fg={() => fileFg(cell.id)}
                                      borderColor={() => borderColorFor(cell)}
                                      overlays={() => overlaysFor(cell)}
                                      theme={theme}
                                      onEnter={() => enterNode(cell)}
                                      onLeave={() => leaveNode()}
                                      onDrill={() => toggleDrill(cell.path)}
                                      bandColors={(w) => bandForFile(cell.id, w)}
                                    />
                                  }
                                >
                                  <ChildDirTile
                                    name={truncate(basename(cell.path), CHILD_W - 2)}
                                    width={CHILD_W}
                                    colors={() => childDirColors(cell.id, CHILD_W - 2)}
                                    textColor={() => theme().background}
                                    borderColor={() => borderColorFor(cell)}
                                    overlays={() => overlaysFor(cell)}
                                    theme={theme}
                                    onDrill={() => setScope(cell.path)}
                                    onEnter={() => enterNode(cell)}
                                    onLeave={() => leaveNode()}
                                  />
                                </Show>
                              </box>
                            )
                          }
                        </For>
                      </box>
                    )}
                  </For>
                </box>

                {/* Out-of-window imports (step 6): white │ drops into a row of
                    boundary tiles, each a square colored by the target's layer hue.
                    Click a tile to re-root at the target's directory. */}
                <Show when={shownBnds.length > 0}>
                  <box flexDirection="row" gap={1} height={1} flexShrink={0}>
                    <For each={shownBnds}>
                      {() => (
                        <box width={TILE_W} alignItems="center" flexShrink={0}>
                          <text fg={theme().text} wrapMode="none">
                            │
                          </text>
                        </box>
                      )}
                    </For>
                  </box>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <For each={shownBnds}>
                      {(b) => (
                        <box
                          width={TILE_W}
                          alignItems="center"
                          flexShrink={0}
                          onMouseDown={() => setScope(posixDir(b.path))}
                          onMouseOver={() => setHovered(b.path)}
                          onMouseOut={() => setHovered(undefined)}
                        >
                          <text fg={hueColor(theme(), hueOf(b.id), "file")} wrapMode="none">
                            ▪
                          </text>
                        </box>
                      )}
                    </For>
                    <Show when={bndOverflow > 0}>
                      <box width={TILE_W} alignItems="center" flexShrink={0}>
                        <text fg={theme().textMuted} wrapMode="none">
                          …
                        </text>
                      </box>
                    </Show>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )
}

// --- overlay layer (Foundation A) ------------------------------------------

// Glyph strip drawn to the right of a node label. `overlays` and `theme` are
// accessors so the strip stays reactive to live activity (step 7) and to theme
// switches. Planned overlays are dimmed; actual ones use the producer's color
// (e.g. the acting agent's) unless `color` overrides it — file tiles force the
// glyphs to the tile's dark foreground so they read against the colored background.
// Renders nothing until a feature fills `overlaysFor`.
function OverlayRow(props: {
  overlays: () => Overlay[]
  theme: () => TuiThemeCurrent
  color?: () => TuiThemeCurrent["text"]
}) {
  return (
    <Show when={props.overlays().length > 0}>
      <box flexDirection="row" flexShrink={0}>
        <For each={props.overlays()}>
          {(o) => (
            <text fg={o.style === "planned" ? props.theme().textMuted : (props.color?.() ?? o.color)} wrapMode="none">
              {ACTION_GLYPH[o.action][o.fill]}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

// --- treemap layer ---------------------------------------------------------

// A directory rendered as its subtree's composition: an optional clickable label
// over a *bordered* grid of layer-colored cells. The border frames the block so it
// reads as a real directory even when empty (an empty/untagged subtree paints solid
// grey rather than vanishing into the panel). The whole block re-roots on click.
// Layer-0 blocks show a label and grow to MAX_ROWS tall; layer-1 children drop the
// label and paint a single-row composition bar inside the child tile's border.
function DirBlock(props: {
  label: string
  labelFg: () => TuiThemeCurrent["text"]
  showLabel: boolean
  rows: number
  maxCols: number
  width?: number
  borderColor: () => TuiThemeCurrent["text"]
  composition: () => Composition | undefined
  colorFor: (key: string | null) => TuiThemeCurrent["text"]
  maxSubtree: () => number
  overlays: () => Overlay[]
  theme: () => TuiThemeCurrent
  onDrill: () => void
  onEnter: () => void
  onLeave: () => void
}) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      onMouseDown={() => props.onDrill()}
      onMouseOver={() => props.onEnter()}
      onMouseOut={() => props.onLeave()}
    >
      <Show when={props.showLabel}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={props.labelFg()} wrapMode="none">
            {props.label}
          </text>
          <OverlayRow overlays={props.overlays} theme={props.theme} />
        </box>
      </Show>
      <box border customBorderChars={SQUARE_CORNERS} borderColor={props.borderColor()} width={props.width} flexShrink={0}>
        <TreemapBlock
          composition={props.composition}
          colorFor={props.colorFor}
          rows={props.rows}
          maxCols={props.maxCols}
          maxSubtree={props.maxSubtree}
          theme={props.theme}
        />
      </box>
    </box>
  )
}

// The colored grid itself, painted *inside* the directory's border. Cell count scales
// (sqrt, so small dirs stay visible) against the biggest sibling's *whole-subtree* size
// and is capped to maxCols × rows; cells are split across the tag bands plus a trailing
// grey band for the not-yet-tagged / non-code remainder, by largest-remainder rounding,
// laid out in fixed-order bands bottom-aligned (the footing stays full, growth appears
// on top). So a directory reads at its true size, starts all grey, and each tag only
// occupies its real byte-proportion as the sweep fills in — rather than a handful of
// tagged files painting the whole block.
function TreemapBlock(props: {
  composition: () => Composition | undefined
  colorFor: (key: string | null) => TuiThemeCurrent["text"]
  rows: number
  maxCols: number
  maxSubtree: () => number
  theme: () => TuiThemeCurrent
}) {
  // Cells to paint for a directory of `size`, scaled (sqrt, floored at 1 when it has
  // any size) against the biggest sibling and capped to the grid.
  const scaleCells = (size: number, max: number, cap: number) =>
    max <= 0 || size <= 0 ? 0 : Math.max(1, Math.min(cap, Math.round(cap * Math.sqrt(size / max))))
  const grid = createMemo(() => {
    const comp = props.composition()
    const cap = props.maxCols * props.rows
    const bands = comp ? compositionBands(comp) : []
    // No descendant source files: keep the bordered box non-empty with one grey cell.
    if (bands.length === 0) return buildGrid([GREY_CELL], props.rows)
    // Size by whole-subtree against the biggest sibling, but floor at the band count
    // (capped) so every present tag gets at least one cell — a real tag is never an
    // invisible sliver, even when its byte-proportion would round to zero.
    const subtree = comp ? metricSubtree(comp) : 0
    const cellCount = Math.min(cap, Math.max(scaleCells(subtree, props.maxSubtree(), cap), bands.length))
    const alloc = allocateCells(bands, cellCount)
    const flat: string[] = []
    for (const a of alloc) for (let i = 0; i < a.n; i++) flat.push(a.key)
    // Degenerate (e.g. only zero-byte files): keep the bordered box non-empty.
    if (flat.length === 0) return buildGrid([GREY_CELL], props.rows)
    return buildGrid(flat, props.rows)
  })
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={grid()}>
        {(row) => (
          <box flexDirection="row" height={1} flexShrink={0}>
            <For each={coalesce(row)}>
              {(run) => (
                <box width={run.len * CELL_W} height={1} flexShrink={0} backgroundColor={props.colorFor(run.value)} />
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

// A file tile: dark label + glyphs over a layer-colored fill, painted on an *inner*
// box so the color sits inside the border ring (matching the in-painted directory
// treemaps) rather than under it. Untagged files have no fill and keep muted text.
// `topSpacer` pushes a parent-layer file down so its tile lines up with sibling
// directories (which carry a name row + top border above their treemap).
function FileTile(props: {
  label: string
  kind: GraphNode["kind"]
  width?: number
  topSpacer?: number
  bg: () => TuiThemeCurrent["text"] | undefined
  fg: () => TuiThemeCurrent["text"]
  borderColor: () => TuiThemeCurrent["text"]
  overlays: () => Overlay[]
  theme: () => TuiThemeCurrent
  onEnter: () => void
  onLeave: () => void
  // Click to drill into the file's function-level paint (A5); absent for boundary
  // probes / non-drillable tiles.
  onDrill?: () => void
  // When the file is drilled, builds a per-column band of its function extents (A5)
  // for the given inner width; the tile then paints that strip instead of its
  // single-hue fill. Returns undefined when the file isn't drilled.
  bandColors?: (width: number) => (TuiThemeCurrent["text"] | undefined)[] | undefined
}) {
  const band = () => props.bandColors?.(nameWidth())
  const nameWidth = () => Math.max(0, (props.width ?? 0) - 2 - props.overlays().length)
  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={(props.topSpacer ?? 0) > 0}>
        <box height={props.topSpacer} flexShrink={0} />
      </Show>
      <box
        border
        customBorderChars={cornersFor(props.kind)}
        borderColor={props.borderColor()}
        width={props.width}
        flexShrink={0}
        onMouseDown={() => props.onDrill?.()}
        onMouseOver={() => props.onEnter()}
        onMouseOut={() => props.onLeave()}
      >
        <Show
          when={band()?.length}
          fallback={
            <box backgroundColor={props.bg()} flexDirection="row" gap={1} flexShrink={0}>
              <text fg={props.fg()} wrapMode="none">
                {props.label}
              </text>
              <OverlayRow overlays={props.overlays} theme={props.theme} color={props.fg} />
            </box>
          }
        >
          <box flexDirection="row" height={1} flexShrink={0}>
            <NameRow name={props.label} width={nameWidth()} colors={() => band()!} textColor={props.fg} theme={props.theme} />
            <OverlayRow overlays={props.overlays} theme={props.theme} />
          </box>
        </Show>
      </box>
    </box>
  )
}

// A child-layer directory tile: a single bordered row whose name is painted in dark
// text *over* the directory's composition — each character cell carries the color of
// the layer at that column (or solid grey when nothing under it is tagged), so a
// child directory still reads its make-up behind its name. Drilling re-roots. When
// files beneath it saw activity this turn, the rightmost cells of the row carry the
// containment (outline) glyphs, so the name shrinks just enough to make room.
function ChildDirTile(props: {
  name: string
  width: number
  colors: () => (TuiThemeCurrent["text"] | undefined)[]
  textColor: () => TuiThemeCurrent["text"]
  borderColor: () => TuiThemeCurrent["text"]
  overlays: () => Overlay[]
  theme: () => TuiThemeCurrent
  onDrill: () => void
  onEnter: () => void
  onLeave: () => void
}) {
  // Inner cols (width − border) shared between the name and the glyph strip.
  const nameWidth = () => Math.max(0, props.width - 2 - props.overlays().length)
  return (
    <box
      border
      customBorderChars={SQUARE_CORNERS}
      borderColor={props.borderColor()}
      width={props.width}
      flexShrink={0}
      onMouseDown={() => props.onDrill()}
      onMouseOver={() => props.onEnter()}
      onMouseOut={() => props.onLeave()}
    >
      <box flexDirection="row" height={1} flexShrink={0}>
        <NameRow name={props.name} width={nameWidth()} colors={props.colors} textColor={props.textColor} theme={props.theme} />
        <OverlayRow overlays={props.overlays} theme={props.theme} />
      </box>
    </box>
  )
}

// One inner row of `width` character cells: each shows the name's character (or a
// space) in `textColor` over the per-column background from `colors` (undefined →
// panel). The per-character split is what lets dark text sit over a multi-color
// composition bar.
function NameRow(props: {
  name: string
  width: number
  colors: () => (TuiThemeCurrent["text"] | undefined)[]
  textColor: () => TuiThemeCurrent["text"]
  theme: () => TuiThemeCurrent
}) {
  const cells = createMemo(() => {
    const colors = props.colors()
    return Array.from({ length: props.width }, (_, i) => ({
      bg: colors[i] ?? props.theme().backgroundPanel,
      ch: props.name[i] ?? " ",
    }))
  })
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <For each={cells()}>
        {(c) => (
          <text bg={c.bg} fg={props.textColor()} wrapMode="none">
            {c.ch}
          </text>
        )}
      </For>
    </box>
  )
}

// Hover-info text for a node: its full repo-relative path (plus size for files).
function describeNode(node: GraphNode) {
  if (node.kind === "directory") return node.path + "/"
  return `${node.path} · ${formatBytes(node.size)}`
}

// Theme status keys cycled to give each agent a distinct, stable color.
const AGENT_PALETTE = ["accent", "info", "success", "warning", "error"] as const

function hashString(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// Compact "time since" for the hover line (e.g. "12s", "3m", "2h").
function relTime(ts: number) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// --- helpers ---------------------------------------------------------------

function basename(p: string) {
  return p.split("/").pop() ?? p
}

function posixDir(p: string) {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

// --- treemap math ----------------------------------------------------------

// The metric (bytes or count) a composition is weighed by. Both are carried so the
// switch is a single constant; `metricTotal` is the directory's total, `metricValue`
// one layer's share.
function metricTotal(c: Composition) {
  return TREEMAP_METRIC === "bytes" ? c.totalBytes : c.totalCount
}
function metricValue(w: FacetWeight) {
  return TREEMAP_METRIC === "bytes" ? w.bytes : w.count
}
// The whole-subtree size (all descendant files, tagged or not), used as the denominator
// so a directory is always sized and split against its real size.
function metricSubtree(c: Composition) {
  return TREEMAP_METRIC === "bytes" ? c.subtreeBytes : c.subtreeCount
}

// Allocation bands for a directory: one per tag (its byte/count share) plus a trailing
// grey band (GREY_CELL) for the not-yet-tagged / non-code remainder (whole subtree minus
// the tagged total). Because the bands sum to the whole subtree, a freshly-created
// collection starts fully grey and each tag only ever grows to its true proportion as
// the background sweep fills in — instead of a few tagged files painting a whole
// directory. Returns [] only when the directory has no descendant source files at all.
function compositionBands(c: Composition): { key: string; value: number }[] {
  const bands = c.weights.map((w) => ({ key: w.facet, value: metricValue(w) }))
  const remainder = metricSubtree(c) - metricTotal(c)
  if (remainder > 0) bands.push({ key: GREY_CELL, value: remainder })
  return bands
}

// --- hue mapping -----------------------------------------------------------

// Agent-inferred hues are named theme colors. Until the semantic layer exists
// (step 4) every node falls back to a structural color (directories accented,
// files muted), so the bar is useful immediately.
function hueColor(theme: TuiThemeCurrent, hue: string | undefined, kind: GraphNode["kind"]) {
  if (hue) return resolveColor(theme, hue)
  return kind === "directory" ? themeColor(theme, DIRECTORY_HUE) : theme.textMuted
}

// Resolve a theme role key (e.g. "info") to a theme color — the architecture
// collection's hues and the agent palette use these.
function themeColor(theme: TuiThemeCurrent, key: string) {
  return key in theme ? (theme[key as keyof TuiThemeCurrent] as TuiThemeCurrent["text"]) : theme.textMuted
}

// Resolve a collection colour: a literal "#RRGGBB" (user palettes) → RGBA, or a theme
// role key (architecture collection) → the theme's colour. Unknown/absent → muted.
function resolveColor(theme: TuiThemeCurrent, color: string | undefined): TuiThemeCurrent["text"] {
  if (!color) return theme.textMuted
  if (color.startsWith("#")) return hexToRgba(color)
  return color in theme ? (theme[color as keyof TuiThemeCurrent] as TuiThemeCurrent["text"]) : theme.textMuted
}

function hexToRgba(hex: string): TuiThemeCurrent["text"] {
  const h = hex.replace("#", "")
  return RGBA.fromInts(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      aperture_top(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
  // A2: searchable Lens picker, reachable from the command palette / `/lens-switch`
  // (and from a click on the active-Lens name in the legend, see View).
  api.keymap.registerLayer({
    commands: [
      {
        name: "aperture.lens.switch",
        title: "Switch Lens",
        slashName: "lens-switch",
        category: "Aperture",
        namespace: "palette",
        run() {
          openLensPicker(api)
        },
      },
    ],
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
