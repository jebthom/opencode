import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { allocateCells } from "@/aperture/treemap"
import { changedFiles, type Turn } from "@/aperture/activity"
import {
  basename,
  capColumns,
  groupByCombination,
  packColumns,
  SEGMENT_BORDER_ROWS,
  type Group,
  type MarkedFile,
  type Segment,
} from "@/aperture/facet-grid"
import { facetColors } from "./aperture-colors"
import { openLensPicker } from "./aperture-lens-picker"

const id = "internal:aperture"

// The Aperture top bar (v3): every marked file in the repo, grouped by the exact combination of
// facets it carries — for facets a, b, c the groups run abc, ab, ac, bc, a, b, c — so the user's
// attention is scoped to precisely the files at issue. Directory structure survives only as a
// containment border around the tiles in a group that share a parent directory; the bar is flat
// and repo-wide on purpose, because a slice through the code ("everything with facet a") should
// cut across directories rather than be organised by them. File browsing belongs to the editor.
//
// One read serves the grid: the whole-repo facet map (`aperture.facetMap`), refetched whenever the
// server says the marks may have moved (aperture.invalidated) or a turn ends. Two more say what
// changed: the session's activity (the same derivation the sidebar draws) for what the *agent*
// changed, and `vcs.status` for everything uncommitted in the working tree — which is how shell
// commands and manual edits show up. Change is orthogonal to the facets, so it never forms a group
// of its own (a file would appear twice): changed files lead their group with a mark, and a toggle
// narrows the grid to the agent's changes, then to the whole working tree.

type FacetMap = {
  lens?: {
    id: string
    name: string
    owner: "user" | "agent"
    legend: readonly { facet: string; label: string; color: string; reason: string; queries: readonly string[] }[]
  }
  facets: readonly string[]
  files: Record<string, { m: readonly { f: number; l: number; b: number }[]; line: number }>
  suppressed: readonly string[]
}

// --- dimensions ------------------------------------------------------------
// A tile is one row: the filename over a band of its facets. A column of tiles is framed by its
// directory's border, so a column is TILE_W wide including that border.
const TILE_W = 22
const NAME_W = TILE_W - 2
// Rows the grid has under each group's header row. Columns of bordered runs are packed into this.
const GRID_ROWS = 9
// The detail region under the legend. A terminal has no tooltip to hang an explanation on, so the
// bar reserves fixed rows for one: what the pointer is over (a facet's query and reason, a group's
// combination, a file's marks), and otherwise the hints that make those hovers discoverable.
// Fixed height, so hovering never reflows the grid.
const DETAIL_ROWS = 2
// Title row + legend row + detail + group header + grid + the bar's bottom border. NB:
// `routes/session/index.tsx` hides the bar outright on short terminals using its own literal —
// move that with this.
const TOP_BAR_HEIGHT = 2 + DETAIL_ROWS + 1 + GRID_ROWS + 1
const GROUP_GAP = 1
const BAR_PADDING_X = 2
const LEGEND_GAP = 2
// Even-trim floor for legend facet labels: the legend is one row that must neither wrap nor clip.
const LEGEND_LABEL_MIN = 6
// Columns held back from the fit test for ambiguous-width glyphs (■ ◀ ▶ ⌄).
const LEGEND_SAFETY_PAD = 2
const LEGEND_RESET = "↺"
const HSCROLL_STEP = 3
// Catch-all for changes nothing tells us about (manual IDE edits outside opencode). The facet map
// is memoized server-side, so a poll costs a map lookup unless something actually changed.
const REFRESH_POLL_MS = 5000
// How many turns of activity to scan for changed files: the server's ceiling, so "this session"
// is as close to literal as the endpoint allows.
const CHANGED_TURNS = 100
const AGENT_MARK = "✎"
const TREE_MARK = "±"
// Columns a group shows before the rest fold behind a "+N more" column, so one huge group can't
// push every other group off the strip. Expanding a group affects that group alone.
const MAX_GROUP_COLUMNS = 3
const MORE_W = 8

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

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const dimensions = useTerminalDimensions()
  // What the pointer is over, explained in the detail region; cleared on mouse-out.
  const [hovered, setHovered] = createSignal<Hovered | undefined>()
  // Facets toggled off in the legend (O4). Held here so a click re-slices on the next frame, and
  // on the server so the VSCode extension follows in the same gesture.
  const [suppressed, setSuppressed] = createSignal<ReadonlySet<string>>(new Set())

  const [map, { refetch }] = createResource(
    () => props.api.state.path.directory,
    async () => {
      const result = await props.api.client.aperture.facetMap({}, { throwOnError: true })
      return result.data as FacetMap
    },
  )

  // Not polled: it reads the message store, and every agent edit already fires one of the two
  // events below.
  const [activity, { refetch: refetchActivity }] = createResource(
    () => ({ directory: props.api.state.path.directory, sessionID: props.session_id }),
    async (key) => {
      const result = await props.api.client.aperture.activity(
        { sessionID: key.sessionID, turns: String(CHANGED_TURNS) },
        { throwOnError: true },
      )
      return result.data as { turns: readonly Turn[] }
    },
  )

  // The working tree's uncommitted changes against HEAD, untracked files included. Not polled
  // either: it runs git, and the file watcher's events arrive as aperture.invalidated.
  const [tree, { refetch: refetchTree }] = createResource(
    () => props.api.state.path.directory,
    async () => (await props.api.client.vcs.status({}, { throwOnError: true })).data ?? [],
  )

  const offInvalidated = props.api.event.on("aperture.invalidated", () => {
    refetch()
    refetchActivity()
    refetchTree()
  })
  onCleanup(() => offInvalidated())

  // The legend filter changed elsewhere (the VSCode picker, or the server clearing it on a Lens
  // switch). The event carries the whole set; our own clicks echo back already applied.
  const offFilter = props.api.event.on("aperture.facets.filtered", (event) => {
    const next = event.properties.facets
    const current = suppressed()
    if (next.length === current.size && next.every((f) => current.has(f))) return
    setSuppressed(new Set(next))
  })
  onCleanup(() => offFilter())

  // A turn boundary — this session or a sub-agent it spawned going idle — is when shell-driven
  // changes that emit no file event have settled.
  const offIdle = props.api.event.on("session.status", (event) => {
    if (event.properties.status.type !== "idle") return
    const sid = event.properties.sessionID
    if (sid !== props.session_id && props.api.state.session.get(sid)?.parentID !== props.session_id) return
    refetch()
    refetchActivity()
    refetchTree()
  })
  onCleanup(() => offIdle())

  const poll = setInterval(() => {
    if (!map.loading) refetch()
  }, REFRESH_POLL_MS)
  onCleanup(() => clearInterval(poll))

  // Guarded reads — never call the resource accessor in its error state (the documented
  // render→catch→re-render leak, PLAN.md). The frame stays mounted.
  const data = () => (map.error ? undefined : map())
  const lens = () => data()?.lens
  const legendEntries = () => lens()?.legend ?? []
  const activeId = () => lens()?.id ?? ""
  const facetIds = () => data()?.facets ?? []

  // Guarded like `data()`: a failure here only costs the change marks, never the grid.
  //
  // git reports paths from the repo root, Aperture from the project directory, which may sit
  // below it — so the directory's offset inside the worktree is stripped. A deletion leaves
  // nothing to open, so deleted paths are dropped, from the agent's changes too (the activity
  // log records an apply_patch delete as an edit).
  const treeStatus = createMemo(() => {
    const prefix = relativePrefix(props.api.state.path.worktree, props.api.state.path.directory)
    return (tree.error ? [] : (tree() ?? [])).flatMap((item) =>
      item.file.startsWith(prefix) ? [{ ...item, file: item.file.slice(prefix.length) }] : [],
    )
  })
  const deleted = createMemo(
    () => new Set(treeStatus().flatMap((item) => (item.status === "deleted" ? [item.file] : []))),
  )
  const treeChanged = createMemo(
    () =>
      new Map(
        treeStatus().flatMap((item) =>
          item.status === "deleted"
            ? []
            : [[item.file, { additions: item.additions, deletions: item.deletions }] as const],
        ),
      ),
  )
  const agentChanged = createMemo(
    () =>
      new Map(
        [...changedFiles(activity.error ? [] : (activity()?.turns ?? []))].filter(([path]) => !deleted().has(path)),
      ),
  )
  const changeOf = (path: string) => {
    if (agentChanged().has(path)) return "agent" as const
    if (treeChanged().has(path)) return "tree" as const
    return undefined
  }

  // Which changes the grid is narrowed to, if any. Local to this view: it scopes one session's
  // attention, unlike the legend filter, which every surface shares. `agent` is a subset of
  // `tree` in the common case, so the cycle widens: all → agent → tree → all.
  const [scope, setScope] = createSignal<"all" | "agent" | "tree">("all")
  const scoped = () => (scope() === "agent" ? agentChanged() : scope() === "tree" ? treeChanged() : undefined)

  const files = createMemo((): MarkedFile[] => {
    const marked = Object.entries(data()?.files ?? {}).map(([path, file]) => ({
      path,
      marks: file.m,
      line: file.line,
      changed: changeOf(path),
    }))
    const only = scoped()
    if (!only) return marked
    // Changed files with no marks at all join too, so nothing in scope is hidden.
    const unmarked = [...only.keys()]
      .filter((path) => !data()?.files[path])
      .map((path) => ({ path, marks: [], line: 1, changed: changeOf(path) }))
    return [...marked.filter((file) => only.has(file.path)), ...unmarked]
  })

  // Groups showing every column, by key. Cleared on a Lens switch, whose keys mean other facets.
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  createEffect(() => {
    activeId()
    setExpanded(new Set<string>())
  })
  const toggleExpanded = (group: Group) => {
    const id = group.key.join(",")
    const next = new Set(expanded())
    if (!next.delete(id)) next.add(id)
    logInteraction(next.has(id) ? "group.expand" : "group.collapse", id)
    setExpanded(next)
  }

  const groups = createMemo(() => {
    const ids = facetIds()
    const off = new Set(ids.flatMap((facet, i) => (suppressed().has(facet) ? [i] : [])))
    return groupByCombination(files(), off, { keepUnmarked: scope() !== "all" }).map((group) => {
      const all = packColumns(group.runs, GRID_ROWS)
      const open = expanded().has(group.key.join(","))
      const capped = capColumns(all, open ? all.length : MAX_GROUP_COLUMNS)
      // `toggle` exists whenever the group is too wide to show whole: "+N more" or "◂ less".
      return { group, columns: capped.columns, hidden: capped.hidden, toggle: all.length > MAX_GROUP_COLUMNS }
    })
  })

  const summary = () => {
    if (map.error) return "fetch error"
    if (!data()) return "loading…"
    if (!lens()) return "no Lens yet"
    const n = files().length
    const g = `${groups().length} group${groups().length === 1 ? "" : "s"}`
    if (scope() === "agent") return `${n} file${n === 1 ? "" : "s"} changed by the agent · ${g}`
    if (scope() === "tree") return `${n} uncommitted file${n === 1 ? "" : "s"} · ${g}`
    return `${n} marked file${n === 1 ? "" : "s"} · ${g}`
  }

  // Study logging: a click in the view, interleaved with the agent's prompts and tool calls.
  const logInteraction = (interaction: string, detail?: string) => {
    void props.api.client.aperture.interaction({
      sessionID: props.session_id,
      interaction,
      lens: activeId(),
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  const cycleLens = (direction: "next" | "prev") => {
    logInteraction("lens.cycle", direction)
    void props.api.client.aperture.cycleLens({ direction })
  }

  // Open the file in the editor, at its first marked line.
  const openFile = (file: MarkedFile) => {
    logInteraction("file.open", file.path)
    void props.api.client.tui.openFile({ path: file.path, line: file.line })
  }

  // Adopt a filter that was already set when this view mounted. Once only: past the first
  // payload the event is the live channel, and re-reading every poll could un-grey a facet the
  // user just clicked if the fetch raced ahead of our own POST.
  let seededFilter = false
  createEffect(() => {
    const d = data()
    if (seededFilter || !d) return
    seededFilter = true
    if (d.suppressed.length) setSuppressed(new Set(d.suppressed))
  })

  const publishFilter = (next: ReadonlySet<string>) => {
    void props.api.client.aperture.facetFilter({ facets: [...next] })
  }
  const toggleFacet = (facet: string) => {
    const next = new Set(suppressed())
    if (!next.delete(facet)) next.add(facet)
    logInteraction("legend.toggle", facet)
    setSuppressed(next)
    publishFilter(next)
  }
  // The scope a click moves to, skipping one with nothing in it.
  const nextScope = () => {
    if (scope() === "all" && agentChanged().size > 0) return "agent"
    if (scope() !== "tree" && treeChanged().size > 0) return "tree"
    return "all"
  }
  const cycleScope = () => {
    const next = nextScope()
    logInteraction("changed.scope", next)
    setScope(next)
  }
  // Worded as the action a click takes, since it starts off (unlike the facet chips, which start
  // on and are clicked to grey out); the summary line names the scope in force. Kept while a
  // scope is on, even at zero, so it can always be undone.
  const changedLabel = () => {
    const next = nextScope()
    if (next === "agent") return `${AGENT_MARK} show agent changes (${agentChanged().size})`
    if (next === "tree") return `${TREE_MARK} show uncommitted (${treeChanged().size})`
    return "show all"
  }
  const showChangedToggle = () => scope() !== "all" || nextScope() !== "all"

  const clearFilter = () => {
    logInteraction("legend.reset")
    setSuppressed(new Set<string>())
    publishFilter(new Set<string>())
  }

  // Delete the active Lens: the first click arms, the second deletes.
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const deleteActiveLens = () => {
    if (!activeId()) return
    if (!confirmingDelete()) return setConfirmingDelete(true)
    setConfirmingDelete(false)
    logInteraction("lens.delete", activeId())
    void props.api.client.aperture.deleteLens({ lens: activeId() })
  }
  const deleteLabel = () => (confirmingDelete() ? "✕ confirm?" : "✕")
  createEffect(() => {
    activeId()
    setConfirmingDelete(false)
  })

  // The lens cluster's rendered width (◀ name ▶ ⌄ ✕ with gap 1), so the legend trim below
  // charges exactly what renders.
  const lensLabel = () => (lens() ? lens()!.name + (lens()!.owner === "agent" ? " (agent)" : "") : "")
  const lensClusterWidth = () => {
    if (!lens()) return 0
    const items = [1, lensLabel().length, 1, 1, deleteLabel().length]
    return items.reduce((a, b) => a + b, 0) + (items.length - 1)
  }
  // Fit the one-row legend: when it would overflow, even-trim the facet labels to the largest
  // shared cap that fits (never below LEGEND_LABEL_MIN). The detail region shows the full label.
  const trimmedLegend = createMemo(() => {
    const entries = legendEntries()
    const reset = suppressed().size > 0 ? 1 : 0
    const toggle = showChangedToggle() ? 1 : 0
    const children = (lens() ? 1 : 0) + entries.length + reset + toggle
    const fixed =
      lensClusterWidth() +
      entries.length * 2 +
      reset * LEGEND_RESET.length +
      toggle * changedLabel().length +
      Math.max(0, children - 1) * LEGEND_GAP +
      LEGEND_SAFETY_PAD
    const budget = dimensions().width - BAR_PADDING_X * 2 - fixed
    const maxLen = entries.reduce((m, e) => Math.max(m, e.label.length), 0)
    let cap = LEGEND_LABEL_MIN
    for (let n = LEGEND_LABEL_MIN; n <= maxLen; n++) {
      if (entries.reduce((s, e) => s + Math.min(e.label.length, n), 0) <= budget) cap = n
      else break
    }
    return entries.map((e) => ({
      ...e,
      label: e.label.length > cap ? e.label.slice(0, cap - 1) + "…" : e.label,
    }))
  })

  const colors = createMemo(() => facetColors(legendEntries(), suppressed(), theme()))
  const facetColor = (facet: string) => colors().facetColor(facet)
  const labelOf = (index: number) => {
    const facet = facetIds()[index]
    return legendEntries().find((e) => e.facet === facet)?.label ?? facet ?? "?"
  }

  // A tile's band: its group's facets, each taking a share of the width proportional to its marked
  // lines, and every one of them at least one cell — a single marked line still shows.
  const bandColors = (file: MarkedFile, group: Group): TuiThemeCurrent["text"][] => {
    const lines = new Map(file.marks.map((m) => [m.f, m.l]))
    const bands = group.key.map((f) => ({ key: String(f), value: lines.get(f) ?? 0 }))
    const alloc = allocateCells(bands, NAME_W)
    const flat = alloc.flatMap((a) => Array.from({ length: a.n }, () => facetColor(facetIds()[Number(a.key)] ?? "")))
    while (flat.length < NAME_W) flat.push(theme().backgroundPanel)
    return flat
  }

  const describeFile = (file: MarkedFile, group: Group) => {
    const lines = new Map(file.marks.map((m) => [m.f, m.l]))
    const agent = agentChanged().get(file.path)
    const uncommitted = treeChanged().get(file.path)
    return [
      ...group.key.map((f) => `${labelOf(f)} ${lines.get(f) ?? 0} line${lines.get(f) === 1 ? "" : "s"}`),
      ...(agent ? [`changed by agent +${agent.additions} −${agent.deletions}`] : []),
      ...(uncommitted ? [`uncommitted +${uncommitted.additions} −${uncommitted.deletions}`] : []),
    ]
  }

  // The detail region's subject, narrowed per kind for <Match>. A facet that vanished under the
  // pointer (a Lens switch) falls back to the hints rather than describing nothing.
  const detailWidth = () => dimensions().width - BAR_PADDING_X * 2
  const hoveredFacet = () => {
    const h = hovered()
    return h?.kind === "facet" ? legendEntries().find((e) => e.facet === h.facet) : undefined
  }
  const hoveredGroup = () => {
    const h = hovered()
    return h?.kind === "group" ? h : undefined
  }
  const hoveredFile = () => {
    const h = hovered()
    return h?.kind === "file" ? h : undefined
  }
  const combinationText = (group: Group) => {
    if (group.key.length === 0) return "changed files that carry no facet"
    const n = group.files.length
    const files = `${n} file${n === 1 ? "" : "s"}`
    if (group.key.length === 1) return `${files} marked only by ${labelOf(group.key[0]!)}`
    return `${files} marked by exactly ${group.key.map(labelOf).join(" + ")}`
  }

  const groupWidth = (entry: { group: Group; columns: Segment[][]; toggle: boolean }) =>
    Math.max(
      entry.columns.length * TILE_W + (entry.toggle ? MORE_W : 0),
      // Two cells per facet square; the unmarked group draws one placeholder square.
      headerText(entry.group).length + Math.max(entry.group.key.length, 1) * 2,
    )
  const contentWidth = createMemo(() => {
    const widths = groups().map(groupWidth)
    return widths.reduce((a, b) => a + b, 0) + GROUP_GAP * Math.max(0, widths.length - 1)
  })
  const scrollbarVisible = createMemo(() => contentWidth() > dimensions().width - BAR_PADDING_X * 2)
  const barHeight = () => TOP_BAR_HEIGHT + (scrollbarVisible() ? 1 : 0)

  // Redirect a vertical wheel into horizontal scroll so either gesture pans the strip. Shift+wheel
  // is left alone — the scrollbox already remaps it.
  let scroll: ScrollBoxRenderable | undefined
  const onWheel = (event: MouseEvent) => {
    const dir = event.scroll?.direction
    if (!scroll || event.modifiers.shift || (dir !== "up" && dir !== "down")) return
    const cells = (event.scroll?.delta ?? 1) * HSCROLL_STEP
    scroll.scrollLeft += dir === "up" ? -cells : cells
  }

  const emptyMessage = () => {
    if (map.error) return "Could not load the Aperture view."
    if (!data()) return ""
    if (!lens()) return "No Lens yet — ask the agent to mark something, or it will curate one as it works."
    if (scope() === "agent" && agentChanged().size === 0) return "The agent hasn't changed any files this session."
    if (scope() === "tree" && treeChanged().size === 0) return "Nothing uncommitted in the working tree."
    if (files().length === 0) return `Nothing marked under "${lens()!.name}" yet.`
    return "Every facet is filtered out — click one in the legend, or ↺ to reset."
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
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme().text}>
            <b>Aperture</b>
          </text>
          <text
            fg={theme().accent}
            onMouseDown={() => {
              logInteraction("refresh")
              refetch()
            }}
          >
            ⟳
          </text>
        </box>
        <text fg={theme().textMuted} wrapMode="none">
          {summary()}
        </text>
      </box>

      <box flexDirection="row" gap={LEGEND_GAP} height={1} flexShrink={0}>
        <Show when={lens()}>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={theme().accent} onMouseDown={() => cycleLens("prev")} wrapMode="none">
              ◀
            </text>
            <text fg={theme().accent} onMouseDown={() => cycleLens("next")} wrapMode="none">
              {lensLabel()}
            </text>
            <text fg={theme().accent} onMouseDown={() => cycleLens("next")} wrapMode="none">
              ▶
            </text>
            {/* Opened on mouse *up*: the dialog backdrop dismisses itself on the mouse-up it sees
                outside its box, so opening on mouse-down would close it immediately. */}
            <text fg={theme().textMuted} onMouseUp={() => openLensPicker(props.api, props.session_id)} wrapMode="none">
              ⌄
            </text>
            <text
              fg={confirmingDelete() ? theme().error : theme().textMuted}
              onMouseDown={() => deleteActiveLens()}
              wrapMode="none"
            >
              {deleteLabel()}
            </text>
          </box>
        </Show>
        <For each={trimmedLegend()}>
          {(entry) => (
            <box
              flexDirection="row"
              flexShrink={0}
              onMouseDown={() => toggleFacet(entry.facet)}
              onMouseOver={() => setHovered({ kind: "facet", facet: entry.facet })}
              onMouseOut={() => setHovered(undefined)}
            >
              <text fg={facetColor(entry.facet)} wrapMode="none">
                ■
              </text>
              <text fg={suppressed().has(entry.facet) ? theme().border : theme().textMuted} wrapMode="none">
                {" " + entry.label}
              </text>
            </box>
          )}
        </For>
        <Show when={suppressed().size > 0}>
          <text fg={theme().accent} onMouseDown={() => clearFilter()} wrapMode="none">
            {LEGEND_RESET}
          </text>
        </Show>
        <Show when={showChangedToggle()}>
          <text
            fg={scope() !== "all" ? theme().accent : theme().textMuted}
            onMouseDown={() => cycleScope()}
            wrapMode="none"
          >
            {changedLabel()}
          </text>
        </Show>
      </box>

      <box flexDirection="column" height={DETAIL_ROWS} flexShrink={0}>
        <Switch fallback={<Hints show={!!lens()} width={detailWidth()} theme={theme} />}>
          <Match when={hoveredFacet()}>
            {(entry) => (
              <>
                <text wrapMode="none" fg={theme().text}>
                  <span style={{ fg: facetColor(entry().facet) }}>■ </span>
                  <b>{truncate(entry().label, detailWidth() - 2)}</b>
                  <span style={{ fg: theme().textMuted }}>
                    {truncate(
                      "  " +
                        (entry().queries.length ? "query: " + entry().queries.join(" · ") : "no rules") +
                        (suppressed().has(entry().facet) ? "  (hidden — click its name to show)" : ""),
                      Math.max(0, detailWidth() - 2 - entry().label.length),
                    )}
                  </span>
                </text>
                <text wrapMode="none" fg={entry().reason ? theme().text : theme().textMuted}>
                  {truncate("reason: " + (entry().reason || "none given"), detailWidth())}
                </text>
              </>
            )}
          </Match>
          <Match when={hoveredGroup()}>
            {(entry) => (
              <>
                <text wrapMode="none" fg={theme().text}>
                  <For each={entry().group.key}>
                    {(f) => <span style={{ fg: facetColor(facetIds()[f] ?? "") }}>■ </span>}
                  </For>
                  {truncate(combinationText(entry().group), detailWidth() - entry().group.key.length * 2)}
                </text>
                <text wrapMode="none" fg={theme().textMuted}>
                  {truncate(
                    [
                      ...(entry().group.key.length ? ["hover one ■ for its query and reason"] : []),
                      ...(entry().toggle ? [entry().hidden > 0 ? "click to show every file" : "click to fold"] : []),
                    ].join(" · "),
                    detailWidth(),
                  )}
                </text>
              </>
            )}
          </Match>
          <Match when={hoveredFile()}>
            {(entry) => (
              <>
                <text wrapMode="none" fg={theme().text}>
                  {truncate(entry().file.path, detailWidth())}
                </text>
                <text wrapMode="none" fg={theme().textMuted}>
                  {truncate(
                    [...describeFile(entry().file, entry().group), `click to open at line ${entry().file.line}`].join(
                      " · ",
                    ),
                    detailWidth(),
                  )}
                </text>
              </>
            )}
          </Match>
        </Switch>
      </box>

      <Show
        when={groups().length > 0}
        fallback={
          <text fg={theme().textMuted} wrapMode="none">
            {emptyMessage()}
          </text>
        }
      >
        {/* NB: the scrollbox's `scrollX`/`scrollY` are constructor-only and inert as props, so
            the content box is configured directly: no maxWidth (horizontal overflow scrolls),
            maxHeight pinned (no vertical scroll). */}
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          flexGrow={1}
          onMouseScroll={onWheel}
          contentOptions={{ flexDirection: "row", gap: GROUP_GAP, maxWidth: undefined, maxHeight: "100%" }}
          verticalScrollbarOptions={{ visible: false }}
          horizontalScrollbarOptions={{
            showArrows: false,
            trackOptions: { foregroundColor: theme().textMuted, backgroundColor: theme().backgroundPanel },
          }}
        >
          <For each={groups()}>
            {(entry) => (
              <box flexDirection="column" flexShrink={0} width={groupWidth(entry)}>
                <box
                  flexDirection="row"
                  height={1}
                  flexShrink={0}
                  onMouseDown={() => entry.toggle && toggleExpanded(entry.group)}
                  onMouseOver={() => setHovered({ kind: "group", ...entry })}
                  onMouseOut={() => setHovered(undefined)}
                >
                  <Show when={entry.group.key.length === 0}>
                    <text fg={theme().textMuted} wrapMode="none">
                      {"□ "}
                    </text>
                  </Show>
                  <For each={entry.group.key}>
                    {(f) => (
                      <text
                        fg={facetColor(facetIds()[f] ?? "")}
                        wrapMode="none"
                        // Claims the hover for its own facet: over/out bubble, and the header's
                        // handler would otherwise replace this with the whole combination.
                        onMouseOver={(event: MouseEvent) => {
                          event.stopPropagation()
                          setHovered({ kind: "facet", facet: facetIds()[f] ?? "" })
                        }}
                      >
                        {"■ "}
                      </text>
                    )}
                  </For>
                  <text fg={theme().textMuted} wrapMode="none">
                    {headerText(entry.group)}
                  </text>
                </box>
                <box flexDirection="row" flexShrink={0}>
                  <For each={entry.columns}>
                    {(column) => (
                      <box flexDirection="column" flexShrink={0}>
                        <For each={column}>
                          {(segment) => (
                            <box
                              border
                              customBorderChars={SQUARE_CORNERS}
                              borderColor={theme().border}
                              title={segmentTitle(segment)}
                              titleAlignment="left"
                              width={TILE_W}
                              height={segment.files.length + SEGMENT_BORDER_ROWS}
                              flexShrink={0}
                              flexDirection="column"
                            >
                              <For each={segment.files}>
                                {(file) => (
                                  <box
                                    onMouseDown={() => openFile(file)}
                                    onMouseOver={() => setHovered({ kind: "file", file, group: entry.group })}
                                    onMouseOut={() => setHovered(undefined)}
                                  >
                                    <NameRow
                                      name={truncate(changeMark(file) + basename(file.path), NAME_W)}
                                      width={NAME_W}
                                      colors={() => bandColors(file, entry.group)}
                                      // No band behind an unmarked file, so its name needs the ordinary text colour.
                                      textColor={() =>
                                        entry.group.key.length === 0 ? theme().text : theme().background
                                      }
                                      theme={theme}
                                    />
                                  </box>
                                )}
                              </For>
                            </box>
                          )}
                        </For>
                      </box>
                    )}
                  </For>
                  <Show when={entry.toggle}>
                    <box
                      width={MORE_W}
                      flexShrink={0}
                      flexDirection="column"
                      paddingLeft={1}
                      onMouseDown={() => toggleExpanded(entry.group)}
                    >
                      <Show
                        when={entry.hidden > 0}
                        fallback={
                          <text fg={theme().accent} wrapMode="none">
                            ◂ less
                          </text>
                        }
                      >
                        <text fg={theme().accent} wrapMode="none">
                          {`+${entry.hidden}`}
                        </text>
                        <text fg={theme().accent} wrapMode="none">
                          more ▸
                        </text>
                      </Show>
                    </box>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}

// One inner row of `width` character cells: each shows the name's character (or a space) in
// `textColor` over the per-column background from `colors`. The per-character split is what
// lets dark text sit over a multi-colour band.
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

type Hovered =
  | { readonly kind: "facet"; readonly facet: string }
  | { readonly kind: "group"; readonly group: Group; readonly toggle: boolean; readonly hidden: number }
  | { readonly kind: "file"; readonly file: MarkedFile; readonly group: Group }

// What the detail region shows when nothing is hovered: the bar's affordances, since none of them
// is visible until the pointer finds it.
function Hints(props: { show: boolean; width: number; theme: () => TuiThemeCurrent }) {
  return (
    <Show when={props.show}>
      <text wrapMode="none" fg={props.theme().textMuted}>
        {truncate("Hover a ■ or a facet name for its query and reason · click a name to hide or show it", props.width)}
      </text>
      <text wrapMode="none" fg={props.theme().textMuted}>
        {truncate(
          "Click a file to open it at its first mark · scroll to pan · click a crowded group to expand it",
          props.width,
        )}
      </text>
    </Show>
  )
}

function headerText(group: Group) {
  const n = group.files.length
  const agent = group.files.filter((file) => file.changed === "agent").length
  const tree = group.files.filter((file) => file.changed === "tree").length
  const label = group.key.length === 0 ? "unmarked · " : ""
  return [
    `${label}${n} file${n === 1 ? "" : "s"}`,
    ...(agent > 0 ? [`${AGENT_MARK}${agent}`] : []),
    ...(tree > 0 ? [`${TREE_MARK}${tree}`] : []),
  ].join(" · ")
}

function changeMark(file: MarkedFile) {
  if (file.changed === "agent") return AGENT_MARK
  if (file.changed === "tree") return TREE_MARK
  return ""
}

// The project directory's path inside the worktree, as a prefix to strip from git's paths.
function relativePrefix(worktree: string, directory: string) {
  if (directory === worktree || !directory.startsWith(worktree + "/")) return ""
  return directory.slice(worktree.length + 1) + "/"
}

// A run's border title: its directory, trimmed from the left so the most specific part survives.
function segmentTitle(segment: Segment) {
  const dir = segment.dir === "" ? "(root)" : segment.dir
  const label = (segment.continued ? "↳ " : "") + dir
  const max = TILE_W - 4
  return label.length > max ? "…" + label.slice(label.length - max + 1) : label
}

function truncate(s: string, max: number) {
  if (max <= 0) return ""
  return s.length > max ? s.slice(0, max - 1) + "…" : s
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
  // Searchable Lens picker, reachable from the command palette / `/lens-switch` (and from the ⌄
  // next to the active Lens name).
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
