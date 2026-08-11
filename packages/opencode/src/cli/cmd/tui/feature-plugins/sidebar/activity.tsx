import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
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

// G0's budget, doubled in G4. The nested scrollbox is not a nicety: the sidebar's own
// scrollbox is shared by every section, so `stickyScroll` on it would pin the WHOLE
// sidebar to its bottom. A nested box with an explicit height is the only way this section
// can stay pinned to its newest step, and it is also what caps its contribution at a
// constant however long the session runs.
//
// G0 sized this at 10 on the assumption that a turn's activity was one block; one row per
// *step* spends rows far faster, and this is the section the user is actually watching.
// Total contribution is 1 header + ACTIVITY_ROWS + HOVER_ROWS.
const ACTIVITY_ROWS = 20
// Reserved always, so the layout cannot jump as the pointer crosses rows.
const HOVER_ROWS = 2
// The sidebar's drawable width; `files.tsx` already hard-codes 36, so this is the house
// number rather than a second opinion.
const SIDEBAR_COLS = 36
// How many recent turns to ask for. More than fits, deliberately — the scrollback is the
// point, and the endpoint pages backwards so a long session costs what a fresh one does.
const ACTIVITY_TURNS = 12

// Row anatomy: spine/indent, the action verb, a space, then the band or label, then `×n`.
const SPINE_COLS = 2
const COUNT_COLS = 5
const INDENT_COLS = 2
const BAND_MIN = 2
// The verb is padded to a fixed width so the bands line up into a column across rows of
// different actions. That alignment is what makes two steps comparable at a glance, and it
// is worth the columns it costs the band.
const VERB_COLS = 6
const bandMax = (depth: number) =>
  SIDEBAR_COLS - SPINE_COLS - VERB_COLS - 1 - COUNT_COLS - depth * INDENT_COLS

// One word per action (G4). This replaced a glyph set (●⌕◆■⚙↗) inherited from the top bar's
// deleted overlay row, where horizontal space was scarce enough to justify a legend the
// reader had to memorise. With the taller budget the words fit, and they need no legend.
const VERBS: Record<Action, string> = {
  read: "Read",
  search: "Search",
  edit: "Edit",
  create: "Write",
  run: "Run",
  fetch: "Fetch",
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
  // One target of an expanded survey step (G4.4), indented a level exactly as a sub-agent
  // lane is. `path` is undefined for nothing; a place carries no facet mix, so it draws its
  // name without a band.
  | { kind: "entry"; key: string; depth: number; path: string; action: Action; count: number; place: boolean }

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

  // Which aggregated survey steps the user has opened (G4.4), by row key. Keyed by position
  // rather than by identity because a refetch rebuilds the steps: position is stable across
  // a refetch that only appended, which is the common case, and an expansion silently
  // following a *different* step after history shifted is a smaller surprise than every
  // expansion snapping shut on each turn boundary.
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  // Segment every turn, then flatten to drawable rows in reading order: oldest turn first,
  // so the newest work sits at the bottom where stickyScroll pins it.
  const rows = createMemo<Row[]>(() => {
    const turns = data()?.turns ?? []
    const segmented: TurnSteps[] = stepsForTurns(turns)
    const open = expanded()
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
        lane.steps.forEach((step, s) => {
          const key = `t${t}l${l}s${s}`
          out.push({ kind: "step", key, step })
          if (!open.has(key)) return
          // Files first, then the directories and search scopes — the files are what the
          // aggregate was hiding, and a place has no band to compare against them anyway.
          step.files.forEach((file, i) =>
            out.push({
              kind: "entry",
              key: `${key}f${i}`,
              depth: step.depth + 1,
              path: file.path,
              action: file.action,
              count: file.count,
              place: false,
            }),
          )
          step.places.forEach((place, i) =>
            out.push({
              kind: "entry",
              key: `${key}p${i}`,
              depth: step.depth + 1,
              path: place.path,
              action: "search",
              count: place.count,
              place: true,
            }),
          )
        })
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
  // Takes a path list rather than a step so an expanded child row (one file) and the
  // aggregate it came from (all of them) reduce through exactly the same arithmetic — the
  // expansion has to agree with the row it opened, or the affordance undermines the reading.
  const bandsFor = (paths: ReadonlyArray<string>) => {
    const files = data()?.files
    if (!files) return []
    const totals = new Map<string, number>()
    for (const path of paths) {
      const mix = files[path]
      if (!mix) continue
      for (const w of mix.w) {
        const facet = facets()[w.f]
        if (facet === undefined) continue
        totals.set(facet, (totals.get(facet) ?? 0) + (mix.t * w.p) / 100)
      }
    }
    return [...totals].map(([key, value]) => ({ key, value }))
  }

  // The colours of one band, left to right. Falls back to the untagged grey when nothing
  // here is painted — the honest grey the treemap already draws for un-swept code, rather
  // than an empty row that reads as a rendering bug.
  const bandColors = (paths: ReadonlyArray<string>, width: number): TuiThemeCurrent["text"][] => {
    const bands = bandsFor(paths)
    if (bands.length === 0) return Array.from({ length: width }, () => resolveColor(theme(), UNTAGGED_HUE))
    const flat: string[] = []
    for (const a of allocateCells(bands, width)) for (let i = 0; i < a.n; i++) flat.push(a.key)
    if (flat.length === 0) return Array.from({ length: width }, () => colors().colorFor(GREY_CELL))
    while (flat.length < width) flat.push(GREY_CELL)
    return flat.map((key) => colors().colorFor(key))
  }

  // Open a file in the editor — the same call a top-bar file tile makes, so a path opens
  // the same way whichever Aperture surface the user clicked it in. Logged like a top-bar
  // click so the study log records the surface a navigation came from. Fire-and-forget:
  // a failed open must never break a click.
  const openFile = (path: string) => {
    void props.api.client.aperture.interaction({
      sessionID: props.session_id,
      interaction: "file.open",
      lens: data()?.lens?.id ?? "",
      detail: path,
    })
    void props.api.client.tui.openFile({ path })
  }

  // What the pointer is over, as the lines to print beneath the path (G4.5).
  //
  // The text is the tools' own recorded titles wherever they have one — for a `Run` step
  // that is the model-written description of the command, which is the single most useful
  // thing this section can say and which the row itself has no room for. Falls back to the
  // paths when a step predates titles or the tool recorded none.
  const [hovered, setHovered] = createSignal<string>()
  const describe = (step: Step): string => {
    if (step.titles.length > 0) return step.titles.join(" · ")
    const names = [...step.files.map((f) => f.path), ...step.places.map((p) => p.path || "(repo root)")]
    return names.length > 0 ? names.join(" · ") : step.agent
  }

  // The idle line, so the reserved rows are never simply blank: what the section is showing.
  const summary = () => {
    if (activity.error) return "activity unavailable"
    const steps = rows().filter((r) => r.kind === "step").length
    const turns = rows().filter((r) => r.kind === "turn").length
    if (steps === 0) return ""
    return `${steps} step${steps === 1 ? "" : "s"} over ${turns} turn${turns === 1 ? "" : "s"} · click a row to expand or open`
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
                <Switch fallback={<LabelRow row={row} theme={theme} />}>
                  <Match when={row.kind === "step" ? row : undefined}>
                    {(it) => (
                      <StepRow
                        step={it().step}
                        expanded={expanded().has(it().key)}
                        theme={theme}
                        colorsFor={bandColors}
                        maxSurvey={maxSurvey}
                        onToggle={() => toggle(it().key)}
                        onOpen={openFile}
                        onHover={() => setHovered(describe(it().step))}
                        onLeave={() => setHovered(undefined)}
                      />
                    )}
                  </Match>
                  <Match when={row.kind === "entry" ? row : undefined}>
                    {(it) => (
                      <EntryRow
                        path={it().path}
                        action={it().action}
                        count={it().count}
                        place={it().place}
                        depth={it().depth}
                        theme={theme}
                        colorsFor={bandColors}
                        onOpen={openFile}
                        onHover={() => setHovered(it().path || "(repo root)")}
                        onLeave={() => setHovered(undefined)}
                      />
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </scrollbox>
          {/* Reserved unconditionally: a hover area that appears and disappears would shift
              every section below it as the pointer moved. Wrapped to HOVER_ROWS lines and
              clipped, so a long bash description degrades to its first ~72 characters
              rather than pushing the sidebar around. */}
          <box height={HOVER_ROWS} flexShrink={0} overflow="hidden">
            <text fg={theme().textMuted}>{hovered() ?? summary()}</text>
          </box>
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

// One step, one row: the spine, the action verb, then either a facet band (gathering) or a
// named band (a changed file) or a plain label (a command, a fetch).
//
// Mouse-down means two different things, and the split is decided by what the row *stands
// for* rather than by its mode: a row standing for many targets expands (G4.4), a row
// standing for exactly one file opens it (G4.3). So there is never an ambiguity about what
// a click will do — a row either has a `▸` or it names a file, never both.
function StepRow(props: {
  step: Step
  expanded: boolean
  theme: () => TuiThemeCurrent
  colorsFor: (paths: ReadonlyArray<string>, width: number) => TuiThemeCurrent["text"][]
  maxSurvey: () => number
  onToggle: () => void
  onOpen: (path: string) => void
  onHover: () => void
  onLeave: () => void
}) {
  const depth = () => props.step.depth
  const verb = () => VERBS[dominantAction(props.step)].padEnd(VERB_COLS)
  const count = () => stepWeight(props.step)
  const targets = () => props.step.files.length + props.step.places.length

  const expandable = () => props.step.mode === "survey" && targets() > 1
  // The one file this row stands for, if it stands for exactly one — which covers every
  // mutation and a single-file gathering step alike.
  const only = () => (expandable() ? undefined : props.step.files[0]?.path)

  // A mutate step holds exactly one file, so it can afford to name it — identity is the
  // whole point of showing a mutation. A survey step names nothing and scales instead.
  const named = () => (props.step.mode === "survey" ? undefined : props.step.files[0]?.path)

  const width = () => {
    const max = bandMax(depth())
    // No file means no mix to paint, so there is no band — a shell command or a fetch
    // would otherwise draw a full-width bar of untagged grey, which reads as an unpainted
    // *file* rather than as an act that touched none. The row spends those columns on its
    // description instead.
    if (props.step.files.length === 0) return 0
    if (props.step.mode !== "survey") return max
    const n = props.step.files.length
    const peak = props.maxSurvey()
    if (peak === 0) return 0
    // sqrt so area (not length) carries the comparison — the same idiom the treemap's
    // `scaleCells` uses, so a block and a step read at the same scale.
    return Math.max(BAND_MIN, Math.min(max, Math.round(max * Math.sqrt(n / peak))))
  }

  const cells = createMemo(() => {
    const w = width()
    if (w <= 0) return []
    const label = named()
    const name = label === undefined ? "" : truncate(basename(label), w)
    const colors = props.colorsFor(
      props.step.files.map((f) => f.path),
      w,
    )
    return Array.from({ length: w }, (_, i) => ({ bg: colors[i]!, ch: name[i] ?? " " }))
  })

  // A step with no file to paint (a shell command, a fetch, a run of directory listings)
  // says what it was in words instead of leaving the row blank. The tool's own recorded
  // title is the best of those words by far — for a shell command it is the model-written
  // description the chat renders, so a `Run` row reads "Output the text smoke-three"
  // rather than naming the agent that happened to run it.
  const beatLabel = () =>
    props.step.titles[0] ?? (props.step.places.length > 0 ? "looked around" : props.step.agent)

  const click = () => {
    if (expandable()) return props.onToggle()
    const path = only()
    if (path !== undefined) props.onOpen(path)
  }

  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      onMouseDown={click}
      onMouseOver={() => props.onHover()}
      onMouseOut={() => props.onLeave()}
    >
      <text fg={props.theme().textMuted} wrapMode="none">
        {`${" ".repeat(depth() * INDENT_COLS)}${expandable() ? (props.expanded ? "▾ " : "▸ ") : " ".repeat(SPINE_COLS)}${verb()} `}
      </text>
      <Show
        when={cells().length > 0}
        fallback={
          <text fg={props.theme().textMuted} wrapMode="none">
            {beatLabel()}
          </text>
        }
      >
        <Band cells={cells()} theme={props.theme} />
      </Show>
      <text fg={props.theme().textMuted} wrapMode="none">
        {count() > 1 ? ` ×${count()}` : ""}
      </text>
    </box>
  )
}

// One target of an expanded survey step (G4.4): the file's own name over its own facet
// band, indented past the aggregate it came from. Clicking opens it.
//
// This is deliberately the same shape a mutation row draws, so an expanded read and a
// recorded edit of the same file look alike — the difference between them is the verb, not
// the rendering.
function EntryRow(props: {
  path: string
  action: Action
  count: number
  place: boolean
  depth: number
  theme: () => TuiThemeCurrent
  colorsFor: (paths: ReadonlyArray<string>, width: number) => TuiThemeCurrent["text"][]
  onOpen: (path: string) => void
  onHover: () => void
  onLeave: () => void
}) {
  const width = () => bandMax(props.depth)
  const label = () => (props.place ? (props.path === "" ? "(repo root)" : props.path) : basename(props.path))

  const cells = createMemo(() => {
    const w = width()
    const name = truncate(label(), w)
    const colors = props.colorsFor([props.path], w)
    return Array.from({ length: w }, (_, i) => ({ bg: colors[i]!, ch: name[i] ?? " " }))
  })

  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      // A place is a directory or a search scope, not a file the editor can open.
      onMouseDown={() => !props.place && props.onOpen(props.path)}
      onMouseOver={() => props.onHover()}
      onMouseOut={() => props.onLeave()}
    >
      <text fg={props.theme().textMuted} wrapMode="none">
        {`${" ".repeat(SPINE_COLS + props.depth * INDENT_COLS)}${VERBS[props.action].padEnd(VERB_COLS)} `}
      </text>
      <Show
        when={!props.place}
        fallback={
          <text fg={props.theme().textMuted} wrapMode="none">
            {truncate(label(), width())}
          </text>
        }
      >
        <Band cells={cells()} theme={props.theme} />
      </Show>
      <text fg={props.theme().textMuted} wrapMode="none">
        {props.count > 1 ? ` ×${props.count}` : ""}
      </text>
    </box>
  )
}

// A run of coloured character cells, drawn as few elements as their colours allow.
function Band(props: { cells: { bg: TuiThemeCurrent["text"]; ch: string }[]; theme: () => TuiThemeCurrent }) {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <For each={coalesceCells(props.cells)}>
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
