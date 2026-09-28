import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { allocateCells } from "@/aperture/treemap"
import {
  basename,
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
// One read serves it: the whole-repo facet map (`aperture.facetMap`), refetched whenever the
// server says the marks may have moved (aperture.invalidated) or a turn ends.

type FacetMap = {
  lens?: {
    id: string
    name: string
    owner: "user" | "agent"
    legend: readonly { facet: string; label: string; color: string }[]
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
// Title row + legend row + group header + grid + the bar's bottom border. NB:
// `routes/session/index.tsx` hides the bar outright on short terminals using its own literal —
// move that with this.
const TOP_BAR_HEIGHT = 2 + 1 + GRID_ROWS + 1
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
  // What the pointer is over, shown in the title row; cleared on mouse-out.
  const [hovered, setHovered] = createSignal<string | undefined>()
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

  const offInvalidated = props.api.event.on("aperture.invalidated", () => refetch())
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
    if (sid === props.session_id || props.api.state.session.get(sid)?.parentID === props.session_id) refetch()
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

  const files = createMemo((): MarkedFile[] =>
    Object.entries(data()?.files ?? {}).map(([path, file]) => ({ path, marks: file.m, line: file.line })),
  )
  const groups = createMemo(() => {
    const ids = facetIds()
    const off = new Set(ids.flatMap((facet, i) => (suppressed().has(facet) ? [i] : [])))
    return groupByCombination(files(), off).map((group) => ({ group, columns: packColumns(group.runs, GRID_ROWS) }))
  })

  const summary = () => {
    if (map.error) return "fetch error"
    if (!data()) return "loading…"
    if (!lens()) return "no Lens yet"
    const n = files().length
    return `${n} marked file${n === 1 ? "" : "s"} · ${groups().length} group${groups().length === 1 ? "" : "s"}`
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
  // shared cap that fits (never below LEGEND_LABEL_MIN). The hover line shows the full label.
  const trimmedLegend = createMemo(() => {
    const entries = legendEntries()
    const reset = suppressed().size > 0 ? 1 : 0
    const children = (lens() ? 1 : 0) + entries.length + reset
    const fixed =
      lensClusterWidth() +
      entries.length * 2 +
      reset * LEGEND_RESET.length +
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
      full: e.label,
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
    return [
      file.path,
      ...group.key.map((f) => `${labelOf(f)} ${lines.get(f) ?? 0} line${lines.get(f) === 1 ? "" : "s"}`),
    ].join(" · ")
  }

  const groupWidth = (entry: { group: Group; columns: Segment[][] }) =>
    Math.max(entry.columns.length * TILE_W, headerText(entry.group).length + entry.group.key.length * 2)
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
        <text fg={hovered() ? theme().text : theme().textMuted} wrapMode="none">
          {hovered() ?? summary()}
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
              onMouseOver={() => setHovered(entry.full)}
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
                  onMouseOver={() => setHovered(entry.group.key.map(labelOf).join(" + "))}
                  onMouseOut={() => setHovered(undefined)}
                >
                  <For each={entry.group.key}>
                    {(f) => (
                      <text fg={facetColor(facetIds()[f] ?? "")} wrapMode="none">
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
                                    onMouseOver={() => setHovered(describeFile(file, entry.group))}
                                    onMouseOut={() => setHovered(undefined)}
                                  >
                                    <NameRow
                                      name={truncate(basename(file.path), NAME_W)}
                                      width={NAME_W}
                                      colors={() => bandColors(file, entry.group)}
                                      textColor={() => theme().background}
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

function headerText(group: Group) {
  return `${group.files.length} file${group.files.length === 1 ? "" : "s"}`
}

// A run's border title: its directory, trimmed from the left so the most specific part survives.
function segmentTitle(segment: Segment) {
  const dir = segment.dir === "" ? "(root)" : segment.dir
  const label = (segment.continued ? "↳ " : "") + dir
  const max = TILE_W - 4
  return label.length > max ? "…" + label.slice(label.length - max + 1) : label
}

function truncate(s: string, max: number) {
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
