#!/usr/bin/env bash
#
# tagger-compare.sh — end-to-end batching comparison for the semantic tagger,
# driving perf/tagger-eval.ts over a slice of the monorepo (NOT the whole repo).
#
# Three phases:
#   1. calibrate  (live, ~1 call/dir)  — fit K (chars/token) + per-call overhead.
#   2. sweep      (dry-run, free)      — ffd bins at several budgets; recommend a
#                                        token bound at the "knee" (diminishing
#                                        returns). No API calls.
#   3. compare    (live, repeated)     — run the batching methods side by side in
#                                        one tagger-eval invocation (one tag table
#                                        + per-method stability) at the chosen bound.
#
# Usage:
#   ANTHROPIC_API_KEY=... perf/tagger-compare.sh [slice-dir] [mode-flag]
#     slice-dir   subtree to test. Default packages/opencode/src/codegraph.
#                 KEEP IT SMALL — every live call costs Haiku tokens.
#     mode-flag   --minimal (default) | --medium | --full   (single mode)
#
# Env overrides:
#   STRATEGIES="fixed,dir,ffd"   methods compared in phase 3 (the three methods:
#                                production fixed-count, directory, bin-packing).
#                                Add bfd,locality to also compare packer variants.
#   BUDGET=N        skip the sweep's recommendation; force this token bound.
#   MAXFILES=N      per-bin file cap for the packers (default 30).
#   FIXED_SIZE=N    chunk size for the `fixed` production baseline (default 30).
#   REPEAT=N        runs per method, for stability (default 3).
#   SWEEP_BUDGETS="2000 3000 4000 6000 8000 12000"   budgets probed in phase 2.
#   SKIP_CALIBRATE=1   skip phase 1.
#   DRY_ONLY=1         run only phase 2 (no API key needed); skip calibrate+compare.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SLICE="${1:-packages/opencode/src/codegraph}"
MODE="${2:---minimal}"
REPEAT="${REPEAT:-3}"
MAXFILES="${MAXFILES:-30}"
FIXED_SIZE="${FIXED_SIZE:-30}"
STRATEGIES="${STRATEGIES:-fixed,dir,ffd}"
SWEEP_BUDGETS="${SWEEP_BUDGETS:-2000 3000 4000 6000 8000 12000}"
EVAL=(bun perf/tagger-eval.ts)

if [[ ! -d "$SLICE" ]]; then
  echo "slice dir not found: $SLICE" >&2
  exit 1
fi
if [[ "$(cd "$SLICE" && pwd)" == "$REPO_ROOT" ]]; then
  echo "refusing to run on the entire repo — pass a smaller slice" >&2
  exit 1
fi

need_key() {
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "ANTHROPIC_API_KEY not set (needed for live phases). Set it, or use DRY_ONLY=1 for the free sweep only." >&2
    exit 1
  fi
}

echo "==> tagger batching comparison"
echo "    slice    : $SLICE"
echo "    mode     : $MODE"
echo "    methods  : $STRATEGIES"
echo "    repeat   : $REPEAT    max-files: $MAXFILES    fixed-size: $FIXED_SIZE"
echo

# ---- Phase 1: calibrate K (live) -------------------------------------------
if [[ "${DRY_ONLY:-0}" != "1" && "${SKIP_CALIBRATE:-0}" != "1" ]]; then
  need_key
  echo "== Phase 1: calibrate K (live) =="
  cal_out="$("${EVAL[@]}" "$SLICE" --calibrate 2>&1)" || {
    echo "$cal_out" >&2
    exit 1
  }
  echo "$cal_out" | grep -E "fit|K \(|overhead|TOKENS_PER_CHAR" || echo "$cal_out"
  echo "  (if suggested K differs materially from the current constant, edit"
  echo "   TOKENS_PER_CHAR in perf/tagger-eval.ts and re-run before trusting budgets)"
  echo
fi

# ---- Phase 2: budget sweep (free, no API) ----------------------------------
echo "== Phase 2: budget sweep (dry-run, no API) =="
echo "   budget   ffd-bins"
min=1000000
B_LIST=()
N_LIST=()
for b in $SWEEP_BUDGETS; do
  n="$("${EVAL[@]}" "$SLICE" "$MODE" --batch ffd --budget "$b" --max-files "$MAXFILES" --dry-run 2>/dev/null \
    | awk '/bins[[:space:]]*:/ {print $3; exit}')"
  n="${n:-0}"
  printf "   %-8s %s\n" "$b" "$n"
  B_LIST+=("$b")
  N_LIST+=("$n")
  if (( n > 0 && n < min )); then min=$n; fi
done

if [[ -n "${BUDGET:-}" ]]; then
  REC="$BUDGET"
  echo "   recommended budget (override) : $REC"
else
  # Knee: smallest budget that already reaches the minimum bin count seen (bins is
  # a step function that flattens — the first budget on the flat is the sweet spot).
  # If the sweep never flattened, this lands on the largest budget, a hint to probe
  # higher with SWEEP_BUDGETS.
  REC="${B_LIST[${#B_LIST[@]}-1]}"
  for i in "${!B_LIST[@]}"; do
    if (( N_LIST[i] > 0 && N_LIST[i] <= min )); then
      REC="${B_LIST[i]}"
      break
    fi
  done
  echo "   recommended budget (knee — first budget reaching min=$min bins) : $REC"
fi
echo "   note: in --minimal the blocks are tiny, so --max-files ($MAXFILES) is usually"
echo "         the binding constraint and the sweep looks flat — a small budget suffices."
echo

if [[ "${DRY_ONLY:-0}" == "1" ]]; then
  echo "DRY_ONLY set — skipping live comparison. Re-run without it (and with a key) to compare."
  exit 0
fi

# ---- Phase 3: compare methods (live) ---------------------------------------
need_key
echo "== Phase 3: compare methods (live, repeat=$REPEAT, budget=$REC) =="
"${EVAL[@]}" "$SLICE" "$MODE" \
  --batch "$STRATEGIES" --budget "$REC" --max-files "$MAXFILES" --fixed-size "$FIXED_SIZE" --repeat "$REPEAT"
echo
echo "Done. What to read in the output above / perf/logs/:"
echo "  - model calls, wallclock, avg ms/call  -> efficiency per method"
echo "  - est-vs-actual input tokens           -> did the K-based budget hold?"
echo "  - 'stability [mode/method]' lines      -> repeatability across the $REPEAT runs"
echo "  - the per-file tag table (≠ column)    -> where the methods assign different tags"
