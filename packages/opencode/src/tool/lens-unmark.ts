import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import { MAX_FACETS } from "@/aperture/lenses"
import * as StudyLog from "@/aperture/study-log"
import * as Tool from "./tool"
import { rosterLines } from "./lens-mark"

// Remove a search rule, or a whole concern, from an Aperture Lens (S2) — the counterpart to
// lens_mark. Deterministic and free, like every rule operation: nothing was ever painted by a
// model, so nothing has to be re-painted.
//
// Note that *hiding* a concern is a different thing and needs no tool: clicking its legend
// entry greys it out non-destructively, which is what makes several unrelated concerns on one
// Lens workable. Unmark is for a rule that is actually wrong (or too broad to paint).

export const Parameters = Schema.Struct({
  lens: Schema.String.annotate({
    description: "Id or name of the Lens to remove from (see lens_list).",
  }),
  rule: Schema.optional(Schema.String).annotate({
    description: "Rule id to remove — lens_mark returns it, and lens_list shows a Lens's rules.",
  }),
  facet: Schema.optional(Schema.String).annotate({
    description: [
      "Concern to remove ENTIRELY, with every rule pointing at it (id or label).",
      `Use this to free a slot when the Lens is at the ${MAX_FACETS}-concern cap.`,
    ].join(" "),
  }),
})

export const LensUnmarkTool = Tool.define(
  "lens_unmark",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description: [
        "Remove a search rule from an Aperture Lens by rule id, or remove a whole concern along with",
        "every rule pointing at it. Instant and free — nothing has to be re-painted. Use it for a rule",
        "that matched the wrong thing or is too broad to paint, or to free a concern slot. To merely",
        "hide a concern, don't remove it: the user can grey it out by clicking its legend entry.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // One metadata shape across every return, as lens_facet_files does.
          const metadata: { lens?: string; removed?: number; facet?: string } = {}
          // Exactly one target. Both or neither is a genuine ambiguity about what to delete, and
          // guessing at a destructive operation is the wrong default.
          if (!params.rule === !params.facet)
            return {
              title: "Nothing specified",
              metadata,
              output: "Pass exactly one of `rule` (a rule id) or `facet` (a concern and all its rules).",
            }

          const result = yield* aperture.unmarkLens({
            lens: params.lens,
            ...(params.rule ? { rule: params.rule } : {}),
            ...(params.facet ? { facet: params.facet } : {}),
          })

          switch (result.status) {
            case "not-found":
              return {
                title: "Unknown Lens",
                metadata,
                output: `No Lens matches "${params.lens}". Run lens_list to see the options.`,
              }
            case "builtin":
              return {
                title: "Built-in Lens",
                metadata,
                output: `"${params.lens}" is a built-in Lens and carries no rules.`,
              }
            case "unknown-rule":
              return {
                title: "Unknown rule",
                metadata,
                output: [
                  `"${params.rule}" isn't a rule on "${result.lens.name}".`,
                  ...rosterLines(result.lens),
                  "",
                  "Run lens_list to see the Lens's rules.",
                ].join("\n"),
              }
            case "unknown-facet":
              return {
                title: "Unknown concern",
                metadata,
                output: [
                  `"${params.facet}" isn't a concern on "${result.lens.name}".`,
                  ...rosterLines(result.lens),
                ].join("\n"),
              }
            case "ok": {
              const { lens, removedRules, removedFacet, recolored } = result
              yield* StudyLog.record(ctx.sessionID, {
                type: "rule",
                op: removedFacet ? "removed-facet" : "removed",
                agent: ctx.agent,
                lens: lens.id,
                ...(removedFacet ? { facet: removedFacet.id } : {}),
                rules: removedRules.map((r) => r.id),
              })
              return {
                title: removedFacet ? `Removed ${removedFacet.label}` : "Removed rule",
                metadata: Object.assign(metadata, {
                  lens: lens.id,
                  removed: removedRules.length,
                  ...(removedFacet ? { facet: removedFacet.id } : {}),
                }),
                output: [
                  removedFacet
                    ? `Removed the concern "${removedFacet.label}" [${removedFacet.id}] and its ${removedRules.length} rule${removedRules.length === 1 ? "" : "s"} from "${lens.name}".`
                    : `Removed rule ${removedRules[0]?.id} from "${lens.name}".`,
                  ...(result.written
                    ? []
                    : [
                        "",
                        "WARNING: the write to .opencode/aperture/lenses.json failed, so this removal may not persist.",
                      ]),
                  // The recolour has to be said out loud: the user is looking at the legend, and a
                  // concern silently changing hue is exactly the colour-instability the rest of
                  // Aperture works to avoid. It happens because facet colour is derived from
                  // position, so removing anything but the last concern shifts the ones after it.
                  ...(recolored.length
                    ? [
                        "",
                        "Because a concern's colour comes from its position, this re-coloured:",
                        ...recolored.map((r) => `  - ${r.label} [${r.facet}] ${r.from} -> ${r.to}`),
                        "Any legend filter the user had set is keyed by id and is unaffected.",
                      ]
                    : []),
                  "",
                  `Concerns on "${lens.name}":`,
                  ...rosterLines(lens),
                ].join("\n"),
              }
            }
          }
        }),
    }
  }),
)
