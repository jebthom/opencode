import path from "node:path"
import { ApertureActivity, type ActivityEntry } from "./activity"

// The derivation half of the Aperture activity model (PLAN.md G1): turn a
// session's stored messages into per-turn, per-agent read/edit/write activity.
//
// Nothing is recorded to produce this. Every tool call is already durably
// persisted as a ToolPart with its tool name, its input and its timings, and
// messages already carry the turn boundary (a user prompt) and the acting agent —
// so the activity log is a *view* of the message store rather than a second
// source of truth that can drift from it. Durability, and history from before this
// feature existed, come for free; there is no ring to evict and nothing to
// invalidate on a Lens switch, because no facet is stored here at all.
//
// Kept pure and structurally typed — no Effect, no MessageV2 import, no database.
// The caller does the reading (see Aperture.activity) and this does the folding,
// which is what lets it be tested from fixtures the way computeFacetMapFiles is.

// The slice of a stored message this derivation reads. Structural rather than
// `SessionV1.WithParts` so a test fixture is three fields instead of a full
// assistant message with tokens, cost and paths.
export interface MessageLike {
  readonly info: {
    readonly role: string
    // Present on both user and assistant messages: the prompting agent on a user
    // message, the acting agent on an assistant one.
    readonly agent?: string
    readonly time?: { readonly created?: number }
  }
  readonly parts: ReadonlyArray<PartLike>
}

export interface PartLike {
  readonly type: string
  // Tool parts only.
  readonly callID?: string
  readonly tool?: string
  readonly state?: {
    readonly status?: string
    readonly input?: Record<string, unknown>
    readonly metadata?: Record<string, unknown>
    readonly time?: { readonly start?: number }
  }
  readonly metadata?: Record<string, unknown>
  // Text parts only: set on prompts the *system* injected rather than the user.
  readonly synthetic?: boolean
}

// A sub-agent session spawned from inside a turn, discovered from the `task` tool
// call that created it. The caller reads this session's messages and folds its
// entries back into the turn that spawned it — the only place they can ever be
// seen, since the sidebar is hidden outright inside subagent sessions.
export interface TurnChild {
  readonly sessionID: string
  readonly agent: string
  readonly callID: string
}

export interface DerivedTurn {
  readonly promptedAt: number
  readonly agent: string
  readonly entries: ActivityEntry[]
  readonly children: TurnChild[]
}

export interface DeriveOptions {
  // Absolute project directory, for normalising a tool's file path against the
  // repo-relative paths AperturePayload nodes are keyed by.
  readonly directory: string
  // The session these messages belong to — a child session when recursing.
  readonly sessionID: string
  // 0 for the viewed session, 1 for a sub-agent it spawned, and so on.
  readonly depth?: number
  // Keep only the most recent N turns. Applied after folding, so a truncated
  // history still reports each surviving turn in full.
  readonly maxTurns?: number
}

// Fold a session's messages (oldest → newest) into turns.
//
// A turn opens on a **non-synthetic** user message. Synthetic user messages are
// how the system feeds results back into a conversation — tool-result injections,
// background sub-agent completions, compaction — and treating those as prompts
// would shatter one user turn into a dozen one-entry turns, which is the single
// most damaging thing this function could get wrong.
export function deriveTurns(messages: ReadonlyArray<MessageLike>, options: DeriveOptions): DerivedTurn[] {
  const depth = options.depth ?? 0
  const turns: DerivedTurn[] = []

  // Activity that arrives before any real prompt (a resumed session whose opening
  // message was compacted away, say) opens an implicit turn so it is still shown,
  // the same accommodation the in-memory tracker made.
  const open = (promptedAt: number, agent: string): DerivedTurn => {
    const turn: DerivedTurn = { promptedAt, agent, entries: [], children: [] }
    turns.push(turn)
    return turn
  }
  const current = (at: number, agent: string) => turns[turns.length - 1] ?? open(at, agent)

  for (const message of messages) {
    const created = message.info.time?.created ?? 0
    const agent = message.info.agent ?? "build"

    if (message.info.role === "user") {
      if (isRealPrompt(message)) open(created, agent)
      continue
    }
    if (message.info.role !== "assistant") continue

    const turn = current(created, agent)
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      // A call whose input hasn't finished streaming has no usable file path yet.
      if (part.state?.status === "pending") continue

      if (part.tool === "task") {
        const child = childSessionOf(part)
        if (child) turn.children.push({ sessionID: child, agent: agentOfTask(part) ?? agent, callID: part.callID ?? "" })
        continue
      }

      const action = ApertureActivity.actionFromTool(part.tool)
      if (!action) continue
      const rel = toRepoRelative(options.directory, part.state?.input?.["filePath"])
      if (!rel) continue
      turn.entries.push({
        path: rel,
        action,
        agent,
        sessionID: options.sessionID,
        depth,
        callID: part.callID ?? "",
        timestamp: part.state?.time?.start ?? created,
      })
    }
  }

  const max = options.maxTurns
  return max !== undefined && turns.length > max ? turns.slice(turns.length - max) : turns
}

// Merge a sub-agent's entries into the turn that spawned it, keeping the turn's
// entries in timeline order so a renderer can read a turn left-to-right regardless
// of which session each action happened in.
export function mergeChildEntries(turn: DerivedTurn, entries: ReadonlyArray<ActivityEntry>): void {
  turn.entries.push(...entries)
  turn.entries.sort((a, b) => a.timestamp - b.timestamp)
}

// A user message counts as a prompt when it carries text the user actually wrote.
// A message with no text parts at all (attachments only) still counts — the
// exclusion is specifically for *synthetic* text, not for a quiet prompt.
function isRealPrompt(message: MessageLike): boolean {
  const texts = message.parts.filter((p) => p.type === "text")
  if (texts.length === 0) return true
  return texts.some((p) => !p.synthetic)
}

// The child session a `task` tool call spawned. The task tool records it via
// `ctx.metadata({ metadata: { parentSessionId, sessionId } })` (tool/task.ts), which
// lands on the running/completed tool state; the part-level metadata is checked too
// so the shape is read wherever it settles.
function childSessionOf(part: PartLike): string | undefined {
  const id = part.state?.metadata?.["sessionId"] ?? part.metadata?.["sessionId"]
  return typeof id === "string" && id.length > 0 ? id : undefined
}

// The sub-agent's own name, so its entries are attributed to it rather than to the
// agent that delegated. `subagent_type` is the task tool's parameter (tool/task.ts).
function agentOfTask(part: PartLike): string | undefined {
  const agent = part.state?.input?.["subagent_type"]
  return typeof agent === "string" && agent.length > 0 ? agent : undefined
}

// Repo-relative POSIX path matching AperturePayload node.path, or undefined for
// anything outside the project (tool inputs may be absolute or cwd-relative).
export function toRepoRelative(directory: string, filePath: unknown): string | undefined {
  if (typeof filePath !== "string" || filePath === "") return undefined
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(directory, filePath)
  const rel = path.relative(directory, abs)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join("/")
}

export * as ApertureActivityModel from "./activity-model"
