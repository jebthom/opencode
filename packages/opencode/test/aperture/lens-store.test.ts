import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ApertureLensStore } from "@/aperture/lens-store"
import { ARCHITECTURE_ID, BUILTIN_LENSES, MAX_FACETS, MAX_RULES } from "@/aperture/lenses"

// A3: Lens definitions + the active pointer persist in the project directory
// under .opencode/aperture/ (not global KV), so a Lens is shareable/committable.

const CREATE = {
  name: "Auth Flow",
  description: "Where auth happens",
  palette: "categorical" as const,
  prompt: "Tag files by their role in authentication.",
  facets: [
    { label: "Login", description: "login + session start" },
    { label: "Tokens", description: "token mint/verify" },
  ],
}

describe("aperture lens-store (project-dir persistence)", () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aperture-lens-store-"))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("create writes lenses.json under .opencode/aperture and is additive", async () => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, CREATE))
    expect(lens.facets.map((f) => f.id)).toEqual(["login", "tokens"])

    // The committable artifact landed on disk in the project directory.
    const file = path.join(dir, ".opencode", "aperture", "lenses.json")
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"))
    expect(onDisk[lens.id].name).toBe("Auth Flow")

    // list() returns built-ins first, then the new user Lens.
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.slice(0, BUILTIN_LENSES.length)).toEqual([...BUILTIN_LENSES])
    expect(all.some((l) => l.id === lens.id)).toBe(true)
  })

  test("active pointer round-trips through active.json", async () => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: "Routing" }))
    // Defaults to architecture before any pointer is written.
    const pointerFile = path.join(dir, ".opencode", "aperture", "active.json")

    await Effect.runPromise(ApertureLensStore.setActive(dir, lens.id))
    expect(JSON.parse(await fs.readFile(pointerFile, "utf8"))).toEqual({ id: lens.id })

    const active = await Effect.runPromise(ApertureLensStore.getActive(dir))
    expect(active.id).toBe(lens.id)
  })

  test("getActive falls back to architecture when nothing is set", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "aperture-empty-"))
    try {
      const active = await Effect.runPromise(ApertureLensStore.getActive(empty))
      expect(active.id).toBe(ARCHITECTURE_ID)
      const list = await Effect.runPromise(ApertureLensStore.list(empty))
      expect(list).toEqual([...BUILTIN_LENSES])
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  test("remove drops a user Lens from disk", async () => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: "Temp" }))
    expect(await Effect.runPromise(ApertureLensStore.remove(dir, lens.id))).toEqual([lens.id])
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.some((l) => l.id === lens.id)).toBe(false)
    // Removing a built-in (lives in code, not on disk) is a no-op.
    expect(await Effect.runPromise(ApertureLensStore.remove(dir, ARCHITECTURE_ID))).toEqual([])
  })

  test("context mode: medium persists, minimal is omitted (default)", async () => {
    const minimal = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: "Min" }))
    expect(minimal.context).toBeUndefined()

    const medium = await Effect.runPromise(
      ApertureLensStore.create(dir, { ...CREATE, name: "Smells", context: "medium" }),
    )
    expect(medium.context).toBe("medium")

    // The default stays absent from the committed JSON; only the medium Lens carries it.
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, ".opencode", "aperture", "lenses.json"), "utf8"))
    expect("context" in onDisk[minimal.id]).toBe(false)
    expect(onDisk[medium.id].context).toBe("medium")
  })

  test("editing context is structural and a downgrade to minimal clears the field", async () => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: "Ctx" }))

    const up = await Effect.runPromise(ApertureLensStore.update(dir, lens.id, { context: "medium" }))
    expect(up?.structural).toBe(true)
    expect(up?.lens.context).toBe("medium")

    const down = await Effect.runPromise(ApertureLensStore.update(dir, lens.id, { context: "minimal" }))
    expect(down?.structural).toBe(true)
    expect(down?.lens.context).toBeUndefined()
    // The field is dropped from disk, not persisted as "minimal".
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, ".opencode", "aperture", "lenses.json"), "utf8"))
    expect("context" in onDisk[lens.id]).toBe(false)

    // Editing something else leaves an existing medium mode untouched and non-structural.
    await Effect.runPromise(ApertureLensStore.update(dir, lens.id, { context: "medium" }))
    const cosmetic = await Effect.runPromise(ApertureLensStore.update(dir, lens.id, { name: "Ctx renamed" }))
    expect(cosmetic?.structural).toBe(false)
    expect(cosmetic?.lens.context).toBe("medium")
  })
})

// Drill-down Lenses: a Lens scoped to a subset of another Lens's facets.
describe("aperture lens-store (drill-downs)", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aperture-drill-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  // Build a parent and a drill-down scoped to one of its facets.
  const withChild = async () => {
    const parent = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: "Parent" }))
    const child = await Effect.runPromise(
      ApertureLensStore.create(dir, {
        ...CREATE,
        name: "Child",
        parent: { lens: parent.id, facets: ["login"] },
      }),
    )
    return { parent, child }
  }

  test("the scope persists to the committable JSON", async () => {
    const { parent, child } = await withChild()
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, ".opencode", "aperture", "lenses.json"), "utf8"))
    expect(onDisk[child.id].parent).toEqual({ lens: parent.id, facets: ["login"] })
    // A root Lens carries no parent field at all.
    expect("parent" in onDisk[parent.id]).toBe(false)
  })

  test("list() places a drill-down immediately after the Lens it drills into", async () => {
    const { parent, child } = await withChild()
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    const ids = all.map((l) => l.id)
    expect(ids.indexOf(child.id)).toBe(ids.indexOf(parent.id) + 1)
    // Built-ins still lead the list (nothing here drills into one).
    expect(all.slice(0, BUILTIN_LENSES.length)).toEqual([...BUILTIN_LENSES])
  })

  test("deleting a Lens cascades to every drill-down beneath it", async () => {
    const { parent, child } = await withChild()
    const grandchild = await Effect.runPromise(
      ApertureLensStore.create(dir, { ...CREATE, name: "Grandchild", parent: { lens: child.id, facets: ["login"] } }),
    )

    const removed = await Effect.runPromise(ApertureLensStore.remove(dir, parent.id))
    expect(removed.sort()).toEqual([parent.id, child.id, grandchild.id].sort())

    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.filter((l) => l.scope === "project")).toEqual([])
  })

  test("deleting a drill-down leaves its parent — and its parent's paint — alone", async () => {
    const { parent, child } = await withChild()
    expect(await Effect.runPromise(ApertureLensStore.remove(dir, child.id))).toEqual([child.id])
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.some((l) => l.id === parent.id)).toBe(true)
  })

  test("merging the parent's facets re-scopes its drill-downs onto the survivor", async () => {
    const { parent, child } = await withChild()
    // The child is scoped to "login"; fold login into tokens.
    await Effect.runPromise(ApertureLensStore.mergeFacets(dir, parent.id, "login", "tokens"))

    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    const updated = all.find((l) => l.id === child.id)!
    // Without this the child would point at a facet that no longer exists and paint nothing.
    expect(updated.parent).toEqual({ lens: parent.id, facets: ["tokens"] })
    expect(all.find((l) => l.id === parent.id)!.facets.map((f) => f.id)).toEqual(["tokens"])
  })

  test("a drill-down scoped to BOTH merged facets collapses to one, not a duplicate", async () => {
    const parent = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: "P2" }))
    const child = await Effect.runPromise(
      ApertureLensStore.create(dir, {
        ...CREATE,
        name: "C2",
        parent: { lens: parent.id, facets: ["login", "tokens"] },
      }),
    )
    await Effect.runPromise(ApertureLensStore.mergeFacets(dir, parent.id, "login", "tokens"))
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.find((l) => l.id === child.id)!.parent!.facets).toEqual(["tokens"])
  })

  test("childrenOf and descendantsOf walk the hierarchy", async () => {
    const { parent, child } = await withChild()
    const grandchild = await Effect.runPromise(
      ApertureLensStore.create(dir, { ...CREATE, name: "GC", parent: { lens: child.id, facets: ["login"] } }),
    )
    expect((await Effect.runPromise(ApertureLensStore.childrenOf(dir, parent.id))).map((l) => l.id)).toEqual([child.id])
    expect((await Effect.runPromise(ApertureLensStore.descendantsOf(dir, parent.id))).map((l) => l.id)).toEqual([
      child.id,
      grandchild.id,
    ])
  })
})

// S1: search rules live on the Lens in lenses.json — small, hand-authored, diffable and
// committable — so the store has to survive a hand-edited or stale rule without losing the
// Lens. Everything here is SHAPE validation; whether a regex compiles or matched 4,000 lines
// is the evaluator's question, because those must be reported rather than silently dropped.
describe("aperture lens-store — search rules", () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aperture-lens-rules-"))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  // Rules arrive via lens_mark (S2), so seed them the way a hand edit or that tool would:
  // straight into the committed doc.
  const seed = async (rules: unknown[]) => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, { ...CREATE, name: `L${Math.random()}` }))
    const file = path.join(dir, ".opencode", "aperture", "lenses.json")
    const doc = JSON.parse(await fs.readFile(file, "utf8"))
    doc[lens.id].rules = rules
    await fs.writeFile(file, JSON.stringify(doc, null, 2))
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    return all.find((l) => l.id === lens.id)!
  }

  test("a well-formed rule round-trips", async () => {
    const lens = await seed([{ id: "r1", facet: "login", find: { kind: "pattern", pattern: "signIn" }, note: "why" }])
    expect(lens.rules).toEqual([
      { id: "r1", facet: "login", find: { kind: "pattern", pattern: "signIn" }, note: "why" } as never,
    ])
  })

  test("drops a rule naming a facet the Lens doesn't have", async () => {
    // The live hazard: facet ids are slugs and mergeFacets can retire one, so a stale rule
    // would otherwise ask the painter for a colour that no longer exists.
    const lens = await seed([{ id: "r1", facet: "ghost", find: { kind: "pattern", pattern: "x" } }])
    expect(lens.rules ?? []).toEqual([])
  })

  test("drops malformed finders but keeps the rest of the Lens", async () => {
    const lens = await seed([
      { id: "r1", facet: "login", find: { kind: "nonsense", pattern: "x" } },
      { id: "r2", facet: "login", find: { kind: "pattern" } },
      { id: "r3", facet: "login", find: { kind: "symbol", name: "" } },
      { id: "", facet: "login", find: { kind: "pattern", pattern: "x" } },
      { id: "r5", facet: "login", find: { kind: "pattern", pattern: "keeper" } },
    ])
    expect(lens.rules!.map((r) => r.id)).toEqual(["r5"])
    expect(lens.facets.length).toBe(2)
  })

  test("truncates past MAX_RULES", async () => {
    const many = Array.from({ length: MAX_RULES + 5 }, (_, i) => ({
      id: `r${i}`,
      facet: "login",
      find: { kind: "pattern", pattern: `p${i}` },
    }))
    const lens = await seed(many)
    expect(lens.rules!.length).toBe(MAX_RULES)
  })

  test("merging facets carries a rule onto the survivor rather than orphaning it", async () => {
    const lens = await seed([{ id: "r1", facet: "login", find: { kind: "pattern", pattern: "signIn" } }])
    await Effect.runPromise(ApertureLensStore.mergeFacets(dir, lens.id, "login", "tokens"))
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    const updated = all.find((l) => l.id === lens.id)!
    // Without the rewrite, normalizeRules would drop this on the very next read: a cosmetic
    // merge would silently destroy a query an agent had to think to write.
    expect(updated.rules!.map((r) => r.facet)).toEqual(["tokens"])
  })
})

// S2: lens_mark's store half. `mark` mints a concern and appends its rule in ONE write, and
// `createSearch` mints the Lens, its first concern and its first rule together — so a refused
// mark can never leave an empty concern or an empty Lens behind.
describe("aperture lens-store — mark / unmark (S2)", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aperture-mark-"))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const PATTERN = { kind: "pattern" as const, pattern: "withRetry\\(" }
  const searchInput = {
    name: "Retry Handling",
    description: "Where retries happen",
    facet: { label: "retry-path", description: "the retry path" },
    rule: { find: PATTERN },
  }

  test("createSearch writes a search Lens with its first concern and rule", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    expect(created.lens.search).toBe(true)
    expect(created.lens.scope).toBe("project")
    expect(created.facet.ruleOnly).toBe(true)
    expect(created.rule.facet).toBe("retry-path")

    // It has to survive the migrate() pass every read goes through — normalizeRules is total
    // and drops anything it doesn't recognise, so a rule this store wrote itself must not be
    // one of those things.
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    const back = all.find((l) => l.id === created.lens.id)!
    expect(back.search).toBe(true)
    expect(back.rules!.map((r) => r.id)).toEqual([created.rule.id])
    expect(back.facets[0]!.ruleOnly).toBe(true)
  })

  test("a second concern takes the next colour and does not move the first", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    const firstColor = created.facet.color
    const marked = await Effect.runPromise(
      ApertureLensStore.mark(dir, created.lens.id, {
        facet: "any-casts",
        find: { kind: "pattern", pattern: "as any" },
      }),
    )
    expect(marked.status).toBe("ok")
    if (marked.status !== "ok") return
    expect(marked.minted).toBe(true)
    // Append stability is the whole reason colour-by-index is tolerable: the concern the user
    // is already looking at must not change hue because another one was added.
    expect(marked.lens.facets[0]!.color).toBe(firstColor)
    expect(marked.lens.facets[1]!.color).not.toBe(firstColor)
  })

  test("re-marking an identical finder replaces rather than duplicating", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    const again = await Effect.runPromise(
      ApertureLensStore.mark(dir, created.lens.id, { facet: "retry-path", find: PATTERN, note: "second thoughts" }),
    )
    expect(again.status).toBe("ok")
    if (again.status !== "ok") return
    // The rule id is a content hash of the finder, so the same query lands on the same id.
    expect(again.replaced?.id).toBe(created.rule.id)
    expect(again.minted).toBe(false)
    expect(again.lens.rules!.length).toBe(1)
    expect(again.lens.rules![0]!.note).toBe("second thoughts")
  })

  test("an existing facet id or label adds a rule without minting", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    const byLabel = await Effect.runPromise(
      ApertureLensStore.mark(dir, created.lens.id, {
        facet: "RETRY-PATH",
        find: { kind: "symbol", name: "retryWithBackoff" },
      }),
    )
    expect(byLabel.status).toBe("ok")
    if (byLabel.status !== "ok") return
    expect(byLabel.minted).toBe(false)
    expect(byLabel.lens.facets.length).toBe(1)
    expect(byLabel.lens.rules!.length).toBe(2)
  })

  test("marking an Overview Lens mints a rule-owned facet and stays non-structural", async () => {
    const lens = await Effect.runPromise(ApertureLensStore.create(dir, CREATE))
    const marked = await Effect.runPromise(
      ApertureLensStore.mark(dir, lens.id, { facet: "any-casts", find: { kind: "pattern", pattern: "as any" } }),
    )
    expect(marked.status).toBe("ok")
    if (marked.status !== "ok") return
    expect(marked.facet.ruleOnly).toBe(true)

    // The point of ruleOnly: a later lens_edit must not read this as a facet the painter
    // gained, because `structural` costs a whole-repo repaint of the Lens and every descendant.
    const edited = await Effect.runPromise(
      ApertureLensStore.update(dir, lens.id, { facets: CREATE.facets.map((f) => ({ ...f })) }),
    )
    expect(edited!.structural).toBe(false)
    // And it survives that edit, which restates the whole facet list and cannot express the flag.
    expect(edited!.lens.facets.find((f) => f.id === "any-casts")?.ruleOnly).toBe(true)
    expect(edited!.lens.rules!.length).toBe(1)
  })

  test("refuses a built-in without writing a shadow entry into the project doc", async () => {
    const result = await Effect.runPromise(ApertureLensStore.mark(dir, ARCHITECTURE_ID, { facet: "x", find: PATTERN }))
    expect(result.status).toBe("builtin")
    // The failure this guards is invisible rather than noisy: a project entry keyed
    // `architecture` would be shadowed by the built-in on every read, so the rule would be
    // persisted, unreachable and unexplainable.
    const file = path.join(dir, ".opencode", "aperture", "lenses.json")
    const onDisk = await fs.readFile(file, "utf8").catch(() => "{}")
    expect(JSON.parse(onDisk)[ARCHITECTURE_ID]).toBeUndefined()
  })

  test("refuses past MAX_FACETS rather than wrapping the palette", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    for (let i = 1; i < MAX_FACETS; i++) {
      const r = await Effect.runPromise(
        ApertureLensStore.mark(dir, created.lens.id, { facet: `c${i}`, find: { kind: "pattern", pattern: `p${i}` } }),
      )
      expect(r.status).toBe("ok")
    }
    const over = await Effect.runPromise(
      ApertureLensStore.mark(dir, created.lens.id, { facet: "one-too-many", find: { kind: "pattern", pattern: "z" } }),
    )
    expect(over).toEqual({ status: "facet-cap", max: MAX_FACETS })
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.find((l) => l.id === created.lens.id)!.facets.length).toBe(MAX_FACETS)
  })

  test("refuses past MAX_RULES instead of letting normalizeRules truncate silently", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    for (let i = 1; i < MAX_RULES; i++) {
      const r = await Effect.runPromise(
        ApertureLensStore.mark(dir, created.lens.id, {
          facet: "retry-path",
          find: { kind: "pattern", pattern: `p${i}` },
        }),
      )
      expect(r.status).toBe("ok")
    }
    // Without this cap the append would report success and then vanish on the next read, since
    // migrate()'s normalizeRules stops at MAX_RULES without saying so.
    const over = await Effect.runPromise(
      ApertureLensStore.mark(dir, created.lens.id, { facet: "retry-path", find: { kind: "pattern", pattern: "last" } }),
    )
    expect(over).toEqual({ status: "rule-cap", max: MAX_RULES })
  })

  test("unmark by rule id removes just that rule", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    const second = await Effect.runPromise(
      ApertureLensStore.mark(dir, created.lens.id, { facet: "retry-path", find: { kind: "symbol", name: "retry" } }),
    )
    if (second.status !== "ok") throw new Error("setup failed")
    const result = await Effect.runPromise(ApertureLensStore.unmark(dir, created.lens.id, { rule: created.rule.id }))
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.removedRules.map((r) => r.id)).toEqual([created.rule.id])
    expect(result.lens.rules!.map((r) => r.id)).toEqual([second.rule.id])
    expect(result.lens.facets.length).toBe(1)
  })

  test("unmark by facet takes its rules with it and reports the recolour", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    const second = await Effect.runPromise(
      ApertureLensStore.mark(dir, created.lens.id, {
        facet: "any-casts",
        find: { kind: "pattern", pattern: "as any" },
      }),
    )
    if (second.status !== "ok") throw new Error("setup failed")
    const secondColor = second.facet.color

    const result = await Effect.runPromise(ApertureLensStore.unmark(dir, created.lens.id, { facet: "retry-path" }))
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.removedFacet?.id).toBe("retry-path")
    // Rules follow the facet: leaving them would mean normalizeRules dropping them on the next
    // read, i.e. the same deletion but silent.
    expect(result.removedRules.map((r) => r.id)).toEqual([created.rule.id])
    expect(result.lens.rules!.map((r) => r.id)).toEqual([second.rule.id])
    // Colour is derived from position, so removing a non-last concern re-hues the survivors —
    // reported so lens_unmark can tell the user rather than letting the legend shift silently.
    expect(result.recolored).toEqual([
      { facet: "any-casts", label: "any-casts", from: secondColor, to: result.lens.facets[0]!.color },
    ])
  })

  test("unmark reports an unknown rule or concern without touching the Lens", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    expect(await Effect.runPromise(ApertureLensStore.unmark(dir, created.lens.id, { rule: "nope" }))).toEqual({
      status: "unknown-rule",
      rule: "nope",
    })
    expect(await Effect.runPromise(ApertureLensStore.unmark(dir, created.lens.id, { facet: "nope" }))).toEqual({
      status: "unknown-facet",
      facet: "nope",
    })
  })

  test("a Search Lens survives an edit at zero facets", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    await Effect.runPromise(ApertureLensStore.unmark(dir, created.lens.id, { facet: "retry-path" }))
    // `update` used to Effect.die on an empty facet list, which would kill the fiber on
    // something as innocent as a rename. Zero concerns is a reachable state for a Search Lens.
    const renamed = await Effect.runPromise(ApertureLensStore.update(dir, created.lens.id, { name: "Renamed" }))
    expect(renamed!.lens.name).toBe("Renamed")
    expect(renamed!.lens.facets).toEqual([])
  })

  test("concurrent marks all land", async () => {
    const created = await Effect.runPromise(ApertureLensStore.createSearch(dir, searchInput))
    // Every mutation is a read-modify-write over one file. Unserialized, the losers of the race
    // write stale content and their rules vanish with no error anywhere — and the `lens`
    // subagent holds lens_mark too, so a primary marking while a subagent marks is reachable.
    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 8 }, (_, i) =>
          ApertureLensStore.mark(dir, created.lens.id, {
            facet: "retry-path",
            find: { kind: "pattern", pattern: `p${i}` },
          }),
        ),
        { concurrency: "unbounded" },
      ),
    )
    const all = await Effect.runPromise(ApertureLensStore.list(dir))
    expect(all.find((l) => l.id === created.lens.id)!.rules!.length).toBe(9)
  })
})
