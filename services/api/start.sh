#!/bin/sh
# Runs the collector, the agents, the Slack bridge and the service in one machine,
# because they share one data volume. The collector, the agents and the bridge
# restart if they stop; if the service stops, the machine restarts. Each process gets
# only the secrets it needs.
cd "$(dirname "$0")/../.." || exit 1

(
  while true; do
    env -u GEMINI_API_KEY -u GUEST_SECRET -u TRANSIT_TOKENS -u TRANSIT_TOKEN_AGENT -u TRANSIT_TOKEN_MEDIA \
      -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u TRANSIT_TOKEN_SLACK \
      node --disable-warning=ExperimentalWarning services/api/src/collect.ts
    echo "Collector stopped. Restarting in 10 seconds." >&2
    sleep 10
  done
) &

# The chat agent and the media agent, once they have a Gemini key and the lead's
# token. They are the first the kernel kills when memory runs out. The first connect
# may fail while the service starts; the loop tries again.
if [ -n "$GEMINI_API_KEY" ] && [ -n "$TRANSIT_TOKEN_AGENT" ]; then
  for agent in main media; do
    (
      echo 1000 > /proc/self/oom_score_adj
      while true; do
        env -u GUEST_SECRET -u TRANSIT_TOKENS -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u TRANSIT_TOKEN_SLACK TRANSIT_URL="http://127.0.0.1:${PORT:-4100}" \
          /opt/agents/bin/python "agents/$agent.py" listen
        echo "The $agent.py agent stopped. Restarting in 10 seconds." >&2
        sleep 10
      done
    ) &
  done
fi

# The Slack bridge, once it has Slack's two tokens and its own planner:slack token
# (TRANSIT_TOKEN_SLACK, listed in TRANSIT_TOKENS). It needs no Gemini key: the chat
# agent answers what it asks.
if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_APP_TOKEN" ]; then
  if [ -n "$TRANSIT_TOKEN_SLACK" ]; then
    (
      echo 1000 > /proc/self/oom_score_adj
      while true; do
        env -u GEMINI_API_KEY -u GUEST_SECRET -u TRANSIT_TOKENS -u TRANSIT_TOKEN_AGENT -u TRANSIT_TOKEN_MEDIA \
          -u SLACK_WEBHOOK_URL TRANSIT_URL="http://127.0.0.1:${PORT:-4100}" \
          /opt/agents/bin/python agents/slack_bridge.py
        echo "The Slack bridge stopped. Restarting in 10 seconds." >&2
        sleep 10
      done
    ) &
  else
    echo "The Slack bridge needs TRANSIT_TOKEN_SLACK, a planner:slack token in TRANSIT_TOKENS." >&2
  fi
fi

exec env -u GEMINI_API_KEY -u TRANSIT_TOKEN_AGENT -u TRANSIT_TOKEN_MEDIA -u SLACK_BOT_TOKEN -u SLACK_APP_TOKEN -u TRANSIT_TOKEN_SLACK \
  node --disable-warning=ExperimentalWarning services/api/src/main.ts
