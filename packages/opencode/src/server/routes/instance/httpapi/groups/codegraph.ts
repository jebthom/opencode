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
