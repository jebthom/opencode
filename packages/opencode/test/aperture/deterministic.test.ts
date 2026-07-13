import { describe, expect, test } from "bun:test"
import { ApertureDeterministic } from "@/aperture/deterministic"
import { RECENCY_FACET_IDS, BUS_FACTOR_FACET_IDS, CHANGE_FACET_IDS, NONE_FACET } from "@/aperture/lenses"

const file = (id: string, path: string, mtime = 0, size = 10): ApertureDeterministic.SubtreeFile => ({
  id,
  path,
  size,
  mtime,
})

describe("deterministic git-changed", () => {
  const subtree = [file("n1", "src/a.ts"), file("n2", "src/b.ts"), file("n3", "src/c.ts")]
  const [CH_1, CH_10, CH_25, CH_50, CH_100] = CHANGE_FACET_IDS

  test("tags only files in the working-tree change set as changed, bridging the repo prefix", () => {
    // git reports repo-root-relative paths; the directory's prefix maps subtree paths onto them.
    const store = ApertureDeterministic.computeStore("git-changed", subtree, {
      git: { prefix: "pkg/app/", changed: new Map([["pkg/app/src/a.ts", 3], ["pkg/app/src/c.ts", 40]]) },
    })
    expect(store["n1"]!.facet).toBe(CH_1)
    expect(store["n2"]!.facet).toBe("unchanged")
    expect(store["n3"]!.facet).toBe(CH_25)
  })

  test("buckets a changed file by its line churn (added + deleted)", () => {
    const store = ApertureDeterministic.computeStore("git-changed", subtree, {
      git: { prefix: "", changed: new Map([["src/a.ts", 0], ["src/b.ts", 24], ["src/c.ts", 500]]) },
    })
    expect(store["n1"]!.facet).toBe(CH_1) // churn 0 (e.g. mode-only) → smallest band
    expect(store["n2"]!.facet).toBe(CH_10) // 24 → 10–24 band
    expect(store["n3"]!.facet).toBe(CH_100) // 500 → 100+ band
  })

  test("bucket edges are lower-inclusive of the next band (9→<10, 10→10-24, 50→50-99, 100→100+)", () => {
    const edges = [file("a", "a.ts"), file("b", "b.ts"), file("c", "c.ts"), file("d", "d.ts"), file("e", "e.ts")]
    const store = ApertureDeterministic.computeStore("git-changed", edges, {
      git: { prefix: "", changed: new Map([["a.ts", 9], ["b.ts", 10], ["c.ts", 49], ["d.ts", 50], ["e.ts", 100]]) },
    })
    expect(store["a"]!.facet).toBe(CH_1)
    expect(store["b"]!.facet).toBe(CH_10)
    expect(store["c"]!.facet).toBe(CH_25)
    expect(store["d"]!.facet).toBe(CH_50)
    expect(store["e"]!.facet).toBe(CH_100)
  })

  test("no prefix (repo root) and empty/absent change set", () => {
    const atRoot = ApertureDeterministic.computeStore("git-changed", subtree, {
      git: { prefix: "", changed: new Map([["src/b.ts", 12]]) },
    })
    expect(atRoot["n2"]!.facet).toBe(CH_10)
    expect(atRoot["n1"]!.facet).toBe("unchanged")
    // Missing git info → everything unchanged rather than throwing.
    const none = ApertureDeterministic.computeStore("git-changed", subtree, {})
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

describe("deterministic bus-factor", () => {
  const [BUS_1, BUS_2, BUS_3, BUS_5] = BUS_FACTOR_FACET_IDS

  // Build a GitAuthorship from a plain { path: { author: lines } } literal.
  const authorship = (
    prefix: string,
    byPath: Record<string, Record<string, number>>,
  ): ApertureDeterministic.GitAuthorship => ({
    prefix,
    byPath: new Map(Object.entries(byPath).map(([p, a]) => [p, new Map(Object.entries(a))])),
  })

  test("buckets files by distinct significant-author count (warm→cool)", () => {
    const subtree = [
      file("solo", "solo.ts"),
      file("duo", "duo.ts"),
      file("trio", "trio.ts"),
      file("quad", "quad.ts"),
      file("five", "five.ts"),
      file("virgin", "virgin.ts"), // absent from history
    ]
    const store = ApertureDeterministic.computeStore("bus-factor", subtree, {
      authorship: authorship("", {
        "solo.ts": { Alice: 40 },
        "duo.ts": { Alice: 20, Bob: 20 },
        "trio.ts": { A: 10, B: 10, C: 10 },
        "quad.ts": { A: 10, B: 10, C: 10, D: 10 },
        "five.ts": { A: 10, B: 10, C: 10, D: 10, E: 10 },
      }),
    })
    expect(store["solo"]!.facet).toBe(BUS_1)
    expect(store["duo"]!.facet).toBe(BUS_2)
    expect(store["trio"]!.facet).toBe(BUS_3) // 3 → 3–4 bucket
    expect(store["quad"]!.facet).toBe(BUS_3) // 4 → same bucket
    expect(store["five"]!.facet).toBe(BUS_5) // 5+ → safe bucket
    // No git history → grey, not bus-1.
    expect(store["virgin"]!.facet).toBe(NONE_FACET)
  })

  test("drive-by edits below the line floor don't inflate the count", () => {
    const subtree = [file("f", "f.ts")]
    // Alice owns the file; Bob/Carol each made a 2-line drive-by (< BUS_FACTOR_MIN_LINES).
    const store = ApertureDeterministic.computeStore("bus-factor", subtree, {
      authorship: authorship("", { "f.ts": { Alice: 200, Bob: 2, Carol: 2 } }),
    })
    expect(store["f"]!.facet).toBe(BUS_1)
  })

  test("many small equal contributors fall back to the raw count (not bus-1)", () => {
    const subtree = [file("f", "f.ts")]
    // Six authors, each only 1 line — none clears the floor, but this is well-spread, not a silo.
    const store = ApertureDeterministic.computeStore("bus-factor", subtree, {
      authorship: authorship("", { "f.ts": { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1 } }),
    })
    expect(store["f"]!.facet).toBe(BUS_5)
  })

  test("bridges the repo prefix like git-changed; missing authorship → all grey", () => {
    const subtree = [file("a", "src/a.ts"), file("b", "src/b.ts")]
    const store = ApertureDeterministic.computeStore("bus-factor", subtree, {
      authorship: authorship("pkg/app/", { "pkg/app/src/a.ts": { Alice: 10, Bob: 10 } }),
    })
    expect(store["a"]!.facet).toBe(BUS_2)
    expect(store["b"]!.facet).toBe(NONE_FACET) // not in history under the prefix
    // Absent authorship entirely → every file grey rather than throwing.
    const none = ApertureDeterministic.computeStore("bus-factor", subtree, {})
    expect(Object.values(none).every((e) => e.facet === NONE_FACET)).toBe(true)
  })

  test("parseAuthorship: per-file per-author churn from git log --numstat output", () => {
    // \x01 marks each commit's author; numstat rows are adds\tdels\tpath. Covers a binary row
    // (`-`), a rename arrow, and an author touching two files across two commits.
    const log = [
      "\x01Alice",
      "10\t2\tsrc/a.ts",
      "3\t0\tsrc/shared.ts",
      "",
      "\x01Bob",
      "-\t-\tassets/logo.png", // binary → counts as 1 touch
      "4\t1\tsrc/shared.ts",
      "\x01Alice",
      "5\t0\t{old => src}/b.ts", // rename → resolves to src/b.ts
    ].join("\n")
    const { prefix, byPath } = ApertureDeterministic.parseAuthorship(log, "repo/")
    expect(prefix).toBe("repo/")
    expect(byPath.get("src/a.ts")!.get("Alice")).toBe(12)
    expect(byPath.get("src/shared.ts")!.get("Alice")).toBe(3)
    expect(byPath.get("src/shared.ts")!.get("Bob")).toBe(5)
    expect(byPath.get("assets/logo.png")!.get("Bob")).toBe(1)
    expect(byPath.get("src/b.ts")!.get("Alice")).toBe(5)
  })
})
