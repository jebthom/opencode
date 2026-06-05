import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { LEGEND, DIRECTORY_HUE, DIRECTORY_LABEL } from "@/codegraph/semantics"

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

type Graph = {
  version: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  semantics: Record<string, { tags: readonly string[]; hue?: string }>
}

const TOP_BAR_HEIGHT = 14
// Children drawn per node before collapsing the rest into a single "…" tile.
const MAX_CHILDREN = 4
const MAX_LABEL = 16
const MAX_CHILD_LABEL = 8

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

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [scope, setScope] = createSignal("")

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
    return layer0.map((node) => {
      const children = byParent.get(node.path) ?? []
      return { node, children: children.slice(0, MAX_CHILDREN), overflow: children.length - MAX_CHILDREN }
    })
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
        <text fg={theme().textMuted}>{summary()}</text>
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

      <box flexDirection="row" gap={2} flexGrow={1}>
        <For each={tree()}>
          {(item) => (
            <box flexDirection="column" flexShrink={0} gap={0}>
              <box
                border
                customBorderChars={cornersFor(item.node.kind)}
                borderColor={theme().border}
                paddingLeft={1}
                paddingRight={1}
                flexShrink={0}
                onMouseDown={() => item.node.kind === "directory" && setScope(item.node.path)}
              >
                <text fg={hueColor(theme(), hueOf(item.node.id), item.node.kind)} wrapMode="none">
                  {truncate(basename(item.node.path), MAX_LABEL)}
                </text>
              </box>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <For each={item.children}>
                  {(child) => (
                    <box
                      border
                      customBorderChars={cornersFor(child.kind)}
                      borderColor={theme().border}
                      flexShrink={0}
                      onMouseDown={() => child.kind === "directory" && setScope(child.path)}
                    >
                      <text fg={hueColor(theme(), hueOf(child.id), child.kind)} wrapMode="none">
                        {truncate(basename(child.path), MAX_CHILD_LABEL)}
                      </text>
                    </box>
                  )}
                </For>
                <Show when={item.overflow > 0}>
                  <box border customBorderChars={SQUARE_CORNERS} borderColor={theme().border} flexShrink={0}>
                    <text fg={theme().textMuted} wrapMode="none">
                      …
                    </text>
                  </box>
                </Show>
              </box>
            </box>
          )}
        </For>
      </box>
    </box>
  )
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
