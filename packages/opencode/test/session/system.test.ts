import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { Storage } from "../../src/storage/storage"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

// Minimal Storage stub — the `aperture` method captures Storage at layer build
// time, but the assertions below only exercise `skills` and the non-build/plan
// `aperture` gate (which returns before touching storage), so the bodies are unused.
const storageStub = Layer.succeed(
  Storage.Service,
  Storage.Service.of({
    remove: () => Effect.void,
    read: (() => Effect.fail(new Error("not implemented"))) as unknown as Storage.Interface["read"],
    update: (() => Effect.fail(new Error("not implemented"))) as unknown as Storage.Interface["update"],
    write: () => Effect.void,
    list: () => Effect.succeed([]),
  }),
)

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ),
    Layer.provide(storageStub),
  ),
)

describe("session.system", () => {
  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("aperture is gated to the build/plan agents", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const lens: Agent.Info = { name: "lens", mode: "all", permission: Permission.fromConfig({ "*": "allow" }), options: {} }
      const explore: Agent.Info = {
        name: "explore",
        mode: "subagent",
        permission: Permission.fromConfig({ "*": "allow" }),
        options: {},
      }
      // Non-build/plan agents return before touching storage — no data needed.
      expect(yield* prompt.aperture(lens)).toBeUndefined()
      expect(yield* prompt.aperture(explore)).toBeUndefined()
    }),
  )
})
