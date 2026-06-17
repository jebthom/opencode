import { createMemo, createSignal, onCleanup } from "solid-js"
import path from "path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { CodeGraphActivity, type ActivityEntry, type Turn } from "@/codegraph/activity"

// Foundation B (PLAN.md): the in-memory activity substrate. Subscribes to the
// live agent-action events and accumulates, per user turn, which files were
// read/edited/written and by which agent. Pure data — the renderer (step 7)
// projects it onto node tiles via the Foundation A overlay slot.
//
// ⚠️ The session.next.* family is gated behind OPENCODE_EXPERIMENTAL_EVENT_SYSTEM
// (same as the bar's existing shell-refetch). With the flag off no events fire and
// the tracker simply stays empty — no glyphs, no error.
//
// All state is client-side and ephemeral. The `Turn`/`ActivityEntry` shapes come
// from the shared contract so a future server-side provenance log + timeline can
// adopt them unchanged.

// How many past turns to retain in memory for the eventual timeline. The live
// view only reads the latest turn; older ones are kept until they age out.
const MAX_TURNS = 50

export interface ActivityTracker {
  // Entries for a repo-relative path within the current turn, oldest→newest.
  readonly entriesFor: (path: string) => ActivityEntry[]
  // Entries on any *descendant* of a repo-relative directory path within the
  // current turn, oldest→newest. Lets a directory tile show (in outline form) the
  // actions performed on the files it contains, propagated up parents/grandparents.
  readonly descendantsFor: (dir: string) => ActivityEntry[]
  // The current (latest) turn, or undefined before the first prompt.
  readonly current: () => Turn | undefined
  // The in-memory ring of recent turns, oldest→newest (future timeline source).
  readonly history: () => Turn[]
  // Distinct agent names that acted in the current turn (for a legend later).
  readonly agents: () => string[]
}

// Must be called inside a component/reactive root (it uses signals + onCleanup).
// `sessionID` is the session the bar is showing; only its prompts reset the turn.
export function createActivityTracker(api: TuiPluginApi, sessionID: string): ActivityTracker {
  const [turns, setTurns] = createSignal<Turn[]>([])
  // Current agent per session, learned from step.started / agent.switched — tool
  // events carry only sessionID, so this is how we attribute an action's agent.
  const agentBySession = new Map<string, string>()
  const agentOf = (sid: string) => agentBySession.get(sid) ?? "build"

  // Event timestamps are typed `number` in the SDK, but the in-process TUI event
  // bus delivers the raw EventV2 value (an Effect DateTime, not millis), so using
  // it directly yields NaN. Fall back to receipt time, which is within ~ms anyway.
  const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Date.now())

  const startTurn = (promptedAt: number) =>
    setTurns((prev) => {
      const next = [...prev, { promptedAt, entries: [] as ActivityEntry[] }]
      return next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next
    })

  const record = (entry: ActivityEntry) =>
    setTurns((prev) => {
      // Activity that arrives before any prompt (e.g. right after attach) opens an
      // implicit first turn so it is still shown.
      const base = prev.length === 0 ? [{ promptedAt: entry.timestamp, entries: [] as ActivityEntry[] }] : prev
      const last = base[base.length - 1]!
      const updated: Turn = { ...last, entries: [...last.entries, entry] }
      return [...base.slice(0, -1), updated]
    })

  // Repo-relative POSIX path matching CodeGraphPayload node.path, or undefined for
  // a file outside the project (tool inputs may be absolute or cwd-relative).
  const toRel = (filePath: string | undefined): string | undefined => {
    if (!filePath) return undefined
    const dir = api.state.path.directory
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(dir, filePath)
    const rel = path.relative(dir, abs)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
    return rel.split(path.sep).join("/")
  }

  // A new user prompt on THIS session starts a fresh "since last interaction"
  // window. Sub-agent prompts (other sessionIDs) don't reset it; their file ops
  // still land in the current turn, attributed by their own sessionID/agent.
  const offPrompted = api.event.on("session.next.prompted", (event) => {
    if (event.properties.sessionID === sessionID) startTurn(ms(event.properties.timestamp))
  })
  const offStep = api.event.on("session.next.step.started", (event) => {
    agentBySession.set(event.properties.sessionID, event.properties.agent)
  })
  const offSwitch = api.event.on("session.next.agent.switched", (event) => {
    agentBySession.set(event.properties.sessionID, event.properties.agent)
  })
  const offTool = api.event.on("session.next.tool.called", (event) => {
    const p = event.properties
    const action = CodeGraphActivity.actionFromTool(p.tool)
    if (!action) return
    const rel = toRel(p.input.filePath as string | undefined)
    if (!rel) return
    record({
      path: rel,
      action,
      agent: agentOf(p.sessionID),
      sessionID: p.sessionID,
      callID: p.callID,
      timestamp: ms(p.timestamp),
    })
  })
  onCleanup(() => {
    offPrompted()
    offStep()
    offSwitch()
    offTool()
  })

  // Per-path index of the current turn, recomputed only when activity changes so
  // per-node lookups in the render loop stay O(1). `exact` is keyed by the touched
  // path; `descend` indexes every entry under each of its ancestor directories so a
  // directory tile can show what happened to files nested anywhere beneath it.
  const index = createMemo(() => {
    const cur = turns().at(-1)
    const exact = new Map<string, ActivityEntry[]>()
    const descend = new Map<string, ActivityEntry[]>()
    const push = (map: Map<string, ActivityEntry[]>, key: string, e: ActivityEntry) => {
      const list = map.get(key)
      if (list) list.push(e)
      else map.set(key, [e])
    }
    if (cur)
      for (const e of cur.entries) {
        push(exact, e.path, e)
        // Index under each ancestor directory: "a/b/c.ts" → "a", "a/b".
        const parts = e.path.split("/")
        for (let i = 1; i < parts.length; i++) push(descend, parts.slice(0, i).join("/"), e)
      }
    return { exact, descend }
  })

  return {
    entriesFor: (p) => index().exact.get(p) ?? [],
    descendantsFor: (d) => index().descend.get(d) ?? [],
    current: () => turns().at(-1),
    history: () => turns(),
    agents: () => {
      const cur = turns().at(-1)
      return cur ? [...new Set(cur.entries.map((e) => e.agent))] : []
    },
  }
}

export * as CodeGraphActivityTracker from "./codegraph-activity"
