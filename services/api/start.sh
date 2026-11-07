#!/bin/sh
# Runs the collector and the service in one machine, because they share one
# data volume. The collector restarts if it stops; if the service stops, the
# machine restarts.
cd "$(dirname "$0")/../.." || exit 1

(
  while true; do
    node --disable-warning=ExperimentalWarning services/api/src/collect.ts
    echo "Collector stopped. Restarting in 10 seconds." >&2
    sleep 10
  done
) &

exec node --disable-warning=ExperimentalWarning services/api/src/main.ts
