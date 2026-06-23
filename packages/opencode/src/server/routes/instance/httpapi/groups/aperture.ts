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
