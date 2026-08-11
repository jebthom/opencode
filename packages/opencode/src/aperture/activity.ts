// The Aperture activity data model (PLAN.md G1): what an agent did to which
// files, per user turn, so the Activity View can render a turn as blocks coloured
// by the active Lens. Deliberately dependency-free (no Effect/Schema) so it is
// safe to import from both server-side producers and the TUI renderer without
// dragging server code into the TUI bundle — same posture as semantics.ts.
//
// Nothing here is *recorded*. Activity is derived at the read boundary from the
// durable message store, where every tool call already lives as a ToolPart (see
// activity-model.ts). That is what makes a Lens switch recolour history for free:
// there is no stored facet to go stale, because there is no stored anything.
//
// This file holds the vocabulary and the wire shapes; activity-model.ts holds the
// derivation that produces them.

// One action category per recorded act. `create` covers the write tool (whole-file
// write, whether the file is new or overwritten); `read` and `edit` map straight from
// their tools. `search` is a scoped look-around (grep/glob/lsp), `run` a shell command,
// `fetch` anything reaching outside the codebase. Order is the display order in a legend.
export const ACTIONS = ["read", "search", "create", "edit", "run", "fetch"] as const
export type Action = (typeof ACTIONS)[number]

// What an action *is*, which is what decides whether it may be aggregated (G2 §1).
//
//  - `survey`  gathering inside the repo: reads, directory listings, searches.
//  - `mutate`  anything that can leave a lasting effect: edits, writes, shell commands.
//  - `external` reaching outside the codebase: web fetches, MCP calls.
//
// Only `survey` aggregates. A step is a maximal run of consecutive survey entries, or a
// *single* non-survey entry — because aggregation asserts the individual acts need not be
// distinguished, which is true of gathering and false of anything consequential. A
// mutation the user did not notice is the failure mode this view exists to prevent.
export const MODES = ["survey", "mutate", "external"] as const
export type Mode = (typeof MODES)[number]

export function modeOf(action: Action): Mode {
  switch (action) {
    case "read":
    case "search":
      return "survey"
    case "create":
    case "edit":
    case "run":
      return "mutate"
    case "fetch":
      return "external"
  }
}

// What an entry points at, which decides what it can contribute to a rendered block.
//
//  - `file`  a repo file the view knows about; joins the facet band via its path.
//  - `place` a directory or search scope. Counted and drawn as navigation, but it
//            contributes NO band cells: a turn's survey entries collapse into one block,
//            so admitting a directory would fold an aggregate into an aggregate — one
//            read of `packages/` would outweigh nine real files and report the mix of code
//            the agent never opened (PLAN.md G2).
//  - `none`  a pathless act (a shell command, a web fetch).
export const TARGETS = ["file", "place", "none"] as const
export type Target = (typeof TARGETS)[number]

// One recorded action an agent took. `path` is repo-relative and matches AperturePayload
// `node.path`, which is what lets the renderer join a `file` entry to its facet mix; it is
// absent exactly when `target` is `none`.
//
// `sessionID` is the session the action happened in — a *child* session for
// sub-agent work — and `depth` says how far from the viewed session that is
// (0 = the session itself, 1 = a sub-agent it spawned). `sessionID` is also the *lane*
// key the step segmenter partitions by before it segments, which is what keeps two
// parallel sub-agents from interleaving into alternating one-entry steps — `agent` cannot
// do that job, since two `Explore` agents share a name. `agent` is the acting agent's
// name, taken from the assistant message the tool call sits on, so a plan→build switch
// mid-turn attributes correctly.
export interface ActivityEntry {
  readonly path?: string
  readonly action: Action
  readonly target: Target
  readonly agent: string
  readonly sessionID: string
  readonly depth: number
  readonly callID: string
  readonly timestamp: number
}

// All activity recorded under one user prompt. A turn is one *non-synthetic* user
// message: synthetic ones (tool-result injections, background sub-agent result
// injections, compaction) are continuations of the prompt that caused them, not
// new prompts, and splitting on them would shatter a single turn into a dozen.
//
// `agent` is the prompting agent (the plan/build distinction at the time of the
// prompt); individual entries carry their own acting agent, which may differ.
export interface Turn {
  readonly promptedAt: number
  readonly agent: string
  readonly entries: ReadonlyArray<ActivityEntry>
}

// Tools that record nothing. Internal bookkeeping with no repo file behind it and no
// external system in front of it — a todo write or a skill load is not something the user
// needs to see on a timeline of what happened to their codebase. `task` is absent from
// this list because it is not an entry at all: it *opens a lane* (see Aperture.activity),
// and its sub-agent's own entries are what get recorded.
const IGNORED_TOOLS = new Set([
  "todowrite",
  "todoread",
  "question",
  "plan",
  "plan_exit",
  "skill",
  "invalid",
  "task",
])

// Map a tool name to the action it represents, or undefined for tools we deliberately
// ignore. The `write` tool — which both overwrites whole files and creates new ones —
// maps to `create`.
//
// The default arm is load-bearing, not a fallback: an *unrecognised* tool is an MCP tool
// or a plugin tool. MCP registers as `sanitize(clientName) + "_" + sanitize(toolName)`
// (mcp/index.ts) with no reserved prefix, so it cannot be identified by pattern — but
// "we don't know what it did and it wasn't a repo file" is exactly what `external` means,
// and `fetch` is its action. Erring this way keeps an unknown act visible on the timeline
// rather than silently dropping it.
export function actionFromTool(tool: string): Action | undefined {
  if (IGNORED_TOOLS.has(tool)) return undefined
  switch (tool) {
    case "read":
      return "read"
    case "grep":
    case "glob":
    case "lsp":
      return "search"
    case "edit":
    case "apply_patch":
      return "edit"
    case "write":
      return "create"
    // Classified `mutate` because we cannot tell from a tool name whether a command
    // mutates, and an un-inspectable act is better treated as consequential than as free.
    // Note it does not need that classification to split a survey run — under the step
    // rule, any non-survey entry already breaks one.
    case "bash":
      return "run"
    case "webfetch":
    case "websearch":
      return "fetch"
    default:
      return "fetch"
  }
}

export * as ApertureActivity from "./activity"
