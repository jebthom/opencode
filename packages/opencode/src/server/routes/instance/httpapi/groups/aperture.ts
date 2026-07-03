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
const LensSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  // "global" = built-in (architecture / git-changed / mtime), "project" = user-defined.
  scope: Schema.Literals(["global", "project"]),
  builtin: Schema.Boolean,
  active: Schema.Boolean,
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
  interaction: Schema.String.annotate({ description: "Interaction type id, e.g. lens.cycle / tile.drill / breadcrumb.nav" }),
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
          success: described(Schema.Array(LensSummary), "All available Lenses (built-in + user), with the active one marked"),
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
