// TEMP DEBUG (auto-session "provider overloaded" investigation).
// Appends JSONL diagnostics to <cwd>/perf/autosession.log so we can trace, across
// both the TUI (main thread) and the server (worker thread): how many sessions get
// auto-created, how many prompt requests are sent/received per session, and what
// the real provider error behind "Provider is overloaded" is.
// Remove this file and its call sites once the issue is resolved.
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

let ensured = false

export function logAutoSession(record: Record<string, unknown>) {
  try {
    const dir = path.join(process.cwd(), "perf")
    if (!ensured) {
      mkdirSync(dir, { recursive: true })
      ensured = true
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...record }) + "\n"
    appendFileSync(path.join(dir, "autosession.log"), line)
  } catch {}
}

export function safeError(error: unknown): unknown {
  try {
    const s = JSON.stringify(error)
    return s.length > 2000 ? s.slice(0, 2000) + "…(truncated)" : JSON.parse(s)
  } catch {
    return String(error)
  }
}
