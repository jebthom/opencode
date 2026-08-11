import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { allocateCells, buildGrid, coalesce } from "@/aperture/treemap"
import { stepsForTurns, stepWeight, type Step, type TurnSteps } from "@/aperture/activity-steps"
import type { Action, Turn } from "@/aperture/activity"
import { facetColors, resolveColor, GREY_CELL } from "../system/aperture-colors"
import { UNTAGGED_HUE } from "@/aperture/lenses"

const id = "internal:sidebar-activity"

// The Activity Path (PLAN.md G2/G3): the agent's work as a vertical timeline of steps,
// each coloured by the active Lens, so a user can see at a glance whether the agent
// visited the concerns they expected.
//
// **The vertical axis is time and one step is exactly one row.** That identity is what
// makes the budget legible — ACTIVITY_ROWS steps are visible, always — and it falls out of
// the step rule rather than being imposed on it: a gathering step aggregates a whole run of
// reads into one row, while every mutation is its own step and therefore its own row. The
// asymmetry IS the encoding of "a mutation the user did not notice is the failure this view
// exists to prevent". Horizontal carries magnitude and composition.
//
// Segmentation lives in `aperture/activity-steps.ts` — pure, tested, and free of any
// orientation — so this file holds only the drawing. Data comes from GET /aperture/activity
// (derived server-side from the message store, never recorded), which also ships the legend
// and the suppressed set, so the sidebar needs no graph fetch of its own.

// G0's budget. The nested scrollbox is not a nicety: the sidebar's own scrollbox is shared
// by every section, so `stickyScroll` on it would pin the WHOLE sidebar to its bottom.
// A nested box with an explicit height is the only way this section can stay pinned to its
// newest step, and it is also what caps its contribution at a constant however long the
// session runs.
const ACTIVITY_ROWS = 10
// The sidebar's drawable width; `files.tsx` already hard-codes 36, so this is the house
// number rather than a second opinion.
const SIDEBAR_COLS = 36
// How many recent turns to ask for. More than fits, deliberately — the scrollback is the
// point, and the endpoint pages backwards so a long session costs what a fresh one does.
const ACTIVITY_TURNS = 12

// Row anatomy: spine/indent, the action mark, a space, then the band or label, then `×n`.
const SPINE_COLS = 2
const MARK_COLS = 2
const COUNT_COLS = 5
const INDENT_COLS = 2
const BAND_MIN = 2
const bandMax = (depth: number) => SIDEBAR_COLS - SPINE_COLS - MARK_COLS - COUNT_COLS - depth * INDENT_COLS

// One glyph per action, restoring the vocabulary G1 deleted from the top bar's overlay row.
// Solid marks for things that changed the repo, outline/领 marks for things that only looked.
const MARKS: Record<Action, string> = {
  read: "●",
  search: "⌕",
  edit: "◆",
  create: "■",
  run: "⚙",
  fetch: "↗",
}

// The wire shape of GET /aperture/activity. Declared locally for the same reason the top
// bar declares `Graph` locally — the generated SDK type is structural and this keeps the
// renderer readable.
type ActivityResult = {
  lens?: { id: string; name: string; legend: readonly { facet: string; label: string; color: string }[] }
  facets: readonly string[]
  turns: readonly Turn[]
  files: Record<string, { t: number; w: readonly { f: number; p: number }[] }>
  suppressed?: readonly string[]
}

// A row is what actually gets drawn: one step, or the muted rule that separates two turns,
// or the header naming a sub-agent's lane. Flattening to rows here (rather than nesting
// three `<For>`s) is what lets the scrollbox treat the timeline as a simple list.
type Row =
  | { kind: "turn"; key: string; promptedAt: number; agent: string }
  | { kind: "lane"; key: string; agent: string; depth: number }
  | { kind: "step"; key: string; step: Step }

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  const [activity, { refetch }] = createResource(
    () => ({ directory: props.api.state.path.directory, sessionID: props.session_id }),
    async (key) => {
      const result = await props.api.client.aperture.activity(
        // Serialised as a string: the query schema is NumberFromString, so the wire form
        // is text and the server does the parsing.
        { sessionID: key.sessionID, turns: String(ACTIVITY_TURNS) },
        { throwOnError: true },
      )
      return result.data as ActivityResult
    },
  )

  // A turn boundary — this session, or a sub-agent it spawned, going idle — is when new
  // activity has settled. `session.status` is a core event (unlike the experimental
  // session.next.* family), so this fires with the experimental event system off, which is
  // the same reason the top bar refetches here.
  const offIdle = props.api.event.on("session.status", (event) => {
    if (event.properties.status.type !== "idle") return
    const sid = event.properties.sessionID
    if (sid === props.session_id || props.api.state.session.get(sid)?.parentID === props.session_id) refetch()
  })
  onCleanup(() => offIdle())

  // A repaint or a Lens switch changes the colours, not the history — but the colours come
  // down with the response, so this has to refetch. `turns` comes back byte-identical
  // either way, which is what "switching Lens recolours history without re-recording it"
  // means in practice.
  const offInvalidated = props.api.event.on("aperture.invalidated", () => refetch())
  onCleanup(() => offInvalidated())

  // The legend filter changed elsewhere (O4). No refetch: the filter is a pure function of
  // the weights we already hold, applied at the one place a facet becomes a colour.
  const [filtered, setFiltered] = createSignal<ReadonlySet<string>>()
  const offFilter = props.api.event.on("aperture.facets.filtered", (event) => {
    setFiltered(new Set(event.properties.facets))
  })
  onCleanup(() => offFilter())

  // Guarded reads — never call the resource accessor in its error state (the documented
  // render→catch→re-render leak, PLAN.md).
  const data = () => (activity.error ? undefined : activity())
  const facets = () => data()?.facets ?? []
  const suppressed = () => filtered() ?? new Set(data()?.suppressed ?? [])
  const colors = createMemo(() => facetColors(data()?.lens?.legend ?? [], suppressed(), theme()))

  // Segment every turn, then flatten to drawable rows in reading order: oldest turn first,
  // so the newest work sits at the bottom where stickyScroll pins it.
  const rows = createMemo<Row[]>(() => {
    const turns = data()?.turns ?? []
    const segmented: TurnSteps[] = stepsForTurns(turns)
    const out: Row[] = []
    segmented.forEach((turn, t) => {
      if (turn.lanes.length === 0) return
      out.push({ kind: "turn", key: `t${t}`, promptedAt: turn.promptedAt, agent: turn.agent })
      turn.lanes.forEach((lane, l) => {
        // Only sub-agent lanes announce themselves; the depth-0 spine is the turn itself
        // and naming it would cost a row per turn to say nothing.
        if (lane.depth > 0) {
          out.push({ kind: "lane", key: `t${t}l${l}`, agent: lane.agent, depth: lane.depth })
        }
        lane.steps.forEach((step, s) => out.push({ kind: "step", key: `t${t}l${l}s${s}`, step }))
      })
    })
    return out
  })

  // The largest gathering step on screen, as the denominator a survey band scales against.
  // Only survey steps compete: a mutate step holds one file and draws its name at full
  // width, so it is not measuring the same thing.
  const maxSurvey = createMemo(() => {
    let max = 0
    for (const row of rows()) {
      if (row.kind === "step" && row.step.mode === "survey") max = Math.max(max, row.step.files.length)
    }
    return max
  })

  // Per-facet totals for a step, rolled up across the files it touched.
  //
  // `t * p / 100` is the documented client rollup: `p` is a rounded percentage and `t` the
  // pre-rounding denominator, so this carries a file's real weight even where a sliver was
  // floored to 1%. Places contribute nothing by design — a survey step is already an
  // aggregate, and folding a directory's subtree into it would report the mix of code the
  // agent never opened.
  const stepBands = (step: Step) => {
    const files = data()?.files
    if (!files) return []
    const totals = new Map<string, number>()
    for (const file of step.files) {
      const mix = files[file.path]
      if (!mix) continue
      for (const w of mix.w) {
        const facet = facets()[w.f]
        if (facet === undefined) continue
        totals.set(facet, (totals.get(facet) ?? 0) + (mix.t * w.p) / 100)
      }
    }
    return [...totals].map(([key, value]) => ({ key, value }))
  }

  // The colours of one step's band, left to right. Falls back to the untagged grey when the
  // step touched nothing painted — the honest grey the treemap already draws for un-swept
  // code, rather than an empty row that reads as a rendering bug.
  const bandColors = (step: Step, width: number): TuiThemeCurrent["text"][] => {
    const bands = stepBands(step)
    if (bands.length === 0) return Array.from({ length: width }, () => resolveColor(theme(), UNTAGGED_HUE))
    const flat: string[] = []
    for (const a of allocateCells(bands, width)) for (let i = 0; i < a.n; i++) flat.push(a.key)
    if (flat.length === 0) return Array.from({ length: width }, () => colors().colorFor(GREY_CELL))
    while (flat.length < width) flat.push(GREY_CELL)
    return flat.map((key) => colors().colorFor(key))
  }

  const empty = () => rows().length === 0

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
        <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text}>
          <b>Activity</b>
        </text>
        <Show when={data()?.lens?.name}>
          {(name) => (
            <text fg={theme().textMuted} wrapMode="none">
              {name()}
            </text>
          )}
        </Show>
      </box>
      <Show when={open()}>
        <Show
          when={!empty()}
          fallback={
            <text fg={theme().textMuted} wrapMode="none">
              {activity.error ? "unavailable" : activity.loading ? "loading…" : "nothing yet"}
            </text>
          }
        >
          <scrollbox
            height={ACTIVITY_ROWS}
            flexShrink={0}
            stickyScroll={true}
            stickyStart="bottom"
            viewportOptions={{ paddingRight: 0 }}
            verticalScrollbarOptions={{ visible: false }}
          >
            <For each={rows()}>
              {(row) => (
                <Show when={row.kind === "step"} fallback={<LabelRow row={row} theme={theme} />}>
                  <StepRow
                    step={(row as Extract<Row, { kind: "step" }>).step}
                    theme={theme}
                    colorsFor={bandColors}
                    maxSurvey={maxSurvey}
                  />
                </Show>
              )}
            </For>
          </scrollbox>
        </Show>
      </Show>
    </box>
  )
}

// A turn separator or a sub-agent lane header — the two rows that carry words rather than
// colour. Muted, so the coloured steps stay the thing the eye lands on.
function LabelRow(props: { row: Row; theme: () => TuiThemeCurrent }) {
  const text = () => {
    const row = props.row
    if (row.kind === "turn") return `── ${relTime(row.promptedAt)} · ${row.agent} ${"─".repeat(SIDEBAR_COLS)}`
    if (row.kind === "lane") return `${" ".repeat(SPINE_COLS)}└ ${row.agent}`
    return ""
  }
  return (
    <box height={1} flexShrink={0}>
      <text fg={props.theme().textMuted} wrapMode="none">
        {truncate(text(), SIDEBAR_COLS)}
      </text>
    </box>
  )
}

// One step, one row: the spine, the action mark, then either a facet band (gathering) or a
// named band (a changed file) or a plain label (a command, a fetch).
function StepRow(props: {
  step: Step
  theme: () => TuiThemeCurrent
  colorsFor: (step: Step, width: number) => TuiThemeCurrent["text"][]
  maxSurvey: () => number
}) {
  const depth = () => props.step.depth
  const mark = () => MARKS[dominantAction(props.step)]
  const count = () => stepWeight(props.step)

  // A mutate step holds exactly one file, so it can afford to name it — identity is the
  // whole point of showing a mutation. A survey step names nothing and scales instead.
  const named = () => (props.step.mode === "survey" ? undefined : props.step.files[0]?.path)

  const width = () => {
    const max = bandMax(depth())
    if (props.step.mode !== "survey") return max
    const n = props.step.files.length
    const peak = props.maxSurvey()
    if (n === 0 || peak === 0) return 0
    // sqrt so area (not length) carries the comparison — the same idiom the treemap's
    // `scaleCells` uses, so a block and a step read at the same scale.
    return Math.max(BAND_MIN, Math.min(max, Math.round(max * Math.sqrt(n / peak))))
  }

  const cells = createMemo(() => {
    const w = width()
    if (w <= 0) return []
    const label = named()
    const name = label === undefined ? "" : truncate(basename(label), w)
    const colors = props.colorsFor(props.step, w)
    return Array.from({ length: w }, (_, i) => ({ bg: colors[i]!, ch: name[i] ?? " " }))
  })

  // A pathless step (a shell command, a web fetch) has no band to draw, so it says what it
  // was in words instead of leaving the row blank.
  const beatLabel = () => (props.step.files.length === 0 && props.step.places.length > 0 ? "looked around" : undefined)

  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={props.theme().textMuted} wrapMode="none">
        {`${" ".repeat(SPINE_COLS + depth() * INDENT_COLS)}${mark()} `}
      </text>
      <Show
        when={cells().length > 0}
        fallback={
          <text fg={props.theme().textMuted} wrapMode="none">
            {beatLabel() ?? props.step.agent}
          </text>
        }
      >
        <box flexDirection="row" height={1} flexShrink={0}>
          <For each={coalesceCells(cells())}>
            {(run) => (
              <Show
                when={run.text.trim().length > 0}
                fallback={<box width={run.len} height={1} flexShrink={0} backgroundColor={run.bg} />}
              >
                {/* Dark text over the band, the treatment the top bar's file tiles use: every
                    band colour is a light fill, so a name reads against all of them without
                    having to know which facet it landed on. */}
                <text bg={run.bg} fg={props.theme().background} wrapMode="none">
                  {run.text}
                </text>
              </Show>
            )}
          </For>
        </box>
      </Show>
      <text fg={props.theme().textMuted} wrapMode="none">
        {count() > 1 ? ` ×${count()}` : ""}
      </text>
    </box>
  )
}

// Collapse a row of coloured character cells into same-colour runs, so a solid band draws
// as one element instead of thirty. Mirrors `coalesce` in treemap.ts, but carries the
// characters along — a run is only mergeable when its colour matches, whatever it spells.
function coalesceCells(cells: { bg: TuiThemeCurrent["text"]; ch: string }[]) {
  const runs: { bg: TuiThemeCurrent["text"]; text: string; len: number }[] = []
  for (const cell of cells) {
    const last = runs[runs.length - 1]
    if (last && last.bg === cell.bg) {
      last.text += cell.ch
      last.len++
    } else runs.push({ bg: cell.bg, text: cell.ch, len: 1 })
  }
  return runs
}

// The action a step's mark shows. A step is single-mode by construction, but a gathering run
// mixes reads and searches — the mark reports whichever it did more of, so a run that was
// mostly grep doesn't claim to be reading.
function dominantAction(step: Step): Action {
  const tally = new Map<Action, number>()
  for (const file of step.files) tally.set(file.action, (tally.get(file.action) ?? 0) + file.count)
  for (const beat of step.beats) tally.set(beat.action, (tally.get(beat.action) ?? 0) + beat.count)
  if (step.places.length > 0) {
    const places = step.places.reduce((sum, p) => sum + p.count, 0)
    tally.set("search", (tally.get("search") ?? 0) + places)
  }
  let best: Action = "read"
  let most = -1
  for (const [action, n] of tally) {
    if (n > most) {
      best = action
      most = n
    }
  }
  return best
}

function relTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function basename(p: string) {
  return p.split("/").pop() ?? p
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Directly below Context, above MCP/LSP/Todo/Files (G0). The path then begins around
    // row 10 of the scroll region even with a four-row title, so it is above the fold on
    // any terminal tall enough to show the sidebar at all.
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
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
