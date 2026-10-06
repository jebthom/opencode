import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { stepsForTurns, stepWeight, type Step, type TurnSteps } from "@/aperture/activity-steps"
import type { Action, EntryConcern, Turn } from "@/aperture/activity"
import { facetColors, resolveColor } from "../system/aperture-colors"

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
// exists to prevent". Each row names what it touched and shows which facets those files carry —
// containment, one square per facet, in the same colours and order as the top bar's group
// headers — and magnitude is the trailing `×n`.
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
// Total contribution is 1 header + ACTIVITY_ROWS + 1 spacer + HOVER_ROWS.
const ACTIVITY_ROWS = 20
// Reserved always, so the layout cannot jump as the pointer crosses rows.
const HOVER_ROWS = 2
// The sidebar's drawable width; `files.tsx` already hard-codes 36, so this is the house
// number rather than a second opinion.
const SIDEBAR_COLS = 36
// How many recent turns to ask for. More than fits, deliberately — the scrollback is the
// point, and the endpoint pages backwards so a long session costs what a fresh one does.
const ACTIVITY_TURNS = 12

// Row anatomy: spine/indent, the action verb, a space, the name or label, the facet squares, then
// `×n`.
const SPINE_COLS = 2
const COUNT_COLS = 5
const INDENT_COLS = 2
// The verb is padded to a fixed width so the names line up into a column across rows of
// different actions. Wide enough for "Search" plus a clear gap.
const VERB_COLS = 8
// A name must stay wide enough to survive after the squares and the change size have taken their
// columns. A guard rather than a working constraint.
const MIN_NAME_COLS = 8
// What the name and the squares share: whatever the tail leaves. A gathering row's tail is the
// `×n` gutter; a mutation's is its change size, which is content-sized and so varies by row.
const rowMax = (depth: number, tail: number) => SIDEBAR_COLS - SPINE_COLS - VERB_COLS - 1 - tail - depth * INDENT_COLS

// The change a step made, split into the pieces that colour differently. Read straight off
// the step — every number here was persisted by the tool that made the change, so nothing
// is measured, recomputed, or generated to produce it.
//
// `−` is U+2212, not a hyphen: it is the width of `+` so two rows' numerals line up.
// `Δ` marks a count of *files* rather than lines, which a `run` reports because a shell
// command persists no diff of its own; reusing `+/−` there would imply a line-level
// knowledge the snapshot patch behind it does not have.
type Stats = { added?: string; removed?: string; changed?: string }

// Three digits each, so a huge refactor cannot push the name below a readable width.
const clampCount = (n: number) => (n >= 1000 ? `${Math.floor(n / 1000)}k` : `${n}`)

function statsOf(step: Step): Stats | undefined {
  const out: Stats = {}
  if (step.additions !== undefined) out.added = `+${clampCount(step.additions)}`
  if (step.deletions !== undefined) out.removed = `−${clampCount(step.deletions)}`
  if (step.changed !== undefined) out.changed = `Δ${clampCount(step.changed)}`
  return (out.added ?? out.removed ?? out.changed) ? out : undefined
}

// Columns the stats occupy, each piece drawn with its own leading space.
const statsCols = (stats: Stats) =>
  [stats.added, stats.removed, stats.changed].reduce((sum, part) => sum + (part ? part.length + 1 : 0), 0)

// One word per action (G4). This replaced a glyph set (●⌕◆■⚙↗) inherited from the top bar's
// deleted overlay row, where horizontal space was scarce enough to justify a legend the
// reader had to memorise. With the taller budget the words fit, and they need no legend.
// The reveal affordance, drawn in the column the verb padding was already spending. The
// longest verb is "Search" (6), so padding the word to VERB_COLS - 1 and then appending the
// icon still lands on exactly VERB_COLS: `Search ↗`. The icon costs the name nothing, and
// the arithmetic rowMax subtracts is unchanged.
//
// A single-width glyph, deliberately: an emoji speech bubble is double-width and would
// shear the left edge of every name on the row below it. Its *absence* is meaningful too —
// a row with no icon is one the chat cannot show, which is how a sub-agent's steps read as
// "this happened somewhere you cannot scroll to".
const GO_CHAT = "↗"
const VERB_TEXT_COLS = VERB_COLS - 1

const VERBS: Record<Action, string> = {
  read: "Read",
  search: "Search",
  edit: "Edit",
  create: "Write",
  run: "Run",
  fetch: "Fetch",
  // Lens changes. "Refine" rather than "Edit" so a concern being reworded never reads as a file
  // being edited; the row's coloured square is what says it is a concern at all.
  "facet-add": "New",
  "facet-remove": "Remove",
  "facet-edit": "Refine",
}

// The wire shape of GET /aperture/activity. Declared locally for the same reason the top
// bar declares `Graph` locally — the generated SDK type is structural and this keeps the
// renderer readable.
type ActivityResult = {
  lens?: { id: string; name: string; legend: readonly { facet: string; label: string; color: string }[] }
  facets: readonly string[]
  turns: readonly Turn[]
  files: Record<string, { m: readonly { f: number; l: number }[]; line: number }>
  suppressed?: readonly string[]
}

// A row is what actually gets drawn: one step, or the muted rule that separates two turns,
// or the header naming a sub-agent's lane. Flattening to rows here (rather than nesting
// three `<For>`s) is what lets the scrollbox treat the timeline as a simple list.
type Row =
  | { kind: "turn"; key: string; promptedAt: number; agent: string }
  // A sub-agent lane. It carries the anchor because its *steps* deliberately do not: the
  // child session's parts are absent from this transcript, so every step in the lane would
  // point at the same one `task` call, and a dozen indented rows all revealing the same
  // block is noise. One lane, one destination, one affordance.
  | { kind: "lane"; key: string; agent: string; depth: number; messageID?: string; partID?: string }
  | { kind: "step"; key: string; step: Step }
  // One target of an expanded survey step (G4.4), indented a level exactly as a sub-agent
  // lane is. A place is a directory or search scope, not a file, so it draws its name without
  // facet squares.
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
          // Every step in a lane shares the `task` anchor, so the first one speaks for all.
          out.push({
            kind: "lane",
            key: `t${t}l${l}`,
            agent: lane.agent,
            depth: lane.depth,
            messageID: lane.steps[0]?.messageID,
            partID: lane.steps[0]?.partID,
          })
        }
        lane.steps.forEach((step, s) => {
          const key = `t${t}l${l}s${s}`
          out.push({ kind: "step", key, step })
          if (!open.has(key)) return
          // Files first, then the directories and search scopes — the files are what the
          // aggregate was hiding, and a place has no facet squares to compare against them anyway.
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

  // Which facets the files a row touched contain: one slot per legend facet, in legend order,
  // holding its colour when any of the files carries it and undefined otherwise. Presence only —
  // how many lines is the top bar's business — and a facet filtered out of the legend is absent,
  // the same re-slicing the top bar's groups do. Places contribute nothing by design: folding a
  // directory's subtree in would report marks in code the agent never opened.
  // Takes a path list rather than a step so an expanded child row (one file) and the step it came
  // from (all of them) reduce the same way.
  const slotsFor = (paths: ReadonlyArray<string>): Slot[] => {
    const files = data()?.files ?? {}
    const present = new Set(paths.flatMap((path) => (files[path]?.m ?? []).filter((m) => m.l > 0).map((m) => m.f)))
    return facets().map((facet, i) =>
      present.has(i) && !suppressed().has(facet) ? colors().facetColor(facet) : undefined,
    )
  }

  // A concern's colour on a Lens-change row. The live legend's while the change was to the
  // active Lens and the concern is still on it — so the filter greys it like every other square
  // here — and otherwise the hex the tool snapshotted, which is how a removed concern, or one on
  // another Lens, still shows the colour it had.
  const concernColor = (step: Step, concern: EntryConcern) =>
    step.lens === data()?.lens?.id && facets().includes(concern.facet)
      ? colors().facetColor(concern.facet)
      : resolveColor(theme(), concern.color)

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
    // At its first marked line, as the top bar opens it; an unmarked file opens at the top.
    const line = data()?.files[path]?.line
    void props.api.client.tui.openFile({ path, ...(line ? { line } : {}) })
  }

  // Scroll the chat to the tool call this row stands for, where the transcript already
  // renders the full diff. That is the whole reason this section does not draw one itself:
  // 36 columns cannot hold a patch, and the chat's `<diff>` is right there.
  //
  // Dispatched as a command rather than called: the chat's scrollbox ref is local to the
  // session route, and a sidebar plugin has no path to it. `dispatchCommand` reaches the
  // same keymap instance the session route registers into, and carries the payload.
  const revealInChat = (target: { messageID?: string; partID?: string }) => {
    if (!target.messageID && !target.partID) return
    void props.api.client.aperture.interaction({
      sessionID: props.session_id,
      interaction: "chat.reveal",
      lens: data()?.lens?.id ?? "",
      detail: target.partID ?? target.messageID ?? "",
    })
    props.api.keymap.dispatchCommand("session.part.reveal", { payload: target })
  }

  // What the pointer is over, as the lines to print beneath the path (G4.5).
  //
  // The text is the tools' own recorded titles wherever they have one — for a `Run` step
  // that is the model-written description of the command, which is the single most useful
  // thing this section can say and which the row itself has no room for. Falls back to the
  // paths when a step predates titles or the tool recorded none.
  //
  // A mutation is described rather than enumerated. Its row shows only a basename and a
  // magnitude, so the two things the hover can add are the *directory* the change landed in
  // and the size in words — and for a shell command, the step-level file count, phrased as
  // the fact it actually is. `edit` already records its title as the relative path, so the
  // title is appended only when it says something the path does not.
  const [hovered, setHovered] = createSignal<string>()
  const describe = (step: Step): string => {
    // A Lens change: the concerns it touched, then the tool's own title ("12 lines · Parsing",
    // "Removed rule", "Edited <Lens>") — skipping a label the title already says.
    if (step.mode === "curate") {
      const title = step.titles[0]
      const labels = step.concerns.map((c) => c.label).filter((label) => !title?.includes(label))
      return [...labels, ...(title ? [title] : [])].join(" · ") || step.agent
    }
    if (step.mode !== "survey") {
      const parts: string[] = []
      const path = step.files[0]?.path
      const title = step.titles[0]
      if (path !== undefined) parts.push(path)
      if (title !== undefined && title !== path) parts.push(title)
      const size = statsOf(step)
      if (size?.added ?? size?.removed) parts.push([size?.added, size?.removed].filter(Boolean).join(" "))
      if (step.changed !== undefined) {
        // Deliberately "in this step", not "by this command": the count comes from the
        // snapshot patch closing the whole LLM step, so anything else that touched the
        // worktree in that window is inside it too. The weaker sentence is the true one.
        parts.push(`${step.changed} file${step.changed === 1 ? "" : "s"} changed in this step`)
      }
      if (parts.length > 0) return parts.join(" · ")
    }
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
    // The idle line is the only place the two hit zones can be taught, since nothing here
    // takes keyboard focus and there is no tooltip to hang a hint on.
    return `${steps} step${steps === 1 ? "" : "s"} over ${turns} turn${turns === 1 ? "" : "s"} · click a name to open it, a verb to find it in the chat`
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
                <Switch fallback={<LabelRow row={row} theme={theme} onReveal={revealInChat} />}>
                  <Match when={row.kind === "step" ? row : undefined}>
                    {(it) => (
                      <StepRow
                        step={it().step}
                        expanded={expanded().has(it().key)}
                        theme={theme}
                        slotsFor={slotsFor}
                        concernColor={concernColor}
                        onToggle={() => toggle(it().key)}
                        onOpen={openFile}
                        onReveal={revealInChat}
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
                        slotsFor={slotsFor}
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
          {/* A blank row, so the hover line reads as a caption on the path rather than as
              one more entry in it. */}
          <box height={1} flexShrink={0} />
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
//
// A lane header is also the one place a sub-agent's work can be revealed: its steps happened
// in a session this transcript does not render, and the `task` call that spawned them is the
// nearest thing on screen. So the header, not the steps, carries the icon.
function LabelRow(props: { row: Row; theme: () => TuiThemeCurrent; onReveal: (target: LaneAnchor) => void }) {
  const text = () => {
    const row = props.row
    if (row.kind === "turn") return `── ${relTime(row.promptedAt)} · ${row.agent} ${"─".repeat(SIDEBAR_COLS)}`
    if (row.kind === "lane") return `${" ".repeat(SPINE_COLS)}└ ${row.agent}`
    return ""
  }
  const anchor = (): LaneAnchor | undefined => {
    const row = props.row
    if (row.kind !== "lane" || (!row.messageID && !row.partID)) return undefined
    return { messageID: row.messageID, partID: row.partID }
  }
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      {/* Only a row that draws the icon gives up the columns for it — a turn separator has
          no anchor, so its rule still runs the full width. */}
      <text fg={props.theme().textMuted} wrapMode="none" flexShrink={0}>
        {truncate(text(), anchor() ? SIDEBAR_COLS - 2 : SIDEBAR_COLS)}
      </text>
      <Show when={anchor()}>
        {(target) => (
          <text
            fg={props.theme().textMuted}
            wrapMode="none"
            flexShrink={0}
            onMouseDown={() => props.onReveal(target())}
          >
            {" " + GO_CHAT}
          </text>
        )}
      </Show>
    </box>
  )
}

type LaneAnchor = { messageID?: string; partID?: string }

// One step, one row: the spine, the action verb, then either a name and its facet squares (a
// changed file, or what a gathering step read) or a plain label (a command, a fetch).
//
// The row has two hit areas, and which is which is decided by what the reader is pointing
// at rather than by a modifier:
//
//   - the **verb and its icon** reveal the act in the chat, where the full diff is drawn;
//   - the **name or label** keeps what it has always meant — a row standing for many targets
//     expands (G4.4), a row standing for exactly one file opens it (G4.3).
//
// So the new gesture costs nothing: it spends the eight columns of the verb, which were
// previously inert, and neither existing affordance loses any of its target. The name is the
// bulk of the row, so expanding a gathering step is still an easy click.
function StepRow(props: {
  step: Step
  expanded: boolean
  theme: () => TuiThemeCurrent
  slotsFor: (paths: ReadonlyArray<string>) => Slot[]
  concernColor: (step: Step, concern: EntryConcern) => TuiThemeCurrent["text"]
  onToggle: () => void
  onOpen: (path: string) => void
  onReveal: (target: LaneAnchor) => void
  onHover: () => void
  onLeave: () => void
}) {
  const depth = () => props.step.depth
  const verb = () => VERBS[dominantAction(props.step)].padEnd(VERB_TEXT_COLS)
  // A sub-agent's steps happened in a session this chat does not render, so they get no
  // icon and no gesture — their lane header carries both. Absence is the signal.
  const anchor = (): LaneAnchor | undefined => {
    if (props.step.depth > 0) return undefined
    if (!props.step.messageID && !props.step.partID) return undefined
    return { messageID: props.step.messageID, partID: props.step.partID }
  }
  const count = () => stepWeight(props.step)
  const targets = () => props.step.files.length + props.step.places.length

  const expandable = () => props.step.mode === "survey" && targets() > 1
  // The one file this row stands for, if it stands for exactly one — which covers every
  // mutation and a single-file gathering step alike.
  const only = () => (expandable() ? undefined : props.step.files[0]?.path)

  // A mutate step holds exactly one file, and identity is the whole point of showing a mutation.
  const named = () => (props.step.mode === "survey" ? undefined : props.step.files[0]?.path)

  // The change this step made, if it made one. Present exactly on mutations, which is why
  // the renderer tests for it rather than for the mode.
  const stats = createMemo(() => statsOf(props.step))

  // What the row spends to the right of the squares: the `×n` gutter for a gathering step, the
  // change size for a mutation. A mutate step always weighs exactly 1 (only survey entries
  // ever join an open draft), so its `×n` is always blank — the stats are reusing reserved
  // columns.
  const tail = () => {
    const s = stats()
    return s === undefined ? COUNT_COLS : statsCols(s)
  }

  const slots = createMemo(() => props.slotsFor(props.step.files.map((f) => f.path)))
  // The name's width: what the tail and the squares leave, capped at the gathering width so the
  // squares start in the same column on every row (a short change size ends its row early rather
  // than shifting them). Zero when the step touched no file — a shell command or a fetch says
  // what it was in words instead.
  const width = () => {
    if (props.step.files.length === 0) return 0
    const room = Math.min(rowMax(depth(), tail()), rowMax(depth(), COUNT_COLS))
    return Math.max(MIN_NAME_COLS, room - squaresCols(slots()))
  }
  // A mutation names its file; a gathering step names its one file, or counts its targets.
  const label = () => {
    const path = named() ?? only()
    if (path !== undefined) return basename(path)
    const files = `${props.step.files.length} files`
    return props.step.places.length > 0 ? `${files} +${props.step.places.length}` : files
  }

  // A step with no file to show (a shell command, a fetch, a run of directory listings)
  // says what it was in words instead of leaving the row blank. The tool's own recorded
  // title is the best of those words by far — for a shell command it is the model-written
  // description the chat renders, so a `Run` row reads "Output the text smoke-three"
  // rather than naming the agent that happened to run it.
  const beatLabel = () => props.step.titles[0] ?? (props.step.places.length > 0 ? "looked around" : props.step.agent)

  // What the name or label does when clicked — unchanged from G4.3/G4.4.
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
      onMouseOver={() => props.onHover()}
      onMouseOut={() => props.onLeave()}
    >
      {/* The reveal zone. flexShrink=0: without it a long path in the sibling label shrinks
          this element and clips the verb, which "Search" (the longest) hits first. */}
      <text
        fg={props.theme().textMuted}
        wrapMode="none"
        flexShrink={0}
        onMouseDown={() => {
          const target = anchor()
          if (target) props.onReveal(target)
        }}
      >
        {`${" ".repeat(depth() * INDENT_COLS)}${expandable() ? (props.expanded ? "▾ " : "▸ ") : " ".repeat(SPINE_COLS)}${verb()}${anchor() ? GO_CHAT : " "} `}
      </text>
      <Show
        when={width() > 0}
        fallback={
          <Show
            when={props.step.concerns.length > 0}
            fallback={
              <text fg={props.theme().textMuted} wrapMode="none" onMouseDown={click}>
                {beatLabel()}
              </text>
            }
          >
            <ConcernLabel
              step={props.step}
              width={rowMax(depth(), COUNT_COLS)}
              theme={props.theme}
              concernColor={props.concernColor}
            />
          </Show>
        }
      >
        <box flexDirection="row" height={1} flexShrink={0} onMouseDown={click}>
          <text fg={props.theme().text} wrapMode="none" flexShrink={0}>
            {truncate(label(), width()).padEnd(width())}
          </text>
          <Squares slots={slots()} theme={props.theme} />
        </box>
      </Show>
      {/* The change size in green/red — the colour is most of why `+12 −3` parses without
          being read. */}
      <Show
        when={stats()}
        fallback={
          <text fg={props.theme().textMuted} wrapMode="none">
            {count() > 1 ? ` ×${count()}` : ""}
          </text>
        }
      >
        {(s) => <StatsTail stats={s()} theme={props.theme} />}
      </Show>
    </box>
  )
}

// A Lens change names the concerns it touched rather than a file: one square each in the
// concern's colour, then the label when there is one concern, or a count when a lens_edit
// rewrote several.
function ConcernLabel(props: {
  step: Step
  width: number
  theme: () => TuiThemeCurrent
  concernColor: (step: Step, concern: EntryConcern) => TuiThemeCurrent["text"]
}) {
  const label = () =>
    props.step.concerns.length === 1 ? props.step.concerns[0]!.label : `${props.step.concerns.length} concerns`
  return (
    <text fg={props.theme().text} wrapMode="none" flexShrink={0}>
      <For each={[...props.step.concerns]}>
        {(concern) => <span style={{ fg: props.concernColor(props.step, concern) }}>■</span>}
      </For>
      {" " + truncate(label(), Math.max(MIN_NAME_COLS, props.width - props.step.concerns.length - 1))}
    </text>
  )
}

// The trailing change size. Three elements rather than one string, because each piece
// carries its own colour — the same green and red the chat uses for this exact string, so a
// magnitude means the same thing in the sidebar as it does in the transcript.
function StatsTail(props: { stats: Stats; theme: () => TuiThemeCurrent }) {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <Show when={props.stats.added}>
        {(v) => (
          <text fg={props.theme().diffAdded} wrapMode="none" flexShrink={0}>
            {" " + v()}
          </text>
        )}
      </Show>
      <Show when={props.stats.removed}>
        {(v) => (
          <text fg={props.theme().diffRemoved} wrapMode="none" flexShrink={0}>
            {" " + v()}
          </text>
        )}
      </Show>
      {/* Muted, not green: a file count is a weaker claim than a line count, and it should
          not read as the same kind of fact. */}
      <Show when={props.stats.changed}>
        {(v) => (
          <text fg={props.theme().textMuted} wrapMode="none" flexShrink={0}>
            {" " + v()}
          </text>
        )}
      </Show>
    </box>
  )
}

// One target of an expanded survey step (G4.4): the file's own name and its own facet squares,
// indented past the aggregate it came from. Clicking opens it.
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
  slotsFor: (paths: ReadonlyArray<string>) => Slot[]
  onOpen: (path: string) => void
  onHover: () => void
  onLeave: () => void
}) {
  // An expanded child is a *read*, so it always draws against the gathering gutter — the step it
  // opened from does too, which is what keeps the squares lined up.
  const slots = createMemo(() => props.slotsFor([props.path]))
  const width = () => Math.max(MIN_NAME_COLS, rowMax(props.depth, COUNT_COLS) - squaresCols(slots()))
  const label = () => (props.place ? (props.path === "" ? "(repo root)" : props.path) : basename(props.path))

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
      <text fg={props.theme().textMuted} wrapMode="none" flexShrink={0}>
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
        <text fg={props.theme().text} wrapMode="none" flexShrink={0}>
          {truncate(label(), width()).padEnd(width())}
        </text>
        <Squares slots={slots()} theme={props.theme} />
      </Show>
      <text fg={props.theme().textMuted} wrapMode="none">
        {props.count > 1 ? ` ×${props.count}` : ""}
      </text>
    </box>
  )
}

// One slot per legend facet: its colour when the row's files carry it, undefined when not.
type Slot = TuiThemeCurrent["text"] | undefined

// Columns the squares take, with the space before them; none when there is no Lens.
const squaresCols = (slots: ReadonlyArray<Slot>) => (slots.length > 0 ? slots.length + 1 : 0)

// A row's containment: one square per facet, in fixed legend slots so a facet stays in the same
// column down the whole path and the rows read as a matrix. Packed without gaps — the sidebar is
// 36 columns, and distinct colours already separate them. A row carrying no facet shows one
// hollow square, the top bar's mark for the unmarked group.
function Squares(props: { slots: ReadonlyArray<Slot>; theme: () => TuiThemeCurrent }) {
  return (
    <Show when={props.slots.length > 0}>
      <text wrapMode="none" flexShrink={0} fg={props.theme().textMuted}>
        {" "}
        <Show when={props.slots.some((slot) => slot !== undefined)} fallback={"□".padEnd(props.slots.length)}>
          <For each={[...props.slots]}>
            {(slot) => <span style={{ fg: slot ?? props.theme().textMuted }}>{slot ? "■" : " "}</span>}
          </For>
        </Show>
      </text>
    </Show>
  )
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
