import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

// Aggregate the Aperture painter's model spend out of the study logs, broken down by the
// dimensions that decide whether the granularity dial (aperture.painter.granularity) can
// afford to be widened: which Lens, which interest heuristic scheduled the pass, and how
// much of the pass was cheap whole-file blocks versus per-declaration ones.
//
// Reads <directory>/perf/logs/sessions/*/events.jsonl, the append-only timeline
// study-log.ts writes. Every painter pass appends one `{ type: "painter" }` record.

interface PainterRecord {
  lens?: string
  origin?: string
  source?: string
  files?: number
  extents?: number
  coarse?: number
  inputTokens?: number
  outputTokens?: number
}

interface Bucket {
  passes: number
  files: number
  extents: number
  coarse: number
  input: number
  output: number
}

const empty = (): Bucket => ({ passes: 0, files: 0, extents: 0, coarse: 0, input: 0, output: 0 })

function add(bucket: Bucket, rec: PainterRecord) {
  bucket.passes += 1
  bucket.files += rec.files ?? 0
  bucket.extents += rec.extents ?? 0
  bucket.coarse += rec.coarse ?? 0
  bucket.input += rec.inputTokens ?? 0
  bucket.output += rec.outputTokens ?? 0
}

function table(title: string, buckets: Map<string, Bucket>) {
  if (buckets.size === 0) return
  console.log(`\n${title}`)
  const rows = [...buckets.entries()].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output))
  const head = ["", "passes", "files", "blocks", "coarse", "fine", "input", "output"]
  const body = rows.map(([key, b]) => [
    key,
    String(b.passes),
    String(b.files),
    String(b.extents),
    String(b.coarse),
    String(b.extents - b.coarse),
    b.input.toLocaleString(),
    b.output.toLocaleString(),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)))
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ")
  console.log(line(head))
  for (const row of body) console.log(line(row))
}

export const ApertureCostCommand = effectCmd({
  command: "aperture-cost",
  describe: "summarize Aperture painter token spend",
  builder: (yargs) =>
    yargs.option("directory", {
      type: "string",
      describe: "project directory to read perf/logs/sessions from (default: cwd)",
    }),
  handler: Effect.fn("Cli.debug.apertureCost")(function* (args: { directory?: string }) {
    const directory = args.directory ?? process.cwd()
    const root = path.join(directory, "perf", "logs", "sessions")
    const folders = yield* Effect.tryPromise(() => readdir(root)).pipe(Effect.orElseSucceed(() => [] as string[]))
    if (folders.length === 0) {
      console.log(`no study logs under ${root}`)
      return
    }

    const byLens = new Map<string, Bucket>()
    const bySource = new Map<string, Bucket>()
    const byOrigin = new Map<string, Bucket>()
    const total = empty()

    for (const folder of folders) {
      const file = path.join(root, folder, "events.jsonl")
      const text = yield* Effect.tryPromise(() => readFile(file, "utf8")).pipe(Effect.orElseSucceed(() => ""))
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        // A truncated final line is normal for an append-only log still being written.
        const rec = ((): (PainterRecord & { type?: string }) | undefined => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })()
        if (rec?.type !== "painter") continue
        for (const [map, key] of [
          [byLens, rec.lens ?? "(unknown)"],
          [bySource, rec.source ?? "(unlabelled)"],
          [byOrigin, rec.origin ?? "(unknown)"],
        ] as const) {
          const bucket = map.get(key) ?? empty()
          add(bucket, rec)
          map.set(key, bucket)
        }
        add(total, rec)
      }
    }

    if (total.passes === 0) {
      console.log(`no painter records in ${folders.length} session log(s) under ${root}`)
      return
    }

    table("by lens", byLens)
    table("by trigger (aperture.painter.granularity decides which of these promote)", bySource)
    table("by origin (fg = a window/interest pass, bg = the whole-repo sweep)", byOrigin)

    console.log(
      `\ntotals: ${total.passes} passes, ${total.files} files, ${total.extents} blocks ` +
        `(${total.coarse} coarse / ${total.extents - total.coarse} fine), ` +
        `${total.input.toLocaleString()} input + ${total.output.toLocaleString()} output tokens`,
    )
    // Function tagging is output-dominated, so output per block is the number that moves
    // when the dial widens — it is what the ~5.8x measurement was actually measuring.
    if (total.extents > 0) console.log(`output tokens per block: ${(total.output / total.extents).toFixed(1)}`)
  }),
})
