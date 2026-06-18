import { Effect, Schema } from "effect"
import { CodeGraph } from "@/codegraph/codegraph"
import * as Tool from "./tool"

// Switches the active code-graph tag collection by id or name. The view re-paints
// from the selected collection's own (cached) tag results — switching back to a
// previously-tagged collection is free (no tokens). Files not yet tagged for the
// selected collection are picked up by the foreground/background taggers.

export const Parameters = Schema.Struct({
  collection: Schema.String.annotate({
    description: "The id or name of the collection to activate (see tag_collection_list).",
  }),
})

export const TagCollectionSelectTool = Tool.define(
  "tag_collection_select",
  Effect.gen(function* () {
    const codegraph = yield* CodeGraph.Service

    return {
      description:
        "Switch the active code-graph tag collection by id or name. Re-paints from that collection's cached tags; switching back to a previously-tagged collection costs nothing.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const found = yield* codegraph.selectCollection(params.collection)
          if (!found) {
            const all = yield* codegraph.collections()
            return {
              title: "Unknown collection",
              metadata: {},
              output: [
                `No collection matches "${params.collection}".`,
                "Available:",
                ...all.map((c) => `- ${c.name} [${c.id}]`),
              ].join("\n"),
            }
          }
          return {
            title: `Active collection: ${found.name}`,
            metadata: {},
            output: `Switched the active collection to "${found.name}" (id: ${found.id}). The code graph will re-paint.`,
          }
        }),
    }
  }),
)
