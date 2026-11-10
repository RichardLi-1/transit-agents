"""Tests for the agents, against a throwaway service on port 4171 and a fake Gemini.

    agents/.venv/bin/python -m unittest discover -s agents/tests -t agents

Where those ports are taken, set AGENT_TEST_PORT for the service (the media agent's
tests and those that need a second service use the next three ports) and EVAL_PORTS
for the eval runner's, such as EVAL_PORTS=4326-4330.

They never call Gemini. In case one tries, it gets a fake key and an address where
nothing listens, so it fails instead of spending money.
"""

import os

os.environ["GEMINI_API_KEY"] = "fake-key-for-tests"
os.environ["GOOGLE_GEMINI_BASE_URL"] = "http://127.0.0.1:9"
os.environ.pop("GOOGLE_API_KEY", None)
# Every model is Gemini's, faked, unless a test sets its own server: the default, Ollama
# on this machine, is never called.
os.environ["MODEL_BASE_URL"] = "off"
# The fake models cost nothing. Tests of costs set their own prices.
os.environ["MODEL_PRICES"] = "test-model=0/0,lead-model=0/0,specialist-model=0/0,reader-model=0/0,qwen3.5:9b=0/0,qwen3.5:4b=0/0"

import core  # noqa: E402  once the key and prices are set

# Retries happen at once in tests: a real run waits seconds between them.
core.RETRY = {**core.RETRY, "initial_delay": 0, "max_delay": 0}
