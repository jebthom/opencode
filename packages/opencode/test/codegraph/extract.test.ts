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

// A small single-layer fixture: top-level source files (with a relative TS
// import between them and an ignored package import), top-level Python files
// with a relative import, plus directories that must appear as collapsed nodes
// without their contents being walked.
const SAMPLE = {
  "index.ts": `import { a } from "./a"\nimport _ from "lodash"\n`,
  "a.ts": `export const a = 1\n`,
  "main.py": `from .util import helper\nimport os\n`,
  "util.py": `def helper(): pass\n`,
  // Nested content lives under directories that should be collapsed; these files
  // must never appear as nodes nor produce edges at the single-layer depth.
  "src/deep.ts": `export const deep = 1\n`,
  "pkg/nested.py": `def nested(): pass\n`,
}

const nodeByPath = (payload: CodeGraphPayload.Payload, p: string) => payload.nodes.find((n) => n.path === p)
const edgeBetween = (payload: CodeGraphPayload.Payload, from: string, to: string) => {
  const f = nodeByPath(payload, from)
  const t = nodeByPath(payload, to)
  return payload.edges.find((e) => e.from === f?.id && e.to === t?.id)
}

describe("CodeGraph.extract", () => {
  it.live("produces nodes for top-level files and directories only", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(payload.version).toBe(CodeGraphPayload.PAYLOAD_VERSION)
      const paths = payload.nodes.map((n) => n.path).toSorted()
      // Top-level source files + collapsed top-level directories. Nothing below
      // the first layer (e.g. src/deep.ts, pkg/nested.py) is enumerated.
      expect(paths).toEqual(["a.ts", "index.ts", "main.py", "pkg", "src", "util.py"])

      expect(nodeByPath(payload, "src")!.kind).toBe("directory")
      expect(nodeByPath(payload, "index.ts")!.kind).toBe("file")
    }),
  )

  it.live("does not walk into top-level directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(payload.nodes.some((n) => n.path.includes("/"))).toBe(false)
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

  it.live("places every node on the single top-level layer", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(payload.nodes.every((n) => n.position.layer === 0)).toBe(true)
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
