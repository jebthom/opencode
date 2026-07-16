import { describe, expect, it } from "bun:test"
import {
  inDomain,
  orderForest,
  scopeLabels,
  buildSystemPrompt,
  dependsOnDeterministic,
  NONE_FACET,
  MAX_LENS_DEPTH,
} from "@/aperture/lenses"
import type { Lens } from "@/aperture/lenses"
import { partitionByDomain, isStale } from "@/aperture/painter"
import type { Domain } from "@/aperture/painter"

// The drill-down domain gate: a Lens scoped to a subset of another Lens's facets. The
// guarantee under test is that a file the parent did NOT put in one of those facets can
// never reach the painter — it is bucketed into "Other" deterministically instead.

const lens = (id: string, facets: string[], parent?: { lens: string; facets: string[] }): Lens => ({
  id,
  name: id,
  description: id,
  prompt: `classify for ${id}`,
  scope: "project",
  facets: facets.map((f) => ({ id: f, label: f.toUpperCase(), description: `the ${f} facet`, color: "#000000" })),
  ...(parent ? { parent } : {}),
})

// A parent store entry: the facet the parent painted, plus (for a parent that is itself a
// drill-down) the grandparent facet that admitted the file.
const entry = (facet: string, via?: string) => ({ facet, hash: "h", ...(via ? { via } : {}) })

describe("inDomain", () => {
  const scope = new Set(["likely"])

  it("admits a file the parent painted into a scoped facet", () => {
    expect(inDomain(entry("likely"), scope)).toBe(true)
  })

  it("excludes a file the parent painted into an unscoped facet", () => {
    expect(inDomain(entry("unlikely"), scope)).toBe(false)
  })

  it("excludes a file the parent has not painted at all", () => {
    expect(inDomain(undefined, scope)).toBe(false)
  })

  it("lets a drill-down be scoped to the parent's own 'Other' bucket", () => {
    expect(inDomain(entry(NONE_FACET), new Set([NONE_FACET]))).toBe(true)
  })

  // The crux. A drill-down's store greys two different populations into NONE_FACET:
  // "outside my domain" and "inside it but fits none of my facets". Only `via` separates
  // them, and a grandchild scoped to "Other" means strictly the second.
  describe("when the parent is itself a drill-down", () => {
    const parentScope = new Set(["likely"])

    it("admits an in-parent-domain file that fit none of the parent's facets", () => {
      expect(inDomain(entry(NONE_FACET, "likely"), new Set([NONE_FACET]), parentScope)).toBe(true)
    })

    it("rejects a file the PARENT had already bucketed out, despite the identical facet", () => {
      // Same stored facet (NONE_FACET) as the case above — `via` is the only difference.
      expect(inDomain(entry(NONE_FACET, "unlikely"), new Set([NONE_FACET]), parentScope)).toBe(false)
    })

    it("rejects an entry with no witness at all (fails closed)", () => {
      expect(inDomain(entry(NONE_FACET), new Set([NONE_FACET]), parentScope)).toBe(false)
    })
  })
})

describe("the containment invariant", () => {
  // A grandchild resolves its domain from its parent's store ALONE — it never reads the
  // grandparent's. This asserts that shortcut is sound: the result is identical to
  // intersecting membership all the way up the chain.
  it("a grandchild reading only its parent's store excludes everything the grandparent did", () => {
    const grandparentScope = new Set(["likely"])
    const childScope = new Set([NONE_FACET])

    // The grandparent painted five files. The child (scoped to "likely") then produced its
    // own store: in-domain files got a child facet or NONE_FACET, out-of-domain files got
    // NONE_FACET — every entry carrying the grandparent facet that witnessed it.
    const grandparent = {
      a: entry("likely"),
      b: entry("likely"),
      c: entry("unlikely"),
      d: entry("unlikely"),
      e: entry("likely"),
    }
    const child = {
      a: entry("cpu", "likely"), // in-domain, fits a child facet
      b: entry(NONE_FACET, "likely"), // in-domain, fits none — a genuine "Other"
      c: entry(NONE_FACET, "unlikely"), // out of domain — bucketed, never modelled
      d: entry(NONE_FACET, "unlikely"), // out of domain
      e: entry("cpu", "likely"),
    }

    // What the grandchild admits, reading ONLY the child's store.
    const viaParentOnly = Object.entries(child)
      .filter(([, e]) => inDomain(e, childScope, grandparentScope))
      .map(([id]) => id)

    // What it *should* admit, walking the whole chain.
    const viaFullChain = Object.entries(child)
      .filter(([id, e]) => inDomain(grandparent[id as keyof typeof grandparent], grandparentScope) && e.facet === NONE_FACET)
      .map(([id]) => id)

    expect(viaParentOnly).toEqual(viaFullChain)
    expect(viaParentOnly).toEqual(["b"])
    // c and d are the trap: same stored facet as b, excluded only because of `via`.
    expect(viaParentOnly).not.toContain("c")
    expect(viaParentOnly).not.toContain("d")
  })
})

describe("partitionByDomain", () => {
  const node = (id: string) => ({ node: { id, path: `${id}.ts` }, hash: "h" })
  const domain = (allowed: string[], witness: Record<string, string>): Domain => ({
    parent: lens("parent", ["likely", "unlikely"]),
    witness: new Map(Object.entries(witness)),
    allowed: new Set(allowed),
  })

  it("never hands an out-of-domain file to the model", () => {
    const stale = [node("in"), node("out")]
    const { classify, bucket, skip } = partitionByDomain(
      stale,
      domain(["in"], { in: "likely", out: "unlikely" }),
    )
    expect(classify.map((r) => r.node.id)).toEqual(["in"])
    expect(bucket.map((r) => r.node.id)).toEqual(["out"])
    expect(skip).toEqual([])
  })

  // An unwitnessed file must be left ALONE, not bucketed: writing NONE_FACET would persist a
  // hash that matches forever after, so a file the parent merely failed to paint this pass
  // would be permanently mislabelled "Other" and never reconsidered.
  it("skips — never buckets — a file the parent failed to paint", () => {
    const { classify, bucket, skip } = partitionByDomain([node("ghost")], domain([], {}))
    expect(classify).toEqual([])
    expect(bucket).toEqual([])
    expect(skip.map((r) => r.node.id)).toEqual(["ghost"])
  })

  it("passes everything through for a root Lens (no domain)", () => {
    const stale = [node("a"), node("b")]
    const { classify, bucket, skip } = partitionByDomain(stale, undefined)
    expect(classify.length).toBe(2)
    expect(bucket).toEqual([])
    expect(skip).toEqual([])
  })
})

describe("isStale", () => {
  it("re-opens a file whose parent moved it to another facet, though its content is identical", () => {
    const painted = { facet: "cpu", hash: "h1", via: "likely" }
    expect(isStale(painted, "h1", "likely")).toBe(false)
    expect(isStale(painted, "h1", "unlikely")).toBe(true)
  })

  it("still re-opens on a content change, and treats an unpainted node as stale", () => {
    expect(isStale({ facet: "cpu", hash: "h1", via: "likely" }, "h2", "likely")).toBe(true)
    expect(isStale(undefined, "h1", "likely")).toBe(true)
  })

  it("ignores `via` for a root Lens", () => {
    expect(isStale({ facet: "domain", hash: "h1" }, "h1", undefined)).toBe(false)
  })
})

describe("orderForest", () => {
  const root = lens("root", ["a", "b"])
  const child = lens("child", ["x"], { lens: "root", facets: ["a"] })
  const grandchild = lens("grandchild", ["y"], { lens: "child", facets: ["x"] })
  const other = lens("other", ["z"])

  it("puts each drill-down immediately after the Lens it drills into", () => {
    const order = orderForest([root, other, grandchild, child])
    expect(order.map((e) => e.lens.id)).toEqual(["root", "child", "grandchild", "other"])
    expect(order.map((e) => e.depth)).toEqual([0, 1, 2, 0])
  })

  it("reports the ROOT's scope on every descendant, so the picker groups them together", () => {
    const builtinParent: Lens = { ...root, scope: "global" }
    const order = orderForest([builtinParent, child])
    expect(order.map((e) => e.rootScope)).toEqual(["global", "global"])
    // The child is still a project Lens in its own right (so it stays deletable).
    expect(order[1]!.lens.scope).toBe("project")
  })

  it("emits an orphan as a root rather than losing it", () => {
    const orphan = lens("orphan", ["q"], { lens: "deleted-lens", facets: ["a"] })
    const order = orderForest([root, orphan])
    expect(order.map((e) => e.lens.id).sort()).toEqual(["orphan", "root"])
    expect(order.find((e) => e.lens.id === "orphan")!.depth).toBe(0)
  })

  it("terminates on a hand-written cycle in lenses.json", () => {
    const a = lens("a", ["f"], { lens: "b", facets: ["f"] })
    const b = lens("b", ["f"], { lens: "a", facets: ["f"] })
    const order = orderForest([a, b])
    expect(order.map((e) => e.lens.id).sort()).toEqual(["a", "b"])
  })

  it("treats a chain deeper than MAX_LENS_DEPTH as broken instead of nesting it", () => {
    const chain: Lens[] = [lens("l0", ["f"])]
    for (let i = 1; i <= MAX_LENS_DEPTH + 1; i++)
      chain.push(lens(`l${i}`, ["f"], { lens: `l${i - 1}`, facets: ["f"] }))
    const order = orderForest(chain)
    expect(order.length).toBe(chain.length)
    expect(Math.max(...order.map((e) => e.depth))).toBeLessThanOrEqual(MAX_LENS_DEPTH)
  })
})

// Drives refresh's decision to drop the live-git/subtree caches. The case that matters is a
// drill-down of git-changed: it is semantic (the model paints it) but its domain gate reads
// the parent's store, which is recomputed from the repo every pass — so it depends on those
// caches exactly as its parent does. Testing only the active Lens left such a child painting
// against a pre-commit git status that ⟳ and the periodic poll could never clear.
describe("dependsOnDeterministic", () => {
  const det = (id: string): Lens => ({ ...lens(id, ["a", "b"]), scope: "global", deterministic: "git-changed" })
  const byId = (lenses: Lens[]) => new Map(lenses.map((l) => [l.id, l]))

  it("is true for a deterministic Lens itself", () => {
    const gitChanged = det("git-changed")
    expect(dependsOnDeterministic(gitChanged, byId([gitChanged]))).toBe(true)
  })

  it("is true for a drill-down of a deterministic Lens, which is itself semantic", () => {
    const gitChanged = det("git-changed")
    const child = lens("child", ["x"], { lens: "git-changed", facets: ["a"] })
    expect(child.deterministic).toBeUndefined()
    expect(dependsOnDeterministic(child, byId([gitChanged, child]))).toBe(true)
  })

  it("is true for a grandchild, whose parent fill still reaches live git state", () => {
    const gitChanged = det("git-changed")
    const child = lens("child", ["x"], { lens: "git-changed", facets: ["a"] })
    const grandchild = lens("grandchild", ["y"], { lens: "child", facets: ["x"] })
    expect(dependsOnDeterministic(grandchild, byId([gitChanged, child, grandchild]))).toBe(true)
  })

  it("is false for a purely semantic chain, which reads only the persisted store", () => {
    const root = lens("root", ["a"])
    const child = lens("child", ["x"], { lens: "root", facets: ["a"] })
    expect(dependsOnDeterministic(child, byId([root, child]))).toBe(false)
  })

  it("is false — not hung — on a hand-written cycle in lenses.json", () => {
    const a = lens("a", ["f"], { lens: "b", facets: ["f"] })
    const b = lens("b", ["f"], { lens: "a", facets: ["f"] })
    expect(dependsOnDeterministic(a, byId([a, b]))).toBe(false)
  })

  it("is false for an orphan whose parent was deleted", () => {
    const orphan = lens("orphan", ["q"], { lens: "deleted-lens", facets: ["a"] })
    expect(dependsOnDeterministic(orphan, byId([orphan]))).toBe(false)
  })

  it("stops at MAX_LENS_DEPTH rather than walking an over-deep chain to its root", () => {
    const chain: Lens[] = [det("l0")]
    for (let i = 1; i <= MAX_LENS_DEPTH + 1; i++)
      chain.push(lens(`l${i}`, ["f"], { lens: `l${i - 1}`, facets: ["f"] }))
    expect(dependsOnDeterministic(chain[chain.length - 1]!, byId(chain))).toBe(false)
    // ...but a chain within the cap still finds the deterministic root.
    expect(dependsOnDeterministic(chain[MAX_LENS_DEPTH]!, byId(chain))).toBe(true)
  })
})

describe("buildSystemPrompt", () => {
  const parent = lens("parent", ["likely", "unlikely"])
  const child = lens("child", ["cpu"], { lens: "parent", facets: ["likely"] })

  it("tells the painter its files are pre-filtered, so it classifies within the domain", () => {
    const prompt = buildSystemPrompt(child, parent)
    expect(prompt).toContain('"LIKELY"')
    expect(prompt).toContain('"parent"')
    expect(prompt).toContain("do not re-apply")
  })

  it("adds no domain note for a root Lens", () => {
    expect(buildSystemPrompt(parent)).not.toContain("already falls under")
  })

  it("renders a scope on the parent's 'Other' bucket by name", () => {
    expect(scopeLabels(parent, [NONE_FACET])).toEqual(["Other"])
  })
})
