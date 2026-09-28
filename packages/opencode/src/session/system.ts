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
import { ApertureLensHistory } from "@/aperture/lens-history"
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
  // The live Aperture state — Lenses, their concerns and owners, the latest changes — injected
  // once per user turn as a reminder rather than into the system prompt, so the system prompt
  // stays byte-stable (and cacheable) while the agent curates.
  readonly apertureState: (agent: Agent.Info) => Effect.Effect<string | undefined>
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

      // How the build/plan agents use Aperture. Static on purpose: the live state (which Lenses
      // exist, whose they are) arrives per turn through `apertureState`, so curating the view
      // mid-turn never changes the system prompt. Gated by exact agent name: the hidden
      // primaries (compaction/title/summary) and subagents must not receive this.
      aperture: Effect.fn("SystemPrompt.aperture")(function* (agent: Agent.Info) {
        if (agent.name !== "build" && agent.name !== "plan") return
        return [
          "<aperture>",
          "The Aperture view shows the user WHERE things are in this repo. A Lens is a named set of up",
          `to ${ApertureLenses.MAX_FACETS} concerns (facets); each concern marks the exact LINES matched by deterministic`,
          "rules — a regex, a declaration name, or a git diff, optionally narrowed by git history (changed",
          "in a ref, by an author, since a date). The top bar groups the marked files by which concerns",
          "they carry; the editor gutter paints the marked lines. Nothing is inferred: every mark comes",
          "from a query the user can check, and it is re-run on every read, so it follows the code.",
          "The current Lenses arrive in an <aperture-state> reminder with each user message.",
          "",
          "CURATING THE VIEW. Keeping the view useful is part of your job. Keep one Lens of your own for",
          "the current task (lens_mark with a new Lens name creates it, named after the task) and curate",
          "its concerns as the work moves:",
          "- Once you know which code is at issue, mark the 2-4 concerns the user most needs to see: the",
          "  code you are about to change, the call sites it affects, the tests that cover it.",
          "- At milestones — a todo completed, a feature landed, a plan finalised — update it: mark what",
          "  became relevant, and lens_unmark your concerns that no longer help. A stale concern is noise.",
          '- After changing code, prefer marks that let the user VERIFY the change: kind "diff" (every line',
          '  you changed), or a pattern narrowed with changed:"HEAD" ("every call to x() this change',
          '  touched"). Use author/since when the question is about who or when.',
          "- Always pass `reason`. Every change is recorded in a Lens history the user reviews, tied to",
          "  the turn that made it.",
          "- Switch the view to your Lens (activate:true, or lens_select) when the active Lens is also",
          "  yours or there is none. Never switch away from the user's own Lens unasked.",
          '- Concerns marked "the user\'s" belong to the user. Never change or remove them on your own',
          "  initiative; if one really must change, the tool asks the user first.",
          "- Don't curate for trivia: a one-line question needs no concern, and a turn needs few changes.",
          "",
          "WHEN THE USER ASKS for a mark, a Lens or a switch, do it directly and pass requestedByUser:true —",
          "it is then theirs.",
          "",
          "MARKING WELL.",
          '- Name the CONCERN, never the search: "retry-path", "any-casts", "feature-flag-reads". The name',
          '  is what the user reads in the legend, so "hit" or "match" says nothing.',
          "- Check the count AND read the samples lens_mark returns. A count of hundreds where you expected",
          "  a dozen means the query is too broad — narrow it with a glob or a tighter pattern (past the cap",
          "  a rule is stored but paints nothing). A small, plausible count can still be the wrong lines: a",
          '  `pattern` rule matches comments and strings too ("as any" finds the prose "has anything").',
          "  If the samples are not what you meant, re-mark with a pattern anchored to real syntax.",
          "- Prefer adding a rule to an existing concern, and a concern to an existing Lens of yours, over",
          "  minting near-duplicates. The user greys out concerns they don't want from the legend.",
          "",
          "DELEGATING EXPLORATION. Explore subagents have NO Lens tools — they propose, you install. When",
          'you dispatch subagent_type "explore" for a where-is or how-does question, put in the task prompt',
          '(a) the concern ids of your current Lens, and (b) the sentence: "End your report with a PROPOSED',
          'MARKS section." Then call lens_mark for each proposal worth keeping.',
          ...(agent.name === "plan"
            ? [
                "",
                'PLANNING. Marking fits planning well: "where does X happen today?" is most of what planning',
                "asks, and a mark changes no code. Mark the concerns your plan depends on as you establish",
                "them, and reference them in the plan by name and colour so the reader can see them.",
              ]
            : []),
          "</aperture>",
        ].join("\n")
      }),

      apertureState: Effect.fn("SystemPrompt.apertureState")(function* (agent: Agent.Info) {
        if (agent.name !== "build" && agent.name !== "plan") return
        const ctx = yield* InstanceState.context
        const all = yield* ApertureLensStore.list(ctx.directory)
        const active = yield* ApertureLensStore.getActive(ctx.directory)
        const recent = yield* ApertureLensHistory.read(ctx.directory, { limit: 5 })
        const lenses = all.map((lens) => {
          const roster = ApertureLenses.concernRoster(lens)
          const free = ApertureLenses.MAX_FACETS - roster.length
          const concerns = roster.length
            ? roster
                .map(
                  (c) =>
                    `${c.label} [${c.facet}] ${c.colorName}, ${c.rules} rule${c.rules === 1 ? "" : "s"}` +
                    (c.owner === "user" ? ", the user's" : ""),
                )
                .join("; ")
            : "no concerns"
          return (
            `- "${lens.name}" [${lens.id}] (${lens.owner === "user" ? "the user's" : "yours"})` +
            `${lens.id === active?.id ? " ACTIVE" : ""}: ${concerns}. ${free} slot${free === 1 ? "" : "s"} free.`
          )
        })
        return [
          "<aperture-state>",
          ...(lenses.length ? ["Lenses:", ...lenses] : ["No Lenses yet."]),
          ...(recent.length
            ? [
                "Latest Lens changes:",
                ...recent.map(
                  (e) =>
                    `- ${e.op} on "${e.lens.name}"${e.facet ? ` (${e.facet})` : ""} by ` +
                    `${e.actor.kind === "user" ? "the user" : (e.actor.agent ?? "an agent")}` +
                    `${e.actor.reason ? ` — ${e.actor.reason}` : ""}`,
                ),
              ]
            : []),
          "</aperture-state>",
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
