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

// One action category per file touch. `create` covers the write tool (whole-file
// write, whether the file is new or overwritten); `read` and `edit` map straight
// from their tools. Order is the display order in a legend.
export const ACTIONS = ["read", "create", "edit"] as const
export type Action = (typeof ACTIONS)[number]

// One recorded action an agent took on a file. `path` is repo-relative and
// matches AperturePayload `node.path`, which is what lets the renderer join an
// entry to the file's facet mix.
//
// `sessionID` is the session the action happened in — a *child* session for
// sub-agent work — and `depth` says how far from the viewed session that is
// (0 = the session itself, 1 = a sub-agent it spawned). The two together are what
// G3 needs to build sub-agent activity orthogonally to the main agent's within a
// turn. `agent` is the acting agent's name, taken from the assistant message the
// tool call sits on, so a plan→build switch mid-turn attributes correctly.
export interface ActivityEntry {
  readonly path: string
  readonly action: Action
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

// Map a tool name to the file action it represents, or undefined for tools that
// don't touch one specific file (bash, grep, glob, task, …). The `write` tool —
// which both overwrites whole files and creates new ones — maps to `create`.
export function actionFromTool(tool: string): Action | undefined {
  switch (tool) {
    case "read":
      return "read"
    case "edit":
      return "edit"
    case "write":
      return "create"
    default:
      return undefined
  }
}

export * as ApertureActivity from "./activity"
