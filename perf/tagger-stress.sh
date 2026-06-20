#!/usr/bin/env bash
#
# tagger-stress.sh — find the per-call file fan-out ceiling for the tagger: how
# many files can ride in a single Haiku request before the model stops echoing
# them all back. Drives perf/tagger-eval.ts --stress.
#
# Each probed size N is one live model call (× REPEAT). minimal context is used so
# input size is never the bottleneck — what we're measuring is the model's
# instruction-following limit (and, flagged separately, the output-token cap).
#
# Usage:
#   ANTHROPIC_API_KEY=... perf/tagger-stress.sh [slice-dir]
#     slice-dir   pool of real files to draw from. Default packages/opencode/src
#                 (a large pool → big N stays realistic). Once the pool is
#                 exhausted, extra files reuse content under unique dupK/ paths.
#
# Env overrides:
#   SIZES="20,40,60,80,120,160,200,260"   file counts to probe (one call each).
#   REPEAT=2    runs per size, to see if omission is consistent (default 2).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SLICE="${1:-packages/opencode/src}"
SIZES="${SIZES:-20,40,60,80,120,160,200,260}"
REPEAT="${REPEAT:-2}"

if [[ ! -d "$SLICE" ]]; then
  echo "slice dir not found: $SLICE" >&2
  exit 1
fi
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY not set — the stress test makes live calls." >&2
  exit 1
fi

echo "==> tagger per-call file ceiling"
echo "    pool slice : $SLICE"
echo "    sizes      : $SIZES"
echo "    repeat     : $REPEAT"
echo "    (~$(echo "$SIZES" | tr ',' '\n' | wc -l | tr -d ' ') sizes × $REPEAT live calls)"
echo

bun perf/tagger-eval.ts "$SLICE" --minimal --stress --stress-sizes "$SIZES" --repeat "$REPEAT"

echo
echo "Read the table: ceiling = largest N where 'missing' is still 0 across all runs."
echo "  'omission (model)'           -> the model itself dropped files at that N"
echo "  'omission (output-cap-bound)' -> output hit max_tokens; raise STRESS_MAX_OUTPUT"
echo "                                   in perf/tagger-eval.ts (up to the model's limit)"
