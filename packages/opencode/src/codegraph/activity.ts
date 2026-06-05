// Shared glyph vocabulary for the code-graph node-overlay layer (PLAN.md
// Foundation A). Deliberately dependency-free (no Effect/Schema) so it is safe to
// import from both server-side producers and the TUI renderer without dragging
// server code into the TUI bundle — same posture as semantics.ts.
//
// The structure of the graph is deterministic and the layer paint is async; this
// vocabulary is a third, *ephemeral* overlay: small glyphs drawn on a node tile
// to show what an agent did to a file (read/edit/write/create) and whether that
// action is real or merely proposed by a plan. Foundation A defines the
// vocabulary and the render slot; the data that fills it arrives in later steps
// (agent tracking = step 7, planning = step 8). Edges (step 6) reuse the same
// hover-info line, not these glyphs.

// One action category per file touch. `create` is a write to a path that has no
// existing node (a brand-new file); everything else maps from the tool name.
export const ACTIONS = ["read", "edit", "write", "create"] as const
export type Action = (typeof ACTIONS)[number]

// Single-width BMP geometric glyphs (same Unicode block as the bar's existing
// ■ / ◀ / ╭ chars, so they render in the same terminals). Ordered light→heavy by
// how much the action changes the file.
export const ACTION_GLYPH: Record<Action, string> = {
  read: "◌", // outline — looked at, unchanged
  edit: "◆", // filled diamond — modified in place
  write: "●", // filled circle — rewritten
  create: "◈", // diamond w/ center — newly created
}

// Short human label for the hover-info line.
export const ACTION_LABEL: Record<Action, string> = {
  read: "read",
  edit: "edited",
  write: "wrote",
  create: "created",
}

// Whether an overlay reflects something that has happened or something a plan
// only proposes. Drives styling at render time: `actual` uses the agent's color,
// `planned` is dimmed (and proposed-file *blocks* get dashed borders in step 8).
// Color is never baked in here — the renderer interprets this, mirroring how
// LAYER_HUE is resolved against the active theme.
export const STYLES = ["actual", "planned"] as const
export type Style = (typeof STYLES)[number]

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value)
}

// --- provenance contract (PLAN.md Foundation B) ----------------------------
// The seam for agent tracking (step 7) and planned reads (step 8). Kept here,
// data-free, so it can be reused if/when provenance is persisted server-side; for
// now the TUI holds it in memory (see codegraph-activity.ts).

// One recorded action an agent took on a file. `path` is repo-relative and
// matches CodeGraphPayload `node.path`. `sessionID` distinguishes concurrent
// agents (a sub-agent carries its own id under a parent); `agent` is its name.
export interface ActivityEntry {
  readonly path: string
  readonly action: Action
  readonly agent: string
  readonly sessionID: string
  readonly callID: string
  readonly timestamp: number
}

// All activity recorded since one user prompt — the "since last interaction"
// window the live view paints. The ring of past turns is what a future timeline
// UI will walk for provenance.
export interface Turn {
  readonly promptedAt: number
  readonly entries: ActivityEntry[]
}

// Map a tool name to the file action it represents, or undefined for tools that
// don't touch one specific file (bash, grep, glob, task, …). `create` vs `write`
// can't be told from the tool name alone — it depends on whether the path already
// has a node — so writes map to `write` and the renderer upgrades to `create`.
export function actionFromTool(tool: string): Action | undefined {
  switch (tool) {
    case "read":
      return "read"
    case "edit":
      return "edit"
    case "write":
      return "write"
    default:
      return undefined
  }
}

export * as CodeGraphActivity from "./activity"
