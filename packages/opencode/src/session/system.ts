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

        return [
          "<aperture>",
          "The Aperture view paints every file and directory in this repo by an active Lens",
          "(a small semantic vocabulary of facets). The user sees this view, so a Lens",
          "is a two-way visual channel between you and them.",
          `Active Lens: "${active.name}" — facets: ${active.facets.map((t) => t.label).join(", ")}.`,
          ...(others.length ? [`Other Lenses: ${others.join(", ")}.`] : []),
          "",
          "When the user EXPLICITLY drives the Lens — e.g. they ran /lens, they approved a schema",
          "the lens agent just proposed, or they asked you to create or switch to a specific",
          "Lens — just fulfill it directly and normally: call lens_create (which",
          "activates the new Lens and switches the view) or lens_select. Do NOT",
          "route an explicit user request through a subagent, and do NOT pass activate:false.",
          "",
          "PAINT AND EXPLORE IN PARALLEL. When a sensemaking question warrants a Lens (e.g.",
          "\"what are the X features\", \"how does Y work\", \"which files touch Z\"), call",
          "lens_create FIRST so the painter starts immediately, then proceed to explore the",
          "relevant files (grep/read, or a subagent) in the SAME turn — do not wait for the",
          "paint to finish. The Lens fills in asynchronously while you explore, so the user",
          "watches it colour the repo as your answer takes shape. lens_create returns at once",
          "(painting is backgrounded); treating it as a blocking step and exploring only",
          "afterwards is the anti-pattern to avoid.",
          "",
          "Separately, you may OPPORTUNISTICALLY introduce a Lens on your own initiative — but",
          "SPARINGLY, since defining one re-paints the repo and costs tokens. Never spam new",
          "Lenses (at most one per feature or question). Consider it only when:",
          "- You are about to build or plan a LARGE multi-file feature: a feature-spread Lens",
          "  lets the user watch the feature paint across the codebase as you create the files.",
          "- The user asks a spatial/spread question (\"which files touch X\", \"how far does Y reach\")",
          "  and has NOT used /lens — a Lens answers it visually.",
          "Prefer an existing Lens: if one above already fits, do not create a new one.",
          "Never switch the active Lens (lens_select) without asking the user first —",
          "switching changes what they are viewing.",
          "For this opportunistic path, delegate to the lens agent via the task tool (subagent_type",
          "\"lens\"). In the task prompt, describe the feature/question and state that this is a",
          "NON-INTERACTIVE subagent invocation: it should design AND create the Lens directly",
          "(no waiting for approval) with activate:false so the user's current view is undisturbed,",
          "then report the Lens name and facets. Afterwards tell the user the Lens exists",
          "and ask whether to switch to it (it paints once active).",
          "</aperture>",
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
