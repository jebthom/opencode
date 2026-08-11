import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { DIRECTORY_HUE } from "@/aperture/semantics"
import { NONE_FACET, NONE_HUE, NONE_LABEL, UNTAGGED_HUE, UNTAGGED_LABEL, BUILTIN_LENS_IDS } from "@/aperture/lenses"
import { allocateCells, buildGrid, coalesce } from "@/aperture/treemap"
import {
  ACTION_GLYPH,
  ACTION_LABEL,
  ACTIONS,
  type Action,
  type ActivityEntry,
  type Fill,
  type Style,
} from "@/aperture/activity"
import { createActivityTracker } from "./aperture-activity"
import { openLensPicker, fetchLenses, drillDownsOf } from "./aperture-lens-picker"

const id = "internal:aperture"

// The Aperture top bar (PLAN.md): a persistent strip that draws the deterministic
// Aperture view as *directory composition blocks* and lets the user walk the tree.
//
// The bar is rooted at a `scope` (a repo-relative directory, "" = repo root) and shows
// the scope's direct child directories as bordered treemap blocks. Clicking a block
// re-roots the view at it *and* reveals that directory in the editor's file tree
// (`tui.directory.reveal`); a root button, an up button, and a clickable breadcrumb
// walk back out without touching the editor. Data is fetched per scope from
// api.client.aperture.get({ scope }); when the server reports a file change inside the
// viewed scope (aperture.invalidated) we refetch just that scope, so the visible view
// stays live without recomputing graphs nobody is looking at.
//
// O1 removed the second tier: there is no per-directory child list, so a directory's
// contents are legible only through its block's composition. What the bar still draws
// per-file is the scope's *own* files, as a packed grid of one-line tiles (see
// `fileColumns`) — each the filename over a band of that file's facet mix. That band is
// the finest-grained facet reading anywhere in the product: finer than the directory
// treemap, which averages a file into its parent, and finer than the VSCode Explorer pip,
// which carries one colour and so can only ever report a file's dominant facet.

type GraphNode = {
  id: string
  path: string
  kind: "file" | "directory"
  size: number
  position: { layer: number; index: number }
}

type GraphEdge = { from: string; to: string; kind: string }

// Per-node composition (server-merged, see payload.ts): a directory's recursive subtree
// mix, or a file's own mix as a subtree of one. The treemap paints a block from these
// weights and a file tile paints its band from them; `count` and `bytes` are both carried
// so TREEMAP_METRIC can switch which one drives cell area.
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

type Graph = {
  version: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  boundaries?: GraphBoundary[]
  semantics: Record<string, { facets: readonly string[]; hue?: string }>
  composition?: Record<string, Composition>
  // The active Lens + legend (facet → label + colour), merged in server-side.
  lens?: { id: string; name: string; legend: readonly { facet: string; label: string; color: string }[] }
  // Facets already toggled off server-side when this payload was built (O4) — the filter
  // the VSCode picker set before the bar opened. Colours above stay true regardless; this
  // only says which of them to paint grey.
  suppressed?: readonly string[]
}

// --- block dimensions ------------------------------------------------------
// A block is a grid of CELL_W-wide cells, `COLUMN_ROWS` tall, whose *area* is the
// directory's size against its biggest sibling. Width is not a separate quantity: it is
// however many columns those cells occupy (`buildGrid` fills column by column, each one
// bottom-up, so a block is a bottom-aligned rectangle). That identity is the point — a block
// is never wider than the colour inside it, so there is no blank right-hand margin.
const COLUMN_COLS_MIN = 2 // → 6 terminal cols outer
const COLUMN_COLS_MAX = 6 // → 14 terminal cols outer
const COLUMN_ROWS = 6
// TREEMAP_METRIC picks whether file count or byte size drives cell area — both are carried
// in the payload, so flipping this is a one-line change. CELL_W is how many terminal columns
// one cell spans (2 reads as a roughly square block).
const TREEMAP_METRIC: "bytes" | "count" = "bytes"
const CELL_W = 2
// The cell budget a full-size block gets. Absolute rather than derived from a per-block
// column count, which is what breaks the circularity: cells are chosen first, and the
// column count falls out of them.
const BLOCK_CELL_CAP = COLUMN_COLS_MAX * COLUMN_ROWS
// Cells for a directory of `size` against the biggest sibling. sqrt so small directories
// stay visible (area, not length, carries the comparison) and floored at 1 so anything with
// bytes at all paints something.
function scaleCells(size: number, max: number, cap: number) {
  return max <= 0 || size <= 0 ? 0 : Math.max(1, Math.min(cap, Math.round(cap * Math.sqrt(size / max))))
}
// Border-inclusive footprint of a `cols`-cell-wide block.
const columnOuterW = (cols: number) => cols * CELL_W + 2

// --- file grid -------------------------------------------------------------
// The scope's own files, drawn as a packed grid of one-line tiles rather than aggregated
// into a single block. A tile is a border around one row: the filename written over a band
// of the file's *facet mix*, so a facet holding a minority of the file still shows — which
// the VSCode Explorer pip structurally cannot do, since a FileDecoration carries one colour
// and therefore only ever reports the dominant facet.
//
// Height is the whole reason this is a grid: laid out in a single row (as the old file tier
// was) the tiles left most of the strip empty, because ordering was preserved at all costs.
// Grouping the files together frees us to wrap them, so the grid fills the height a
// directory block already occupies and the strip gets shorter instead of longer.
const FILE_TILE_H = 3 // top border + one content row + bottom border
// Inner width is FILE_TILE_W − 2 = 12 characters. The single knob to turn if filenames read
// as too clipped or the grid as too sparse.
const FILE_TILE_W = 14
// A directory block's total height: its label row, its border, and its treemap. The file
// grid is sized to match so the two kinds of column are the same height and the bar's
// budget doesn't depend on which one the scope happens to contain.
const BLOCK_H = 1 + 2 + COLUMN_ROWS
// Tiles per grid column — derived, so raising COLUMN_ROWS keeps the two aligned instead of
// silently overflowing the strip. At COLUMN_ROWS = 6 this is exactly 3.
const FILE_GRID_ROWS = Math.max(1, Math.floor(BLOCK_H / FILE_TILE_H))

// The bar's base height, and the budget every other vertical constant is cut from: the
// four header rows (title / nav / legend / actions), one block (a label row over a
// COLUMN_ROWS-tall treemap wrapped in a 2-row border), and the bar's own bottom border.
// One row is added on top *only while the horizontal scrollbar is actually showing* (see
// scrollbarVisible) — the block fills the whole height, so the scrollbar would otherwise
// paint over its bottom border, but when the strip fits, that row goes back to the
// conversation. Dropping the file tier (O1) took this from 20 to 14; if you want to spend
// the space back, spend it on COLUMN_ROWS. NB: `routes/session/index.tsx` hides the bar
// outright on short terminals using its own literal — move that with this.
const TOP_BAR_HEIGHT = 4 + BLOCK_H + 1
// Inter-column gap in the scroll strip (the scrollbox's contentOptions gap) and the bar's
// own horizontal padding — both feed the content-width vs viewport-width test that decides
// whether the horizontal scrollbar shows. Keep in sync with the JSX that uses them.
//
// Zero: blocks pack against each other exactly as the file tiles do, so the strip has one
// density rather than two. Adjacent borders sharing a column is what makes a row of small
// directories read as a row rather than as scattered boxes. Block labels are trimmed one
// column short (see the render) so neighbouring names still can't collide.
const SCROLL_GAP = 0
const BAR_PADDING_X = 2
// Inter-item gap in the one-row legend strip. Named (not the literal 2) because the fit
// test below has to reproduce the row's exact width to know when to trim — keep the JSX
// gap prop and this constant the same.
const LEGEND_GAP = 2
// Even-trim floor for legend facet labels. The legend is a fixed single row that must
// neither wrap (vertical space is scarce) nor clip; when the swatches + labels overflow
// the bar width, every facet label is capped to a shared length — as large as still fits —
// but never shorter than this: below it a label stops being recognisable. A trimmed label
// renders LEGEND_LABEL_MIN columns (LEGEND_LABEL_MIN-1 chars + "…"). The lens name and the
// fixed "Other"/"Non-code" labels are never trimmed; the hover line still shows a swatch's
// full label, so trimming hides characters but loses no information.
const LEGEND_LABEL_MIN = 6
// A couple of columns held back from the fit test so ambiguous-width legend glyphs
// (■ ◀ ▶ ⌄) a terminal may render two cells wide can't nudge the row past the edge.
const LEGEND_SAFETY_PAD = 2
// The "clear the legend filter" control (O4), rendered at the tail of the legend row only
// while at least one facet is greyed. Named because the fit test has to charge for it —
// it appears and disappears under the user, and a row that only overflows once something
// is filtered would be a bug that shows up exactly when the feature is in use.
const LEGEND_RESET = "↺"
// The hue a facet takes while it is filtered out of the legend (O4). Must match
// SUPPRESSED_HUE in extension.ts and MUTED_HEX in chip.ts — one facet greying to two
// different colours across the two surfaces would read as a bug in one of them. Since C1
// all three are the same literal hex rather than a token each surface resolves for itself.
const SUPPRESSED_HUE = NONE_HUE
// Cells moved per wheel notch when we redirect a vertical wheel into horizontal
// scroll. Blocks are ~10 cols wide, so 1 cell/notch (the raw terminal delta) feels
// sluggish; a small multiplier makes the bar pan at a comfortable speed.
const HSCROLL_STEP = 3
// How often (ms) to poll-refresh the view for changes nothing tells us about — files
// created/deleted in the user's IDE outside opencode emit no event the bar can see, so
// they'd otherwise only surface on navigation or a manual ⟳. Recompute is a cheap scoped
// walk, so a low-frequency poll keeps the view honest without meaningful cost.
const REFRESH_POLL_MS = 5000

// Cell sentinel for an empty / fully-untagged directory: painted light grey so the
// bordered box reads as a real-but-uninhabited directory rather than a black void. The
// leading space is deliberate — it keeps this distinct from any real tag id (slugs are
// trimmed kebab-case and can never start with a space), so don't "tidy" it to "grey".
const GREY_CELL = " grey"

// Directory blocks and file tiles share one corner set. Kind used to be encoded by corner
// shape (files rounded), which is redundant now that the two are different shapes in
// different parts of the strip.
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
  // Foundation A hover-info line: what a node tile / link shows when pointed at.
  // Cleared on mouse-out so the header falls back to the summary. Set as a plain
  // string so any feature (node detail, edge target, …) can drive it uniformly.
  const [hovered, setHovered] = createSignal<string | undefined>()
  // Facets toggled off in the legend (O4): clicking a swatch greys that facet everywhere
  // instead of hiding it, so the remaining facets pop while the layout holds still.
  //
  // Held here *and* on the server. Locally so a click repaints on the next frame rather
  // than after a round trip; on the server so the VSCode extension greys the same facets in
  // the same gesture. The POST is what tells the server, and its echoed event is what tells
  // any other surface — see the subscription below.
  const [suppressed, setSuppressed] = createSignal<ReadonlySet<string>>(new Set())

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
  //
  // No `drill` is sent any more (O1): the bar doesn't draw files, so it has no file to
  // ask for function-level extents about. Nothing is lost — the VSCode extension drills
  // every visible/open editor to paint its gutter, which is what schedules the fine paint
  // now, and O3's interest set already covers open tabs.
  const [graph, { refetch }] = createResource(
    () => ({ directory: props.api.state.path.directory, scope: scope() }),
    async (key) => {
      const result = await props.api.client.aperture.get({ scope: key.scope, refresh: "true" }, { throwOnError: true })
      return result.data as Graph
    },
  )

  // Step the active Lens one forward/back, wrapping at the ends. The
  // server flips the active Lens and publishes aperture.invalidated for the
  // viewed scope, which the subscription below turns into a refetch — so the repaint
  // rides the same path a `/lens`-driven switch already uses.
  const cycleLens = (direction: "next" | "prev") => {
    logInteraction("lens.cycle", direction)
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

  // The legend filter changed somewhere else (O4) — the VSCode picker, or the server
  // clearing it on a Lens switch. Adopt it wholesale: the event carries the entire set, and
  // the server is the authority for it. No refetch — the filter only changes how the
  // colours we already hold are painted.
  //
  // Our own clicks come back through here too, already applied optimistically — bail on an
  // unchanged set so the echo costs nothing rather than repainting the strip a second time.
  const offFilter = props.api.event.on("aperture.facets.filtered", (event) => {
    const next = event.properties.facets
    const current = suppressed()
    if (next.length === current.size && next.every((f) => current.has(f))) return
    setSuppressed(new Set(next))
  })
  onCleanup(() => offFilter())

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

  // Aperture research/study logging: record a top-bar interaction (a click in the
  // view) to the per-session study log, interleaved with the agent's prompts/tool
  // calls. `interaction` is the type id (e.g. "lens.cycle", "dir.reveal"); `detail`
  // is an optional target (e.g. the path navigated to). Fire-and-forget — a logging
  // failure must never break a click. (`drill` is no longer sent: with the file tier
  // gone there is no drilled file, and tile.drill/tile.undrill have left the log with it.)
  const logInteraction = (interaction: string, detail?: string) => {
    void props.api.client.aperture.interaction({
      sessionID: props.session_id,
      interaction,
      scope: scope(),
      lens: activeId(),
      ...(detail !== undefined ? { detail } : {}),
    })
  }
  // Navigate the directory tree — logs the navigation then re-roots. Used on its own by
  // the breadcrumb / ⌂ / ◀ controls, which deliberately do *not* disturb the editor.
  const navigateScope = (path: string) => {
    logInteraction("tile.navigate", path)
    setScope(path)
  }
  // Reveal a directory in the editor's file tree. This is the link the file tier used to
  // provide: the bar no longer lists files, so the way to get from "this part of the repo
  // looks interesting" to the files themselves is to open it where files belong. The host
  // (the Aperture VSCode extension) listens for `tui.directory.reveal` and runs
  // revealInExplorer, which expands the parent chain, scrolls the folder into view and
  // focuses it — focus moving to the Explorer is intended, since you asked to go there.
  // Fire-and-forget: no editor attached, or a failed publish, must not break the click.
  const revealDirectory = (path: string) => {
    logInteraction("dir.reveal", path)
    void props.api.client.tui.revealDirectory({ path })
  }
  // Clicking a directory block does both: re-root the bar *and* reveal it in the editor.
  const openDirectory = (path: string) => {
    navigateScope(path)
    revealDirectory(path)
  }
  // Clicking a file tile opens it in the editor. The bar has no file view of its own to
  // drill into any more — the tile already shows the whole file's facet band — so the only
  // thing left to want from a click is the file itself.
  const openFile = (path: string) => {
    logInteraction("file.open", path)
    void props.api.client.tui.openFile({ path })
  }

  // Adopt a filter that was already set when this view mounted — the extension's picker set
  // one before the TUI opened, or this panel was remounted. Once only: past the first
  // payload the event subscription is the live channel, and re-reading every poll would let
  // a fetch that raced ahead of our own POST un-grey a facet the user just clicked.
  let seededFilter = false
  createEffect(() => {
    if (seededFilter || graph.error || graph.loading) return
    const g = graph()
    if (!g) return
    seededFilter = true
    if (g.suppressed?.length) setSuppressed(new Set(g.suppressed))
  })

  // Push the filter to the server, which holds it for every surface and echoes it back as
  // aperture.facets.filtered so the VSCode extension greys in the same gesture (O4).
  // Fire-and-forget, like the other click actions: a failed publish must leave the local
  // paint alone rather than un-grey what the user just clicked.
  const publishFilter = (next: ReadonlySet<string>) => {
    void props.api.client.aperture.facetFilter({ facets: [...next] })
  }
  // Click a legend swatch (glyph or label) to grey its facet; click again to restore.
  // Multi-select — each click is independent, so "show me only the parsing code" is a
  // matter of turning the others off.
  const toggleFacet = (facet: string) => {
    const next = new Set(suppressed())
    if (!next.delete(facet)) next.add(facet)
    logInteraction("legend.toggle", facet)
    setSuppressed(next)
    publishFilter(next)
  }
  // The way back from any filter, however many clicks built it. Only rendered while
  // something is actually suppressed, so it costs no room in the common case.
  const clearFilter = () => {
    logInteraction("legend.reset")
    setSuppressed(new Set<string>())
    publishFilter(new Set<string>())
  }

  // Delete the active Lens via the ✕ control. Two-step: the first click arms a
  // "confirm?" state, the second performs the delete. Fire-and-forget — the repaint
  // (and the fall-back to Architecture) rides aperture.invalidated like a cycle.
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  // Deleting a Lens also deletes every drill-down scoped to it (their domains are its
  // facets — without it they can't paint at all). That's painted work the user can't see
  // from here, so the confirm has to count it rather than destroy it silently.
  const [cascade, setCascade] = createSignal(0)
  const deleteActiveLens = () => {
    if (!canDeleteActive()) return
    if (!confirmingDelete()) {
      setConfirmingDelete(true)
      void fetchLenses(props.api)
        .then((all) => setCascade(drillDownsOf(all, activeId()).length))
        .catch(() => setCascade(0))
      return
    }
    setConfirmingDelete(false)
    logInteraction("lens.delete", activeId())
    void props.api.client.aperture.deleteLens({ lens: activeId() })
  }
  const deleteLabel = () => {
    if (!confirmingDelete()) return "✕"
    const n = cascade()
    return n > 0 ? `✕ confirm? (+${n} drill-down${n > 1 ? "s" : ""})` : "✕ confirm?"
  }
  // Disarm the confirm if the active Lens changes out from under us.
  createEffect(() => {
    activeId()
    setConfirmingDelete(false)
    setCascade(0)
  })
  // Columns the leading lens-name cluster occupies (◀ name ▶ ⌄ [delete], inner gap 1), or
  // 0 when there's no active Lens. Mirrors the JSX at the head of the legend row so the
  // trim budget below matches what actually renders.
  const lensClusterWidth = () => {
    if (!activeName()) return 0
    const items = [1, activeName().length, 1, 1] // ◀  name  ▶  ⌄
    if (canDeleteActive()) items.push(deleteLabel().length) // ✕ / ✕ confirm? (+N …)
    return items.reduce((a, b) => a + b, 0) + (items.length - 1) // + inner gap-1s
  }
  // Path-B legend fit: reproduce the one-row legend's rendered width and, when it overflows
  // the bar, even-trim the facet labels to a shared cap (as large as fits, floored at
  // LEGEND_LABEL_MIN) so the row neither wraps nor clips. Labels at or under the cap are left
  // whole; longer ones are ellipsised. Only the facet labels are trimmable — the lens cluster
  // and the fixed Other/Non-code swatches are counted as fixed overhead. Returns the legend
  // entries with (possibly) shortened labels.
  const trimmedLegend = createMemo(() => {
    const entries = legendEntries()
    // The reset control is only in the row while a filter is on, so it's only charged for
    // then — otherwise every unfiltered legend would pay for a control it isn't showing.
    const reset = suppressed().size > 0 ? 1 : 0
    // Top-level children of the legend row: optional lens cluster + one per entry + the two
    // fixed swatches + the optional reset control. Gaps sit between them.
    const children = (activeName() ? 1 : 0) + entries.length + 2 + reset
    const fixed =
      lensClusterWidth() +
      entries.length * 2 + // ■ + leading space on each entry (the label is the trimmable rest)
      (2 + NONE_LABEL.length) + // "Other" swatch + label
      (2 + UNTAGGED_LABEL.length) + // "Non-code" swatch + label
      reset * LEGEND_RESET.length +
      Math.max(0, children - 1) * LEGEND_GAP +
      LEGEND_SAFETY_PAD
    const budget = dimensions().width - BAR_PADDING_X * 2 - fixed
    const maxLen = entries.reduce((m, e) => Math.max(m, e.label.length), 0)
    // Largest shared cap whose trimmed-label total still fits the budget; never below the
    // floor. sum(min(len, n)) is monotonic in n, so grow from the floor and stop when it
    // no longer fits. A negative/tiny budget leaves cap at the floor (best effort).
    let cap = LEGEND_LABEL_MIN
    for (let n = LEGEND_LABEL_MIN; n <= maxLen; n++) {
      const used = entries.reduce((s, e) => s + Math.min(e.label.length, n), 0)
      if (used <= budget) cap = n
      else break
    }
    // Carry the untrimmed text as `full` so a swatch can reveal it on hover (below) —
    // trimming then hides characters without losing information.
    if (cap >= maxLen) return entries.map((e) => ({ ...e, full: e.label }))
    return entries.map((e) => ({
      ...e,
      full: e.label,
      label: e.label.length > cap ? e.label.slice(0, cap - 1) + "…" : e.label,
    }))
  })
  // The one place a facet id becomes a colour — and therefore the one place the legend
  // filter is applied (O4). A suppressed facet is handed the untagged grey here, so every
  // surface downstream (the treemap blocks, the file-tile bands, the legend swatch itself)
  // greys without knowing the filter exists. Painting from the *unfiltered* weights is what
  // keeps a suppressed facet's area: nothing re-flows, so two directories stay comparable
  // across a click, which is the whole reason to filter rather than to search.
  //
  // SUPPRESSED_HUE is NONE_HUE, not the dimmer UNTAGGED_HUE: a facet you turned off is
  // still *code*, so it should sit where "Other" sits rather than dropping to the grey that
  // means "nothing to see here". It also has to be the grey the VSCode extension uses (see
  // SUPPRESSED_HUE in extension.ts / MUTED_HEX in chip.ts) — the same facet greying to two
  // different colours across the two surfaces would read as a bug in one of them.
  const colorByFacet = createMemo(() => {
    const off = suppressed()
    return new Map(legendEntries().map((e) => [e.facet, off.has(e.facet) ? SUPPRESSED_HUE : e.color]))
  })
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

  // The blocks in the strip: the scope's direct child *directories*, in payload order.
  // Layer-1 is no longer read at all — the bar shows one level, and what's below it is
  // legible through each block's composition rather than through a child list (O1).
  const dirNodes = createMemo(() =>
    nodes()
      .filter((n) => n.position.layer === 0 && n.kind === "directory")
      .toSorted((a, b) => a.position.index - b.position.index),
  )

  // The scope's own files, as grid columns of FILE_GRID_ROWS tiles each.
  //
  // Sorted alphabetically and filled *column-major*, so reading order is down a column then
  // right — the direction the strip scrolls. Alphabetical rather than payload order because
  // grouping the files together is what buys the wrapping in the first place: once they are
  // no longer interleaved with directories there is nothing left for payload order to mean,
  // and alphabetical is what makes a name findable by eye.
  const fileColumns = createMemo(() => {
    const files = nodes()
      .filter((n) => n.position.layer === 0 && n.kind === "file")
      .toSorted((a, b) => basename(a.path).localeCompare(basename(b.path)))
    const columns: GraphNode[][] = []
    for (let i = 0; i < files.length; i += FILE_GRID_ROWS) columns.push(files.slice(i, i + FILE_GRID_ROWS))
    return columns
  })

  // Per-character background colours for a node's one-row band: its composition spread
  // across `width` columns, each facet taking its byte-proportion and the not-yet-painted /
  // non-code remainder filling the rest in grey. Used by the file tiles, which is why a
  // file now needs a `composition` entry of its own (see computeComposition) — painting from
  // `semantics[id].hue` would flatten it back to the single dominant facet the Explorer pip
  // is already stuck with, and losing that distinction is the reason the grid exists.
  const bandColors = (id: string, width: number): (TuiThemeCurrent["text"] | undefined)[] => {
    const comp = compositionOf(id)
    const bands = comp ? compositionBands(comp) : []
    if (bands.length === 0) return Array.from({ length: width }, () => resolveColor(theme(), UNTAGGED_HUE))
    const alloc = allocateCells(bands, width)
    const flat: TuiThemeCurrent["text"][] = []
    for (const a of alloc) for (let i = 0; i < a.n; i++) flat.push(colorFor(a.key))
    while (flat.length < width) flat.push(theme().backgroundPanel)
    return flat
  }

  // A block's treemap scales its cell count against the biggest sibling (by *whole-subtree*
  // size, tagged or not), so the largest block fills its grid and the rest read at their
  // true proportion — a few tagged files never inflate a directory to full size.
  // Directories only: the file grid is a fixed-size layout, so it neither scales against
  // this denominator nor belongs in it.
  const maxDirSubtree0 = createMemo(() => {
    let max = 0
    for (const n of nodes()) {
      if (n.kind !== "directory" || n.position.layer !== 0) continue
      const c = compositionOf(n.id)
      if (c) max = Math.max(max, metricSubtree(c))
    }
    return max
  })

  // Blocks carry their name in a label row; it brightens on hover.
  const dirLabelFg = (node: GraphNode) => (hoveredId() === node.id ? theme().accent : theme().textMuted)

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

  // A file's facet mix as text — the band spelled out, since a 14-column strip of colour
  // can show that a file is mixed without saying what it is mixed *of*. Same reading the
  // VSCode Explorer pip puts in its tooltip.
  const describeMix = (id: string) => {
    const comp = compositionOf(id)
    if (!comp) return undefined
    const total = metricSubtree(comp)
    if (total <= 0 || comp.weights.length === 0) return undefined
    const labelOf = (facet: string) =>
      facet === NONE_FACET ? NONE_LABEL : (legendEntries().find((e) => e.facet === facet)?.label ?? facet)
    const parts = comp.weights.map((w) => `${labelOf(w.facet)} ${Math.round((metricValue(w) / total) * 100)}%`)
    const untagged = total - metricTotal(comp)
    if (untagged > 0) parts.push(`${UNTAGGED_LABEL} ${Math.round((untagged / total) * 100)}%`)
    return parts.join(" · ")
  }

  // Hover text for a node: its path/size, plus the latest action on it this turn.
  const hoverNode = (node: GraphNode) => {
    const mix = node.kind === "file" ? describeMix(node.id) : undefined
    const base = mix ? `${describeNode(node)} · ${mix}` : describeNode(node)
    // List out-of-window import targets so a dependency that left the window is
    // still legible even though it can't be drawn as an in-window highlight.
    const outs = boundariesFor().get(node.id) ?? []
    const withOut = outs.length ? `${base} · →${outs.map((b) => basename(b.path)).join(" ")}` : base
    const entries = activity.entriesFor(node.path)
    const latest = entries[entries.length - 1]
    return latest ? `${withOut} · ${latest.agent} ${ACTION_LABEL[latest.action]} ${relTime(latest.timestamp)}` : withOut
  }

  // How many cells a directory's treemap paints. Everything about a block's size derives
  // from this one number — the grid it draws and the width of the box around it — so the
  // box cannot end up wider than its contents. Previously width was scaled separately from
  // cell count, and a "there's horizontal room, so draw everything full-size" rule sat on
  // top of it; between them a small directory got a big empty box.
  const blockCells = (id: string) => {
    const comp = compositionOf(id)
    const bands = comp ? compositionBands(comp) : []
    // Nothing under it the painter sees as code: one grey cell, so the box still reads as a
    // real-but-uninhabited directory rather than vanishing.
    if (!comp || bands.length === 0) return 1
    // Floor at the band count so every facet actually present gets at least one cell — a
    // real facet is never an invisible sliver.
    return Math.min(
      BLOCK_CELL_CAP,
      Math.max(scaleCells(metricSubtree(comp), maxDirSubtree0(), BLOCK_CELL_CAP), bands.length),
    )
  }
  // ...and the columns those cells occupy, which is the block's width. `buildGrid` lays the
  // same count into ceil(cells / rows) columns, so this matches what actually gets drawn;
  // the clamp only bites at the very bottom, where a sub-one-column directory is widened to
  // the COLUMN_COLS_MIN floor so it stays a legible box.
  const blockCols = (id: string) =>
    Math.max(COLUMN_COLS_MIN, Math.min(COLUMN_COLS_MAX, Math.ceil(blockCells(id) / COLUMN_ROWS)))
  const blockWidth = (id: string) => columnOuterW(blockCols(id))

  // Whether the strip overflows the viewport horizontally — i.e. whether OpenTUI will draw
  // the horizontal scrollbar on the scrollbox's bottom row. Computed from data + terminal
  // width rather than read off the renderable (no per-frame polling, no layout-timing race):
  // the strip's width is the sum of the block footprints plus the inter-block gaps, and the
  // viewport is the full-width bar less its own horizontal padding.
  // The file grid is one strip child however many columns it holds, so it contributes its
  // whole packed width but only one gap.
  const contentWidth = createMemo(() => {
    const widths = dirNodes().map((n) => blockWidth(n.id))
    const columns = fileColumns().length
    if (columns > 0) widths.push(columns * FILE_TILE_W)
    if (widths.length === 0) return 0
    return widths.reduce((a, b) => a + b, 0) + SCROLL_GAP * (widths.length - 1)
  })
  const scrollbarVisible = createMemo(() => contentWidth() > dimensions().width - BAR_PADDING_X * 2)
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

  // Re-root the view by typing/pasting a repo-relative path. This is the reliable way to
  // point the bar at something the agent mentioned: file/dir references in the chat aren't
  // clickable (an inline text run carries no mouse events), so instead of hunting for a
  // tile you copy the path from anywhere and drop it here. Opened from the ⌖ button;
  // prefilled with the current scope, blank input means the repo root. Opens on mouse-up
  // (a dialog opened on mouse-down is dismissed by the backdrop seeing the release).
  const openGoto = () => {
    const DialogPrompt = props.api.ui.DialogPrompt
    props.api.ui.dialog.replace(() => (
      <DialogPrompt
        title="Go to path"
        value={scope()}
        placeholder="repo-relative path (blank = repo root)"
        onConfirm={(value: string) => {
          logInteraction("goto", scopeFromInput(value))
          setScope(scopeFromInput(value))
          props.api.ui.dialog.clear()
        }}
        onCancel={() => props.api.ui.dialog.clear()}
      />
    ))
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

      {/* Navigation row: refresh + go-to + root + up + breadcrumb. Always present so the
          graph area below doesn't jump as the user drills in and out. Crumbs are clickable
          for quick navigation; the ⌖ button opens a "go to path" prompt (type/paste a path)
          for jumping somewhere arbitrary — e.g. a path the agent mentioned in chat. */}
      <box flexDirection="row" gap={1} height={1} flexShrink={0}>
        <text
          fg={theme().accent}
          onMouseDown={() => {
            logInteraction("refresh")
            refetch()
          }}
        >
          ⟳
        </text>
        <text
          fg={theme().accent}
          onMouseUp={() => openGoto()}
          onMouseOver={() => setHovered("go to a path (type or paste)")}
          onMouseOut={() => setHovered(undefined)}
        >
          ⌖
        </text>
        <Show when={scope() !== ""} fallback={<text fg={theme().textMuted}>/</text>}>
          <text
            fg={theme().accent}
            onMouseDown={() => {
              logInteraction("nav.root")
              setScope("")
            }}
          >
            ⌂
          </text>
          <text
            fg={theme().accent}
            onMouseDown={() => {
              logInteraction("nav.up", upTarget())
              setScope(upTarget())
            }}
          >
            ◀
          </text>
          <For each={crumbs()}>
            {(crumb, i) => (
              <text
                fg={i() === crumbs().length - 1 ? theme().text : theme().textMuted}
                onMouseDown={() => {
                  logInteraction("breadcrumb.nav", crumb.path)
                  setScope(crumb.path)
                }}
              >
                {(i() === 0 ? "" : "/ ") + crumb.label}
              </text>
            )}
          </For>
        </Show>
      </box>

      {/* Legend: the fixed architectural-layer vocabulary the async painter paints
          with. Stable row so the swatches don't move as nodes get (re)tagged. */}
      <box flexDirection="row" gap={LEGEND_GAP} height={1} flexShrink={0}>
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
                cycling once there are many Lenses. Opened on mouse *up*, not down:
                the dialog backdrop dismisses itself on the mouse-up it sees outside
                its inner box, so opening on mouse-down means the same gesture's
                release closes the popup immediately (see ui/dialog.tsx). */}
            <text fg={theme().textMuted} onMouseUp={() => openLensPicker(props.api, props.session_id)} wrapMode="none">
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
                {deleteLabel()}
              </text>
            </Show>
          </box>
        </Show>
        <For each={trimmedLegend()}>
          {(entry) => (
            // Hovering a swatch surfaces the untrimmed facet name in the hover line, so an
            // ellipsised label still tells you what it stands for.
            //
            // Clicking anywhere in this box — glyph or label — toggles the facet off and on
            // (O4). The handler sits on the wrapper rather than on the ■ so the whole entry
            // is the hit area: the label is the wider half and the easier thing to aim at.
            // onMouseDown, not up: the mouse-up convention above is only for controls that
            // open a dialog whose backdrop would eat the release.
            <box
              flexDirection="row"
              flexShrink={0}
              onMouseDown={() => toggleFacet(entry.facet)}
              onMouseOver={() => setHovered(entry.full)}
              onMouseOut={() => setHovered(undefined)}
            >
              {/* Painted through facetColor, not entry.color, so the swatch greys with
                  everything else it stands for — the legend shows its own off-state. */}
              <text fg={facetColor(entry.facet)} wrapMode="none">
                ■
              </text>
              <text fg={suppressed().has(entry.facet) ? theme().border : theme().textMuted} wrapMode="none">
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
        {/* Un-grey everything in one click. Shown only while a filter is on — it is the
            exit from a state, not a permanent control, and the legend row has no columns to
            spare for one. Its width is in the trim budget (see trimmedLegend) so the labels
            give up the space it takes rather than the row overflowing when it appears. */}
        <Show when={suppressed().size > 0}>
          <text fg={theme().accent} onMouseDown={() => clearFilter()} wrapMode="none">
            {LEGEND_RESET}
          </text>
        </Show>
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
        {/* One block per child directory, then the loose-files aggregate. There is no
            second tier: a directory's files are already summed into its treemap, so the
            child list the bar used to draw beneath each block was showing the same bytes
            twice at the cost of six rows of height (O1). */}
        <For each={dirNodes()}>
          {(node) => (
            <DirBlock
              // One column short of the block, so that with SCROLL_GAP at 0 two neighbouring
              // labels always have a space between them instead of running together.
              label={truncate(basename(node.path), blockWidth(node.id) - 1)}
              labelFg={() => dirLabelFg(node)}
              rows={COLUMN_ROWS}
              cells={blockCells(node.id)}
              width={blockWidth(node.id)}
              borderColor={() => borderColorFor(node)}
              composition={() => compositionOf(node.id)}
              colorFor={colorFor}
              overlays={() => overlaysFor(node)}
              theme={theme}
              onDrill={() => openDirectory(node.path)}
              onEnter={() => enterNode(node)}
              onLeave={() => leaveNode()}
            />
          )}
        </For>
        {/* The scope's own files, packed into a grid rather than aggregated into one block.
            Each tile is the filename over a band of that file's facet mix, so a minority
            facet stays visible — the thing a single aggregate block averages away and the
            Explorer pip cannot show at all (one colour per FileDecoration ⇒ dominant only).
            The whole grid is a single strip child, so its tiles pack tight against each
            other while the strip's gap still separates it from the directory blocks. */}
        <Show when={fileColumns().length > 0}>
          <box flexDirection="row" flexShrink={0}>
            <For each={fileColumns()}>
              {(column) => (
                <box flexDirection="column" flexShrink={0}>
                  <For each={column}>
                    {(node) => (
                      <FileTile
                        label={basename(node.path)}
                        width={FILE_TILE_W}
                        colors={(w) => bandColors(node.id, w)}
                        borderColor={() => borderColorFor(node)}
                        overlays={() => overlaysFor(node)}
                        theme={theme}
                        onOpen={() => openFile(node.path)}
                        onEnter={() => enterNode(node)}
                        onLeave={() => leaveNode()}
                      />
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        </Show>
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

// A directory rendered as its subtree's composition: a clickable label over a
// *bordered* grid of layer-colored cells. The border frames the block so it reads as a
// real directory even when empty (an empty/untagged subtree paints solid grey rather
// than vanishing into the panel). The whole block is the click target.
//
// `cells` and `width` are computed together by the caller from one number, so the box is
// exactly as wide as the cells it holds — see `blockCells`/`blockCols`.
function DirBlock(props: {
  label: string
  labelFg: () => TuiThemeCurrent["text"]
  rows: number
  cells: number
  width?: number
  borderColor: () => TuiThemeCurrent["text"]
  composition: () => Composition | undefined
  colorFor: (key: string | null) => TuiThemeCurrent["text"]
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
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={props.labelFg()} wrapMode="none">
          {props.label}
        </text>
        <OverlayRow overlays={props.overlays} theme={props.theme} />
      </box>
      <box
        border
        customBorderChars={SQUARE_CORNERS}
        borderColor={props.borderColor()}
        width={props.width}
        flexShrink={0}
      >
        <TreemapBlock
          composition={props.composition}
          colorFor={props.colorFor}
          rows={props.rows}
          cells={props.cells}
          theme={props.theme}
        />
      </box>
    </box>
  )
}

// The colored grid itself, painted *inside* the directory's border. `cells` — the block's
// area, decided by the caller so the surrounding box can be sized to match — is split
// across the tag bands plus a trailing grey band for the not-yet-tagged / non-code
// remainder, by largest-remainder rounding, laid out in fixed-order bands column-major and
// bottom-aligned (each column fills bottom-up before the next one starts, so the footing
// stays full and a band reads as columns rather than as stripes) — the same order the VSCode
// tree chip's mosaic uses, so the two renderings of one directory can be read the same way.
// So a directory reads at its true size, starts all grey, and each tag only occupies its
// real byte-proportion as the sweep fills in — rather than a handful of tagged files
// painting the whole block.
function TreemapBlock(props: {
  composition: () => Composition | undefined
  colorFor: (key: string | null) => TuiThemeCurrent["text"]
  rows: number
  cells: number
  theme: () => TuiThemeCurrent
}) {
  const grid = createMemo(() => {
    const comp = props.composition()
    const bands = comp ? compositionBands(comp) : []
    // No descendant source files: keep the bordered box non-empty with one grey cell.
    if (bands.length === 0) return buildGrid([GREY_CELL], props.rows)
    const alloc = allocateCells(bands, props.cells)
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

// A file tile: one bordered row, the filename in dark text over a band of the file's own
// facet mix. The band is the point — it is the finest-grained facet reading in the product,
// finer than the directory treemap (which averages the file into its parent) and finer than
// the VSCode Explorer pip (one colour, so dominant-only). Clicking opens the file.
function FileTile(props: {
  label: string
  width: number
  colors: (width: number) => (TuiThemeCurrent["text"] | undefined)[]
  borderColor: () => TuiThemeCurrent["text"]
  overlays: () => Overlay[]
  theme: () => TuiThemeCurrent
  onOpen: () => void
  onEnter: () => void
  onLeave: () => void
}) {
  // Inner cols (width − border) shared between the name and the activity glyph strip, so
  // the glyphs sit flush right and the band keeps its full width behind the name.
  const nameWidth = () => Math.max(0, props.width - 2 - props.overlays().length)
  return (
    <box
      border
      customBorderChars={SQUARE_CORNERS}
      borderColor={props.borderColor()}
      width={props.width}
      flexShrink={0}
      onMouseDown={() => props.onOpen()}
      onMouseOver={() => props.onEnter()}
      onMouseOut={() => props.onLeave()}
    >
      <box flexDirection="row" height={1} flexShrink={0}>
        <NameRow
          name={truncate(props.label, nameWidth())}
          width={nameWidth()}
          colors={() => props.colors(nameWidth())}
          // Dark text over the band, the same treatment the directory bars used: every band
          // colour (facet hues and the untagged grey alike) is a light fill, so the label
          // reads against all of them without having to know which facet it landed on.
          textColor={() => props.theme().background}
          theme={props.theme}
        />
        <OverlayRow overlays={props.overlays} theme={props.theme} />
      </box>
    </box>
  )
}

// One inner row of `width` character cells: each shows the name's character (or a space) in
// `textColor` over the per-column background from `colors` (undefined → panel). The
// per-character split is what lets dark text sit over a multi-colour composition band.
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

// Turn typed/pasted text into a directory scope: trim surrounding slashes/space, and if it
// points at a file (a basename with an extension — a dot past the first char) root at its
// parent directory, so pasting a file path from chat lands on the file's 2-level window.
// Dotfiles (".github") keep their own name, as the dot is leading.
function scopeFromInput(input: string): string {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "")
  if (trimmed === "") return ""
  const segs = trimmed.split("/")
  if ((segs[segs.length - 1] ?? "").lastIndexOf(".") > 0) segs.pop()
  return segs.join("/")
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
          openLensPicker(
            api,
            ("params" in api.route.current ? api.route.current.params?.sessionID : undefined) as string | undefined,
          )
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
