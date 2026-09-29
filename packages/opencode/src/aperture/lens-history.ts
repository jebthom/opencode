import { Effect, Option, Schema } from "effect"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { Facet, Lens, Owner, Rule } from "./lenses"

// The append-only history of every Lens definition change (v3): who created, edited or removed
// which Lens, facet or rule, when, why, and in which chat turn.
//
// This is product data, not research data. `study-log.ts` records what participants and agents
// *did* for the paper; this records what the Lens vocabulary *was* at every point, so the sidebar
// (or anything else) can replay it, link a change back to the turn that made it, and show a user
// why the view looks the way it does now. Agents curate facets on their own initiative in v3, so
// "why is this concern here?" has to have an answer that outlives the conversation's scrollback.
//
// Stored next to the definitions it describes, in `.opencode/aperture/lens-history.jsonl`, one
// JSON object per line. Written only from inside lens-store's per-directory mutex, so entries
// serialise with the changes they describe and `seq` is gap-free.

// Who made a change. `turnID` is the id of the user message that opened the chat turn — every
// assistant message's `parentID` — so an entry maps one-to-one onto the turn it happened in, and
// `messageID` + `callID` pin it to the exact tool call.
export interface Actor {
  readonly kind: Owner
  // The agent that made the change (also set when an agent acted on the user's explicit request,
  // in which case `kind` is "user").
  readonly agent?: string
  readonly sessionID?: string
  readonly turnID?: string
  readonly messageID?: string
  readonly callID?: string
  // Why, in the actor's words. Agents are required to give one for every curation change.
  readonly reason?: string
  // Set once the user has approved an agent's change to something they own.
  readonly consented?: boolean
}

export const USER: Actor = { kind: "user" }

export type Op =
  | "lens.create"
  | "lens.delete"
  | "lens.edit"
  | "lens.select"
  | "facet.add"
  | "facet.remove"
  | "facet.edit"
  | "rule.add"
  | "rule.replace"
  | "rule.remove"
  // Not a change: a checkpoint written when the agent completes a todo, snapshotting the active
  // Lens so review can replay "the view as it stood at the end of each part" of a multi-part task.
  | "milestone"

export interface Entry {
  readonly seq: number
  readonly at: number
  readonly op: Op
  readonly actor: Actor
  readonly lens: { readonly id: string; readonly name: string }
  readonly facet?: string
  readonly rule?: string
  // Snapshots of the thing that changed, so the state at any point can be reconstructed by replay
  // and a removal still says what was removed.
  readonly before?: Snapshot
  readonly after?: Snapshot
  // Hit count at creation — the measure of what a rule actually meant when it was installed.
  readonly hits?: { readonly lines: number; readonly files: number; readonly overCap?: boolean }
  // Set on "milestone" entries only: the todo that was completed and its position in the list.
  readonly milestone?: { readonly todo: string; readonly index: number }
}

export type Snapshot =
  | { readonly lens: Pick<Lens, "name" | "description" | "owner"> }
  // A "milestone" entry's `after`: the whole active Lens at that moment.
  | { readonly view: Lens }
  | { readonly facet: Facet; readonly rules?: ReadonlyArray<Rule> }
  | { readonly rule: Rule }

export type Draft = Omit<Entry, "seq" | "at">

export interface Query {
  readonly since?: number
  readonly sessionID?: string
  readonly turnID?: string
  readonly lens?: string
  readonly limit?: number
}

function historyFile(directory: string) {
  return path.join(directory, ".opencode", "aperture", "lens-history.jsonl")
}

// The next sequence number per directory. Seeded from the file's line count on first use, then
// kept in memory; every append happens under lens-store's mutex, so this never races.
const nextSeq = new Map<string, number>()

// Append entries. Best-effort by design: a history write that fails must not undo or block the
// definition change it describes (which has already landed), so failures are logged to stderr
// by the caller's Effect and otherwise swallowed.
export const append = (directory: string, drafts: ReadonlyArray<Draft>): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (drafts.length === 0) return
    const file = historyFile(directory)
    const seq = nextSeq.get(directory) ?? (await readLines(file)).length
    const at = Date.now()
    const lines = drafts.map((draft, i) => JSON.stringify({ seq: seq + i, at, ...draft }))
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, lines.join("\n") + "\n")
    nextSeq.set(directory, seq + drafts.length)
  }).pipe(Effect.catchCause(() => Effect.void))

// Read entries matching `query`, oldest first. `limit` keeps the newest N of the matches.
export const read = (directory: string, query: Query = {}): Effect.Effect<Entry[]> =>
  Effect.promise(async () => {
    const entries = (await readLines(historyFile(directory))).flatMap((line) => {
      const parsed = parse(line)
      return parsed ? [parsed] : []
    })
    const matched = entries.filter(
      (e) =>
        (query.since === undefined || e.seq >= query.since) &&
        (query.sessionID === undefined || e.actor.sessionID === query.sessionID) &&
        (query.turnID === undefined || e.actor.turnID === query.turnID) &&
        (query.lens === undefined || e.lens.id === query.lens),
    )
    return query.limit === undefined ? matched : matched.slice(-query.limit)
  })

async function readLines(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8").catch(() => "")
  return text.split("\n").filter((line) => line.trim().length > 0)
}

// A hand-edited or truncated line costs that one entry, never the whole history.
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parse(line: string): Entry | undefined {
  const value = Option.getOrUndefined(decodeLine(line)) as Partial<Entry> | undefined
  if (typeof value?.seq !== "number" || typeof value.op !== "string" || typeof value.lens?.id !== "string")
    return undefined
  return value as Entry
}

// Test seam: forget the in-memory sequence so a test directory starts fresh.
export function resetForTest(directory: string) {
  nextSeq.delete(directory)
}

export * as ApertureLensHistory from "./lens-history"
