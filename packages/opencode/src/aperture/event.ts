import { Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"

// Defining the events here registers them in the EventV2 registry; importing this module from
// the aperture route group guarantees registration happens before api.ts snapshots the registry
// into the SDK Event union.
export const Event = {
  // The active Lens's hits (or the Lens itself) may have changed: a file edit, a mark, a Lens
  // switch, or a finished turn. Every surface refetches what it shows. Must be published with a
  // `location`, or the HTTP /event SSE filter drops it and the VSCode extension — the only
  // HTTP-SSE consumer — silently never repaints.
  //
  // `scope` is kept for wire compatibility and is always "" now that the view is repo-wide.
  Invalidated: EventV2.define({
    type: "aperture.invalidated",
    schema: {
      scope: Schema.String,
    },
  }),
  // The legend filter changed (O4): the set of facets the user has toggled off, which every
  // surface paints grey. Carries the whole set rather than a delta so a listener can apply it
  // without tracking history. View-only — nothing is recomputed, so it does not ride Invalidated.
  FacetsFiltered: EventV2.define({
    type: "aperture.facets.filtered",
    schema: {
      facets: Schema.Array(Schema.String).annotate({
        description: "Facet ids toggled off in the legend; empty means nothing is filtered",
      }),
    },
  }),
}

export * as ApertureEvent from "./event"
