import { AperturePayload } from "@/aperture/payload"
// Side-effect import: registers the aperture.invalidated event in the EventV2
// registry before api.ts snapshots it into the SDK Event union.
import "@/aperture/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/aperture"

// Repo-relative directory the view is rooted at ("" / omitted = repo root).
// `refresh=true` recomputes that scope from disk instead of serving the cache —
// used by the TUI refresh control to pick up external edits / clear errors.
const ApertureQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.String),
  refresh: Schema.optional(Schema.Literals(["true", "false"])),
  // Drill into a file (A5): a repo-relative file path. When present the payload also
  // carries `extents` (the file's function-level tiles) and a drill-in paint pass is
  // scheduled at top priority. Rides the same endpoint so the TUI keeps one fetch path.
  drill: Schema.optional(Schema.String),
})

// Step the active Lens one forward/back in the list, wrapping at the
// ends. Drives the top-bar ◀/▶ arrows; repaint rides the aperture.invalidated
// event the switch publishes, so this just returns the newly-active Lens.
const CycleLensQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  direction: Schema.Literals(["next", "prev"]),
})

// Delete a user-defined Lens by id or name. Drives the top-bar ✕ control
// and the `/lens-delete` command — both deterministic, never routed through the agent.
// Built-in Lenses are immutable, so the result reports why a delete was refused.
const DeleteLensQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  lens: Schema.String,
})

// Outcome: "ok" with the now-active Lens (Architecture when the deleted one was
// active), or a refusal ("not-found" / "builtin").
const DeleteLensResult = Schema.Struct({
  status: Schema.Literals(["ok", "not-found", "builtin"]),
  active: Schema.optional(AperturePayload.LensInfo),
})

// One row in the Lens picker (A2): enough to list, group, and mark the active Lens.
// Rows arrive in DFS-forest order — each Lens immediately followed by the drill-downs
// scoped to it — so the picker renders the hierarchy by indenting on `depth` alone.
const LensSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  // "global" = built-in (architecture / git-changed / mtime), "project" = user-defined.
  scope: Schema.Literals(["global", "project"]),
  builtin: Schema.Boolean,
  active: Schema.Boolean,
  // Set on a drill-down: the id of the Lens whose facets define its domain.
  parent: Schema.optional(Schema.String),
  // Nesting depth (0 = root). Drives the picker's indent.
  depth: Schema.Number,
  // The scope of the ROOT ancestor, not this Lens's own. The picker groups on it, so a
  // project drill-down of a built-in parent stays adjacent to that parent instead of being
  // torn into the "Project" section and rendered indented under nothing.
  rootScope: Schema.Literals(["global", "project"]),
})

// Whole-repo file → facet mix under the active Lens (O2). The bulk counterpart to the
// per-file `drill` the editor gutter uses: the VSCode Explorer decorates every row of the
// file tree, so it needs one fetch that answers for the whole repo.
//
// Each file's *whole* mix ships rather than a pre-reduced dominant facet — a client
// filtering to one facet needs that facet's share, not the file's plurality winner. `f`
// indexes into `facets`; `p` is an integer percent of the file's attributed bytes,
// descending. Files with nothing painted are omitted.
//
// `t` is the attributed byte total those percentages divide. Percentages alone cannot be
// rolled up — a client aggregating a directory from its files would weight every file
// equally and disagree with the byte-weighted directory treemap — so `t` is what lets the
// VSCode tree's folder chips reproduce `attributeFileBytes` exactly.
const FacetMapResult = Schema.Struct({
  lens: AperturePayload.LensInfo,
  // Facet ids in legend order, with the "Other" facet appended (it is a real stored value
  // but never a Lens facet, so it needs an index without polluting the legend).
  facets: Schema.Array(Schema.String),
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ t: Schema.Int, w: Schema.Array(Schema.Struct({ f: Schema.Int, p: Schema.Int })) }),
  ),
  // Facets currently toggled off in the legend (O4). Carried here as well as on the
  // aperture.facets.filtered event so a client that reconnects — or connects after the
  // filter was set — recovers it from an ordinary refresh instead of painting unfiltered.
  suppressed: Schema.Array(Schema.String),
})

// Per-turn agent activity for a session, facet-resolved under the active Lens (G1). Feeds
// the sidebar Activity View: a turn renders as blocks coloured by what the agent was
// working on, so a user can see at a glance whether it visited the concerns they expected.
//
// Derived from the durable message store on every read, never recorded — which is what
// makes a Lens switch recolour history for free: `turns` comes back byte-identical and only
// `facets`/`files` move. The facet half is shaped exactly like FacetMapResult (same
// vocabulary, same `{t, w:[{f,p}]}` weights, same `suppressed`) so the Activity View, the
// Explorer pip and the directory treemap are three renderings of one attribution.
const ActivityQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.String,
  // How many of the most recent turns to report. Clamped server-side.
  turns: Schema.optional(Schema.NumberFromString),
})

// One file touch. `depth` is 0 for the viewed session and 1 for a sub-agent it spawned —
// sub-agent work lives in its own session, and the sidebar is hidden outright inside those,
// so the parent's view is the only place it can ever be seen.
const ActivityEntrySchema = Schema.Struct({
  path: Schema.String,
  action: Schema.Literals(["read", "create", "edit"]),
  agent: Schema.String,
  sessionID: Schema.String,
  depth: Schema.Int,
  callID: Schema.String,
  timestamp: Schema.Number,
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
  lens: AperturePayload.LensInfo,
  facets: Schema.Array(Schema.String),
  turns: Schema.Array(ActivityTurnSchema),
  // Facet mix per *touched* path only, deduped across turns — the same shape as
  // FacetMapResult.files, scoped to what the turns actually reference.
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ t: Schema.Int, w: Schema.Array(Schema.Struct({ f: Schema.Int, p: Schema.Int })) }),
  ),
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

// Re-root the Aperture view at a directory (the reciprocal of tui.directory.reveal). Posted
// by a host surface — the VSCode extension's file tree, when the user expands a folder — and
// published as aperture.scope.focused for the TUI's top bar to adopt. Purely a navigation
// intent: nothing is computed or stored, so an unknown path costs a repaint at most.
export const ScopeFocusInput = Schema.Struct({
  scope: Schema.String.annotate({
    description: "Repo-relative directory to re-root the view at; empty clears to the repo root",
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
  status: Schema.Literals(["ok", "not-found"]),
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
        HttpApiEndpoint.get("get", root, {
          query: ApertureQuery,
          success: described(AperturePayload.Payload, "The deterministic Aperture payload"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.get",
            summary: "Get Aperture view",
            description: "Retrieve the deterministic Aperture payload for the active instance.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("facetMap", `${root}/facets`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields }),
          success: described(FacetMapResult, "Every painted file in the repo with its facet mix"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.facetMap",
            summary: "Get the whole-repo facet map",
            description:
              "Every painted source file in the repo with its facet mix under the active Lens, for bulk file-tree decoration.",
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
              "Per-turn agent read/edit/write activity for a session, with the facet of each touched file under the active Lens. Derived from the message store on read, so switching Lens recolours history without re-recording it.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("cycleLens", `${root}/lens/cycle`, {
          query: CycleLensQuery,
          success: described(AperturePayload.LensInfo, "The newly-active Lens"),
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
            description: "Delete a user-defined Aperture Lens by id or name. Built-in Lenses are immutable.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("listLenses", `${root}/lens/list`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields }),
          success: described(
            Schema.Array(LensSummary),
            "All available Lenses (built-in + user), with the active one marked",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.listLenses",
            summary: "List Lenses",
            description: "List every available Aperture Lens (built-in + user-defined) for the searchable Lens picker.",
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
            description: "Activate an Aperture Lens by id or name; the view re-paints from its cached facets.",
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
        HttpApiEndpoint.post("focusScope", `${root}/scope`, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields }),
          payload: ScopeFocusInput,
          success: described(Schema.Boolean, "Scope focus intent published"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "aperture.focusScope",
            summary: "Re-root the Aperture view",
            description:
              "Publish an intent for the Aperture view (the TUI top bar) to re-root at a directory — the reciprocal of the top bar revealing a directory in the host editor's file tree.",
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
