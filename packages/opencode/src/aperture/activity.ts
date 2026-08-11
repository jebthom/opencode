// Shared glyph vocabulary for the Aperture node-overlay layer (PLAN.md
// Foundation A). Deliberately dependency-free (no Effect/Schema) so it is safe to
// import from both server-side producers and the TUI renderer without dragging
// server code into the TUI bundle — same posture as semantics.ts.
//
// The structure of the graph is deterministic and the layer paint is async; this
// vocabulary is a third, *ephemeral* overlay: small glyphs drawn on a node tile
// to show what an agent did to a file (read/create/edit) and whether that
// action is real or merely proposed by a plan. Foundation A defines the
// vocabulary and the render slot; the data that fills it arrives in later steps
// (agent tracking = step 7, planning = step 8). Edges (step 6) reuse the same
// hover-info line, not these glyphs.

// One action category per file touch. `create` covers the write tool (whole-file
// write, whether the file is new or overwritten); `read` and `edit` map straight
// from their tools. Order is the display order of glyphs on a tile / in the legend.
export const ACTIONS = ["read", "create", "edit"] as const
export type Action = (typeof ACTIONS)[number]

// Whether a glyph marks the node an agent acted on *directly* (`solid`) or an
// ancestor *directory* that merely contains a touched file (`outline`). The same
// action glyph propagates up the tree from the changed file to its parent,
// grandparent, … each drawn in its outline form. Orthogonal to `Style` (actual vs
// planned): a planned action and an actual one can each be solid or outline.
export const FILLS = ["solid", "outline"] as const
export type Fill = (typeof FILLS)[number]

// One shape per action — read = circle, create = square, edit = diamond — with a
// solid and an outline form each. Single-width BMP geometric glyphs from the same
// Unicode block (U+25xx) as the bar's existing ■ / ◀ / ╭ chars, so every form
// renders wherever those do. `solid` is the node actually touched; `outline` is a
// containing directory (see Fill).
export const ACTION_GLYPH: Record<Action, Record<Fill, string>> = {
  read: { solid: "●", outline: "○" }, // circle — looked at
  create: { solid: "■", outline: "□" }, // square — whole-file write / new file
  edit: { solid: "◆", outline: "◇" }, // diamond — modified in place
}

// Resolve an action + fill to its glyph (convenience for renderers).
export function glyphFor(action: Action, fill: Fill): string {
  return ACTION_GLYPH[action][fill]
}

// Short human label for the hover-info line.
export const ACTION_LABEL: Record<Action, string> = {
  read: "read",
  create: "created",
  edit: "edited",
}

// Whether an overlay reflects something that has happened or something a plan
// only proposes. Drives styling at render time: `actual` uses the agent's color,
// `planned` is dimmed (and proposed-file *blocks* get dashed borders in step 8).
// Color is never baked in here — the renderer interprets this. (Unlike LAYER_HUE, which
// is now literal hex; overlay styling is still theme-relative because it dims the *agent's*
// colour rather than naming one.)
export const STYLES = ["actual", "planned"] as const
export type Style = (typeof STYLES)[number]

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value)
}

// --- provenance contract (PLAN.md Foundation B) ----------------------------
// The seam for agent tracking (step 7) and planned reads (step 8). Kept here,
// data-free, so it can be reused if/when provenance is persisted server-side; for
// now the TUI holds it in memory (see aperture-activity.ts).

// One recorded action an agent took on a file. `path` is repo-relative and
// matches AperturePayload `node.path`. `sessionID` distinguishes concurrent
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
