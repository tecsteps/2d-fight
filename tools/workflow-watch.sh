#!/usr/bin/env bash
# Hang detector for a running workflow.
#
# A workflow that dies loudly is easy — the harness notifies. The dangerous case
# is an agent that sits forever on a blocking command: the run stays "alive", no
# notification ever arrives, and the loop's fallback heartbeat is the only thing
# that eventually notices. This watches the actual evidence of progress (agents
# appending to their transcripts) and shouts when that stops.
#
# Usage: tools/workflow-watch.sh <workflow-dir> <expected-agent-count> [stall-seconds]
#
# Emits one line per event on stdout, so it can be driven by Monitor:
#   PROGRESS  n/N agents done, newest write Ns ago
#   STALL     no agent has written for Ns  <- act on this
#   COMPLETE  all N agents returned
set -uo pipefail

DIR="${1:?workflow transcript dir}"
EXPECTED="${2:?expected agent count}"
STALL="${3:-420}"

# Only re-announce a stall every Nth poll; a monitor that spams gets throttled.
STALL_EVERY=5
poll=0
stall_seen=0

while true; do
  poll=$((poll + 1))

  if [[ ! -d "$DIR" ]]; then
    echo "STALL  workflow dir vanished: $DIR"
    exit 1
  fi

  done_n=$(grep -c '"type":"result"' "$DIR/journal.jsonl" 2>/dev/null || echo 0)

  newest=0
  for f in "$DIR"/agent-*.jsonl; do
    [[ -e "$f" ]] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    (( m > newest )) && newest=$m
  done

  now=$(date +%s)
  age=$(( newest > 0 ? now - newest : 0 ))

  if (( done_n >= EXPECTED )); then
    echo "COMPLETE  all $EXPECTED agents returned"
    exit 0
  fi

  if (( newest > 0 && age > STALL )); then
    stall_seen=$((stall_seen + 1))
    if (( stall_seen == 1 || stall_seen % STALL_EVERY == 0 )); then
      echo "STALL  no agent transcript written for ${age}s (${done_n}/${EXPECTED} done)"
    fi
  else
    # Recovered, or still healthy — reset so the next stall announces promptly.
    if (( stall_seen > 0 )); then
      echo "PROGRESS  recovered, newest write ${age}s ago (${done_n}/${EXPECTED} done)"
    fi
    stall_seen=0
  fi

  sleep 45
done
