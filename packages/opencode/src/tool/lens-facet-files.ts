import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import * as Tool from "./tool"

// Lists the files an Aperture Lens has painted with a given Facet (or set of
// Facets), grouped by Facet. This is the bridge from the high-altitude view to
// the code: once a Lens has coloured the repo, the agent can ask "which files
// carry <facet>?" and then read those files to answer questions about a
// component. Defaults to the active Lens and to every Facet when unspecified.

export const Parameters = Schema.Struct({
  facets: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Facet ids or labels to list files for (see lens_list for a Lens's facets). Omit to get every Facet in the Lens.",
  }),
  lens: Schema.optional(Schema.String).annotate({
    description: "Lens id or name to read (see lens_list). Omit to use the active Lens.",
  }),
})

export const LensFacetFilesTool = Tool.define(
  "lens_facet_files",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description:
        "List the files an Aperture Lens has painted with a given Facet (or Facets), grouped by Facet, so you can read those files to answer questions about a component. Defaults to the active Lens and all Facets.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const metadata: { lens?: string; counts: Record<string, number> } = { counts: {} }
          const result = yield* aperture.facetFiles(params.lens, params.facets ?? [])
          if (result.status === "not-found") {
            const all = yield* aperture.lenses()
            return {
              title: "Unknown Lens",
              metadata,
              output: [
                `No Lens matches "${params.lens}".`,
                "Available:",
                ...all.map((c) => `- ${c.name} [${c.id}]`),
              ].join("\n"),
            }
          }

          metadata.lens = result.lens.id
          const lines: string[] = []
          for (const group of result.groups) {
            metadata.counts[group.facet] = group.paths.length
            lines.push(`facet '${group.label}' [${group.facet}] (${group.paths.length} file${group.paths.length === 1 ? "" : "s"}):`)
            for (const path of group.paths) lines.push(`  - ${path}`)
            if (group.paths.length === 0) lines.push("  (none painted yet)")
          }
          if (result.unknownFacets.length)
            lines.push(`Unknown facet(s) ignored: ${result.unknownFacets.join(", ")}`)

          const total = result.groups.reduce((sum, g) => sum + g.paths.length, 0)
          return {
            title: `${total} file(s) across ${result.groups.length} facet(s) — ${result.lens.name}`,
            metadata,
            output: lines.length ? lines.join("\n") : "No files painted for the requested Facet(s) yet.",
          }
        }),
    }
  }),
)
