import { Context, Effect, Layer } from "effect"
import { statSync } from "fs"
import path from "path"

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
import { ApertureLenses, type Lens } from "@/aperture/lenses"
import { ApertureRules } from "@/aperture/rules"
import { ApertureGitLookup } from "@/aperture/git-lookup"
import { ApertureFiles } from "@/aperture/files"
import { Git } from "@/git"

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
  readonly apertureState: (agent: Agent.Info, turnID: string) => Effect.Effect<string | undefined>
  readonly apertureCheck: (agent: Agent.Info, turnID: string) => Effect.Effect<string | undefined>
  readonly apertureNudge: (
    agent: Agent.Info,
    input: {
      readonly turnID: string
      readonly todos: ReadonlyArray<{ readonly content: string; readonly status: string }>
      readonly edits: ReadonlyArray<{ readonly file: string; readonly at: number }>
    },
  ) => Effect.Effect<{ readonly key: string; readonly text: string } | undefined>
}

// Changed files scanned for stray matches, and stray matches (one per concern and file) listed at once. A bulk
// change (a codemod, a vendored directory) must not turn every step into a repo-wide search.
const STRAY_MAX_FILES = 200
const STRAY_MAX_LISTED = 5
// Line runs shown per stray before eliding; the agent reads the file for the rest.
const STRAY_MAX_RUNS = 4

// The agent's concerns on `lens` whose why may no longer hold: never given, or last set before the
// most recent milestone (a completed todo is when a task moves from understanding to changing to
// verifying, which is exactly when a why goes stale). The user's concerns are left out — rewriting
// those would only raise consent prompts for something the agent was never asked to keep current.
function staleWhys(lens: Lens, entries: ReadonlyArray<ApertureLensHistory.Entry>) {
  const milestone = entries.findLast((e) => e.op === "milestone")?.seq ?? -1
  return lens.facets
    .filter((facet) => facet.owner === "agent")
    .flatMap((facet) => {
      if (!facet.why) return [{ facet, flag: "MISSING" }]
      const set = entries.findLast(
        (e) =>
          e.facet === facet.id &&
          (e.op === "facet.add" || (e.op === "facet.edit" && (!e.fields || e.fields.includes("why")))),
      )
      return (set?.seq ?? -1) < milestone ? [{ facet, flag: "STALE: set before the last completed todo" }] : []
    })
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const git = yield* Git.Service

    // What each directory's current turn has already shown the agent, so a stray is listed once per
    // turn (in the turn-start state, or a nudge when it appears mid-turn) rather than every step.
    // Nothing carries across turns on purpose: a stray stays outstanding until a rule settles it.
    const shown = new Map<string, { readonly turn: string; readonly keys: Set<string> }>()
    const shownIn = (directory: string, turn: string) => {
      const current = shown.get(directory)
      if (current?.turn === turn) return current.keys
      const keys = new Set<string>()
      shown.set(directory, { turn, keys })
      return keys
    }
    // Keyed with the line count, so more of the same code appearing in a file is new.
    const strayKey = (lens: Lens, stray: ApertureRules.Stray) =>
      [lens.id, stray.facet, stray.file, stray.ranges.reduce((n, [a, b]) => n + b - a + 1, 0)].join("\0")
    const strayCache = new Map<string, { readonly key: string; readonly found: ApertureRules.Stray[] }>()

    // Matches of the active Lens's rules, in changed files, that the rules' scopes leave out.
    // "Changed" is everything git reports against HEAD, untracked files included, so a file the
    // user or a shell command created counts as much as one the agent edited; `edited` adds the
    // agent's own edits for a directory that is not a git repo.
    const strays = (directory: string, edited: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const lens = yield* ApertureLensStore.getActive(directory)
        if (!lens?.rules?.length) return undefined
        const repo = yield* git.isRepo(directory)
        const changed = repo ? yield* changedFiles(directory) : []
        // Source files only, as everywhere else in Aperture: logs, lockfiles and Aperture's own state
        // (which quotes every rule's pattern verbatim) would otherwise always match.
        const files = [...new Set([...edited, ...changed])]
          .filter(ApertureFiles.isSourcePath)
          .flatMap((file) => {
            const stat = statSync(path.join(directory, file), { throwIfNoEntry: false })
            return stat?.isFile() ? [{ file, stamp: `${stat.mtimeMs}:${stat.size}` }] : []
          })
          .slice(0, STRAY_MAX_FILES)
        // This runs on every step, and most steps change nothing, so the search is skipped while
        // the rules and every candidate file are as they were last time.
        const key = [ApertureRules.rulesHash(lens.rules), ...files.map((f) => `${f.file}@${f.stamp}`)].join("\n")
        const cached = strayCache.get(directory)
        const found =
          cached?.key === key
            ? cached.found
            : yield* ApertureRules.strays(
                directory,
                lens.rules,
                files.map((f) => f.file),
                repo ? ApertureGitLookup.make(git, directory) : undefined,
              )
        strayCache.set(directory, { key, found })
        return found.length ? { lens, strays: found } : undefined
      })

    // Files changed against HEAD, plus untracked ones, relative to `directory`. Deleted files are
    // dropped by the stat in `strays`.
    const changedFiles = (directory: string) =>
      Effect.gen(function* () {
        const diff = yield* git.run(["diff", "--name-only", "--relative", "HEAD", "--"], { cwd: directory })
        const untracked = yield* git.run(["ls-files", "--others", "--exclude-standard"], { cwd: directory })
        return [diff, untracked].flatMap((result) =>
          result.exitCode === 0
            ? result
                .text()
                .split("\n")
                .flatMap((line) => (line.trim() ? [line.trim()] : []))
            : [],
        )
      })

    // The strays as a short list for the agent, and recorded as shown this turn. Capped, and terse
    // on purpose: it is repeated every turn until settled, so each line has to earn its context.
    const strayList = (
      directory: string,
      turn: string,
      found: { readonly lens: Lens; readonly strays: ReadonlyArray<ApertureRules.Stray> },
    ) => {
      const keys = shownIn(directory, turn)
      for (const stray of found.strays) keys.add(strayKey(found.lens, stray))
      const listed = found.strays.slice(0, STRAY_MAX_LISTED)
      const rest = found.strays.slice(STRAY_MAX_LISTED)
      return [
        ...listed.map((stray) => {
          const owner =
            found.lens.facets.find((f) => f.id === stray.facet)?.owner === "user" ? " (the user's: ask first)" : ""
          const runs = stray.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
          const at = runs.slice(0, STRAY_MAX_RUNS).join(", ") + (runs.length > STRAY_MAX_RUNS ? ", …" : "")
          return `- ■ ${stray.facet}${owner}: ${stray.file} at ${at} (rule ${stray.rules.join(", ")})`
        }),
        ...(rest.length ? [`- …and ${rest.length} more in ${new Set(rest.map((s) => s.file)).size} file(s)`] : []),
        "Settle each with Lens calls: lines that belong → widen the rule's glob/path, or add a rule with a note;",
        "lines that don't → add \"!<file>\" to the rule's glob. To revise a rule, lens_mark the new one, then lens_unmark the old.",
      ]
    }

    const apertureState = Effect.fn("SystemPrompt.apertureState")(function* (agent: Agent.Info, turnID: string) {
      if (agent.name !== "build" && agent.name !== "plan") return
      const ctx = yield* InstanceState.context
      const unmarked = yield* strays(ctx.directory, [])
      const all = yield* ApertureLensStore.list(ctx.directory)
      const active = yield* ApertureLensStore.getActive(ctx.directory)
      const recent = yield* ApertureLensHistory.read(ctx.directory, { limit: 5 })
      const stale = active ? staleWhys(active, yield* ApertureLensHistory.read(ctx.directory, { lens: active.id })) : []
      // The active Lens in full (each concern's what and why, staleness flagged), the rest compactly:
      // enough to reuse a concern instead of minting a near-duplicate.
      const lenses = all.flatMap((lens) => {
        const roster = ApertureLenses.concernRoster(lens)
        const free = ApertureLenses.MAX_FACETS - roster.length
        const head =
          `- "${lens.name}" [${lens.id}] (${lens.owner === "user" ? "the user's" : "yours"})` +
          `${lens.id === active?.id ? " ACTIVE" : ""}: ${roster.length ? "" : "no concerns. "}${free} slot${free === 1 ? "" : "s"} free.`
        const name = (c: ApertureLenses.ConcernSummary) =>
          `■ ${c.facet} (${c.label}) ${c.colorName}, ${c.rules} rule${c.rules === 1 ? "" : "s"}` +
          (c.owner === "user" ? ", the user's" : "")
        if (lens.id !== active?.id) return [head, ...roster.map((c) => `  ${name(c)} — ${c.what || "(no what)"}`)]
        return [
          head,
          ...roster.flatMap((c) => {
            const flag = stale.find((s) => s.facet.id === c.facet)?.flag
            return [
              `  ${name(c)}`,
              `    what: ${c.what || "(none)"}`,
              `    why:  ${c.why || "(none)"}${flag ? `  [${flag}]` : ""}`,
            ]
          }),
        ]
      })
      return [
        "<aperture-state>",
        ...(lenses.length ? ["Lenses:", ...lenses] : ["No Lenses yet."]),
        ...(stale.length
          ? [
              "Whys marked STALE or MISSING may no longer say why to look at those lines. If this Lens still serves",
              "the message, rewrite them with lens_edit at your next checkpoint; keep each what.",
            ]
          : []),
        // Re-listed every turn until a rule settles them: an unmarked match reads to the user as
        // "the code isn't here", which is the one thing the view must never say wrongly.
        ...(unmarked
          ? [
              "Unmarked matches — changed files with lines a rule matches outside its glob/path, so the view shows them unmarked:",
              ...strayList(ctx.directory, turnID, unmarked),
            ]
          : []),
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
        // The standing rule (a relevant Lens is always active) is stated in the system prompt, but
        // restating it next to the user's message is what makes agents act on it for questions.
        !active
          ? "No Lens is active. If this message is about code in this repo, mark it on a Lens of yours and activate it once grounded: before your first edit or explanation."
          : active.owner === "user"
            ? `The user's Lens "${active.name}" is active; don't switch away from it. Mark on your own Lens without activating it.`
            : `Your Lens "${active.name}" is active. If this message starts a new task or part, give it its own Lens once grounded, before your first edit or explanation; if it continues this one, change the Lens only at a checkpoint.`,
        "</aperture-state>",
      ].join("\n")
    })

    // The mandatory end-of-turn check. The view is part of the answer, and prompting alone can't
    // guarantee a model keeps it current, so a build/plan turn that recorded no Lens change, or
    // left no Lens active, gets one curation step before control returns to the user. Returns
    // undefined when the turn passes, otherwise the reminder that drives the curation step.
    const apertureCheck = Effect.fn("SystemPrompt.apertureCheck")(function* (agent: Agent.Info, turnID: string) {
      if (agent.name !== "build" && agent.name !== "plan") return
      const ctx = yield* InstanceState.context
      const entries = yield* ApertureLensHistory.read(ctx.directory, { turnID })
      const change = entries.findLast((e) => e.op !== "milestone")
      // A turn that curated early and then finished more todos still owes the view an update.
      const stale = entries.findLast((e) => e.op === "milestone" && e.seq > (change?.seq ?? -1))
      const active = yield* ApertureLensStore.getActive(ctx.directory)
      // Strays the agent has already been shown this turn don't earn a curation step of their own —
      // that would spend a model call every turn on a choice the agent has already seen. Only ones
      // that appeared too late for a nudge (the last step's edits) do.
      const unmarked = yield* strays(ctx.directory, [])
      const seen = shownIn(ctx.directory, turnID)
      const unseen = unmarked?.strays.some((stray) => !seen.has(strayKey(unmarked.lens, stray))) ?? false
      if (change && !stale && active && !unseen) return
      const whys = active ? staleWhys(active, yield* ApertureLensHistory.read(ctx.directory, { lens: active.id })) : []
      // The state block below re-lists the strays, so the reminder only points at them.
      const state = (yield* apertureState(agent, turnID)) ?? ""
      if (change && !stale && active)
        return [
          state,
          "<system-reminder>",
          'APERTURE CHECK: files changed this turn hold unmarked matches, listed above under "Unmarked matches".',
          "Settle them now with Lens calls; do NOT edit files or continue the task.",
          "End with ONE line for the user: what changed in the view, or `View unchanged: <why>`.",
          "</system-reminder>",
        ].join("\n")
      const why = !change
        ? "without any change to the Lens view"
        : stale
          ? `without a Lens change since you completed "${stale.milestone?.todo}"`
          : "with no Lens active"
      return [
        state,
        "<system-reminder>",
        `APERTURE CHECK: this turn ended ${why}.`,
        "This is the end-of-turn checkpoint: before the user replies, bring the view in line with this turn's work.",
        "- Each part you changed or explained needs a Lens of yours showing it: the changed lines (kind",
        '  "diff") and the 2-4 concerns your reply walked through, with whys that say what to check.',
        "  Activate the last part's Lens, unless the user's own Lens is active: then mark without activating.",
        "- You may read and search to find the exact lines. Do NOT edit files and do NOT continue the",
        "  task: only read-only tools and Lens tools.",
        "- If the reply was not about code in this repo, or the view already shows it, change nothing.",
        ...(unmarked ? ['- Whatever the reply was about, settle the "Unmarked matches" listed above.'] : []),
        ...(whys.length
          ? [
              `- These concerns' whys may be out of date: ${whys.map((w) => `■ ${w.facet.id}`).join(", ")}. Rewrite`,
              "  each with lens_edit to say what to check, if its Lens still serves this turn.",
            ]
          : []),
        "End with ONE line for the user: what changed in the view, or `View unchanged: <why>`.",
        "</system-reminder>",
      ].join("\n")
    })

    // The mid-turn nudges, at the checkpoints the system prompt names. The Lens should change only
    // at those, so the user isn't watching concerns churn at agent speed. A completed todo (a
    // "milestone" history entry, written by todowrite) asks the agent to decide whether the next
    // todo starts a new part — only the agent can tell a step from a part. A turn that starts
    // editing with no Lens change at all missed the before-acting checkpoint, and is nudged once.
    // The nudge is concrete — the todo, the files, the next todo — so the agent makes a small local
    // decision instead of recalling a general rule. `key` lets the caller send each nudge once.
    const apertureNudge = Effect.fn("SystemPrompt.apertureNudge")(function* (
      agent: Agent.Info,
      input: {
        readonly turnID: string
        readonly todos: ReadonlyArray<{ readonly content: string; readonly status: string }>
        readonly edits: ReadonlyArray<{ readonly file: string; readonly at: number }>
      },
    ) {
      if (agent.name !== "build" && agent.name !== "plan") return
      const ctx = yield* InstanceState.context
      const entries = yield* ApertureLensHistory.read(ctx.directory, { turnID: input.turnID })
      const change = entries.findLast((e) => e.op !== "milestone")
      const since = change?.at ?? 0
      const files = [...new Set(input.edits.filter((e) => e.at >= since).map((e) => e.file))]
      const reached = entries.filter((e) => e.op === "milestone" && e.seq > (change?.seq ?? -1))
      const next = input.todos.find((t) => t.status === "in_progress" || t.status === "pending")
      const edited = files.length ? `Files you edited since the last Lens change: ${files.join(", ")}.` : undefined
      // Only strays that appeared this turn after the turn-start state listed them. Checked before
      // the milestone: a milestone nudge repeats its key until the Lens changes and the caller drops
      // repeats, so strays folded into one could be recorded as shown without being sent.
      const unmarked = yield* strays(ctx.directory, files)
      const seen = shownIn(ctx.directory, input.turnID)
      const fresh = unmarked?.strays.filter((stray) => !seen.has(strayKey(unmarked.lens, stray))) ?? []
      if (unmarked && fresh.length)
        return {
          key: `strays:${fresh.map((stray) => strayKey(unmarked.lens, stray)).join("|")}`,
          text: [
            "<system-reminder>",
            "APERTURE: new unmarked matches — lines a rule matches outside its glob/path, so the view shows them unmarked:",
            ...strayList(ctx.directory, input.turnID, { lens: unmarked.lens, strays: fresh }),
            "Then continue the task.",
            "</system-reminder>",
          ].join("\n"),
        }
      const active = reached.length ? yield* ApertureLensStore.getActive(ctx.directory) : undefined
      const whys = active ? staleWhys(active, yield* ApertureLensHistory.read(ctx.directory, { lens: active.id })) : []
      if (reached.length)
        return {
          key: `milestone:${reached[reached.length - 1].seq}`,
          text: [
            "<system-reminder>",
            `APERTURE MILESTONE: you completed ${reached.map((e) => `"${e.milestone?.todo}"`).join(", ")}.`,
            ...(edited ? [edited] : []),
            ...(next
              ? [
                  `Next todo: "${next.content}". Decide whether it continues this part or starts a new one:`,
                  "- Same part: leave the Lens as it is, unless a mark has proved wrong.",
                  "- New part (a checkpoint): finish this part's Lens, keeping it as the part's record; then, once",
                  "  grounded in the next part, give it its own Lens and activate it.",
                ]
              : ["No todos remain: finish this part's Lens before you reply."]),
            'Finishing a Lens: mark the changed lines (kind "diff", globbed to the part\'s files) and rewrite',
            ...(whys.length
              ? [
                  "whys (lens_edit) to say what to check — each what stays:",
                  ...whys.map((w) => `    ■ ${w.facet.id}: why was "${w.facet.why || "(none)"}"`),
                ]
              : ["whys (lens_edit) to say what to check."]),
            "Then continue the task.",
            "</system-reminder>",
          ].join("\n"),
        }
      if (change || !files.length) return
      return {
        key: `edits:${input.turnID}`,
        text: [
          "<system-reminder>",
          `APERTURE: you started editing (${files.join(", ")}) with no Lens change this turn.`,
          "If the active Lens doesn't already show this work, mark it now (the before-acting checkpoint): the",
          'code you\'re changing, its call sites and tests, and a kind "diff" concern globbed to these files.',
          "Then continue the task.",
          "</system-reminder>",
        ].join("\n"),
      }
    })

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
          "Aperture is your visual channel to the user: a Lens highlights the exact lines in this repo that",
          "your work is about, so the user can follow your reasoning and check your changes in the code.",
          `A Lens is a named group of up to ${ApertureLenses.MAX_FACETS} concerns (facets). Each concern has a colour, a what, a why, and`,
          "deterministic rules — a regex, a declaration name, or a git diff, optionally narrowed by git",
          "history — that are re-run on every read, so the marks follow the code. The current Lenses",
          "arrive in an <aperture-state> reminder with each user message.",
          "",
          "Your chat says WHAT and WHY; your marks show WHERE. A reply about code in this repo is not done",
          "until a Lens of yours shows it.",
          "",
          'LENSES. One Lens per part of the work, named after it ("Webhook limits: sender"). A part is a',
          "distinct feature, fix or question; the steps within it (todos like \"add tests\", \"update callers\")",
          "share its Lens. A task with several parts, planned as milestones or not, gets several Lenses, so",
          "the user can return to part A after you've moved on to part B. Each time you finish a step, decide",
          "explicitly whether the next one continues this part or starts a new one. A finished part's Lens",
          "is its record: add to it for a follow-up, but don't prune it. To dig deeper into one part, start a",
          "new Lens and split its concerns into finer ones.",
          "",
          "WHEN TO UPDATE. The user reads the view while you work, and concerns that change at your speed",
          "are unreadable. Marks moving with the code as you edit are fine; adding, removing or rewriting",
          "concerns happens only at these checkpoints:",
          "1. After grounding, before acting. Once you've read enough (including any explore results) to know",
          "   which code you'll explain or change, and before your first edit or your explanation, mark it on",
          "   the part's Lens and activate it. Marks made after grounding stay stable; marks made before get",
          "   redone. For a change: the code you'll change, the call sites it affects, the tests that cover",
          '   it, and a kind "diff" concern globbed to the part\'s files so your edits appear as you make them.',
          "   For a question: the 2-4 concerns your explanation walks through.",
          "2. At a part boundary. Finish the part's Lens (as in 3), then start and activate the next part's",
          "   Lens (as in 1).",
          "3. When a part or the turn ends. Make the Lens verifiable: the changed lines (kind \"diff\", or a",
          '   pattern narrowed with changed:"HEAD" — "every call to x() this change touched"), and whys',
          "   rewritten to say what to check.",
          "Between checkpoints, leave concerns alone and save what you learn for the next one. The exceptions:",
          "a mark that proved wrong, unmarked matches the state lists, and anything the user asks for.",
          "",
          "CONCERNS.",
          '- `what` is what the lines are, as a phrase a newcomer can picture ("every place a failed request',
          '  is re-queued"). Like its colour, it is the concern\'s identity: keep it. A new intent is a new concern.',
          "- `why` is why to look at those lines now: before a change, what you'll do there; after it, what",
          "  to check. A provisional why is fine at checkpoint 1; rewrite it with lens_edit at a later one.",
          "- Show the precedent. If your change follows a pattern already in this codebase (a sibling module",
          "  you modelled it on, this repo's way of handling errors, tests or config), mark one or two",
          "  instances of it as their own concern, with a why naming what you followed. Language idioms and",
          "  general techniques don't count.",
          "- Prefer adding a rule (with a `note` saying which part it marks) or a concern to an existing Lens",
          "  of yours for the same part over minting near-duplicates.",
          "- In chat, write a concern as ■ followed by its id (■ retry-path); the user's view paints the",
          "  square in its colour. At each checkpoint, announce each new or rewritten concern in one sentence",
          "  as ■ id: what — why. Between checkpoints, say nothing about the view.",
          "",
          "OWNERSHIP. Activate your Lens (activate:true, or lens_select) whenever the active Lens is yours or",
          "there is none, including at each part boundary, so the view tracks your work. Never switch away",
          "from the user's own Lens unasked: mark on yours and tell them it exists. When the user asks for a",
          "mark, a Lens or a switch, do it and pass requestedByUser:true; it is then theirs, and the tools ask",
          "before you change it.",
          "",
          "Skip marking only when the message is not about code in this repo, or the active Lens already",
          "shows what your reply discusses.",
          "",
          "DELEGATING EXPLORATION. Explore subagents have NO Lens tools: they propose, you install. When you",
          'dispatch subagent_type "explore" for a where-is or how-does question, put in the task prompt',
          '(a) the concern ids of your current Lens, and (b) the sentence: "End your report with a PROPOSED',
          'MARKS section." At your next checkpoint, call lens_mark for each proposal worth keeping.',
          ...(agent.name === "plan"
            ? [
                "",
                'PLANNING. Marking fits planning well: "where does X happen today?" is most of what planning',
                "asks, and a mark changes no code. Once grounded, mark the concerns each part of the plan",
                "depends on, on that part's Lens, and reference them in the plan by token (■ id) so the reader",
                "can see them.",
              ]
            : []),
          "</aperture>",
        ].join("\n")
      }),

      apertureState,
      apertureCheck,
      apertureNudge,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer), Layer.provide(Git.defaultLayer))

export * as SystemPrompt from "./system"
