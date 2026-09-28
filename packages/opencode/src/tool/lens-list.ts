import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import { describeFinder } from "@/aperture/lenses"
import * as Tool from "./tool"
import { rosterLines } from "./lens-mark"

// Lists the project's Aperture Lenses, which one is active, and each Lens's concerns (with their
// owner) and rules (with their ids) — everything an agent needs before lens_mark / lens_unmark.

export const Parameters = Schema.Struct({})

export const LensListTool = Tool.define(
  "lens_list",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description: [
        "List the Aperture Lenses for this project and the active one. Each Lens shows its owner, its",
        "concerns (and whether each is the user's or yours) and its rules with their ids — check here",
        "before lens_mark so you add to an existing concern instead of installing a near-duplicate, and",
        "to get a rule id for lens_unmark.",
      ].join(" "),
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const all = yield* aperture.lenses()
          const active = yield* aperture.activeLens()
          const lenses = all.map((c) =>
            [
              `- ${c.name} [${c.id}] (${c.owner === "user" ? "the user's" : "yours"})${c.id === active?.id ? " (active)" : ""}: ${c.description}`,
              ...rosterLines(c).map((line) => "  " + line),
              ...(c.rules ?? []).map(
                (rule) =>
                  `    rule ${rule.id} → ${rule.facet}: ${describeFinder(rule.find, rule.where)}${rule.note ? ` — ${rule.note}` : ""}`,
              ),
            ].join("\n"),
          )
          return {
            title: `${all.length} Lens(es)`,
            metadata: { ...(active ? { active: active.id } : {}), count: all.length },
            output: all.length
              ? ["Lenses:", ...lenses, "", `Active Lens: ${active ? `${active.name} [${active.id}]` : "none"}`].join(
                  "\n",
                )
              : "No Lenses yet. lens_mark with a new Lens name creates one.",
          }
        }),
    }
  }),
)
