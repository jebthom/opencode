import { Effect, Schema } from "effect"
import path from "path"
import { createHash } from "crypto"
import { generateObject } from "ai"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Log from "@opencode-ai/core/util/log"
import type { EventV2 } from "@opencode-ai/core/event"
import type { Storage } from "@/storage/storage"
import type { Provider } from "@/provider/provider"
import type { Config } from "@/config/config"
import { CodeGraphSemanticStore } from "./semantic-store"
import { CodeGraphEvent } from "./event"
import { CodeGraphSemantics, LAYERS, LAYER_DESCRIPTION, type Layer } from "./semantics"
import { CodeGraphExtract } from "./extract"

// Semantic tagger (PLAN.md step 4). Given the file nodes of a viewed scope, it
// infers one architectural layer per file with a small/fast model and writes the
// result to the per-project semantic store. It is the *only* place tokens are
// spent in the code-graph feature.
//
// Frugality is the whole point and comes from two rules:
//   1. Stale-only — a file is (re)tagged only when it has no stored entry or its
//      content hash changed. Re-displaying unchanged files spends nothing.
//   2. Minimal context — by default the model sees only the path, parsed import
//      specifiers, and the leading comment; agent-authored code is rarely named
//      pathologically, so that's usually enough to place a file. The `medium`
//      flag (config) adds exported names + the file head when tuning.
//
// Failure is soft: any read/model/parse error leaves existing semantics intact
// and publishes nothing, so the structure bar always keeps working.

const log = Log.create({ service: "codegraph.tagger" })

// Caps so a large window can never blow up a prompt or a single request: read at
// most this many stale files per pass, in chunks of this size per model call.
const MAX_PER_PASS = 60
const TAG_BATCH = 30
const READ_CONCURRENCY = 24
const MAX_FILE_BYTES = 512 * 1024
const HEAD_LINES = 30
const MAX_COMMENT_CHARS = 240

export interface FileNode {
  readonly id: string
  readonly path: string
}

export interface Deps {
  readonly storage: Storage.Interface
  readonly events: EventV2.Interface
  readonly provider: Provider.Interface
  readonly config: Config.Interface
}

const TagResult = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      layer: Schema.Literals(LAYERS),
    }),
  ),
})

// Tag any stale file node in `fileNodes` and persist the result. Requires only
// FSUtil from context (provided at the fork site); all other services are passed
// in so callers keep a clean `R = never` return type.
export const tagStale = Effect.fn("CodeGraph.tagStale")(function* (
  deps: Deps,
  directory: string,
  projectID: string,
  scope: string,
  fileNodes: ReadonlyArray<FileNode>,
) {
  if (fileNodes.length === 0) return

  const store = yield* CodeGraphSemanticStore.read(deps.storage, projectID)

  // Read + hash each candidate, keeping only those whose content changed (or were
  // never tagged). Files we can't read are simply skipped.
  const fs = yield* FSUtil.Service
  const read = yield* Effect.forEach(
    fileNodes,
    (node) =>
      fs
        .readFileStringSafe(path.join(directory, node.path))
        .pipe(
          Effect.map((content) => ({ node, content }) as { node: FileNode; content: string | undefined }),
          Effect.orElseSucceed(() => ({ node, content: undefined as string | undefined })),
        ),
    { concurrency: READ_CONCURRENCY },
  )

  const stale = read
    .filter((r): r is { node: FileNode; content: string } => typeof r.content === "string")
    .map((r) => ({ ...r, hash: hashContent(r.content) }))
    .filter((r) => store[r.node.id]?.hash !== r.hash)
    .slice(0, MAX_PER_PASS)

  if (stale.length === 0) return

  const context = yield* contextMode(deps.config)
  const language = yield* resolveLanguage(deps.provider)
  if (!language) {
    log.info("no small model available; skipping tag pass", { projectID, scope })
    return
  }

  // Path → its hash so we can record freshness on whatever the model returns.
  const hashByPath = new Map(stale.map((r) => [r.node.path, r.hash]))
  const idByPath = new Map(stale.map((r) => [r.node.path, r.node.id]))

  const tagged: CodeGraphSemanticStore.Store = {}
  for (const chunk of chunkArray(stale, TAG_BATCH)) {
    const blocks = chunk.map((r) => describe(r.node.path, r.content, context)).join("\n\n")
    const assignments = yield* classify(language, blocks).pipe(
      Effect.catchCause((cause) => {
        log.error("classify failed", { projectID, scope, cause })
        return Effect.succeed<ReadonlyArray<{ path: string; layer: Layer }>>([])
      }),
    )
    for (const a of assignments) {
      const id = idByPath.get(a.path)
      const hash = hashByPath.get(a.path)
      if (!id || !hash) continue
      tagged[id] = { layer: a.layer, hash }
    }
  }

  const count = Object.keys(tagged).length
  if (count === 0) return

  yield* CodeGraphSemanticStore.upsert(deps.storage, projectID, tagged)
  log.info("tagged", { projectID, scope, count })

  // Only now that something actually changed do we nudge the live view to refetch
  // and re-merge — the guard that keeps a tag→refetch→tag cycle from forming
  // (the next pass finds matching hashes and publishes nothing).
  yield* deps.events.publish(CodeGraphEvent.Event.Invalidated, { scope }).pipe(Effect.ignore)
}, Effect.provide(FSUtil.defaultLayer))

// --- model -----------------------------------------------------------------

// Resolve the small/fast model (Haiku-class by default, honors `small_model`).
function resolveLanguage(provider: Provider.Interface) {
  return Effect.gen(function* () {
    const def = yield* provider.defaultModel()
    const small = yield* provider.getSmallModel(def.providerID)
    if (!small) return undefined
    return yield* provider.getLanguage(small)
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
}

const SYSTEM = [
  "You assign each source file to exactly one architectural layer of a codebase.",
  "Layers:",
  ...LAYERS.map((l) => `- ${l}: ${LAYER_DESCRIPTION[l]}`),
  "Infer the layer from the file path, its imports, and its leading comment.",
  "Return one entry per input file, echoing its exact path.",
].join("\n")

const classify = (language: Parameters<typeof generateObject>[0]["model"], blocks: string) =>
  Effect.tryPromise(() =>
    generateObject({
      model: language,
      temperature: 0,
      schema: Object.assign(Schema.toStandardSchemaV1(TagResult), Schema.toStandardJSONSchemaV1(TagResult)),
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Classify these files:\n\n${blocks}` },
      ],
    }).then((r) => {
      const result = r.object as typeof TagResult.Type
      return result.files.filter((f): f is { path: string; layer: Layer } => CodeGraphSemantics.isLayer(f.layer))
    }),
  )

// --- per-file context ------------------------------------------------------

function contextMode(config: Config.Interface) {
  return config.get().pipe(
    Effect.map((cfg) => (cfg.codegraph?.tagger?.context === "medium" ? "medium" : "minimal") as "minimal" | "medium"),
    Effect.catchCause(() => Effect.succeed("minimal" as const)),
  )
}

// Compact textual context for one file. `minimal` = path + imports + leading
// comment; `medium` additionally includes exported names and the file head.
function describe(rel: string, content: string, mode: "minimal" | "medium"): string {
  const capped = content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) : content
  const imports = CodeGraphExtract.parseImports(rel, capped)
  const comment = leadingComment(capped)
  const lines = [`path: ${rel}`]
  if (imports.length) lines.push(`imports: ${imports.slice(0, 20).join(", ")}`)
  if (comment) lines.push(`comment: ${comment}`)
  if (mode === "medium") {
    const exports = exportedNames(capped)
    if (exports.length) lines.push(`exports: ${exports.slice(0, 20).join(", ")}`)
    lines.push("head:", capped.split("\n").slice(0, HEAD_LINES).join("\n"))
  }
  return lines.join("\n")
}

// First contiguous run of leading comments (// or /* */ or #), flattened.
function leadingComment(content: string): string {
  const out: string[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (line === "" && out.length === 0) continue
    const stripped = line
      .replace(/^\/\/+/, "")
      .replace(/^\/\*+/, "")
      .replace(/\*+\/$/, "")
      .replace(/^\*+/, "")
      .replace(/^#+/, "")
      .trim()
    const isComment = /^(\/\/|\/\*|\*|#)/.test(line)
    if (!isComment && line !== "") break
    if (stripped) out.push(stripped)
    if (out.join(" ").length > MAX_COMMENT_CHARS) break
  }
  return out.join(" ").slice(0, MAX_COMMENT_CHARS)
}

const EXPORT_DECL = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm
const EXPORT_LIST = /^export\s*\{([^}]*)\}/gm

function exportedNames(content: string): string[] {
  const names = new Set<string>()
  for (const m of content.matchAll(EXPORT_DECL)) names.add(m[1]!)
  for (const m of content.matchAll(EXPORT_LIST)) {
    for (const part of m[1]!.split(","))
      names.add(
        part
          .trim()
          .replace(/\s+as\s+.*/, "")
          .trim(),
      )
  }
  names.delete("")
  return [...names]
}

// --- helpers ---------------------------------------------------------------

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

function chunkArray<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export * as CodeGraphTagger from "./tagger"
