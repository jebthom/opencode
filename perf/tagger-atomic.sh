#!/usr/bin/env bash
#
# tagger-atomic.sh — the atomic-directory-concurrency test. Tags each directory as
# its own request (splitting any directory past --max-files into same-directory
# chunks, never merging across directories) and runs them --concurrency-wide.
# Maximally coherent prompts; the many small under-filled calls are "wasted" fill
# but cheap once parallelized.
#
# Reports it head-to-head against the CURRENT LIVE batching — fixed N-file chunks
# run sequentially (chunkArray(stale, TAG_BATCH=30)) — so the table shows the real
# end-to-end speedup of (proposed, concurrent) vs (production, as-is).
#
# Usage:
#   ANTHROPIC_API_KEY=... perf/tagger-atomic.sh [slice-dir] [mode-flag]
#     slice-dir   subtree to tag (default packages/opencode/src — a big slice so the
#                 full speedup shows; smaller = fewer tokens/time)
#     mode-flag   --minimal (default) | --medium | --full
#
# Env overrides:
#   CONC=16        concurrency for the atomic-directory run (default 16).
#   MAXFILES=30    split a directory into chunks of at most this many files.
#   FIXED_SIZE=30  chunk size for the live-baseline `fixed` run (production = 30).
#   REPEAT=2       runs per config, averaged (default 2; the sequential baseline is
#                  the slow part, so keep this small).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SLICE="${1:-packages/opencode/src}"
MODE="${2:---minimal}"
CONC="${CONC:-16}"
MAXFILES="${MAXFILES:-30}"
FIXED_SIZE="${FIXED_SIZE:-30}"
REPEAT="${REPEAT:-2}"

if [[ ! -d "$SLICE" ]]; then
  echo "slice dir not found: $SLICE" >&2
  exit 1
fi
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY not set — this test makes live calls." >&2
  exit 1
fi

echo "==> atomic-directory concurrency vs live fixed batching"
echo "    slice    : $SLICE"
echo "    mode     : $MODE"
echo "    atomic   : dirsplit, max ${MAXFILES} files/dir-chunk, concurrency ${CONC}"
echo "    baseline : fixed ${FIXED_SIZE}/chunk, sequential (production as-is)"
echo "    repeat   : $REPEAT (averaged)"
echo

# Run one eval config, stream its full report, and emit one parsed summary line:
#   "<bins>|<wall_avg_s>|<calls>|<retries>|<drops>"
run_cfg() {
  local out
  out="$(bun perf/tagger-eval.ts "$SLICE" "$MODE" "$@" --repeat "$REPEAT" 2>/dev/null)"
  echo "$out" >&2 # full report to stderr so it scrolls but doesn't pollute parse
  local bins wall calls retr drops
  bins="$(echo "$out" | awk '/^  bins/ {print $3; exit}')"
  wall="$(echo "$out" | awk -F'[:s]' '/wallclock/ {v=$2; gsub(/ /,"",v); s+=v; n++} END{if(n) printf "%.1f", s/n}')"
  calls="$(echo "$out" | awk '/model calls/ {print $4; exit}')"
  retr="$(echo "$out" | awk '/throttle/ {s+=$3} END{print s+0}')"
  drops="$(echo "$out" | grep -c 'MISMATCH' || true)"
  echo "${bins:-?}|${wall:-?}|${calls:-?}|${retr:-0}|${drops:-0}"
}

echo "== running baseline: fixed ${FIXED_SIZE}, sequential =="
base="$(run_cfg --batch fixed --fixed-size "$FIXED_SIZE" --concurrency 1)"
echo
echo "== running atomic: dirsplit, concurrency ${CONC} =="
atom="$(run_cfg --batch dirsplit --max-files "$MAXFILES" --concurrency "$CONC")"

IFS='|' read -r b_bins b_wall b_calls b_retr b_drops <<<"$base"
IFS='|' read -r a_bins a_wall a_calls a_retr a_drops <<<"$atom"

speedup="$(awk -v b="$b_wall" -v a="$a_wall" 'BEGIN{ if(a>0 && b!="?" ) printf "%.1fx", b/a; else print "?" }')"

echo
echo "================ summary ($MODE, repeat $REPEAT) ================"
printf "  %-26s %-6s %-12s %-7s %-8s %s\n" "config" "bins" "wall_avg(s)" "calls" "retries" "drops(MISMATCH runs)"
printf "  %-26s %-6s %-12s %-7s %-8s %s\n" "fixed-${FIXED_SIZE} sequential (live)" "$b_bins" "$b_wall" "$b_calls" "$b_retr" "$b_drops"
printf "  %-26s %-6s %-12s %-7s %-8s %s\n" "dirsplit x${CONC} (atomic)" "$a_bins" "$a_wall" "$a_calls" "$a_retr" "$a_drops"
echo
echo "  speedup (atomic vs live): ${speedup}"
[[ "$a_retr" != "0" ]] && echo "  NOTE: atomic run hit throttling ($a_retr retries) — back concurrency off."
echo "  drops = how many of the $REPEAT runs returned fewer tags than files (omission);"
echo "          coherence should keep this at/near 0 for the atomic run."
