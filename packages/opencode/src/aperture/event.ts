import { Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"

// Emitted when a cached Aperture scope goes stale because a file inside its
// visible window changed (PLAN.md step 2.5 — visibility-gated recompute). The
// server only fires this for scopes that are actually cached (i.e. someone is
// viewing them), so a file buried in an unopened directory produces no event.
// The TUI renderer subscribes and refetches just the scope it is showing.
//
// Defining the event here registers it in the EventV2 registry; importing this
// module from the aperture route group guarantees registration happens before
// api.ts snapshots the registry into the SDK Event union.
export const Event = {
  Invalidated: EventV2.define({
    type: "aperture.invalidated",
    schema: {
      scope: Schema.String,
    },
  }),
}

export * as ApertureEvent from "./event"
