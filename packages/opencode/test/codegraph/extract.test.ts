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
const edgeBetween = (payload: CodeGraphPayload.Payload, from: string, to: string) => {
  const f = nodeByPath(payload, from)
  const t = nodeByPath(payload, to)
  return payload.edges.find((e) => e.from === f?.id && e.to === t?.id)
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
