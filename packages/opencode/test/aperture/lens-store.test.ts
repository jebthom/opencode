import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ApertureLensStore } from "@/aperture/lens-store"
import { ApertureLensHistory, USER, type Actor } from "@/aperture/lens-history"
import { MAX_FACETS, MAX_RULES, PALETTES, type Finder } from "@/aperture/lenses"

// Lens definitions, the active pointer and the change history persist in the project directory
// under .opencode/aperture/, so a Lens is shareable and committable and its history is reviewable.

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
const pattern = (p: string): Finder => ({ kind: "pattern", pattern: p })
const AGENT: Actor = { kind: "agent", agent: "build", sessionID: "ses_1", turnID: "msg_turn1", reason: "curating" }

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "aperture-lens-store-"))
  ApertureLensHistory.resetForTest(dir)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const create = (actor: Actor = USER, name = "Retry Handling") =>
  run(
    ApertureLensStore.create(
      dir,
      {
        name,
        description: "retries",
        facet: "retry-path",
        facetReason: "where retries re-enter",
        find: pattern("retry\\("),
      },
      actor,
    ),
  )

const lensOf = async (actor: Actor = USER) => {
  const result = await create(actor)
  if (result.status !== "ok") throw new Error(result.status)
  return result.lens
}

describe("aperture lens-store — persistence", () => {
  test("create writes the Lens, its first concern and rule in one go, owned by the actor", async () => {
    const lens = await lensOf(AGENT)
    expect(lens.owner).toBe("agent")
    expect(lens.facets.map((f) => [f.id, f.owner, f.createdBy])).toEqual([["retry-path", "agent", "build"]])
    expect(lens.rules?.map((r) => [r.facet, r.createdBy])).toEqual([["retry-path", "build"]])

    const onDisk = JSON.parse(await fs.readFile(path.join(dir, ".opencode", "aperture", "lenses.json"), "utf8"))
    expect(onDisk[lens.id].name).toBe("Retry Handling")
    expect(await run(ApertureLensStore.list(dir))).toEqual([lens])
  })

  test("getActive is the stored Lens, else the first Lens, else none", async () => {
    expect(await run(ApertureLensStore.getActive(dir))).toBeUndefined()
    const first = await lensOf()
    const second = (await create(USER, "Second")) as { lens: typeof first }
    expect((await run(ApertureLensStore.getActive(dir)))?.id).toBe(first.id)
    await run(ApertureLensStore.setActive(dir, second.lens, USER))
    expect((await run(ApertureLensStore.getActive(dir)))?.id).toBe(second.lens.id)
    // A pointer at a Lens that no longer exists falls back rather than showing nothing.
    await run(ApertureLensStore.remove(dir, second.lens.id, USER))
    expect((await run(ApertureLensStore.getActive(dir)))?.id).toBe(first.id)
  })

  test("resolve finds a Lens by id or case-insensitive name", async () => {
    const lens = await lensOf()
    const all = await run(ApertureLensStore.list(dir))
    expect(ApertureLensStore.resolve(all, lens.id)?.id).toBe(lens.id)
    expect(ApertureLensStore.resolve(all, "retry handling")?.id).toBe(lens.id)
    expect(ApertureLensStore.resolve(all, "nope")).toBeUndefined()
  })
})

describe("aperture lens-store — mark / unmark", () => {
  test("mark adds a rule to an existing concern by label, or mints a new one", async () => {
    const lens = await lensOf()
    const same = await run(ApertureLensStore.mark(dir, lens.id, { facet: "RETRY-PATH", find: pattern("again") }, USER))
    expect(same.status === "ok" && same.minted).toBe(false)
    const minted = await run(ApertureLensStore.mark(dir, lens.id, { facet: "backoff", find: pattern("sleep") }, USER))
    if (minted.status !== "ok") throw new Error(minted.status)
    expect(minted.minted).toBe(true)
    expect(minted.facet.color).toBe(PALETTES.categorical.colors[1]!)
    expect(minted.lens.rules).toHaveLength(3)
  })

  test("re-marking an identical finder replaces rather than duplicates; a filter makes it distinct", async () => {
    const lens = await lensOf()
    const again = await run(
      ApertureLensStore.mark(dir, lens.id, { facet: "retry-path", find: pattern("retry\\(") }, USER),
    )
    expect(again.status === "ok" && again.replaced !== undefined).toBe(true)
    const filtered = await run(
      ApertureLensStore.mark(
        dir,
        lens.id,
        { facet: "retry-path", find: pattern("retry\\("), where: { changed: "HEAD" } },
        USER,
      ),
    )
    if (filtered.status !== "ok") throw new Error(filtered.status)
    expect(filtered.replaced).toBeUndefined()
    expect(filtered.lens.rules).toHaveLength(2)
  })

  test("refuses past the facet and rule caps", async () => {
    const lens = await lensOf()
    for (let i = 1; i < MAX_FACETS; i++)
      await run(ApertureLensStore.mark(dir, lens.id, { facet: `c${i}`, find: pattern(`x${i}`) }, USER))
    const over = await run(ApertureLensStore.mark(dir, lens.id, { facet: "one-too-many", find: pattern("y") }, USER))
    expect(over.status).toBe("facet-cap")
    for (let i = MAX_FACETS; i < MAX_RULES; i++)
      await run(ApertureLensStore.mark(dir, lens.id, { facet: "c1", find: pattern(`z${i}`) }, USER))
    const tooMany = await run(ApertureLensStore.mark(dir, lens.id, { facet: "c1", find: pattern("last") }, USER))
    expect(tooMany.status).toBe("rule-cap")
  })

  test("unmarking a concern takes its rules and leaves the others' colours alone", async () => {
    const lens = await lensOf()
    await run(ApertureLensStore.mark(dir, lens.id, { facet: "backoff", find: pattern("sleep") }, USER))
    const result = await run(ApertureLensStore.unmark(dir, lens.id, { facet: "retry-path" }, USER))
    if (result.status !== "ok") throw new Error(result.status)
    expect(result.removedRules.map((r) => r.facet)).toEqual(["retry-path"])
    expect(result.lens.facets.map((f) => [f.id, f.color])).toEqual([["backoff", PALETTES.categorical.colors[1]!]])
    // Survives a re-read, and the freed slot goes to the next concern minted.
    const minted = await run(ApertureLensStore.mark(dir, lens.id, { facet: "jitter", find: pattern("rand") }, USER))
    if (minted.status !== "ok") throw new Error(minted.status)
    expect(minted.lens.facets.map((f) => [f.id, f.color])).toEqual([
      ["backoff", PALETTES.categorical.colors[1]!],
      ["jitter", PALETTES.categorical.colors[0]!],
    ])
  })

  test("an agent must give a reason to mint a concern; a user need not", async () => {
    const lens = await lensOf(AGENT)
    const bare = await run(ApertureLensStore.mark(dir, lens.id, { facet: "backoff", find: pattern("sleep") }, AGENT))
    expect(bare).toEqual({ status: "needs-reason", facet: "backoff" })
    const missing = await run(
      ApertureLensStore.create(dir, { name: "Other", description: "", facet: "x", find: pattern("x") }, AGENT),
    )
    expect(missing.status).toBe("needs-reason")
    // Adding a rule to an existing concern needs no reason.
    const more = await run(ApertureLensStore.mark(dir, lens.id, { facet: "retry-path", find: pattern("again") }, AGENT))
    expect(more.status).toBe("ok")
    const user = await run(ApertureLensStore.mark(dir, lens.id, { facet: "backoff", find: pattern("sleep") }, USER))
    expect(user.status).toBe("ok")
  })

  test("a reason on an existing concern replaces it and is recorded as a facet edit", async () => {
    const lens = await lensOf(AGENT)
    const result = await run(
      ApertureLensStore.mark(
        dir,
        lens.id,
        { facet: "retry-path", facetReason: "the callers the fix must reach", find: pattern("again") },
        AGENT,
      ),
    )
    if (result.status !== "ok") throw new Error(result.status)
    expect(result.facet.reason).toBe("the callers the fix must reach")
    expect((await run(ApertureLensStore.get(dir, lens.id)))?.facets[0]?.reason).toBe("the callers the fix must reach")
    const history = await run(ApertureLensHistory.read(dir, {}))
    const edit = history.find((e) => e.op === "facet.edit")
    expect(edit?.before).toMatchObject({ facet: { reason: "where retries re-enter" } })
    expect(edit?.after).toMatchObject({ facet: { reason: "the callers the fix must reach" } })
  })

  test("update revises a reason, and a palette switch keeps each facet's slot", async () => {
    const lens = await lensOf()
    await run(ApertureLensStore.mark(dir, lens.id, { facet: "backoff", find: pattern("sleep") }, USER))
    const result = await run(
      ApertureLensStore.update(
        dir,
        lens.id,
        { palette: "ordinal", facets: [{ ref: "backoff", reason: "how long callers wait" }] },
        USER,
      ),
    )
    if (result.status !== "ok") throw new Error(result.status)
    expect(result.lens.facets.map((f) => [f.id, f.color, f.reason])).toEqual([
      ["retry-path", PALETTES.ordinal.colors[0]!, "where retries re-enter"],
      ["backoff", PALETTES.ordinal.colors[1]!, "how long callers wait"],
    ])
  })

  test("a stored colour survives the read; v3 files without reasons read as empty", async () => {
    const file = path.join(dir, ".opencode", "aperture", "lenses.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        v3: {
          id: "v3",
          name: "V3",
          description: "",
          palette: "categorical",
          owner: "agent",
          facets: [{ id: "b", label: "b", description: "", owner: "agent", color: PALETTES.categorical.colors[1] }],
          rules: [{ id: "b-1", facet: "b", find: { kind: "pattern", pattern: "b" } }],
        },
      }),
    )
    const [lens] = await run(ApertureLensStore.list(dir))
    expect(lens?.facets).toEqual([
      { id: "b", label: "b", description: "", reason: "", owner: "agent", color: PALETTES.categorical.colors[1]! },
    ])
  })

  test("unmark reports an unknown rule or concern without writing", async () => {
    const lens = await lensOf()
    expect((await run(ApertureLensStore.unmark(dir, lens.id, { rule: "nope" }, USER))).status).toBe("unknown-rule")
    expect((await run(ApertureLensStore.unmark(dir, lens.id, { facet: "nope" }, USER))).status).toBe("unknown-facet")
  })
})

describe("aperture lens-store — ownership", () => {
  test("an agent acting on its own may not change the user's Lens without consent", async () => {
    const lens = await lensOf(USER)
    const mark = await run(ApertureLensStore.mark(dir, lens.id, { facet: "mine", find: pattern("q") }, AGENT))
    expect(mark.status).toBe("needs-consent")
    const unmark = await run(ApertureLensStore.unmark(dir, lens.id, { facet: "retry-path" }, AGENT))
    expect(unmark.status).toBe("needs-consent")
    expect((await run(ApertureLensStore.update(dir, lens.id, { name: "Renamed" }, AGENT))).status).toBe("needs-consent")
    expect((await run(ApertureLensStore.remove(dir, lens.id, AGENT))).status).toBe("needs-consent")
    // Nothing changed.
    expect(await run(ApertureLensStore.list(dir))).toEqual([lens])
  })

  test("consent, or the user's own request, lets the change through", async () => {
    const lens = await lensOf(USER)
    const consented = await run(
      ApertureLensStore.mark(
        dir,
        lens.id,
        { facet: "mine", facetReason: "r", find: pattern("q") },
        { ...AGENT, consented: true },
      ),
    )
    expect(consented.status).toBe("ok")
    const requested = await run(ApertureLensStore.unmark(dir, lens.id, { facet: "mine" }, { ...AGENT, kind: "user" }))
    expect(requested.status).toBe("ok")
  })

  test("an agent curates its own Lens freely", async () => {
    const lens = await lensOf(AGENT)
    expect(
      (await run(ApertureLensStore.mark(dir, lens.id, { facet: "b", facetReason: "r", find: pattern("q") }, AGENT)))
        .status,
    ).toBe("ok")
    expect((await run(ApertureLensStore.unmark(dir, lens.id, { facet: "retry-path" }, AGENT))).status).toBe("ok")
    expect((await run(ApertureLensStore.remove(dir, lens.id, AGENT))).status).toBe("ok")
  })

  test("a user-owned concern on an agent's Lens is still the user's", async () => {
    const lens = await lensOf(AGENT)
    await run(
      ApertureLensStore.mark(
        dir,
        lens.id,
        { facet: "asked-for", facetReason: "r", find: pattern("q") },
        { ...AGENT, kind: "user" },
      ),
    )
    expect((await run(ApertureLensStore.unmark(dir, lens.id, { facet: "asked-for" }, AGENT))).status).toBe(
      "needs-consent",
    )
  })
})

describe("aperture lens-store — update", () => {
  test("renames the Lens and relabels a concern without touching its rules", async () => {
    const lens = await lensOf()
    const result = await run(
      ApertureLensStore.update(
        dir,
        lens.id,
        { name: "Retries", facets: [{ ref: "retry-path", label: "Retry path", description: "every retry" }] },
        USER,
      ),
    )
    if (result.status !== "ok") throw new Error(result.status)
    expect(result.lens.name).toBe("Retries")
    expect(result.lens.facets[0]).toMatchObject({ id: "retry-path", label: "Retry path", description: "every retry" })
    expect(result.lens.rules).toEqual(lens.rules)
  })

  test("reports an unknown concern", async () => {
    const lens = await lensOf()
    const result = await run(ApertureLensStore.update(dir, lens.id, { facets: [{ ref: "nope", label: "x" }] }, USER))
    expect(result.status).toBe("unknown-facet")
  })
})

describe("aperture lens-store — v2 migration", () => {
  test("drops painter facets and fields, keeps rule-owned concerns as the user's", async () => {
    const file = path.join(dir, ".opencode", "aperture", "lenses.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        "old-1": {
          id: "old-1",
          name: "Old Overview",
          description: "painted",
          palette: "pastel",
          prompt: "classify files",
          scope: "project",
          context: "medium",
          directories: ["src"],
          facets: [
            { id: "ui", label: "UI", description: "", color: "#000000" },
            { id: "any-casts", label: "any-casts", description: "", color: "#000000", ruleOnly: true },
            { id: "flags", label: "flags", description: "", color: "#000000" },
          ],
          rules: [
            { id: "flags-1", facet: "flags", find: { kind: "pattern", pattern: "flag\\(" } },
            { id: "broken", facet: "ui", find: { kind: "nope" } },
          ],
        },
      }),
    )
    const [lens] = await run(ApertureLensStore.list(dir))
    expect(lens).toEqual({
      id: "old-1",
      name: "Old Overview",
      description: "painted",
      palette: "categorical",
      owner: "user",
      facets: [
        {
          id: "any-casts",
          label: "any-casts",
          description: "",
          reason: "",
          owner: "user",
          color: PALETTES.categorical.colors[0]!,
        },
        {
          id: "flags",
          label: "flags",
          description: "",
          reason: "",
          owner: "user",
          color: PALETTES.categorical.colors[1]!,
        },
      ],
      rules: [{ id: "flags-1", facet: "flags", find: { kind: "pattern", pattern: "flag\\(" } }],
    })
  })

  test("a painter-only Overview Lens is dropped; an unmarked-to-empty Lens is kept", async () => {
    const file = path.join(dir, ".opencode", "aperture", "lenses.json")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        painted: {
          id: "painted",
          name: "Painted",
          description: "",
          prompt: "classify files",
          facets: [{ id: "ui", label: "UI", description: "", color: "#000000" }],
        },
        emptied: {
          id: "emptied",
          name: "Emptied",
          description: "",
          palette: "categorical",
          owner: "agent",
          facets: [],
        },
      }),
    )
    expect((await run(ApertureLensStore.list(dir))).map((l) => l.id)).toEqual(["emptied"])
  })

  test("an active pointer at a retired built-in falls back to a real Lens", async () => {
    const lens = await lensOf()
    await fs.writeFile(path.join(dir, ".opencode", "aperture", "active.json"), JSON.stringify({ id: "architecture" }))
    expect((await run(ApertureLensStore.getActive(dir)))?.id).toBe(lens.id)
  })
})

describe("aperture lens-store — history", () => {
  test("every change is appended with its actor, turn and snapshots, in order", async () => {
    const lens = await lensOf(AGENT)
    await run(
      ApertureLensStore.mark(
        dir,
        lens.id,
        { facet: "b", facetReason: "r", find: pattern("q"), hits: { lines: 3, files: 1 } },
        AGENT,
      ),
    )
    await run(ApertureLensStore.unmark(dir, lens.id, { facet: "b" }, { ...AGENT, turnID: "msg_turn2" }))
    await run(ApertureLensStore.setActive(dir, lens, USER))

    const entries = await run(ApertureLensHistory.read(dir))
    expect(entries.map((e) => e.op)).toEqual([
      "lens.create",
      "facet.add",
      "rule.add",
      "facet.add",
      "rule.add",
      "facet.remove",
      "lens.select",
    ])
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(entries[4]!.hits).toEqual({ lines: 3, files: 1 })
    expect(entries[5]!.before).toMatchObject({ facet: { id: "b" }, rules: [{ facet: "b" }] })
    expect(entries[5]!.actor).toMatchObject({ kind: "agent", agent: "build", reason: "curating" })
  })

  test("filters by turn, so a chat turn maps to exactly the Lens changes it made", async () => {
    const lens = await lensOf(AGENT)
    await run(
      ApertureLensStore.mark(
        dir,
        lens.id,
        { facet: "b", facetReason: "r", find: pattern("q") },
        { ...AGENT, turnID: "msg_turn2" },
      ),
    )
    const turn2 = await run(ApertureLensHistory.read(dir, { turnID: "msg_turn2" }))
    expect(turn2.map((e) => e.op)).toEqual(["facet.add", "rule.add"])
    expect((await run(ApertureLensHistory.read(dir, { turnID: "msg_turn1" }))).length).toBe(3)
    expect((await run(ApertureLensHistory.read(dir, { limit: 1 })))[0]!.op).toBe("rule.add")
  })

  test("a refused change records nothing", async () => {
    const lens = await lensOf(USER)
    const before = (await run(ApertureLensHistory.read(dir))).length
    await run(ApertureLensStore.remove(dir, lens.id, AGENT))
    expect((await run(ApertureLensHistory.read(dir))).length).toBe(before)
  })
})
