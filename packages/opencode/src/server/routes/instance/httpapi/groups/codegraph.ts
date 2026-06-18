import { CodeGraphPayload } from "@/codegraph/payload"
// Side-effect import: registers the codegraph.invalidated event in the EventV2
// registry before api.ts snapshots it into the SDK Event union.
import "@/codegraph/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/codegraph"

// Repo-relative directory the view is rooted at ("" / omitted = repo root).
// `refresh=true` recomputes that scope from disk instead of serving the cache —
// used by the TUI refresh control to pick up external edits / clear errors.
const CodeGraphQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.String),
  refresh: Schema.optional(Schema.Literals(["true", "false"])),
})

// Step the active tag collection one forward/back in the list, wrapping at the
// ends. Drives the top-bar ◀/▶ arrows; repaint rides the codegraph.invalidated
// event the switch publishes, so this just returns the newly-active collection.
const CycleCollectionQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  direction: Schema.Literals(["next", "prev"]),
})

// Delete a user-defined tag collection by id or name. Drives the top-bar ✕ control
// and the `/tag-delete` command — both deterministic, never routed through the agent.
// Built-in collections are immutable, so the result reports why a delete was refused.
const DeleteCollectionQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  collection: Schema.String,
})

// Outcome: "ok" with the now-active collection (Architecture when the deleted one was
// active), or a refusal ("not-found" / "builtin").
const DeleteCollectionResult = Schema.Struct({
  status: Schema.Literals(["ok", "not-found", "builtin"]),
  active: Schema.optional(CodeGraphPayload.CollectionInfo),
})

export const CodeGraphApi = HttpApi.make("codegraph")
  .add(
    HttpApiGroup.make("codegraph")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: CodeGraphQuery,
          success: described(CodeGraphPayload.Payload, "The deterministic code-graph payload"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codegraph.get",
            summary: "Get code graph",
            description: "Retrieve the deterministic code-graph payload for the active instance.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("cycleCollection", `${root}/collection/cycle`, {
          query: CycleCollectionQuery,
          success: described(CodeGraphPayload.CollectionInfo, "The newly-active tag collection"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codegraph.cycleCollection",
            summary: "Cycle active tag collection",
            description: "Switch the active code-graph tag collection to the next or previous one, wrapping at the ends.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.get("deleteCollection", `${root}/collection/delete`, {
          query: DeleteCollectionQuery,
          success: described(DeleteCollectionResult, "The outcome and the now-active tag collection"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codegraph.deleteCollection",
            summary: "Delete a tag collection",
            description: "Delete a user-defined code-graph tag collection by id or name. Built-in collections are immutable.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "codegraph",
          description: "Code graph routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode codegraph HttpApi",
      version: "0.0.1",
      description: "Code graph HttpApi surface.",
    }),
  )
