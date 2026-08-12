import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { ApertureLensStore } from "@/aperture/lens-store"
import { ApertureLenses } from "@/aperture/lenses"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
  readonly aperture: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),

      // Lightweight awareness of the Aperture Lens system for the primary
      // build/plan agents, so they can use it as an occasional two-way visual
      // channel with the user. Gated by exact agent name: the hidden primaries
      // (compaction/title/summary) and the `lens` agent itself (which owns the
      // authoritative schema-design instructions) must not receive this.
      aperture: Effect.fn("SystemPrompt.aperture")(function* (agent: Agent.Info) {
        if (agent.name !== "build" && agent.name !== "plan") return

        const ctx = yield* InstanceState.context
        const all = yield* ApertureLensStore.list(ctx.directory)
        const active = yield* ApertureLensStore.getActive(ctx.directory)
        const others = all.filter((c) => c.id !== active.id).map((c) => c.name)
        // The Search Lenses and their concerns, injected rather than left to a lens_list round
        // trip — this is the vocabulary the agent has to paste into an Explore task prompt (see
        // DELEGATING EXPLORATION), and it is what stops it minting `retry-path-2` beside an
        // existing `retry-path`.
        const searchLenses = all.filter((c) => ApertureLenses.isSearch(c))
        const rosters = searchLenses.map((lens) => {
          const roster = ApertureLenses.concernRoster(lens)
          const free = ApertureLenses.MAX_FACETS - roster.length
          return (
            `Search Lens "${lens.name}" [${lens.id}] — ` +
            (roster.length
              ? roster
                  .map((c) => `${c.label} [${c.facet}] ${c.colorName} (${c.rules} rule${c.rules === 1 ? "" : "s"})`)
                  .join(", ")
              : "no concerns yet") +
            `. ${free} concern slot${free === 1 ? "" : "s"} free.`
          )
        })

        return [
          "<aperture>",
          "The Aperture view paints every file and directory in this repo by an active Lens",
          "(a small semantic vocabulary of facets). The user sees this view, so a Lens",
          "is a two-way visual channel between you and them.",
          `Active Lens: "${active.name}" — facets: ${active.facets.map((t) => t.label).join(", ")}.`,
          ...(others.length ? [`Other Lenses: ${others.join(", ")}.`] : []),
          ...rosters,
          "",
          "When the user EXPLICITLY drives the Lens — e.g. they ran /lens, they approved a schema",
          "the lens agent just proposed, or they asked you to create or switch to a specific",
          "Lens — just fulfill it directly and normally: call lens_create (which",
          "activates the new Lens and switches the view) or lens_select. Do NOT",
          "route an explicit user request through a subagent, and do NOT pass activate:false.",
          "",
          "PAINT AND EXPLORE IN PARALLEL. When a sensemaking question warrants a Lens (e.g.",
          '"what are the X features", "how does Y work", "which files touch Z"), call',
          "lens_create FIRST so the painter starts immediately, then proceed to explore the",
          "relevant files (grep/read, or a subagent) in the SAME turn — do not wait for the",
          "paint to finish. The Lens fills in asynchronously while you explore, so the user",
          "watches it colour the repo as your answer takes shape. lens_create returns at once",
          "(painting is backgrounded); treating it as a blocking step and exploring only",
          "afterwards is the anti-pattern to avoid.",
          "",
          "Separately, you may OPPORTUNISTICALLY introduce a Lens on your own initiative, and you",
          "should lean toward offering one whenever the repo's spatial layout would help the user",
          "see your answer — not only for the biggest questions. Defining one re-paints the repo and",
          "costs tokens, so keep it to at most one per feature or question and don't spam; a new Lens",
          "should still correspond to a real feature or concern worth mapping, not a trivial detail.",
          "Good moments (when the user has NOT already driven the Lens via /lens):",
          "- They ask how a feature works, where it lives, or which files/areas it touches —",
          "  a Lens answers it visually.",
          "- Your answer already amounts to mapping a feature or concern across several files.",
          "Prefer an existing Lens: if one above already fits, do not create a new one.",
          "Never switch the active Lens (lens_select) without asking the user first —",
          "switching changes what they are viewing.",
          "For this opportunistic path, delegate to the lens agent via the task tool (subagent_type",
          '"lens"). In the task prompt, describe the feature/question and state that this is a',
          "NON-INTERACTIVE subagent invocation: it should design AND create the Lens directly",
          "(no waiting for approval) with activate:false so the user's current view is undisturbed,",
          "then report the Lens name and facets. Afterwards tell the user the Lens exists",
          "and ask whether to switch to it (it paints once active).",
          "",
          "MARKING CONCERNS. A Lens paints whole files by judgement; lens_mark paints individual",
          'LINES by a query. Use it whenever you answer a "where do we do X?" question, so the',
          "answer survives as something the user can look at instead of scrolling away.",
          "- What is stored is the QUERY (a regex, or a declaration name), never line numbers. It is",
          "  re-run against the files on every read, so a deleted usage loses its paint and a new one",
          "  gains it with no intervention from you.",
          "- It costs no model call and repaints nothing. It is cheap in a way lens_create is not, so",
          '  the "at most one per question" restraint above does NOT apply to marking.',
          '- Name the CONCERN, never the search: "retry-path", "any-casts", "feature-flag-reads".',
          '  The name is what the user reads in the legend, so "hit" or "match" says nothing.',
          "- Check BOTH numbers it returns, and the samples. They catch different mistakes. A count of",
          "  hundreds where you expected a dozen means the query is too broad — narrow it with a glob",
          "  or a tighter pattern and mark again (past the cap a rule is stored but paints nothing).",
          "  READ THE SAMPLE LINES: a small, plausible count can still be entirely the wrong lines,",
          '  and a `pattern` rule matches comments and strings too. Searching for "as any" finds the',
          '  prose "has anything" and "has any descendant", which looks like a perfectly narrow 2-hit',
          "  result and is not a type assertion at all. If the samples are not what you meant, re-mark",
          "  with a pattern anchored to real syntax rather than accepting the count.",
          "- Several loosely-related concerns are EXPECTED to share one Search Lens: the user greys",
          "  out the ones they don't want by clicking the legend. So prefer adding a concern to an",
          "  existing Search Lens over creating another one, and reuse a concern id when a new rule",
          "  fits it.",
          "- Marks are invisible until that Lens is active. Do not pass activate:true unasked — say",
          "  which concerns now exist, with their hit counts and colours, and offer lens_select.",
          "",
          "DELEGATING EXPLORATION. Explore subagents have NO Lens tools, deliberately — they are",
          "read-only, and installing a rule is a persistent, committable write. They propose; you",
          'install. When you dispatch subagent_type "explore" for a where-is or how-does question,',
          "put in the task prompt (a) the concern ids from the Search Lens roster above, and (b) the",
          'sentence: "End your report with a PROPOSED MARKS section." Then call lens_mark for each',
          "proposal worth keeping, reusing a listed concern rather than minting a near-duplicate.",
          ...(agent.name === "build"
            ? [
                "",
                "BUILDING A FEATURE. When you are about to build a feature that spans several files",
                "or areas (especially one just planned/approved, where the plan proposed a Lens), sequence",
                "the work so the user watches the feature paint across the repo as you create it:",
                "1. Create the feature Lens FIRST with lens_create and activate it — its facets are",
                "   the feature's sub-areas/layers (e.g. UI, state, API, tests). If an approved plan",
                "   proposed a Lens schema, use that schema. This is the explicit/approved path:",
                "   create and activate directly — do NOT route through the lens subagent or pass",
                "   activate:false. lens_create returns each facet's hue.",
                "2. THEN write your task-tracking list (todowrite). Tag each item with the facet it",
                "   advances (by label, noting its hue) so the user can map tasks to the colours",
                "   appearing in the view as you work.",
                "3. THEN work the tasks, creating files under those facets so the view paints as you go.",
                "When you finish, summarize the build referencing the Lens: which facets the feature",
                "touched and how it spread across the repo.",
              ]
            : []),
          ...(agent.name === "plan"
            ? [
                "",
                "PLANNING A FEATURE. When your plan is for a feature that spans several files or areas, propose a Lens",
                'alongside it: in your final plan, add a short "Aperture Lens" section naming the Lens,',
                "its palette, and its 1–6 facets (the feature's sub-areas) each with a one-line",
                "definition. Do NOT create the Lens here — plan mode is read-only. The build agent will",
                "create it first so the user watches the feature paint as it is built.",
                'lens_mark is the exception, and planning is its best fit: "where does X happen today?" is',
                "most of what planning asks, and a mark costs no model call, repaints nothing and changes",
                "no code. Mark the concerns your plan depends on as you establish them, and reference them",
                "in the plan by name and colour so the reader can see them in the view.",
              ]
            : []),
          "</aperture>",
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
