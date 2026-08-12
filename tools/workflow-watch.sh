#!/usr/bin/env bash
# Hang and death detector for a running workflow.
#
# A workflow that dies loudly is easy — the harness notifies. Two failure modes
# are silent:
#
#   1. An agent wedged on a command that never returns. The run stays nominally
#      alive forever and no notification ever arrives.
#   2. An agent killed by a terminal API error (529 Overloaded, etc.). The
#      journal still lists it as started-with-no-result, so the workflow waits on
#      a corpse.
#
# The first version of this script checked the NEWEST agent transcript across the
# whole workflow, which cannot see either case while any sibling is still
# writing — and that is the normal case, since agents run concurrently. It missed
# a dead faces agent for 26 minutes. So staleness is now tracked PER AGENT, for
# agents the journal says started but never returned.
#
# Usage: tools/workflow-watch.sh <workflow-dir> <expected-agent-count> [stall-seconds]
#
# Emits one line per event on stdout, for Monitor:
#   DEAD      <agent> died with an API error   <- restart it
#   STALL     <agent> silent for Ns            <- investigate, likely wedged
#   COMPLETE  all N agents returned
#
# Watches one or more workflows. Monitor caps every watch at 30 minutes
# regardless of `persistent`, so each extra monitor is another thing to re-arm
# on a timer; covering every live workflow from one invocation keeps that cost
# flat as waves overlap.
set -uo pipefail

usage() { echo "usage: $0 <dir>:<agent-count> [<dir>:<agent-count> ...] [--stall N]" >&2; exit 2; }

STALL=420
SPECS=()
while (( $# )); do
  case "$1" in
    --stall) STALL="${2:?}"; shift 2 ;;
    *:*) SPECS+=("$1"); shift ;;
    *) usage ;;
  esac
done
(( ${#SPECS[@]} )) || usage

STALL_EVERY=6
poll=0
declare -A announced=()
declare -A finished_wf=()

while true; do
  poll=$((poll + 1))
  live=0

  for spec in "${SPECS[@]}"; do
    DIR="${spec%:*}"
    EXPECTED="${spec##*:}"
    name="$(basename "$DIR")"

    [[ -n "${finished_wf[$name]:-}" ]] && continue

    if [[ ! -d "$DIR" ]]; then
      echo "STALL  [$name] workflow dir vanished"
      finished_wf[$name]=1
      continue
    fi

    journal="$DIR/journal.jsonl"
    [[ -f "$journal" ]] || { live=1; continue; }

    # No `|| echo 0` here: grep -c prints 0 *and* exits 1 when there are no
    # matches, so the fallback appends a second line and the count becomes
    # "0\n0", which blows up the arithmetic below. Let the non-zero exit pass.
    done_n=$(grep -c '"type":"result"' "$journal" 2>/dev/null)
    done_n=${done_n:-0}
    if (( done_n >= EXPECTED )); then
      echo "COMPLETE  [$name] all $EXPECTED agents returned"
      finished_wf[$name]=1
      continue
    fi
    live=1

    mapfile -t started < <(grep '"type":"started"' "$journal" 2>/dev/null \
      | sed -n 's/.*"agentId":"\([^"]*\)".*/\1/p')
    mapfile -t done_ids < <(grep '"type":"result"' "$journal" 2>/dev/null \
      | sed -n 's/.*"agentId":"\([^"]*\)".*/\1/p')

    now=$(date +%s)
    for a in "${started[@]}"; do
      for f in "${done_ids[@]}"; do [[ "$a" == "$f" ]] && continue 2; done

      t="$DIR/agent-$a.jsonl"
      [[ -f "$t" ]] || continue
      age=$(( now - $(stat -c %Y "$t") ))
      (( age <= STALL )) && continue

      # A terminal API error leaves its message as the last thing in the
      # transcript. Death and a wedge need different fixes: a corpse needs
      # restarting, a wedge needs diagnosing first.
      if tail -c 4000 "$t" | grep -qE 'API Error: (429|5[0-9][0-9])|Overloaded|rate.?limit'; then
        kind="DEAD"; detail="died with an API error"
      else
        kind="STALL"; detail="silent, likely wedged on a command"
      fi

      key="$kind:$name:$a"
      n="${announced[$key]:-0}"
      if (( n == 0 || n % STALL_EVERY == 0 )); then
        echo "$kind  [$name] ${a:0:12} $detail after ${age}s  (${done_n}/${EXPECTED} done)"
      fi
      announced[$key]=$(( n + 1 ))
    done
  done

  (( live )) || { echo "COMPLETE  all watched workflows finished"; exit 0; }
  sleep 45
done
