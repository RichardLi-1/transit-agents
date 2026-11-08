"""Computer use from the chat, for the local demo.

When a planner asks in a study's chat to work the simulator, such as "Retime the Don
Mills & Eglinton signal in the simulator", this opens the mock intersection simulator
in a window on this machine, lets Gemini work it by sight (computer_use.py --app
microsim), and posts in the chat what it changed and what it cost. npm run dev starts
it, and tells the lead to leave those messages to it. One run at a time.

    python computer_listen.py

Settings: TRANSIT_URL, DATA_DIR (for the demo's "computer" token) or
TRANSIT_TOKEN_COMPUTER, and GEMINI_API_KEY in agents/.env, as for computer_use.py.
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

HERE = Path(__file__).parent
# A planner's message that asks for the simulator. The lead leaves these to this.
TRIGGER = re.compile(r"\b(simulator|signal timing|retime|computer use)\b", re.I)
HOLD_SECONDS = 8
POLL_SECONDS = 1.5


def wants_computer(text: str) -> bool:
    return bool(TRIGGER.search(text))


def token() -> str:
    if value := os.environ.get("TRANSIT_TOKEN_COMPUTER"):
        return value
    data = Path(os.environ.get("DATA_DIR") or HERE.parent / "data")
    value = json.loads((data / "demo-tokens.json").read_text()).get("computer")
    if not value:
        sys.exit('No "computer" token: restart the demo, which writes one to demo-tokens.json.')
    return value


def asked(entry: dict[str, Any]) -> str | None:
    """The study a planner's message asks the simulator for, or None."""
    data = entry.get("data") or {}
    if entry.get("type") != "activity" or data.get("kind") != "message" or entry.get("audience"):
        return None
    if not str(entry.get("actor", "")).startswith("planner:") or not entry.get("studyId"):
        return None
    return entry["studyId"] if wants_computer(str(data.get("text", ""))) else None


def summary(lines: list[str], ok: bool) -> str:
    """What the run did, in the chat's words, from computer_use.py's last lines."""
    saved = next((line for line in lines if line.startswith("The app saved:")), "")
    outcome = next((line for line in lines if line.startswith("Northbound left:")), "")
    cost = next((line for line in lines if "model calls" in line), "")
    if not ok or not saved or saved.endswith("nothing."):
        last = next((line for line in reversed(lines) if line.strip()), "no output")
        return f"The simulator run didn't finish: {last[:300]}"
    done = saved.removeprefix("The app saved: ").rstrip(".")
    parts = [f"Done in the simulator, and saved: {done}."]
    if outcome:
        parts.append(outcome)
    parts.append("Gemini asked before saving; you set this task, so it went ahead.")
    if cost:
        parts.append(cost.split(",")[0].rstrip(".") + ".")
    return " ".join(parts)


def main() -> int:
    url = (os.environ.get("TRANSIT_URL") or "http://127.0.0.1:4100").rstrip("/")
    http = httpx.Client(base_url=url, headers={"authorization": f"Bearer {token()}"}, timeout=30)

    def say(study: str, text: str) -> None:
        http.post(f"/v1/studies/{study}/activity", json={"kind": "message", "text": text[:4000]}).raise_for_status()

    def mark(study: str, kind: str) -> None:
        http.post(f"/v1/studies/{study}/activity", json={"kind": kind}).raise_for_status()

    after = int(http.get("/health").json()["head"]["seq"])
    print(f"Listening for simulator requests on {url}. Stop with Ctrl+C.", flush=True)
    while True:
        try:
            page = http.get("/v1/log", params={"after": after, "limit": 200}).json()
        except httpx.HTTPError:
            time.sleep(POLL_SECONDS * 2)
            continue
        for entry in page:
            after = max(after, int(entry.get("seq", 0)))
            study = asked(entry)
            if not study:
                continue
            print(f"{study}: simulator run asked for at {entry['seq']}", flush=True)
            try:
                mark(study, "run.started")
                say(study, "Opening the intersection simulator on this screen. Gemini will work it by sight, and ask before it saves.")
                run = subprocess.run(
                    [sys.executable, str(HERE / "computer_use.py"), "--app", "microsim", "--headed", "--confirm",
                     "--hold", str(HOLD_SECONDS), "--study", study, "--service", url],
                    cwd=HERE.parent, capture_output=True, text=True, timeout=600,
                )
                lines = (run.stdout + run.stderr).splitlines()
                print("\n".join(lines[-6:]), flush=True)
                say(study, summary(lines, run.returncode == 0))
            except Exception as error:  # the run, or the service
                print(f"{study}: simulator run failed: {error}", file=sys.stderr, flush=True)
                try:
                    say(study, f"The simulator run didn't finish: {type(error).__name__}.")
                except httpx.HTTPError:
                    pass
            finally:
                try:
                    mark(study, "run.finished")
                except httpx.HTTPError:
                    pass
            # Anything asked while it ran is skipped: one run at a time.
            after = max(after, int(http.get("/health").json()["head"]["seq"]))
        if len(page) < 200:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
