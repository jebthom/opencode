import { describe, expect, test } from "bun:test"
import { stepsForTurn, stepWeight, type Step } from "@/aperture/activity-steps"
import type { Action, ActivityEntry, Target, Turn } from "@/aperture/activity"

// Segmentation is the whole design (PLAN.md G2): a step is either a maximal run of
// consecutive `survey` entries within one lane, or a *single* non-survey entry. Only
// gathering aggregates — a mutation the user did not notice is the failure mode the
// Activity View exists to prevent, so each one gets its own node on the path.

let clock = 0

const entry = (
  action: Action,
  opts: {
    path?: string
    target?: Target
    agent?: string
    session?: string
    depth?: number
    at?: number
    additions?: number
    deletions?: number
    changed?: number
  } = {},
): ActivityEntry => ({
  ...(opts.path === undefined ? {} : { path: opts.path }),
  action,
  target: opts.target ?? (opts.path === undefined ? "none" : "file"),
  agent: opts.agent ?? "build",
  sessionID: opts.session ?? "ses_root",
  depth: opts.depth ?? 0,
  callID: `c_${clock}`,
  timestamp: opts.at ?? clock++,
  ...(opts.additions === undefined ? {} : { additions: opts.additions }),
  ...(opts.deletions === undefined ? {} : { deletions: opts.deletions }),
  ...(opts.changed === undefined ? {} : { changed: opts.changed }),
})

const turn = (entries: ActivityEntry[]): Turn => ({ promptedAt: 0, agent: "build", entries })

// The single lane's steps, as [mode, the paths it stands for].
const spine = (t: Turn) => {
  const result = stepsForTurn(t)
  return (result.lanes[0]?.steps ?? []).map((s) => [s.mode, s.files.map((f) => f.path)] as const)
}

const modes = (steps: ReadonlyArray<Step>) => steps.map((s) => s.mode)

describe("survey runs aggregate, everything else does not", () => {
  test("reads → write → reads is three steps", () => {
    expect(
      spine(
        turn([
          entry("read", { path: "a.ts" }),
          entry("read", { path: "b.ts" }),
          entry("create", { path: "c.ts" }),
          entry("read", { path: "d.ts" }),
          entry("read", { path: "e.ts" }),
        ]),
      ),
    ).toEqual([
      ["survey", ["a.ts", "b.ts"]],
      ["mutate", ["c.ts"]],
      ["survey", ["d.ts", "e.ts"]],
    ])
  })

  test("reads → THREE writes → reads is five steps", () => {
    // The asymmetry is the point: twelve reads collapse to one node, but three writes are
    // three, because aggregating them would be a claim they need not be distinguished.
    expect(
      spine(
        turn([
          entry("read", { path: "a.ts" }),
          entry("create", { path: "x.ts" }),
          entry("create", { path: "y.ts" }),
          entry("create", { path: "z.ts" }),
          entry("read", { path: "b.ts" }),
        ]),
      ),
    ).toEqual([
      ["survey", ["a.ts"]],
      ["mutate", ["x.ts"]],
      ["mutate", ["y.ts"]],
      ["mutate", ["z.ts"]],
      ["survey", ["b.ts"]],
    ])
  })

  test("three edits to ONE file are three steps, never deduped", () => {
    const steps = spine(turn([1, 2, 3].map(() => entry("edit", { path: "a.ts" }))))
    expect(steps).toEqual([
      ["mutate", ["a.ts"]],
      ["mutate", ["a.ts"]],
      ["mutate", ["a.ts"]],
    ])
  })

  test("three reads of one file inside a run are one mark with a count", () => {
    const result = stepsForTurn(turn([1, 2, 3].map(() => entry("read", { path: "a.ts" }))))
    const step = result.lanes[0]!.steps[0]!
    expect(result.lanes[0]!.steps).toHaveLength(1)
    expect(step.files).toEqual([{ path: "a.ts", action: "read", count: 3 }])
    expect(stepWeight(step)).toBe(3)
  })

  test("reads and searches are one gathering step; the mix of tools is not a boundary", () => {
    const result = stepsForTurn(
      turn([
        entry("read", { path: "a.ts" }),
        entry("search", { path: "src", target: "place" }),
        entry("read", { path: "b.ts" }),
      ]),
    )
    const steps = result.lanes[0]!.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]!.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"])
    // A place is counted as navigation but paints no cells, so it never joins `files`.
    expect(steps[0]!.places).toEqual([{ path: "src", count: 1 }])
  })
})

describe("run boundaries", () => {
  test("a shell command splits a gathering run in two", () => {
    // `read, read, bash, read` is three steps: running the tests is not gathering.
    expect(
      modes(
        stepsForTurn(
          turn([
            entry("read", { path: "a.ts" }),
            entry("read", { path: "b.ts" }),
            entry("run"),
            entry("read", { path: "c.ts" }),
          ]),
        ).lanes[0]!.steps,
      ),
    ).toEqual(["survey", "mutate", "survey"])
  })

  test("four consecutive shell commands are four steps", () => {
    const steps = stepsForTurn(turn([1, 2, 3, 4].map(() => entry("run")))).lanes[0]!.steps
    expect(steps).toHaveLength(4)
    expect(steps.every((s) => s.beats.length === 1 && s.files.length === 0)).toBe(true)
  })

  test("an external call is its own step too", () => {
    expect(
      modes(
        stepsForTurn(turn([entry("read", { path: "a.ts" }), entry("fetch"), entry("read", { path: "b.ts" })])).lanes[0]!
          .steps,
      ),
    ).toEqual(["survey", "external", "survey"])
  })

  test("an agent switch inside one session breaks a gathering run", () => {
    // A plan→build switch is a real change of actor even at the same depth.
    const steps = stepsForTurn(
      turn([
        entry("read", { path: "a.ts", agent: "plan" }),
        entry("read", { path: "b.ts", agent: "plan" }),
        entry("read", { path: "c.ts", agent: "build" }),
      ]),
    ).lanes[0]!.steps
    expect(steps.map((s) => [s.agent, s.files.map((f) => f.path)])).toEqual([
      ["plan", ["a.ts", "b.ts"]],
      ["build", ["c.ts"]],
    ])
  })

  test("a turn boundary closes every open run", () => {
    // Two turns segment independently: reads at the end of one and the start of the next
    // are different steps, because they answer different prompts.
    const first = stepsForTurn(turn([entry("read", { path: "a.ts" })]))
    const second = stepsForTurn(turn([entry("read", { path: "b.ts" })]))
    expect(first.lanes[0]!.steps).toHaveLength(1)
    expect(second.lanes[0]!.steps).toHaveLength(1)
    expect(first.lanes[0]!.steps[0]!.files.map((f) => f.path)).toEqual(["a.ts"])
  })
})

describe("lanes", () => {
  test("three parallel sub-agents interleaved by timestamp become three lanes, not nine steps", () => {
    // THE regression this design exists to prevent. mergeChildEntries sorts the whole turn
    // by timestamp, so parallel Explore agents arrive A,B,C,A,B,C… — segmenting that merged
    // sequence directly would shatter every run into alternating one-entry steps.
    const entries: ActivityEntry[] = []
    let at = 10
    for (const round of [0, 1, 2]) {
      for (const agent of ["a", "b", "c"]) {
        entries.push(
          entry("read", {
            path: `${agent}${round}.ts`,
            agent: "Explore",
            session: `ses_${agent}`,
            depth: 1,
            at: at++,
          }),
        )
      }
    }
    const result = stepsForTurn(turn(entries))
    expect(result.lanes).toHaveLength(3)
    for (const lane of result.lanes) {
      expect(lane.steps).toHaveLength(1)
      expect(lane.steps[0]!.files).toHaveLength(3)
    }
    // Lane-major and ordered by when each opened, so a lane reads as one agent's work.
    expect(result.lanes.map((l) => l.sessionID)).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(result.lanes[0]!.steps[0]!.files.map((f) => f.path)).toEqual(["a0.ts", "a1.ts", "a2.ts"])
  })

  test("the viewed session's lane leads, whatever order its entries arrived in", () => {
    // A child's entries can timestamp *before* the parent's, since the parent is blocked
    // while the sub-agent works — but the spine still comes first.
    const result = stepsForTurn(
      turn([
        entry("read", { path: "child.ts", session: "ses_child", depth: 1, at: 10 }),
        entry("edit", { path: "parent.ts", session: "ses_root", depth: 0, at: 20 }),
      ]),
    )
    expect(result.lanes.map((l) => [l.depth, l.sessionID])).toEqual([
      [0, "ses_root"],
      [1, "ses_child"],
    ])
  })

  test("one session's entries never merge with another's, even when adjacent and same-mode", () => {
    const result = stepsForTurn(
      turn([
        entry("read", { path: "a.ts", session: "ses_x", depth: 1, at: 1 }),
        entry("read", { path: "b.ts", session: "ses_y", depth: 1, at: 2 }),
      ]),
    )
    expect(result.lanes).toHaveLength(2)
    expect(result.lanes.every((l) => l.steps.length === 1)).toBe(true)
  })
})

describe("step contents", () => {
  test("a later action wins when one file is touched twice in a run", () => {
    // Only reachable inside a survey run; a mutate step holds a single entry by
    // construction. A file read and then read again keeps its action either way.
    const step = stepsForTurn(
      turn([entry("read", { path: "a.ts" }), entry("search", { path: "a.ts", target: "place" })]),
    ).lanes[0]!.steps[0]!
    expect(step.files).toEqual([{ path: "a.ts", action: "read", count: 1 }])
    expect(step.places).toEqual([{ path: "a.ts", count: 1 }])
  })

  test("a step spans the timestamps of the entries it holds", () => {
    const step = stepsForTurn(
      turn([entry("read", { path: "a.ts", at: 100 }), entry("read", { path: "b.ts", at: 400 })]),
    ).lanes[0]!.steps[0]!
    expect([step.startedAt, step.endedAt]).toEqual([100, 400])
  })

  test("an empty turn yields no lanes", () => {
    expect(stepsForTurn(turn([])).lanes).toEqual([])
  })

  test("titles accumulate deduped, in first-seen order", () => {
    // The hover line reads these. For `bash` the title is the model-written description the
    // chat already renders, so nothing is generated to produce it.
    const step = stepsForTurn(
      turn([
        { ...entry("read", { path: "a.ts" }), title: "Read a.ts" },
        { ...entry("read", { path: "b.ts" }), title: "Read b.ts" },
        { ...entry("read", { path: "a.ts" }), title: "Read a.ts" },
      ]),
    ).lanes[0]!.steps[0]!
    expect(step.titles).toEqual(["Read a.ts", "Read b.ts"])
  })

  test("a step whose entries carry no title has none, rather than empty strings", () => {
    const step = stepsForTurn(turn([entry("run")])).lanes[0]!.steps[0]!
    expect(step.titles).toEqual([])
  })
})

// The size of a change reaches a row through the step, so the accumulator has to carry it
// without inventing any of it: a survey step must stay silent, and a mutate step must
// report exactly what its one entry recorded.
describe("change size", () => {
  const only = (t: Turn) => stepsForTurn(t).lanes[0]!.steps[0]!

  test("a mutate step carries its entry's line counts through freeze", () => {
    const step = only(turn([entry("edit", { path: "a.ts", additions: 12, deletions: 3 })]))
    expect([step.additions, step.deletions]).toEqual([12, 3])
  })

  test("a survey step carries no counts at all", () => {
    // Absent, not zero: the renderer keys off absence to decide whether a row has a
    // magnitude to state, so three explicit undefineds would read as "changed nothing"
    // where they should read as "is not a change".
    const step = only(turn([entry("read", { path: "a.ts" }), entry("read", { path: "b.ts" })]))
    expect("additions" in step).toBe(false)
    expect("deletions" in step).toBe(false)
    expect("changed" in step).toBe(false)
  })

  test("a write reports additions with no deletions beside them", () => {
    const step = only(turn([entry("create", { path: "a.ts", additions: 42 })]))
    expect(step.additions).toBe(42)
    expect("deletions" in step).toBe(false)
  })

  test("a run step carries its changed-file count", () => {
    const step = only(turn([entry("run", { changed: 3 })]))
    expect(step.changed).toBe(3)
    expect("additions" in step).toBe(false)
  })

  test("a mutate step always weighs exactly one", () => {
    // Not new behaviour — it follows from the step rule, since only survey entries ever
    // join an open draft. But the row layout spends the `×n` gutter on the diff stats
    // *because* this holds, so it is worth a guard of its own.
    for (const step of stepsForTurn(
      turn([
        entry("edit", { path: "a.ts" }),
        entry("edit", { path: "a.ts" }),
        entry("create", { path: "b.ts" }),
        entry("run"),
      ]),
    ).lanes[0]!.steps) {
      expect(stepWeight(step)).toBe(1)
    }
  })
})

// A row's destination in the chat. Carried by the step rather than looked up later, because
// segmentation is where the entries are still available to choose between.
describe("chat anchor", () => {
  test("a survey run anchors to its FIRST entry, not its last", () => {
    // `startedAt` is the first entry's too, so a row's identity and its destination agree —
    // and a gathering run reads better from its opening than from its close.
    const step = stepsForTurn(
      turn([
        { ...entry("read", { path: "a.ts" }), messageID: "m1", partID: "p1" },
        { ...entry("read", { path: "b.ts" }), messageID: "m1", partID: "p2" },
        { ...entry("read", { path: "c.ts" }), messageID: "m1", partID: "p3" },
      ]),
    ).lanes[0]!.steps[0]!
    expect([step.messageID, step.partID]).toEqual(["m1", "p1"])
  })

  test("each mutation keeps its own anchor", () => {
    const steps = stepsForTurn(
      turn([
        { ...entry("edit", { path: "a.ts" }), messageID: "m1", partID: "p1" },
        { ...entry("edit", { path: "b.ts" }), messageID: "m1", partID: "p2" },
      ]),
    ).lanes[0]!.steps
    expect(steps.map((s) => s.partID)).toEqual(["p1", "p2"])
  })

  test("a step whose entries carry no anchor has none", () => {
    // The renderer reads the absence as "there is nothing to reveal" and draws no icon, so
    // this must stay absent rather than becoming an empty string.
    const step = stepsForTurn(turn([entry("read", { path: "a.ts" })])).lanes[0]!.steps[0]!
    expect("messageID" in step).toBe(false)
    expect("partID" in step).toBe(false)
  })
})
