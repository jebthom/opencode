import { Effect, Schema } from "effect"
import { CodeGraph } from "@/codegraph/codegraph"
import { CodeGraphCollectionStore } from "@/codegraph/collection-store"
import * as Tool from "./tool"

// Lists the code-graph tag collections available in this project (the global
// built-ins plus any the user has defined) and which one is active, along with the
// predefined colour palettes. The `/tag` flow uses this to let the user pick an
// existing collection or to inform a new schema proposal.

export const Parameters = Schema.Struct({})

export const TagCollectionListTool = Tool.define(
  "tag_collection_list",
  Effect.gen(function* () {
    const codegraph = yield* CodeGraph.Service

    return {
      description:
        "List the code-graph tag collections for this project (built-in + user-defined), the active one, and the available colour palettes.",
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const all = yield* codegraph.collections()
          const active = yield* codegraph.activeCollection()
          const palettes = CodeGraphCollectionStore.paletteSummary()

          const collections = all.map((c) => {
            const marker = c.id === active.id ? " (active)" : ""
            const tags = c.tags.map((t) => t.label).join(", ")
            return `- ${c.name} [${c.id}] (${c.scope})${marker}: ${c.description}\n    tags: ${tags}`
          })

          return {
            title: `${all.length} collection(s)`,
            metadata: { active: active.id, count: all.length },
            output: [
              "Tag collections:",
              ...collections,
              "",
              `Active collection: ${active.name} [${active.id}]`,
              "",
              "Palettes (each categorical, ~6 colours):",
              ...palettes.map((p) => `- ${p.id}: ${p.label} (${p.swatches} colours)`),
            ].join("\n"),
          }
        }),
    }
  }),
)
