import { Effect } from "effect"
import type { Actor } from "@/aperture/lens-history"
import type { Lens } from "@/aperture/lenses"
import type { Context } from "./tool"

// Shared by the Lens-editing tools: who is acting, and how to get the user's consent when an
// agent's own curation would change something the user owns.

// The history actor for a tool call. `turnID` is the user message that opened the turn — the
// assistant message's `parentID` — which is what maps a Lens change one-to-one onto a chat turn.
// `requestedByUser` is the agent's own statement that the user explicitly asked for this change;
// the change is then the user's, and needs no further consent.
export function actorOf(ctx: Context, params: { readonly requestedByUser?: boolean; readonly reason?: string }): Actor {
  const own = ctx.messages.find((m) => m.info.id === ctx.messageID)?.info
  const turnID =
    (own?.role === "assistant" ? own.parentID : undefined) ??
    ctx.messages.findLast((m) => m.info.role === "user")?.info.id
  return {
    kind: params.requestedByUser ? "user" : "agent",
    agent: ctx.agent,
    sessionID: ctx.sessionID,
    ...(turnID ? { turnID } : {}),
    messageID: ctx.messageID,
    ...(ctx.callID ? { callID: ctx.callID } : {}),
    ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
  }
}

// Ask the user to approve an agent's change to a Lens or facet they own, then hand back the
// actor with consent recorded. A rejection fails the tool call the same way a rejected edit does,
// so the agent sees the refusal. The `lens_consent` permission defaults to "ask" for every agent
// (agent.ts) — a blanket "*": "allow" must not be able to approve it silently.
export function withConsent(ctx: Context, actor: Actor, lens: Lens, change: string) {
  return ctx
    .ask({
      permission: "lens_consent",
      patterns: [lens.id],
      always: [lens.id],
      metadata: { lens: lens.name, change, ...(actor.reason ? { reason: actor.reason } : {}) },
    })
    .pipe(Effect.as({ ...actor, consented: true } satisfies Actor))
}
