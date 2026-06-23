import { describe, expect, test } from "bun:test"
import { ApertureDeterministic } from "@/aperture/deterministic"
import { RECENCY_FACET_IDS } from "@/aperture/lenses"

const file = (id: string, path: string, mtime = 0, size = 10): ApertureDeterministic.SubtreeFile => ({
  id,
  path,
  size,
  mtime,
})

describe("deterministic git-changed", () => {
  const subtree = [file("n1", "src/a.ts"), file("n2", "src/b.ts"), file("n3", "src/c.ts")]

  test("tags only files in the working-tree change set as changed, bridging the repo prefix", () => {
    // git reports repo-root-relative paths; the directory's prefix maps subtree paths onto them.
    const store = ApertureDeterministic.computeStore("git-changed", subtree, {
      prefix: "pkg/app/",
      changed: new Set(["pkg/app/src/a.ts", "pkg/app/src/c.ts"]),
    })
    expect(store["n1"]!.facet).toBe("changed")
    expect(store["n2"]!.facet).toBe("unchanged")
    expect(store["n3"]!.facet).toBe("changed")
  })

  test("no prefix (repo root) and empty/absent change set", () => {
    const atRoot = ApertureDeterministic.computeStore("git-changed", subtree, {
      prefix: "",
      changed: new Set(["src/b.ts"]),
    })
    expect(atRoot["n2"]!.facet).toBe("changed")
    expect(atRoot["n1"]!.facet).toBe("unchanged")
    // Missing git info → everything unchanged rather than throwing.
    const none = ApertureDeterministic.computeStore("git-changed", subtree, undefined)
    expect(Object.values(none).every((e) => e.facet ==="unchanged")).toBe(true)
  })
})

describe("deterministic mtime buckets", () => {
  test("equal time spans: a checkout-time majority shares bucket 0, recent edits climb to the warm end", () => {
    const base = 1_000_000
    // 5 files share one old mtime; one file is far newer (the recent edit).
    const subtree = [
      file("a", "src/a.ts", base),
      file("b", "src/b.ts", base),
      file("c", "src/c.ts", base),
      file("d", "src/d.ts", base),
      file("e", "src/e.ts", base),
      file("z", "src/z.ts", base + 600),
    ]
    const store = ApertureDeterministic.computeStore("mtime-buckets", subtree, undefined)
    // The clustered majority all land in the oldest bucket — "vast majority one colour".
    for (const id of ["a", "b", "c", "d", "e"]) expect(store[id]!.facet).toBe(RECENCY_FACET_IDS[0])
    // The single recent edit clamps into the newest (warm) bucket.
    expect(store["z"]!.facet).toBe(RECENCY_FACET_IDS[5])
  })

  test("all-equal mtime collapses to one colour; missing mtime (0) is treated as oldest", () => {
    const equal = [file("a", "a.ts", 5), file("b", "b.ts", 5), file("c", "c.ts", 5)]
    const store = ApertureDeterministic.computeStore("mtime-buckets", equal, undefined)
    expect(Object.values(store).every((e) => e.facet ===RECENCY_FACET_IDS[0])).toBe(true)

    // A file whose platform reports no mtime (0) is bucketed as oldest, not as a 1970 outlier
    // that would stretch the range over real files. The range is set by the real mtimes only.
    const withZero = [file("zero", "zero.ts", 0), file("old", "old.ts", 1000), file("new", "new.ts", 1600)]
    const s2 = ApertureDeterministic.computeStore("mtime-buckets", withZero, undefined)
    expect(s2["zero"]!.facet).toBe(RECENCY_FACET_IDS[0]) // clamped to the oldest real mtime
    expect(s2["old"]!.facet).toBe(RECENCY_FACET_IDS[0])
    expect(s2["new"]!.facet).toBe(RECENCY_FACET_IDS[5])
  })
})
