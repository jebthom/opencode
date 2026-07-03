// Aperture research/study logging.
//
// A prototype for user studies (recorded, but we also need machine-readable
// per-session logs to recreate issues, compute summary stats, and trace how
// participants interact). This is the single writer: every server-side signal
// (prompts, assistant output, tool calls + results, painter token spend, lens
// ops, phase transitions) and every TUI top-bar click funnels through here and
// lands, timestamp-ordered, in one file per session.
//
// Layout (under <directory>/perf/logs/sessions, gitignored):
//   <YYYY-MM-DD_HH-MM-SS>_<rootSessionID>/
//     manifest.json   header + rolling summary (rewritten in place)
//     events.jsonl     append-only unified timeline
//
// Design notes:
//   - Modeled on painter.ts `writePerfLine` and cli/cmd/run/trace.ts: best-effort,
//     failures swallowed (`Effect.ignore`) — study logging must NEVER break or
//     slow a session.
//   - Structural typing (SessionMeta) instead of importing session.ts, to avoid an
//     import cycle (session.ts registers sessions here).
//   - One in-process map keyed by sessionID; subagent (child) sessions share their
//     root's folder so a whole session tree is one timeline. The map is populated at
//     Session.createNext, before any prompt or click, so lookups hit.
//   - Per-folder append/manifest writes are serialized through a promise chain so
//     concurrent fibers (parallel subagents) never interleave partial lines.
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import { Effect } from "effect"

// Minimal structural snapshot of a session — avoids importing session.ts (cycle).
export interface SessionMeta {
  id: string
  parentID?: string
  directory: string
  createdMs: number
  agent?: string
  version?: string
}

interface Summary {
  prompts: Record<string, number>
  apertureToolCalls: { byUser: number; byAgent: number }
  toolCalls: Record<string, number>
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  painterTokens: { input: number; output: number }
  cost: number
  clicks: Record<string, number>
  models: string[]
  startedMs: number
  lastMs: number
}

interface Entry {
  folder: string
  rootID: string
  directory: string
  header: Record<string, unknown>
  summary: Summary
  tail: Promise<void>
}

// sessionID -> entry. Children point at the same Entry object as their root.
const sessions = new Map<string, Entry>()
// Most-recent session with activity in this process — painter passes (not tied to a
// session) are attributed here.
let lastActiveSessionID: string | undefined

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

// Local date-time folder stamp, e.g. 2026-07-03_09-36-12 — per the study's grouping.
function folderStamp(createdMs: number, id: string): string {
  const d = new Date(createdMs)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(
    d.getMinutes(),
  )}-${pad(d.getSeconds())}_${id}`
}

function freshSummary(startedMs: number): Summary {
  return {
    prompts: {},
    apertureToolCalls: { byUser: 0, byAgent: 0 },
    toolCalls: {},
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    painterTokens: { input: 0, output: 0 },
    cost: 0,
    clicks: {},
    models: [],
    startedMs,
    lastMs: startedMs,
  }
}

// Best-effort git branch + short commit for the manifest header. Swallowed on failure.
function git(directory: string): Promise<{ branch?: string; commit?: string }> {
  const run = (args: string[]) =>
    new Promise<string | undefined>((resolve) => {
      execFile("git", args, { cwd: directory, timeout: 2000 }, (err, stdout) =>
        resolve(err ? undefined : stdout.trim() || undefined),
      )
    })
  return Promise.all([run(["rev-parse", "--abbrev-ref", "HEAD"]), run(["rev-parse", "--short", "HEAD"])]).then(
    ([branch, commit]) => ({ branch, commit }),
  )
}

// Serialize all writes for a folder through the entry's promise chain so parallel
// fibers can't interleave partial lines or racing manifest rewrites.
function enqueue(entry: Entry, work: () => Promise<void>): Promise<void> {
  entry.tail = entry.tail.then(work, work)
  return entry.tail
}

function writeEvents(entry: Entry, rec: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"
  return appendFile(path.join(entry.folder, "events.jsonl"), line)
}

function writeManifest(entry: Entry): Promise<void> {
  const summary = { ...entry.summary, wallclockMs: entry.summary.lastMs - entry.summary.startedMs }
  return writeFile(path.join(entry.folder, "manifest.json"), JSON.stringify({ ...entry.header, summary }, null, 2))
}

// Fold a timeline record into the rolling summary. Keeps user- vs agent-attributed
// Aperture ops separate: agent = lens_* tool calls; user = top-bar lens clicks +
// slash-command lens ops.
function applySummary(entry: Entry, rec: Record<string, unknown>): void {
  const s = entry.summary
  s.lastMs = Date.now()
  const type = rec.type
  if (type === "prompt") {
    const agent = typeof rec.agent === "string" ? rec.agent : "unknown"
    s.prompts[agent] = (s.prompts[agent] ?? 0) + 1
  } else if (type === "tool") {
    const name = typeof rec.name === "string" ? rec.name : "unknown"
    s.toolCalls[name] = (s.toolCalls[name] ?? 0) + 1
    if (rec.aperture === true) s.apertureToolCalls.byAgent += 1
  } else if (type === "assistant-step") {
    const t = rec.tokens as Summary["tokens"] | undefined
    if (t) {
      s.tokens.input += t.input ?? 0
      s.tokens.output += t.output ?? 0
      s.tokens.reasoning += t.reasoning ?? 0
      s.tokens.cache.read += t.cache?.read ?? 0
      s.tokens.cache.write += t.cache?.write ?? 0
    }
    if (typeof rec.cost === "number") s.cost += rec.cost
    if (typeof rec.model === "string" && !s.models.includes(rec.model)) s.models.push(rec.model)
  } else if (type === "painter") {
    s.painterTokens.input += typeof rec.inputTokens === "number" ? rec.inputTokens : 0
    s.painterTokens.output += typeof rec.outputTokens === "number" ? rec.outputTokens : 0
  } else if (type === "click") {
    const kind = typeof rec.interaction === "string" ? rec.interaction : "unknown"
    s.clicks[kind] = (s.clicks[kind] ?? 0) + 1
    // Lens switch/select/delete via the top-bar are user-driven Aperture ops.
    if (kind.startsWith("lens.")) s.apertureToolCalls.byUser += 1
  } else if (type === "lens-op" && rec.by === "user") {
    s.apertureToolCalls.byUser += 1
  }
}

// Register a session (root or subagent). Idempotent. Called from Session.createNext
// for every session, so the folder exists before any prompt/tool/click fires.
export function register(meta: SessionMeta): Effect.Effect<void> {
  return Effect.promise(async () => {
    if (sessions.has(meta.id)) return
    // Subagent: share the root's folder + summary; emit a start marker.
    if (meta.parentID && sessions.has(meta.parentID)) {
      const parent = sessions.get(meta.parentID)!
      sessions.set(meta.id, parent)
      await enqueue(parent, () =>
        writeEvents(parent, { sessionID: meta.id, agent: meta.agent, type: "subagent-start", parentID: meta.parentID }),
      ).catch(() => {})
      return
    }
    // Root session: create the folder + manifest header.
    const folder = path.join(meta.directory, "perf", "logs", "sessions", folderStamp(meta.createdMs, meta.id))
    const summary = freshSummary(meta.createdMs)
    const entry: Entry = {
      folder,
      rootID: meta.id,
      directory: meta.directory,
      header: {
        sessionID: meta.id,
        directory: meta.directory,
        version: meta.version,
        agent: meta.agent,
        startedAt: new Date(meta.createdMs).toISOString(),
      },
      summary,
      tail: Promise.resolve(),
    }
    sessions.set(meta.id, entry)
    await mkdir(folder, { recursive: true }).catch(() => {})
    const g = await git(meta.directory).catch(() => ({}))
    entry.header.git = g
    await enqueue(entry, () => writeManifest(entry)).catch(() => {})
  }).pipe(Effect.ignore)
}

// Append one timeline record for a session and refresh its rolling summary. No-op
// (swallowed) if the session was never registered.
export function record(sessionID: string, rec: Record<string, unknown>): Effect.Effect<void> {
  return Effect.promise(async () => {
    const entry = sessions.get(sessionID)
    if (!entry) return
    lastActiveSessionID = sessionID
    applySummary(entry, rec)
    await enqueue(entry, async () => {
      await writeEvents(entry, { sessionID, ...rec })
      await writeManifest(entry)
    }).catch(() => {})
  }).pipe(Effect.ignore)
}

// Attribute a painter pass's token spend to the most-recently-active session (the
// painter runs in a forked fiber not tied to a session). Kept separate from
// conversation tokens in the summary.
export function recordPainter(rec: Record<string, unknown>): Effect.Effect<void> {
  if (!lastActiveSessionID) return Effect.void
  return record(lastActiveSessionID, { type: "painter", ...rec })
}
