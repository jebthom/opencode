import { CodeGraphPayload } from "@/codegraph/payload"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/codegraph"

export const CodeGraphApi = HttpApi.make("codegraph")
  .add(
    HttpApiGroup.make("codegraph")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
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
