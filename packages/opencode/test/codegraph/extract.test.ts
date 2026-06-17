import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "path"
import { CodeGraphExtract } from "@/codegraph/extract"
import { CodeGraphPayload } from "@/codegraph/payload"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(Layer.mergeAll(FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))

const writeFiles = Effect.fnUntraced(function* (root: string, files: Record<string, string>) {
  const fs = yield* FSUtil.Service
  for (const [rel, content] of Object.entries(files)) {
    yield* fs.writeWithDirs(path.join(root, rel), content)
  }
})

// A small fixture spanning three directory layers. The extractor draws a 2-level
// window (scope's children + grandchildren), so layer 0/1 content is visible and
// anything at layer 2 (e.g. src/sub/too-deep.ts) must be excluded — its parent
// directory (src/sub) appears as a collapsed node instead.
const SAMPLE = {
  "index.ts": `import { a } from "./a"\nimport _ from "lodash"\n`,
  "a.ts": `export const a = 1\n`,
  "main.py": `from .util import helper\nimport os\n`,
  "util.py": `def helper(): pass\n`,
  // Grandchildren (layer 1 from the repo root) — now visible.
  "src/deep.ts": `export const deep = 1\n`,
  "pkg/nested.py": `def nested(): pass\n`,
  // Layer 2 — past the window. src/sub is a collapsed node; its file is excluded.
  "src/sub/too-deep.ts": `export const tooDeep = 1\n`,
}

const nodeByPath = (payload: CodeGraphPayload.Payload, p: string) => payload.nodes.find((n) => n.path === p)
const boundaryByPath = (payload: CodeGraphPayload.Payload, p: string) =>
  (payload.boundaries ?? []).find((b) => b.path === p)
const edgeBetween = (payload: CodeGraphPayload.Payload, from: string, to: string) => {
  const f = nodeByPath(payload, from)
  const t = nodeByPath(payload, to)
  return payload.edges.find((e) => e.from === f?.id && e.to === t?.id)
}

// A scoped window (src) whose file reaches *out* of the window via a relative
// import. lib/helper.ts is one hop outside src; lib/deep/more.ts is a second hop,
// reachable only by parsing the boundary file — which step 6 must never do.
const CROSS_DIR = {
  "src/app.ts": `import { h } from "../lib/helper"\nimport { u } from "./util"\n`,
  "src/util.ts": `export const u = 1\n`,
  "lib/helper.ts": `import { m } from "./deep/more"\nexport const h = 1\n`,
  "lib/deep/more.ts": `export const m = 1\n`,
}

describe("CodeGraph.extract", () => {
  it.live("produces nodes for the scope's children and grandchildren", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(payload.version).toBe(CodeGraphPayload.PAYLOAD_VERSION)
      const paths = payload.nodes.map((n) => n.path).toSorted()
      // Layer 0 (top-level files + dirs) and layer 1 (their children). The
      // collapsed grandchild dir src/sub appears, but nothing at layer 2.
      expect(paths).toEqual([
        "a.ts",
        "index.ts",
        "main.py",
        "pkg",
        "pkg/nested.py",
        "src",
        "src/deep.ts",
        "src/sub",
        "util.py",
      ])

      expect(nodeByPath(payload, "src")!.kind).toBe("directory")
      expect(nodeByPath(payload, "src/sub")!.kind).toBe("directory")
      expect(nodeByPath(payload, "index.ts")!.kind).toBe("file")
    }),
  )

  it.live("stops at the view depth (no layer-2 content)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      // src/sub is shown as a collapsed node; its contents are not walked.
      expect(nodeByPath(payload, "src/sub/too-deep.ts")).toBeUndefined()
    }),
  )

  it.live("resolves relative TS imports and ignores package imports", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(edgeBetween(payload, "index.ts", "a.ts")).toBeDefined()
      // "lodash" is external — no node, no edge.
      expect(payload.nodes.some((n) => n.path.includes("lodash"))).toBe(false)
    }),
  )

  it.live("resolves Python relative imports", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(edgeBetween(payload, "main.py", "util.py")).toBeDefined()
    }),
  )

  it.live("places nodes on scope-relative layers (0 for children, 1 for grandchildren)", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(nodeByPath(payload, "index.ts")!.position.layer).toBe(0)
      expect(nodeByPath(payload, "src")!.position.layer).toBe(0)
      expect(nodeByPath(payload, "src/deep.ts")!.position.layer).toBe(1)
      expect(nodeByPath(payload, "src/sub")!.position.layer).toBe(1)
    }),
  )

  it.live("re-roots at a scope: paths stay repo-relative, layers are scope-relative", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir, { scope: "src" })

      const paths = payload.nodes.map((n) => n.path).toSorted()
      // The window now slides to src: its direct children src/deep.ts and src/sub
      // (layer 0) plus the grandchild src/sub/too-deep.ts (layer 1) — content that
      // was past the window from the root view. Paths stay repo-relative.
      expect(paths).toEqual(["src/deep.ts", "src/sub", "src/sub/too-deep.ts"])
      expect(nodeByPath(payload, "src/deep.ts")!.position.layer).toBe(0)
      expect(nodeByPath(payload, "src/sub")!.position.layer).toBe(0)
      expect(nodeByPath(payload, "src/sub/too-deep.ts")!.position.layer).toBe(1)

      // A file's id is stable whether seen from the root or from a sub-scope.
      const root = yield* CodeGraphExtract.extract(dir)
      expect(nodeByPath(payload, "src/deep.ts")!.id).toBe(nodeByPath(root, "src/deep.ts")!.id)
    }),
  )

  it.live("returns an empty payload for a non-existent scope", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir, { scope: "does/not/exist" })

      expect(payload.nodes).toEqual([])
      expect(payload.edges).toEqual([])
    }),
  )

  it.live("is deterministic: identical input yields identical output", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)

      const first = yield* CodeGraphExtract.extract(dir)
      const second = yield* CodeGraphExtract.extract(dir)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    }),
  )

  it.live("emits one-hop boundary nodes for out-of-window imports, but not transitive ones", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, CROSS_DIR)
      const payload = yield* CodeGraphExtract.extract(dir, { scope: "src" })

      // The window holds only src's files; lib/* is outside it.
      expect(payload.nodes.map((n) => n.path).toSorted()).toEqual(["src/app.ts", "src/util.ts"])

      // The one-hop import target appears as a boundary (not a placed node), and
      // the edge from the importer points at it.
      const helper = boundaryByPath(payload, "lib/helper.ts")
      expect(helper).toBeDefined()
      expect(helper!.kind).toBe("file")
      expect(nodeByPath(payload, "lib/helper.ts")).toBeUndefined()
      const appID = nodeByPath(payload, "src/app.ts")!.id
      expect(payload.edges.find((e) => e.from === appID && e.to === helper!.id)).toBeDefined()

      // The second hop (lib/helper.ts → lib/deep/more.ts) is never resolved: we
      // don't parse the boundary file, so repo-wide/transitive targets stay out.
      expect(boundaryByPath(payload, "lib/deep/more.ts")).toBeUndefined()
      expect(nodeByPath(payload, "lib/deep/more.ts")).toBeUndefined()

      // An in-window relative import is still a normal edge, never a boundary.
      expect(edgeBetween(payload, "src/app.ts", "src/util.ts")).toBeDefined()
      expect(boundaryByPath(payload, "src/util.ts")).toBeUndefined()
    }),
  )

  it.live("emits no boundaries when every import resolves in-window", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      // SAMPLE's imports (./a, .util) all resolve inside the root window.
      expect(payload.boundaries).toEqual([])
    }),
  )

  it.live("ignores node_modules and similar directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        ...SAMPLE,
        "node_modules/dep/index.js": `module.exports = {}\n`,
      })
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(payload.nodes.some((n) => n.path.includes("node_modules"))).toBe(false)
    }),
  )
})

describe("CodeGraph.listFiles", () => {
  it.live("enumerates every source file in the repo, past the 2-level window", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const files = yield* CodeGraphExtract.listFiles(dir)
      const paths = files.map((f) => f.path)

      // Unlike extract's window, the deep layer-2 file is included.
      expect(paths).toContain("src/sub/too-deep.ts")
      expect(paths).toContain("index.ts")
      expect(paths).toContain("pkg/nested.py")
      // Directories are not files, so they never appear here.
      expect(paths).not.toContain("src")
    }),
  )

  it.live("skips ignored directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        ...SAMPLE,
        "node_modules/dep/index.js": `module.exports = {}\n`,
        "dist/bundle.js": `export const x = 1\n`,
      })
      const files = yield* CodeGraphExtract.listFiles(dir)

      expect(files.some((f) => f.path.includes("node_modules"))).toBe(false)
      expect(files.some((f) => f.path.startsWith("dist/"))).toBe(false)
    }),
  )

  it.live("assigns each file the same stable id extract would", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const listed = yield* CodeGraphExtract.listFiles(dir)
      const payload = yield* CodeGraphExtract.extract(dir)

      // A file visible in both the root window and the full listing must carry an
      // identical id, so a sweep-time tag is reused when the file is later viewed.
      const indexListed = listed.find((f) => f.path === "index.ts")
      const indexNode = nodeByPath(payload, "index.ts")
      expect(indexListed?.id).toBe(indexNode?.id)
    }),
  )
})

describe("CodeGraph.dfsCompare", () => {
  it.live("orders paths in DFS pre-order: a directory's files before its subtrees", () =>
    Effect.sync(() => {
      // src/a.ts must come before everything under src/sub/, and src/* before pkg/*.
      const input = ["src/sub/deep.ts", "pkg/x.ts", "src/a.ts", "src/b.ts", "src/sub/also.ts"]
      const sorted = [...input].sort(CodeGraphExtract.dfsCompare)
      expect(sorted).toEqual(["pkg/x.ts", "src/a.ts", "src/b.ts", "src/sub/also.ts", "src/sub/deep.ts"])
    }),
  )

  it.live("places a file in a directory before descending into a sibling subdir", () =>
    Effect.sync(() => {
      const sorted = ["src/z/inner.ts", "src/a.ts"].sort(CodeGraphExtract.dfsCompare)
      expect(sorted).toEqual(["src/a.ts", "src/z/inner.ts"])
    }),
  )
})

describe("CodeGraph.listFilesDfs", () => {
  it.live("enumerates the whole repo in DFS order with the same ids as listFiles", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const dfs = yield* CodeGraphExtract.listFilesDfs(dir)
      const flat = yield* CodeGraphExtract.listFiles(dir)

      // Same set of files + identical stable ids — only the order differs.
      expect(new Set(dfs.map((f) => f.path))).toEqual(new Set(flat.map((f) => f.path)))
      const dfsById = new Map(dfs.map((f) => [f.path, f.id]))
      for (const f of flat) expect(dfsById.get(f.path)).toBe(f.id)

      // The deep layer-2 file is included, and src/deep.ts precedes src/sub/too-deep.ts.
      const paths = dfs.map((f) => f.path)
      expect(paths).toContain("src/sub/too-deep.ts")
      expect(paths.indexOf("src/deep.ts")).toBeLessThan(paths.indexOf("src/sub/too-deep.ts"))
    }),
  )
})

describe("CodeGraph.listSubtree", () => {
  it.live("enumerates the full subtree with sizes and stable ids", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const files = yield* CodeGraphExtract.listSubtree(dir)
      const byPath = new Map(files.map((f) => [f.path, f]))

      // Full depth (past the 2-level window) with non-zero sizes for real files.
      expect(byPath.has("src/sub/too-deep.ts")).toBe(true)
      expect(byPath.get("index.ts")!.size).toBeGreaterThan(0)
      // Ids match what extract assigns, so composition can be keyed off the window.
      const payload = yield* CodeGraphExtract.extract(dir)
      expect(byPath.get("index.ts")!.id).toBe(nodeByPath(payload, "index.ts")!.id)
    }),
  )

  it.live("re-roots at a scope: paths stay repo-relative, only the subtree is walked", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const files = yield* CodeGraphExtract.listSubtree(dir, "src")
      const paths = files.map((f) => f.path).toSorted()

      // Only src's subtree, repo-relative; nothing from siblings like pkg/ or root.
      expect(paths).toEqual(["src/deep.ts", "src/sub/too-deep.ts"])
    }),
  )

  it.live("skips ignored directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        ...SAMPLE,
        "node_modules/dep/index.js": `module.exports = {}\n`,
      })
      const files = yield* CodeGraphExtract.listSubtree(dir)

      expect(files.some((f) => f.path.includes("node_modules"))).toBe(false)
    }),
  )
})
