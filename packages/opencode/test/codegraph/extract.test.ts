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

// A small fixture exercising: nested dirs, a relative TS import (with extension
// resolution), a package import (must NOT become an edge), and a Python
// relative import.
const SAMPLE = {
  "src/index.ts": `import { a } from "./lib/a"\nimport _ from "lodash"\n`,
  "src/lib/a.ts": `export const a = 1\n`,
  "pkg/main.py": `from .util import helper\nimport os\n`,
  "pkg/util.py": `def helper(): pass\n`,
}

const nodeByPath = (payload: CodeGraphPayload.Payload, p: string) => payload.nodes.find((n) => n.path === p)
const edgeBetween = (payload: CodeGraphPayload.Payload, from: string, to: string) => {
  const f = nodeByPath(payload, from)
  const t = nodeByPath(payload, to)
  return payload.edges.find((e) => e.from === f?.id && e.to === t?.id)
}

describe("CodeGraph.extract", () => {
  it.live("produces nodes for files and ancestor directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(payload.version).toBe(CodeGraphPayload.PAYLOAD_VERSION)
      const paths = payload.nodes.map((n) => n.path).toSorted()
      expect(paths).toEqual(["pkg", "pkg/main.py", "pkg/util.py", "src", "src/index.ts", "src/lib", "src/lib/a.ts"])

      expect(nodeByPath(payload, "src")!.kind).toBe("directory")
      expect(nodeByPath(payload, "src/index.ts")!.kind).toBe("file")
    }),
  )

  it.live("resolves relative TS imports and ignores package imports", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(edgeBetween(payload, "src/index.ts", "src/lib/a.ts")).toBeDefined()
      // "lodash" is external — no node, no edge.
      expect(payload.nodes.some((n) => n.path.includes("lodash"))).toBe(false)
    }),
  )

  it.live("resolves Python relative imports", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(edgeBetween(payload, "pkg/main.py", "pkg/util.py")).toBeDefined()
    }),
  )

  it.live("assigns layer by directory depth", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      expect(nodeByPath(payload, "src")!.position.layer).toBe(0)
      expect(nodeByPath(payload, "src/index.ts")!.position.layer).toBe(1)
      expect(nodeByPath(payload, "src/lib/a.ts")!.position.layer).toBe(2)
    }),
  )

  it.live("aggregates directory size from descendant files", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, SAMPLE)
      const payload = yield* CodeGraphExtract.extract(dir)

      const srcLib = nodeByPath(payload, "src/lib")!
      const a = nodeByPath(payload, "src/lib/a.ts")!
      expect(srcLib.size).toBe(a.size)
      expect(a.size).toBeGreaterThan(0)
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
