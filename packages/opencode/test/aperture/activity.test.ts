import { describe, expect, test } from "bun:test"
import { deriveTurns, mergeChildEntries, toRepoRelative, toRepoScope, type MessageLike } from "@/aperture/activity-model"
import { computeFacetMapFiles } from "@/aperture/aperture"
import { NONE_FACET } from "@/aperture/lenses"

// Activity is *derived*, not recorded (PLAN.md G1): every tool call already lives in the
// durable message store, so the log is a view of it rather than a second source of truth.
// That makes the derivation the whole feature — if it groups turns wrongly, no amount of
// rendering saves it.

const DIR = "/repo"

let seq = 0
const next = () => `p_${(seq++).toString().padStart(3, "0")}`

const user = (text: string, opts: { agent?: string; at?: number; synthetic?: boolean } = {}): MessageLike => ({
  info: { role: "user", agent: opts.agent ?? "build", time: { created: opts.at ?? 1000 } },
  parts: [{ type: "text", ...(opts.synthetic ? { synthetic: true } : {}) }],
})

const tool = (
  name: string,
  input: Record<string, unknown>,
  opts: { status?: string; at?: number; metadata?: Record<string, unknown> } = {},
) => ({
  type: "tool",
  callID: next(),
  tool: name,
  state: {
    status: opts.status ?? "completed",
    input,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    time: { start: opts.at ?? 2000 },
  },
})

const assistant = (parts: ReturnType<typeof tool>[], opts: { agent?: string; at?: number } = {}): MessageLike => ({
  info: { role: "assistant", agent: opts.agent ?? "build", time: { created: opts.at ?? 1500 } },
  parts,
})

const derive = (messages: MessageLike[], sessionID = "ses_root", depth = 0) =>
  deriveTurns(messages, { directory: DIR, sessionID, depth })

describe("deriveTurns", () => {
  test("maps every tool onto an action and a target", () => {
    const turns = derive([
      user("go"),
      assistant([
        tool("read", { filePath: "src/a.ts" }),
        tool("edit", { filePath: "src/b.ts" }),
        tool("write", { filePath: "src/c.ts" }),
        tool("bash", { command: "ls" }),
        tool("grep", { pattern: "x", path: "src" }),
      ]),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.entries.map((e) => [e.path, e.action, e.target])).toEqual([
      ["src/a.ts", "read", "file"],
      ["src/b.ts", "edit", "file"],
      // The write tool means "whole-file write", new file or overwrite alike.
      ["src/c.ts", "create", "file"],
      // A shell command names no path we could ever colour, but it is still a step.
      [undefined, "run", "none"],
      ["src", "search", "place"],
    ])
  })

  test("a directory read is a place, not a file", () => {
    // The read tool takes a directory as happily as a file and agents use it that way
    // constantly. Its result metadata says which, authoritatively (tool/read.ts).
    const turns = derive([
      user("go"),
      assistant([
        tool("read", { filePath: "packages" }, { metadata: { display: { type: "directory" } } }),
        tool("read", { filePath: "src/a.ts" }, { metadata: { display: { type: "file" } } }),
      ]),
    ])
    expect(turns[0]!.entries.map((e) => [e.path, e.target])).toEqual([
      ["packages", "place"],
      ["src/a.ts", "file"],
    ])
  })

  test("a search with no path scopes to the repo root", () => {
    const turns = derive([user("go"), assistant([tool("glob", { pattern: "**/*.ts" })])])
    expect(turns[0]!.entries.map((e) => [e.path, e.action, e.target])).toEqual([["", "search", "place"]])
  })

  test("apply_patch expands into one entry per changed file", () => {
    // Its *input* is patch text with no path field at all, so without reading the result
    // metadata every patch-based edit would be a blind spot — and each changed file has to
    // become its own step, since mutations are never aggregated.
    const turns = derive([
      user("go"),
      assistant([
        tool(
          "apply_patch",
          { patchText: "..." },
          {
            metadata: {
              files: [
                { relativePath: "src/a.ts", type: "update" },
                { relativePath: "src/new.ts", type: "add" },
              ],
            },
          },
        ),
      ]),
    ])
    expect(turns[0]!.entries.map((e) => [e.path, e.action, e.target])).toEqual([
      ["src/a.ts", "edit", "file"],
      ["src/new.ts", "create", "file"],
    ])
  })

  test("an unrecognised tool records as an external fetch, and bookkeeping tools record nothing", () => {
    // MCP tools register as `client_tool` with no reserved prefix, so they cannot be
    // identified by pattern — but "we don't know what it did and it wasn't a repo file" is
    // exactly what external means, and staying visible beats being silently dropped.
    const turns = derive([
      user("go"),
      assistant([
        tool("linear_create_issue", { title: "x" }),
        tool("webfetch", { url: "https://example.com" }),
        tool("todowrite", { todos: [] }),
        tool("skill", { name: "x" }),
      ]),
    ])
    expect(turns[0]!.entries.map((e) => [e.action, e.target])).toEqual([
      ["fetch", "none"],
      ["fetch", "none"],
    ])
  })

  test("a synthetic user message does NOT open a turn", () => {
    // Tool-result injections, background sub-agent completions and compaction all arrive as
    // synthetic user messages. Splitting on them would shatter one prompt into many turns —
    // the single most damaging thing this function could get wrong.
    const turns = derive([
      user("go"),
      assistant([tool("read", { filePath: "src/a.ts" })]),
      user("<task .../>", { synthetic: true }),
      assistant([tool("edit", { filePath: "src/b.ts" })]),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.entries).toHaveLength(2)
  })

  test("two real prompts make two turns, in prompt order", () => {
    const turns = derive([
      user("first", { at: 100 }),
      assistant([tool("read", { filePath: "src/a.ts" })]),
      user("second", { at: 200 }),
      assistant([tool("read", { filePath: "src/b.ts" })]),
    ])
    expect(turns.map((t) => t.promptedAt)).toEqual([100, 200])
    expect(turns[0]!.entries.map((e) => e.path)).toEqual(["src/a.ts"])
    expect(turns[1]!.entries.map((e) => e.path)).toEqual(["src/b.ts"])
  })

  test("an entry carries the ACTING agent, not the prompting one", () => {
    // A plan→build switch mid-turn is exactly the case the in-memory tracker needed an
    // agentBySession map and two extra event subscriptions to reconstruct. Here it is just
    // the assistant message's own field.
    const turns = derive([
      user("go", { agent: "plan" }),
      assistant([tool("read", { filePath: "src/a.ts" })], { agent: "plan" }),
      assistant([tool("edit", { filePath: "src/b.ts" })], { agent: "build" }),
    ])
    expect(turns[0]!.agent).toBe("plan")
    expect(turns[0]!.entries.map((e) => e.agent)).toEqual(["plan", "build"])
  })

  test("a task call yields its child session rather than an entry", () => {
    const turns = derive([
      user("go"),
      assistant([
        tool("task", { subagent_type: "explore", prompt: "look" }, { metadata: { sessionId: "ses_child" } }),
      ]),
    ])
    expect(turns[0]!.entries).toHaveLength(0)
    expect(turns[0]!.children).toEqual([
      { sessionID: "ses_child", agent: "explore", callID: expect.any(String) },
    ])
  })

  test("a child session's entries fold into the parent turn at depth 1, in timeline order", () => {
    const parent = derive([
      user("go", { at: 100 }),
      assistant([tool("read", { filePath: "src/a.ts" }, { at: 300 })]),
    ])
    const child = derive(
      [user("look"), assistant([tool("read", { filePath: "src/z.ts" }, { at: 200 })], { agent: "explore" })],
      "ses_child",
      1,
    )
    mergeChildEntries(parent[0]!, child[0]!.entries)
    // Sorted by timestamp, so a turn reads as one timeline regardless of which session each
    // action happened in — which is what G3's orthogonal sub-agent axis is built on.
    expect(parent[0]!.entries.map((e) => [e.path, e.depth, e.sessionID])).toEqual([
      ["src/z.ts", 1, "ses_child"],
      ["src/a.ts", 0, "ses_root"],
    ])
  })

  test("pending tool calls are skipped, errored ones are kept", () => {
    // A pending call's input is still streaming, so it has no usable path. An errored one is
    // real activity — the agent tried to touch that file.
    const turns = derive([
      user("go"),
      assistant([
        tool("edit", {}, { status: "pending" }),
        tool("edit", { filePath: "src/b.ts" }, { status: "error" }),
        tool("read", { filePath: "src/c.ts" }, { status: "running" }),
      ]),
    ])
    expect(turns[0]!.entries.map((e) => e.path)).toEqual(["src/b.ts", "src/c.ts"])
  })

  test("activity before any prompt opens an implicit turn", () => {
    const turns = derive([assistant([tool("read", { filePath: "src/a.ts" })])])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.entries).toHaveLength(1)
  })

  test("maxTurns keeps the most recent turns", () => {
    const messages = [1, 2, 3].flatMap((n) => [
      user(`p${n}`, { at: n * 100 }),
      assistant([tool("read", { filePath: `src/${n}.ts` })]),
    ])
    const turns = deriveTurns(messages, { directory: DIR, sessionID: "ses_root", maxTurns: 2 })
    expect(turns.map((t) => t.promptedAt)).toEqual([200, 300])
  })
})

describe("toRepoRelative", () => {
  test("normalises absolute and relative in-project paths to repo-relative POSIX", () => {
    expect(toRepoRelative(DIR, "/repo/src/a.ts")).toBe("src/a.ts")
    expect(toRepoRelative(DIR, "src/a.ts")).toBe("src/a.ts")
  })

  test("rejects anything outside the project", () => {
    // A path that escapes the repo has no AperturePayload node to join to, so an entry for
    // it could only ever paint nothing.
    expect(toRepoRelative(DIR, "/etc/passwd")).toBeUndefined()
    expect(toRepoRelative(DIR, "../outside.ts")).toBeUndefined()
    expect(toRepoRelative(DIR, DIR)).toBeUndefined()
    expect(toRepoRelative(DIR, "")).toBeUndefined()
    expect(toRepoRelative(DIR, undefined)).toBeUndefined()
  })
})

describe("toRepoScope", () => {
  test("treats the repo root as a real scope rather than a degenerate one", () => {
    // The difference from toRepoRelative: a search with no path, or a read of the project
    // directory itself, is scoped to "" — which is how AperturePayload keys the root.
    expect(toRepoScope(DIR, DIR)).toBe("")
    expect(toRepoScope(DIR, "")).toBe("")
    expect(toRepoScope(DIR, undefined)).toBe("")
    expect(toRepoScope(DIR, "src")).toBe("src")
    expect(toRepoScope(DIR, "/repo/src/nested")).toBe("src/nested")
  })

  test("still rejects anything outside the project", () => {
    expect(toRepoScope(DIR, "/etc")).toBeUndefined()
    expect(toRepoScope(DIR, "../outside")).toBeUndefined()
  })
})

describe("facet agreement", () => {
  // The activity response's `files` is `computeFacetMapFiles` over the *touched* subset —
  // filtered at the input, not in the reduction — so an Activity View block, an Explorer pip
  // and a treemap band for the same file are three renderings of one attribution.
  const FACETS = ["likely", "hot", NONE_FACET]
  const SUBTREE = [
    { id: "n_a", path: "src/a.ts", size: 100 },
    { id: "n_b", path: "src/b.ts", size: 200 },
    { id: "n_c", path: "src/c.ts", size: 300 },
  ]
  const STORE = {
    n_a: { facet: "likely", hash: "h" },
    n_b: { facet: "hot", hash: "h" },
    n_c: { facet: "hot", hash: "h" },
  }

  test("the touched subset equals the whole-repo map restricted to those paths", () => {
    const touched = new Set(["src/a.ts", "src/c.ts"])
    const all = computeFacetMapFiles(SUBTREE, STORE, {}, FACETS)
    const scoped = computeFacetMapFiles(
      SUBTREE.filter((f) => touched.has(f.path)),
      STORE,
      {},
      FACETS,
    )
    expect(Object.keys(scoped).sort()).toEqual(["src/a.ts", "src/c.ts"])
    for (const path of touched) expect(scoped[path]).toEqual(all[path]!)
  })
})
