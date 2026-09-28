import { AperturePayload } from "@/aperture/payload"
// Side-effect import: registers the aperture events in the EventV2 registry before api.ts
// snapshots it into the SDK Event union.
import "@/aperture/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/aperture"

// One file's line tags under the active Lens — the editor gutter's read.
const LinesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  path: Schema.String.annotate({ description: "Repo-relative file path" }),
})

// The append-only Lens history (lens-history.ts). `turnID` is the id of the user message that
// opened a chat turn, so `?turnID=` returns exactly the Lens changes made during that turn.
const HistoryQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  since: Schema.optional(Schema.NumberFromString).annotate({ description: "Only entries with seq >= this" }),
  sessionID: Schema.optional(Schema.String),
  turnID: Schema.optional(Schema.String),
  lens: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString).annotate({ description: "Keep only the newest N matches" }),
})

const HistoryActor = Schema.Struct({
  kind: Schema.Literals(["user", "agent"]),
  agent: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  turnID: Schema.optional(Schema.String),
  messageID: Schema.optional(Schema.String),
  callID: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  consented: Schema.optional(Schema.Boolean),
})

const HistoryEntry = Schema.Struct({
  seq: Schema.Int,
  at: Schema.Number,
  op: Schema.Literals([
    "lens.create",
    "lens.delete",
    "lens.edit",
    "lens.select",
    "facet.add",
    "facet.remove",
    "facet.edit",
    "rule.add",
    "rule.replace",
    "rule.remove",
  ]),
  actor: HistoryActor,
  lens: Schema.Struct({ id: Schema.String, name: Schema.String }),
  facet: Schema.optional(Schema.String),
  rule: Schema.optional(Schema.String),
  // Snapshots of what changed: `{ lens }`, `{ facet, rules? }` or `{ rule }`.
  before: Schema.optional(Schema.Unknown),
  after: Schema.optional(Schema.Unknown),
  hits: Schema.optional(
    Schema.Struct({ lines: Schema.Int, files: Schema.Int, overCap: Schema.optional(Schema.Boolean) }),
  ),
})

// Step the active Lens one forward/back in the list, wrapping at the ends. Drives the top-bar
// ◀/▶ arrows; the repaint rides the aperture.invalidated event the switch publishes.
const CycleLensQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  direction: Schema.Literals(["next", "prev"]),
})
const CycleLensResult = Schema.Struct({
  // Absent when there are no Lenses to cycle through.
  active: Schema.optional(AperturePayload.LensInfo),
})

// Delete a Lens by id or name. Drives the top-bar ✕ control — deterministic, and always the
// user's own action.
const DeleteLensQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  lens: Schema.String,
})

const DeleteLensResult = Schema.Struct({
  status: Schema.Literals(["ok", "not-found", "needs-consent"]),
  active: Schema.optional(AperturePayload.LensInfo),
})

// One row in the Lens picker.
const LensSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  owner: Schema.Literals(["user", "agent"]),
  active: Schema.Boolean,
  facets: Schema.Int,
  rules: Schema.Int,
})

// Every marked file in the repo under the active Lens. `m` is the file's marks per facet — `f`
// indexes `facets`, `l` is marked lines, `b` marked bytes — as raw counts, so a client rolls a
// directory up by plain summation with nothing rounded away. `line` is the first marked line,
// where a click should open the file.
const MarkedFile = Schema.Struct({
  m: Schema.Array(Schema.Struct({ f: Schema.Int, l: Schema.Int, b: Schema.Int })),
  line: Schema.Int,
})

const FacetMapResult = Schema.Struct({
  // Absent when the project has no Lens yet.
  lens: Schema.optional(AperturePayload.LensInfo),
  // Facet ids in legend order.
  facets: Schema.Array(Schema.String),
  files: Schema.Record(Schema.String, MarkedFile),
  // Facets currently toggled off in the legend (O4), so a client that reconnects recovers the
  // filter from an ordinary refresh.
  suppressed: Schema.Array(Schema.String),
})

// Per-turn agent activity for a session, facet-resolved under the active Lens (G1). Feeds
// the sidebar Activity View: a turn renders as blocks coloured by what the agent was
// working on, so a user can see at a glance whether it visited the concerns they expected.
//
// Derived from the durable message store on every read, never recorded — which is what
// makes a Lens switch recolour history for free: `turns` comes back byte-identical and only
// `facets`/`files` move. The facet half is shaped exactly like FacetMapResult, so the Activity
// View and the top bar can never disagree about a file.
const ActivityQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.String,
  // How many of the most recent turns to report. Clamped server-side.
  turns: Schema.optional(Schema.NumberFromString),
})

// One recorded act. `target` says what it points at and therefore what it can contribute:
// a `file` joins the facet band, a `place` (directory read or search scope) is counted as
// navigation but paints no cells, and `none` is a pathless act with no path field at all.
//
// `depth` is 0 for the viewed session and 1 for a sub-agent it spawned — sub-agent work
// lives in its own session, and the sidebar is hidden outright inside those, so the
// parent's view is the only place it can ever be seen. `sessionID` doubles as the lane key
// the client segments by, which is what keeps parallel sub-agents from interleaving.
const ActivityEntrySchema = Schema.Struct({
  path: Schema.optional(Schema.String),
  action: Schema.Literals(["read", "search", "create", "edit", "run", "fetch"]),
  target: Schema.Literals(["file", "place", "none"]),
  agent: Schema.String,
  sessionID: Schema.String,
  depth: Schema.Int,
  callID: Schema.String,
  timestamp: Schema.Number,
  // The tool's own one-line description, already persisted on its completed part — for
  // `bash` the model-written summary the chat renders. Nothing is generated to produce it.
  title: Schema.optional(Schema.String),
  // How big the change was, read from the diff the tool already persisted rather than
  // recomputed. `deletions` is absent on a whole-file write (the old content is not stored,
  // so removed lines are unknowable and are not guessed); `changed` counts *files* and only
  // appears on a shell command, which persists no diff of its own.
  additions: Schema.optional(Schema.Int),
  deletions: Schema.optional(Schema.Int),
  changed: Schema.optional(Schema.Int),
  // Where this act is visible in the *viewed* session's chat, which the client uses to
  // reveal it. Sub-agent entries carry the parent's `task` call rather than their own part:
  // the child session's parts are not in this transcript at all.
  messageID: Schema.optional(Schema.String),
  partID: Schema.optional(Schema.String),
})

// One user turn. A turn is a non-synthetic user message: the synthetic ones (tool-result
// and background sub-agent injections, compaction) are continuations of the prompt that
// caused them, not new prompts. `agent` is the prompting agent; an entry carries its own
// acting agent, which differs after a plan→build switch mid-turn.
const ActivityTurnSchema = Schema.Struct({
  promptedAt: Schema.Number,
  agent: Schema.String,
  entries: Schema.Array(ActivityEntrySchema),
})

const ActivityResult = Schema.Struct({
  lens: Schema.optional(AperturePayload.LensInfo),
  facets: Schema.Array(Schema.String),
  turns: Schema.Array(ActivityTurnSchema),
  // Marks per *touched* path only, deduped across turns — the same shape as
  // FacetMapResult.files, scoped to what the turns actually reference.
  files: Schema.Record(Schema.String, MarkedFile),
  suppressed: Schema.Array(Schema.String),
})

// Replace the legend filter (O4): the set of facets to grey out, in the active Lens's
// vocabulary. The whole set, not a delta — the TUI's legend and the extension's picker each
// own a set, and sending it entire is what stops the two drifting apart. Ids outside the
// active Lens are dropped; the response is what was kept.
export const FacetFilterInput = Schema.Struct({
  facets: Schema.Array(Schema.String).annotate({
    description: "Facet ids to grey out; empty clears the filter",
  }),
})

// Activate a Lens by id or name (the searchable Lens picker / `/lens-switch`). The
// repaint rides the aperture.invalidated event the switch publishes; this returns the
// resolved Lens, or "not-found" when the id/name doesn't match an available Lens.
const SelectLensQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  lens: Schema.String,
})
const SelectLensResult = Schema.Struct({
  status: Schema.Literals(["ok", "not-found", "needs-consent"]),
  active: Schema.optional(AperturePayload.LensInfo),
})

// Aperture research/study logging: one top-bar interaction (a click in the view —
// lens switch, tile/breadcrumb navigation, file drill, etc.). Posted by the TUI so
// every user interaction lands in the same per-session timeline as the agent's
// prompts/tool-calls. `interaction` is the type id (e.g. "lens.cycle", "tile.drill").
export const InteractionInput = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The viewed session the interaction belongs to" }),
  interaction: Schema.String.annotate({
    description: "Interaction type id, e.g. lens.cycle / tile.drill / breadcrumb.nav",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "Repo-relative scope the view was at" }),
  drill: Schema.optional(Schema.String).annotate({ description: "Drilled file path, if any" }),
  lens: Schema.optional(Schema.String).annotate({ description: "Active lens id at the time" }),
  detail: Schema.optional(Schema.String).annotate({ description: "Optional extra payload (e.g. the target path)" }),
})

export const ApertureApi = HttpApi.make("aperture")
  .add(
    HttpApiGroup.make("aperture")
      .add(
        HttpApiEndpoint.get("lines", `${root}/lines`, {
          query: LinesQuery,
          success: described(AperturePayload.Lines, "One file's line tags under the active Lens"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.lines",
            summary: "Get a file's Aperture marks",
            description: "The marked line ranges of one file under the active Lens, for editor gutter painting.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("history", `${root}/history`, {
          query: HistoryQuery,
          success: described(Schema.Array(HistoryEntry), "Lens history entries, oldest first"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.history",
            summary: "Get the Lens history",
            description:
              "The append-only history of Lens, facet and rule changes, each tied to the actor, session and chat turn that made it.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("facetMap", `${root}/facets`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields }),
          success: described(FacetMapResult, "Every marked file in the repo with its marks per facet"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.facetMap",
            summary: "Get the whole-repo facet map",
            description: "Every file with marked lines under the active Lens, with marked-line counts per facet.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("activity", `${root}/activity`, {
          query: ActivityQuery,
          success: described(ActivityResult, "The session's recent turns with each touched file's facet mix"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.activity",
            summary: "Get a session's Aperture activity",
            description:
              "Per-turn agent read/edit/write activity for a session, with the marks of each touched file under the active Lens. Derived from the message store on read, so switching Lens recolours history without re-recording it.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("cycleLens", `${root}/lens/cycle`, {
          query: CycleLensQuery,
          success: described(CycleLensResult, "The newly-active Lens"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.cycleLens",
            summary: "Cycle active Lens",
            description: "Switch the active Aperture Lens to the next or previous one, wrapping at the ends.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("deleteLens", `${root}/lens/delete`, {
          query: DeleteLensQuery,
          success: described(DeleteLensResult, "The outcome and the now-active Lens"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.deleteLens",
            summary: "Delete a Lens",
            description: "Delete an Aperture Lens by id or name.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("listLenses", `${root}/lens/list`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields }),
          success: described(Schema.Array(LensSummary), "Every Lens, with the active one marked"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.listLenses",
            summary: "List Lenses",
            description: "List every Aperture Lens for the searchable Lens picker.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("selectLens", `${root}/lens/select`, {
          query: SelectLensQuery,
          success: described(SelectLensResult, "The outcome and the now-active Lens"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.selectLens",
            summary: "Select a Lens",
            description: "Activate an Aperture Lens by id or name.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("facetFilter", `${root}/facet-filter`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields }),
          payload: FacetFilterInput,
          success: described(Schema.Array(Schema.String), "The facets now greyed out"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.facetFilter",
            summary: "Set the legend facet filter",
            description:
              "Grey out the given facets across every Aperture surface (top bar, tree chips, editor gutter). View-only and never persisted; an empty list clears the filter.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("interaction", `${root}/interaction`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields }),
          payload: InteractionInput,
          success: described(Schema.Boolean, "Interaction recorded"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.interaction",
            summary: "Log an Aperture view interaction",
            description: "Record a top-bar click in the Aperture view to the per-session study log (research logging).",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "aperture",
          description: "Aperture routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode aperture HttpApi",
      version: "0.0.1",
      description: "Aperture HttpApi surface.",
    }),
  )
