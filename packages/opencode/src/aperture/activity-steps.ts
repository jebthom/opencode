import { ApertureActivity, type Action, type ActivityEntry, type Mode, type Turn } from "./activity"

// Segmentation for the Activity View (PLAN.md G2/G3): turn a turn's flat entry list into
// the nodes of a vertical path.
//
// **A step is either (a) a maximal run of consecutive `survey` entries within one
// (turn, lane), or (b) a single non-survey entry.**
//
// Only survey aggregates. Aggregation asserts that the individual acts need not be
// distinguished, which is true of gathering — "the agent looked at this much of this mix"
// is the useful reading, and which of twelve files it opened third is not — and false of
// anything that leaves a lasting effect. A mutation the user did not notice is the failure
// mode this view exists to prevent, so every mutation and every external call gets its own
// node. Three edits to one file are three steps; twelve reads are one.
//
// Kept pure and dependency-free, the same posture as treemap.ts: no Solid, no theme, no
// Effect. That is what lets it be unit-tested from fixtures, and it is also the half that
// would survive if the path were ever drawn horizontally instead — the orientation lives
// entirely in the renderer.

// One agent's own timeline inside a turn, keyed by session.
//
// Lanes are not cosmetic. `mergeChildEntries` pushes each sub-agent's entries into the
// parent turn and then sorts the WHOLE turn by timestamp, so three parallel `Explore`
// agents arrive interleaved entry-by-entry: A,B,C,A,B,C… Segmenting that merged sequence
// directly would shatter every survey run into alternating one-entry steps — wrong, and
// ruinous against a ten-row sidebar budget. Partitioning by session *before* segmenting
// fixes it structurally. `agent` cannot do that job: two Explore agents share a name.
export interface Lane {
  readonly sessionID: string
  readonly agent: string
  readonly depth: number
  readonly startedAt: number
  readonly steps: ReadonlyArray<Step>
}

// A file the step touched. `count` is how many times, and `action` is the LAST one seen —
// a file edited and then written reads as created. Both only ever exceed the trivial case
// inside a survey run, since every other step holds exactly one entry.
export interface StepFile {
  readonly path: string
  readonly action: Action
  readonly count: number
}

// A directory read or a search scope ("" is the repo root). Counted as navigation; it
// paints no cells, because a survey step is already an aggregate and folding a directory
// into it would report the mix of code the agent never opened (see Aperture.activity).
export interface StepPlace {
  readonly path: string
  readonly count: number
}

// A pathless act — a shell command, a web fetch, an MCP call — grouped by action.
export interface StepBeat {
  readonly action: Action
  readonly count: number
}

export interface Step {
  readonly mode: Mode
  readonly sessionID: string
  readonly agent: string
  readonly depth: number
  readonly startedAt: number
  readonly endedAt: number
  // A survey step holds many, deduped in first-touch order. A mutate step holds exactly
  // one file (or none, for a shell command); an external step holds none. Arrays either
  // way, so the renderer has one shape to draw and this module one path to walk.
  readonly files: ReadonlyArray<StepFile>
  readonly places: ReadonlyArray<StepPlace>
  readonly beats: ReadonlyArray<StepBeat>
  // The one-line descriptions the tools recorded, deduped in first-seen order and capped.
  // A single-entry step has one (a `Run` step's is the command's model-written summary);
  // an aggregated survey step has one per distinct call, which is what its hover line
  // enumerates. Capped because a survey run is unbounded and the hover shows two lines.
  readonly titles: ReadonlyArray<string>
  // The size of the change this step made, summed from its entries. Absent on a survey
  // step, which changes nothing — so the renderer can treat "has a magnitude" and "is a
  // mutation" as the same test rather than checking the mode separately.
  readonly additions?: number
  readonly deletions?: number
  readonly changed?: number
  // Where to find this step in the chat, taken from its FIRST entry. First rather than last
  // because `startedAt` is the first entry's too, so a row's identity and its destination
  // agree — and a gathering run reads better from its opening than from its close. A step
  // whose entries carried no anchor has none, which is the renderer's signal that there is
  // nothing to reveal.
  readonly messageID?: string
  readonly partID?: string
}

// Enough to fill two 36-column hover lines several times over; beyond that the row's `×n`
// is the honest summary and a longer list would only be truncated.
const TITLES_MAX = 12

export interface TurnSteps {
  readonly promptedAt: number
  readonly agent: string
  // The depth-0 lane first — the spine — then sub-agent lanes by when they started.
  readonly lanes: ReadonlyArray<Lane>
}

// Mutable while accumulating; frozen into a Step on the way out. Maps rather than arrays
// so dedup is O(1) and insertion order gives first-touch order for free.
interface Draft {
  mode: Mode
  readonly sessionID: string
  agent: string
  readonly depth: number
  readonly startedAt: number
  endedAt: number
  readonly files: Map<string, StepFile>
  readonly places: Map<string, StepPlace>
  readonly beats: Map<Action, StepBeat>
  readonly titles: Set<string>
  additions?: number
  deletions?: number
  changed?: number
  readonly messageID?: string
  readonly partID?: string
}

export function stepsForTurn(turn: Turn): TurnSteps {
  const drafts = new Map<string, Draft[]>()

  for (const entry of turn.entries) {
    const mode = ApertureActivity.modeOf(entry.action)
    let lane = drafts.get(entry.sessionID)
    if (!lane) {
      lane = []
      drafts.set(entry.sessionID, lane)
    }

    // Join the open step only when both it and this entry are gathering, and only while
    // the acting agent is unchanged — a plan→build switch inside one session is a real
    // change of actor even at the same depth. Everything else opens a new step, which is
    // what makes each mutation its own node.
    const open = lane[lane.length - 1]
    const joinable = open !== undefined && open.mode === "survey" && mode === "survey" && open.agent === entry.agent
    const step = joinable ? open : openDraft(lane, entry, mode)
    absorb(step, entry)
  }

  const lanes = [...drafts.values()]
    .filter((lane) => lane.length > 0)
    .map(
      (lane): Lane => ({
        sessionID: lane[0]!.sessionID,
        agent: lane[0]!.agent,
        depth: lane[0]!.depth,
        startedAt: lane[0]!.startedAt,
        steps: lane.map(freeze),
      }),
    )
    // Depth first (so the viewed session's spine leads), then by when the lane opened.
    // Lane-major, deliberately: emitting steps in global time order would interleave
    // parallel sub-agents again at step granularity, and a lane only reads as one agent's
    // work if its steps are contiguous.
    .sort((a, b) => a.depth - b.depth || a.startedAt - b.startedAt)

  return { promptedAt: turn.promptedAt, agent: turn.agent, lanes }
}

export function stepsForTurns(turns: ReadonlyArray<Turn>): TurnSteps[] {
  return turns.map(stepsForTurn)
}

function openDraft(lane: Draft[], entry: ActivityEntry, mode: Mode): Draft {
  const draft: Draft = {
    mode,
    sessionID: entry.sessionID,
    agent: entry.agent,
    depth: entry.depth,
    startedAt: entry.timestamp,
    endedAt: entry.timestamp,
    files: new Map(),
    places: new Map(),
    beats: new Map(),
    titles: new Set(),
    // Set here and never in `absorb`, so a run keeps the anchor of the entry that opened it.
    messageID: entry.messageID,
    partID: entry.partID,
  }
  lane.push(draft)
  return draft
}

function absorb(step: Draft, entry: ActivityEntry): void {
  step.endedAt = Math.max(step.endedAt, entry.timestamp)
  // A Set, so a run that read the same file twice doesn't say so twice.
  if (entry.title !== undefined && step.titles.size < TITLES_MAX) step.titles.add(entry.title)

  // Summed rather than assigned. Today a mutate step is a single entry by construction, so
  // every one of these is a one-term sum — but summing costs nothing and means the step
  // rule could change without silently reporting only the last entry's magnitude. A survey
  // entry carries no counts, so a survey step is left with all three undefined.
  if (entry.additions !== undefined) step.additions = (step.additions ?? 0) + entry.additions
  if (entry.deletions !== undefined) step.deletions = (step.deletions ?? 0) + entry.deletions
  if (entry.changed !== undefined) step.changed = (step.changed ?? 0) + entry.changed

  if (entry.path !== undefined && entry.target === "file") {
    const prev = step.files.get(entry.path)
    // The later action wins, so a file edited and then written reads as created. Only
    // reachable inside a survey run; a mutate step is a single entry by construction.
    step.files.set(entry.path, { path: entry.path, action: entry.action, count: (prev?.count ?? 0) + 1 })
    return
  }
  if (entry.path !== undefined && entry.target === "place") {
    const prev = step.places.get(entry.path)
    step.places.set(entry.path, { path: entry.path, count: (prev?.count ?? 0) + 1 })
    return
  }
  const prev = step.beats.get(entry.action)
  step.beats.set(entry.action, { action: entry.action, count: (prev?.count ?? 0) + 1 })
}

function freeze(draft: Draft): Step {
  return {
    mode: draft.mode,
    sessionID: draft.sessionID,
    agent: draft.agent,
    depth: draft.depth,
    startedAt: draft.startedAt,
    endedAt: draft.endedAt,
    files: [...draft.files.values()],
    places: [...draft.places.values()],
    beats: [...draft.beats.values()],
    titles: [...draft.titles],
    // Spread conditionally, so a survey Step has no such keys at all rather than three
    // explicit undefineds — `"additions" in step` stays a usable test.
    ...(draft.additions !== undefined ? { additions: draft.additions } : {}),
    ...(draft.deletions !== undefined ? { deletions: draft.deletions } : {}),
    ...(draft.changed !== undefined ? { changed: draft.changed } : {}),
    ...(draft.messageID !== undefined ? { messageID: draft.messageID } : {}),
    ...(draft.partID !== undefined ? { partID: draft.partID } : {}),
  }
}

// How many acts a step stands for, across every kind of target — the `×n` a row shows.
export function stepWeight(step: Step): number {
  let total = 0
  for (const file of step.files) total += file.count
  for (const place of step.places) total += place.count
  for (const beat of step.beats) total += beat.count
  return total
}

export * as ApertureActivitySteps from "./activity-steps"
