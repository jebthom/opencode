import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ApertureLensStore } from "@/aperture/lens-store"
import { ARCHITECTURE_ID, BUILTIN_LENSES, MAX_RULES } from "@/aperture/lenses"

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
