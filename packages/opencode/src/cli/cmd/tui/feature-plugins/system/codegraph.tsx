import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { LEGEND, DIRECTORY_HUE, DIRECTORY_LABEL } from "@/codegraph/semantics"
import { ACTION_GLYPH, ACTION_LABEL, type Action, type Style } from "@/codegraph/activity"
import { createActivityTracker } from "./codegraph-activity"

const id = "internal:codegraph"

// Step 2.5 renderer (PLAN.md): a persistent top-bar that draws a 2-level window
// of the deterministic code graph and lets the user drill into directories.
//
// The bar is rooted at a `scope` (a repo-relative directory, "" = repo root). It
// shows the scope's direct children as bordered boxes (layer 0) and their
// children as smaller boxes (layer 1). Clicking a directory box re-roots the
// view at it; a root button, an up button, and a clickable breadcrumb walk back
// out. Data is fetched per scope from api.client.codegraph.get({ scope }); when
// the server reports a file change inside the viewed scope (codegraph.invalidated)
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

// An out-of-window one-hop import target (step 6). No position/size — it isn't
// placed in the layer grid; the renderer draws it as a boundary tile under the
// importing node. An edge's `to` may reference a boundary id.
type GraphBoundary = { id: string; path: string; kind: "file" | "directory" }

type Graph = {
  version: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  boundaries?: GraphBoundary[]
  semantics: Record<string, { tags: readonly string[]; hue?: string; layer?: string }>
}

// +1 row over the graph's own budget so the horizontal scrollbar lives below the
// tiles without stealing a row of node detail.
const TOP_BAR_HEIGHT = 15
// Cells moved per wheel notch when we redirect a vertical wheel into horizontal
// scroll. Tiles are ~CHILD_W wide, so 1 cell/notch (the raw terminal delta) feels
// sluggish; a small multiplier makes the bar pan at a comfortable speed.
const HSCROLL_STEP = 3
// Children drawn per node before collapsing the rest into a single "…" tile.
const MAX_CHILDREN = 4
const MAX_LABEL = 16
const MAX_CHILD_LABEL = 7
// Fixed tile widths (step 6). Children and their containment drops share CHILD_W
// so a `│` drop always centers over its child regardless of label length; boundary
// tiles + their drops share TILE_W likewise. Fixed widths are what make the purely
// visual connector edges align without per-tile column math.
const CHILD_W = 11
const TILE_W = 3

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
type Overlay = { action: Action; color: TuiThemeCurrent["text"]; style: Style }

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [scope, setScope] = createSignal("")

  // Layer-0 directories whose child row is expanded past MAX_CHILDREN to show all
  // children (the unlimited horizontal strip makes this cheap). Keyed by node id.
  // Reset on every scope change so navigating the tree always lands on the compact
  // 4-children + "…" view; horizontal scrolling doesn't touch scope, so an expanded
  // directory stays expanded while you pan.
  const [expanded, setExpanded] = createSignal(new Set<string>())
  createEffect(() => {
    scope()
    setExpanded(new Set<string>())
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
    () => ({ directory: props.api.state.path.directory, scope: scope() }),
    async (key) => {
      const result = await props.api.client.codegraph.get(
        { scope: key.scope, refresh: "true" },
        { throwOnError: true },
      )
      return result.data as Graph
    },
  )

  // Live update: refetch only when the change is inside the scope we're showing.
  const off = props.api.event.on("codegraph.invalidated", (event) => {
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

  // Guarded reads — never call the resource accessor in its error state (the
  // documented render→catch→re-render leak, PLAN.md). The frame stays mounted.
  const nodes = () => (graph.error ? [] : (graph()?.nodes ?? []))
  const summary = () => {
    if (graph.error) return "fetch error"
    const g = graph()
    return g ? `${g.nodes.length} nodes · ${g.edges.length} edges` : "loading…"
  }
  const hueOf = (nodeID: string) => (graph.error ? undefined : graph()?.semantics[nodeID]?.hue)
  const boundaries = () => (graph.error ? [] : (graph()?.boundaries ?? []))
  const edgeList = () => (graph.error ? [] : (graph()?.edges ?? []))

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

  // Overlay glyphs for a node tile: this turn's agent activity on the file. One
  // glyph per distinct action, colored by the agent that most recently performed
  // it. Reactive via the activity index; planned styling arrives with step 8.
  const overlaysFor = (node: GraphNode): Overlay[] => {
    const entries = activity.entriesFor(node.path)
    if (entries.length === 0) return []
    const overlays: Overlay[] = []
    const seen = new Set<Action>()
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (seen.has(e.action)) continue
      seen.add(e.action)
      overlays.unshift({ action: e.action, color: agentColor(e.agent), style: "actual" })
    }
    return overlays
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
      height={TOP_BAR_HEIGHT}
      flexDirection="column"
      backgroundColor={theme().backgroundPanel}
      paddingLeft={2}
      paddingRight={2}
      border={["bottom"]}
      borderColor={theme().border}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Code Graph</b>
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

      {/* Legend: the fixed architectural-layer vocabulary the async tagger paints
          with. Stable row so the swatches don't move as nodes get (re)tagged. */}
      <box flexDirection="row" gap={2} height={1} flexShrink={0}>
        <For each={LEGEND}>
          {(entry) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={themeColor(theme(), entry.hue)} wrapMode="none">
                ■
              </text>
              <text fg={theme().textMuted} wrapMode="none">
                {" " + entry.label}
              </text>
            </box>
          )}
        </For>
        <box flexDirection="row" flexShrink={0}>
          <text fg={themeColor(theme(), DIRECTORY_HUE)} wrapMode="none">
            ■
          </text>
          <text fg={theme().textMuted} wrapMode="none">
            {" " + DIRECTORY_LABEL}
          </text>
        </box>
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
        contentOptions={{ flexDirection: "row", gap: 2, maxWidth: undefined, maxHeight: "100%" }}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{
          showArrows: false,
          trackOptions: { foregroundColor: theme().textMuted, backgroundColor: theme().backgroundPanel },
        }}
      >
        <For each={tree()}>
          {(item) => {
            const bnds = boundariesFor().get(item.node.id) ?? []
            const shownBnds = bnds.slice(0, MAX_CHILDREN)
            const bndOverflow = bnds.length - MAX_CHILDREN
            const hasChildren = item.children.length > 0
            // Collapsed to MAX_CHILDREN until this directory is expanded via its "…"
            // tile; reactive so clicking "…" grows the row (and the column) in place.
            const shownChildren = () => (expanded().has(item.node.id) ? item.children : item.children.slice(0, MAX_CHILDREN))
            const overflow = () => item.children.length - shownChildren().length
            return (
              <box flexDirection="column" flexShrink={0} gap={0}>
                <box
                  border
                  customBorderChars={cornersFor(item.node.kind)}
                  borderColor={borderColorFor(item.node)}
                  paddingLeft={1}
                  paddingRight={1}
                  flexShrink={0}
                  onMouseDown={() => item.node.kind === "directory" && setScope(item.node.path)}
                  onMouseOver={() => enterNode(item.node)}
                  onMouseOut={() => leaveNode()}
                >
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <text fg={hueColor(theme(), hueOf(item.node.id), item.node.kind)} wrapMode="none">
                      {truncate(basename(item.node.path), MAX_LABEL)}
                    </text>
                    <OverlayRow overlays={() => overlaysFor(item.node)} theme={theme} />
                  </box>
                </box>

                {/* Containment edge: a white │ drop centered over each child. The
                    drops row mirrors the children row's fixed CHILD_W + gap, so each
                    drop aligns to its child regardless of label length. */}
                <Show when={hasChildren}>
                  <box flexDirection="row" gap={1} height={1} flexShrink={0}>
                    <For each={shownChildren()}>
                      {() => (
                        <box width={CHILD_W} alignItems="center" flexShrink={0}>
                          <text fg={theme().text} wrapMode="none">
                            │
                          </text>
                        </box>
                      )}
                    </For>
                    <Show when={overflow() > 0}>
                      <box width={CHILD_W} alignItems="center" flexShrink={0}>
                        <text fg={theme().text} wrapMode="none">
                          │
                        </text>
                      </box>
                    </Show>
                  </box>
                </Show>

                <box flexDirection="row" gap={1} flexShrink={0}>
                  <For each={shownChildren()}>
                    {(child) => (
                      <box
                        width={CHILD_W}
                        border
                        customBorderChars={cornersFor(child.kind)}
                        borderColor={borderColorFor(child)}
                        flexShrink={0}
                        onMouseDown={() => child.kind === "directory" && setScope(child.path)}
                        onMouseOver={() => enterNode(child)}
                        onMouseOut={() => leaveNode()}
                      >
                        <box flexDirection="row" gap={1} flexShrink={0}>
                          <text fg={hueColor(theme(), hueOf(child.id), child.kind)} wrapMode="none">
                            {truncate(basename(child.path), MAX_CHILD_LABEL)}
                          </text>
                          <OverlayRow overlays={() => overlaysFor(child)} theme={theme} />
                        </box>
                      </box>
                    )}
                  </For>
                  {/* Click to expand this directory's row to all its children. The
                      column (and so the parent's footprint) grows to fit; the strip
                      scrolls if it runs past the viewport. No collapse affordance by
                      design — navigating away resets every directory to compact. */}
                  <Show when={overflow() > 0}>
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
                  </Show>
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
// (e.g. the acting agent's). Renders nothing until a feature fills `overlaysFor`.
function OverlayRow(props: { overlays: () => Overlay[]; theme: () => TuiThemeCurrent }) {
  return (
    <Show when={props.overlays().length > 0}>
      <box flexDirection="row" flexShrink={0}>
        <For each={props.overlays()}>
          {(o) => (
            <text fg={o.style === "planned" ? props.theme().textMuted : o.color} wrapMode="none">
              {ACTION_GLYPH[o.action]}
            </text>
          )}
        </For>
      </box>
    </Show>
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

// --- hue mapping -----------------------------------------------------------

// Agent-inferred hues are named theme colors. Until the semantic layer exists
// (step 4) every node falls back to a structural color (directories accented,
// files muted), so the bar is useful immediately.
function hueColor(theme: TuiThemeCurrent, hue: string | undefined, kind: GraphNode["kind"]) {
  if (hue && hue in theme) return theme[hue as keyof TuiThemeCurrent] as TuiThemeCurrent["text"]
  return kind === "directory" ? themeColor(theme, DIRECTORY_HUE) : theme.textMuted
}

// Resolve a named theme key (the layer hues) to a color, for the legend swatches.
function themeColor(theme: TuiThemeCurrent, key: string) {
  return key in theme ? (theme[key as keyof TuiThemeCurrent] as TuiThemeCurrent["text"]) : theme.textMuted
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      codegraph_top(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
