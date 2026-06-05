import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createResource, For } from "solid-js"

const id = "internal:codegraph"

// Step 2 renderer (PLAN.md): a persistent top-bar that draws the deterministic
// code graph. Data comes from the server via api.client.codegraph.get(); layout
// is computed here by a pluggable strategy keyed on orientation, so moving this
// pane to a sidebar later only swaps the strategy (and the host slot), not the
// data path.

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

type Orientation = "horizontal" | "vertical"

type Cell = { node: GraphNode; label: string }
type Layout = { columns: Cell[][] }

const TOP_BAR_HEIGHT = 9
const MOCK_CHILD_PREFIX = "tmp"

// First graph visual (step 2, placeholder semantics). Each real node from the
// extractor renders as a bordered square tagged with its filename; beneath it
// hang 1–3 placeholder children drawn as labeled branches. The children and
// their count are NOT real structure yet — they stand in for the eventual child
// nodes so the bar reads as a graph. The child count is derived from the node id
// (see childCount) rather than Math.random() so it stays stable across renders;
// re-rolling every frame would thrash the reconciler (see PLAN.md failure mode).
// Resource reads stay guarded (never call graph() in the error state).
function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  const [graph] = createResource(
    () => props.api.state.path.directory,
    async () => {
      const result = await props.api.client.codegraph.get({}, { throwOnError: true })
      return result.data as Graph
    },
  )

  const nodes = () => (graph.error ? [] : (graph()?.nodes ?? []))
  const summary = () => {
    if (graph.error) return "fetch error"
    const g = graph()
    return g ? `${g.nodes.length} nodes · ${g.edges.length} edges` : "loading…"
  }
  const hueOf = (nodeID: string) => (graph.error ? undefined : graph()?.semantics[nodeID]?.hue)

  // Real nodes paired with their placeholder children. Memoized on the node set
  // so it recomputes only when the graph data actually changes.
  const tree = createMemo(() =>
    nodes().map((node) => ({
      node,
      children: Array.from({ length: childCount(node.id) }, (_, i) => `${MOCK_CHILD_PREFIX}-${i + 1}`),
    })),
  )

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
      <box flexDirection="row" gap={2} flexGrow={1}>
        <For each={tree()}>
          {(item) => (
            <box flexDirection="column" flexShrink={0}>
              <box border borderColor={theme().border} paddingLeft={1} paddingRight={1} flexShrink={0}>
                <text fg={hueColor(theme(), hueOf(item.node.id), item.node.kind)} wrapMode="none">
                  {basename(item.node.path)}
                </text>
              </box>
              <For each={item.children}>
                {(child, i) => (
                  <text fg={theme().textMuted} wrapMode="none">
                    {(i() === item.children.length - 1 ? "└─ " : "├─ ") + child}
                  </text>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

// Basename of a repo-relative path, truncated to the node-square tag width.
function basename(p: string) {
  const name = p.split("/").pop() ?? p
  return name.length > MAX_LABEL ? name.slice(0, MAX_LABEL - 1) + "…" : name
}

// Placeholder child count in [1, 3], derived deterministically from the node id
// so it never re-rolls between renders. Replace with real child structure when
// the extractor emits nested nodes.
function childCount(nodeID: string) {
  let h = 0
  for (let i = 0; i < nodeID.length; i++) h = (h * 31 + nodeID.charCodeAt(i)) | 0
  return 1 + (Math.abs(h) % 3)
}

// --- pluggable layout strategy ---------------------------------------------

// Maps deterministic (layer, index) positions to a grid of cells. Horizontal:
// layers become columns (left→right). Vertical (stub for the future sidebar
// orientation): layers become rows. Only the arrangement differs; the node
// data and ids are identical, so structure stays stable across orientations.
function computeLayout(nodes: GraphNode[], orientation: Orientation): Layout {
  if (orientation === "vertical") return computeVertical(nodes)
  return computeHorizontal(nodes)
}

const MAX_ROWS_PER_COLUMN = TOP_BAR_HEIGHT - 2
const MAX_LABEL = 18

function computeHorizontal(nodes: GraphNode[]): Layout {
  const byLayer = new Map<number, GraphNode[]>()
  for (const node of nodes) {
    const bucket = byLayer.get(node.position.layer) ?? []
    bucket.push(node)
    byLayer.set(node.position.layer, bucket)
  }
  const columns = [...byLayer.entries()]
    .toSorted((a, b) => a[0] - b[0])
    .map(([, members]) => {
      const sorted = members.toSorted((a, b) => a.position.index - b.position.index)
      const visible = sorted.slice(0, MAX_ROWS_PER_COLUMN)
      const cells: Cell[] = visible.map((node) => ({ node, label: cellLabel(node) }))
      const overflow = sorted.length - visible.length
      if (overflow > 0 && cells.length > 0) {
        cells[cells.length - 1] = { node: cells[cells.length - 1]!.node, label: `+${overflow} more` }
      }
      return cells
    })
  return { columns }
}

// Stub: arranges layers as a single column for narrow/tall placement. Fleshed
// out when the pane actually moves to a sidebar.
function computeVertical(nodes: GraphNode[]): Layout {
  const sorted = nodes.toSorted((a, b) =>
    a.position.layer - b.position.layer || a.position.index - b.position.index,
  )
  return { columns: [sorted.map((node) => ({ node, label: cellLabel(node) }))] }
}

function cellLabel(node: GraphNode) {
  const name = node.path.split("/").pop() ?? node.path
  const prefix = node.kind === "directory" ? "▸ " : "  "
  const trimmed = name.length > MAX_LABEL ? name.slice(0, MAX_LABEL - 1) + "…" : name
  return prefix + trimmed
}

// --- hue mapping -----------------------------------------------------------

// Agent-inferred hues are named theme colors. Until the semantic layer exists
// (step 4) every node falls back to a structural color (directories accented,
// files muted), so the bar is useful immediately.
function hueColor(theme: TuiThemeCurrent, hue: string | undefined, kind: GraphNode["kind"]) {
  if (hue && hue in theme) return theme[hue as keyof TuiThemeCurrent] as TuiThemeCurrent["text"]
  return kind === "directory" ? theme.accent : theme.textMuted
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
