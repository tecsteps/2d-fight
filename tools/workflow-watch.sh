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
set -uo pipefail

DIR="${1:?workflow transcript dir}"
EXPECTED="${2:?expected agent count}"
STALL="${3:-420}"

STALL_EVERY=6
poll=0
declare -A announced=()

while true; do
  poll=$((poll + 1))

  if [[ ! -d "$DIR" ]]; then
    echo "STALL  workflow dir vanished: $DIR"
    exit 1
  fi

  journal="$DIR/journal.jsonl"
  [[ -f "$journal" ]] || { sleep 20; continue; }

  done_n=$(grep -c '"type":"result"' "$journal" 2>/dev/null || echo 0)
  if (( done_n >= EXPECTED )); then
    echo "COMPLETE  all $EXPECTED agents returned"
    exit 0
  fi

  # Agents the journal started but never returned a result for.
  mapfile -t started < <(grep '"type":"started"' "$journal" 2>/dev/null \
    | sed -n 's/.*"agentId":"\([^"]*\)".*/\1/p')
  mapfile -t finished < <(grep '"type":"result"' "$journal" 2>/dev/null \
    | sed -n 's/.*"agentId":"\([^"]*\)".*/\1/p')

  now=$(date +%s)
  for a in "${started[@]}"; do
    for f in "${finished[@]}"; do [[ "$a" == "$f" ]] && continue 2; done

    t="$DIR/agent-$a.jsonl"
    [[ -f "$t" ]] || continue
    age=$(( now - $(stat -c %Y "$t") ))
    (( age <= STALL )) && continue

    # A terminal API error leaves its message as the last thing in the
    # transcript. Distinguishing death from a wedge changes the fix: a corpse
    # needs restarting, a wedge needs diagnosing first.
    if tail -c 4000 "$t" | grep -qE 'API Error: (429|5[0-9][0-9])|Overloaded|rate.?limit'; then
      kind="DEAD"
      detail="died with an API error"
    else
      kind="STALL"
      detail="silent, likely wedged on a command"
    fi

    key="$kind:$a"
    n="${announced[$key]:-0}"
    if (( n == 0 || n % STALL_EVERY == 0 )); then
      echo "$kind  ${a:0:12} $detail after ${age}s  (${done_n}/${EXPECTED} done)"
    fi
    announced[$key]=$(( n + 1 ))
  done

  sleep 45
done
