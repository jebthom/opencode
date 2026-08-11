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
      const base = {
        agent,
        sessionID: options.sessionID,
        depth,
        callID: part.callID ?? "",
        timestamp: part.state?.time?.start ?? created,
      }

      // One apply_patch call changes many files at once, and each of those is a mutation
      // the user needs to see individually — so it expands into one entry per patched
      // file rather than a single opaque act. The paths come from the tool's own result
      // metadata (tool/apply_patch.ts), since its *input* is patch text with no path
      // field at all; without this, patch-based edits would be a blind spot.
      if (part.tool === "apply_patch") {
        for (const file of patchedFiles(part)) {
          turn.entries.push({ ...base, action: file.action, target: "file", path: file.path })
        }
        continue
      }

      const aim = targetOf(action, part, options.directory)
      if (!aim) continue
      turn.entries.push({ ...base, action, ...aim })
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

// What one tool call points at, or undefined to drop it (a path outside the project).
//
// This is a best guess that `Aperture.activity` is free to overrule: only the service
// holds the repo's file set, so only it can finally say whether a path is a file it knows,
// a directory above one, or neither. Deciding as much as possible here anyway is what
// keeps this function testable from fixtures without a database behind it.
function targetOf(
  action: ApertureActivity.Action,
  part: PartLike,
  directory: string,
): { target: ApertureActivity.Target; path?: string } | undefined {
  // A shell command or a web fetch names no path we could colour.
  if (action === "run" || action === "fetch") return { target: "none" }

  // grep/glob/lsp take an *optional* directory to search in; omitting it means the repo
  // root, which is a real scope rather than a missing one.
  if (action === "search") return scopeTarget(part.state?.input?.["path"], directory)

  const raw = part.state?.input?.["filePath"]
  // The `read` tool takes a directory as happily as a file, and agents use it that way
  // constantly. Its result metadata says which, authoritatively (tool/read.ts) — but a
  // still-*running* read has no metadata yet, and that case falls through to the service's
  // own file-or-ancestor test, which reaches the same answer from the file set.
  if (action === "read" && displayType(part) === "directory") return scopeTarget(raw, directory)

  const rel = toRepoRelative(directory, raw)
  return rel === undefined ? undefined : { target: "file", path: rel }
}

function scopeTarget(raw: unknown, directory: string): { target: ApertureActivity.Target; path?: string } | undefined {
  if (raw === undefined || raw === null || raw === "") return { target: "place", path: "" }
  const rel = toRepoScope(directory, raw)
  return rel === undefined ? undefined : { target: "place", path: rel }
}

// The `display.type` a tool reported on its result ("file" | "directory" for `read`).
// Absent on pending/running calls, which is why callers must have a fallback.
function displayType(part: PartLike): string | undefined {
  const display = part.state?.metadata?.["display"]
  if (typeof display !== "object" || display === null) return undefined
  const type = (display as Record<string, unknown>)["type"]
  return typeof type === "string" ? type : undefined
}

// The files one apply_patch call changed, from its result metadata (`files`, built at
// tool/apply_patch.ts). `relativePath` there is already repo-relative POSIX, resolved
// against the instance worktree; if that ever diverges from Aperture's directory the path
// simply fails the service's known-file test and is dropped, which is the safe direction.
//
// A `delete` keeps its entry rather than being skipped here: the service drops
// since-deleted paths through the same filter that handles every other vanished file, and
// duplicating that judgement in the derivation would be a second opinion to keep in sync.
function patchedFiles(part: PartLike): { path: string; action: ApertureActivity.Action }[] {
  const files = part.state?.metadata?.["files"]
  if (!Array.isArray(files)) return []
  const out: { path: string; action: ApertureActivity.Action }[] = []
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue
    const rel = (file as Record<string, unknown>)["relativePath"]
    if (typeof rel !== "string" || rel === "") continue
    // "add" creates a whole file; "update"/"move"/"delete" change one that existed.
    out.push({ path: rel, action: (file as Record<string, unknown>)["type"] === "add" ? "create" : "edit" })
  }
  return out
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

// Same, for a *scope* rather than a thing inside one: a search path or a directory read,
// where the repo root is a legitimate answer rather than a degenerate one. `""` means the
// root, matching how AperturePayload keys the root scope.
export function toRepoScope(directory: string, dirPath: unknown): string | undefined {
  if (typeof dirPath !== "string" || dirPath === "") return ""
  const abs = path.isAbsolute(dirPath) ? dirPath : path.resolve(directory, dirPath)
  const rel = path.relative(directory, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel === "" ? "" : rel.split(path.sep).join("/")
}

export * as ApertureActivityModel from "./activity-model"
