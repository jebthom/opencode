# Sub-file resolution (function-level tags) — design sketch

Status: design only, not built. Read alongside PLAN.md (tag collections, the
semantic tagger, and the treemap composition contract are the substrate this
extends).

## Problem

Each file currently gets one tag. That's right for coarse lenses (architecture,
ownership) but lossy for fine-grained, cross-cutting hypotheses ("where does
checkout validate inventory") — those live in a few functions inside a file
that's mostly about something else. So some lenses need to paint *within* a file.

## Why function-level, not file-level multi-tag

Letting a file carry several tags seems cheaper, but a file is one indivisible
byte mass: a "90% A / 10% B" file forces you to either double-count its bytes or
invent a split, and the composition system treats those weights as ground truth
(the `total*`/`subtree*` partition contract). A *function* has a real byte
extent, so a file's tag mix becomes a true aggregation of its functions — same
upward-aggregation machinery as dir→file, one level deeper, still honest. The
model also keeps doing only single-label-per-unit (its reliable task); a file's
"mixedness" is then *measured* from the spread of its function tags rather than
asked of the model (whose file-level confidence we don't trust).

## When to descend: only on drill-in

The user navigating *into* a file is itself the signal that their hypothesis now
needs function resolution; if they never drill, file-level already satisfies
their belief and the finer detail is unwanted noise. This self-gates both cost
and clutter — no whole-repo function sweep, no tool-side guess about which files
are "mixed." A size-prior (pre-warm files so big their single tag is likely a
lie) is optional polish, not core. Results cache per-function-hash, so tiles
accrete real multi-colour along the path the user actually investigated, free to
re-view until the file is edited.

## Extents: line-delimited, no parsing

Regex the *start* lines of top-level declarations (`x1, x2, …`); a declaration's
span is `[xi, x(i+1) − 1]`; everything before `x1` is residual (imports /
top-level). We never find the true closing brace because we only care at function
granularity. This partition always tiles the file exhaustively with no gaps or
overlaps — so it satisfies the byte contract *better* than brace-counting (which
can leave bytes unassigned or overlap on a parse slip) and stays
deterministic/offline. Top-level-only means a class is one unit and nesting never
needs brace logic (allow one level deeper later if big mixed classes
under-resolve). Known skew: interstitial top-level code (a config object, a fat
literal) folds into the preceding declaration's tag — acceptable, because
declaration-sparse files are exactly where file-level tagging was already
adequate and where measured entropy reads low, so the tile correctly stays
near-single-colour.

## Two guardrails

- **Never on the critical path of defining or filling a lens.** The product's
  value is cheap, "gist-y" lenses the user defines freely and explores; a wait
  before the lens is usable is friction that kills exploration. Function work is
  strictly a drill-in refinement layered on top of the (progressively-painted)
  file-level lens — if it ever becomes "define a tag, now wait while we
  function-tag the repo," it has defeated the point. It slots onto the existing
  single-permit tagger as top priority (`drill-in > foreground view > background
  sweep`), with minimal per-function context (signature + leading comment).

- **Painting, not reading.** The job is to locate and colour a concept within a
  file at a glance, then hand off to the editor/agent to actually read the code. A
  scrollable syntax-highlighted pane would just be a worse editor and would pull
  the tool away from its real differentiator — the persistent, updating,
  high-altitude lens.
