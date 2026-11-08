"""Ask the lead from Slack: a mention, or a direct message, goes into a study's chat,
and the lead's answer comes back in the Slack thread with a link to the study.

    python agents/slack_bridge.py

It connects over Socket Mode, so it needs no public address. It reads SLACK_BOT_TOKEN
(xoxb-) and SLACK_APP_TOKEN (xapp-) from the environment or agents/.env, and posts as
the service's "slack" planner token: TRANSIT_TOKEN_SLACK, or else the demo's "slack"
token in DATA_DIR/demo-tokens.json. The log names it planner:slack. Decisions are never
made from Slack: only a signed-in planner records one.

"@Transit Agents what would the Don Mills extension cost?" asks the Ontario Line study.
"ontario:", "lawrence:", "sherbourne:" or a study's id in front picks the study.
"""

import json
import os
import re
import sys
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import dotenv
import httpx

HERE = Path(__file__).parent

# Short names for the demo's studies, and the one a question without a prefix goes to.
STUDIES = {
    "ontario": "ontario-line-don-mills",
    "lawrence": "lawrence-sunnybrook",
    "sherbourne": "sherbourne-castle-frank",
}
DEFAULT_STUDY = STUDIES["ontario"]

# How long to wait for the lead, and how often to read the log meanwhile, in seconds.
WAIT_SECONDS = 240
POLL_SECONDS = 2

# The most of an answer a Slack reply shows, in characters; the study has all of it.
SLACK_LIMIT = 2500
# The most a chat message may be, as the service allows.
MESSAGE_LIMIT = 4000

WORKING = "Working on it…"
TIMED_OUT = "The lead hasn't answered after 4 minutes. It may still be working: the answer will be in the study."
NO_QUESTION = "Ask me something about a study, such as “what would the Don Mills extension cost?”. Put ontario:, lawrence: or sherbourne: in front to pick the study."
DECISIONS = "Decisions can't be made from Slack. Only a signed-in planner can record a decision, in the study."
FAILED = "I couldn't reach the study just now. Try again in a minute."

# The agents whose messages aren't the lead's answers: the scripted replay's and the media agent's.
NOT_THE_LEAD = frozenset({"agent:replay", "agent:media"})

# What the lead says, without starting a run, when it won't answer: past its limits.
HELD_BACK = ("The agent has reached today's spending limit", "The agent has answered as many messages")

# Leading user mentions, as Slack sends them: <@U123> or <@U123|name>.
MENTION = re.compile(r"^\s*(?:<@[A-Z0-9]+(?:\|[^>]*)?>[\s,:]*)+", re.I)
# A study prefix: a short name or an id, then a colon.
PREFIX = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s*")

# Asking the agents to adopt, decide or record a decision, as against asking about one.
# "Should we adopt option B?" asks for advice, so the lead answers it.
_ASK = r"(?:adopt|decide|approve|reject|choose|pick|select|go\s+with|sign\s+off|finali[sz]e)"
DECIDING = re.compile(
    rf"^(?:please\s+|ok(?:ay)?[,\s]+|so[,\s]+)*{_ASK}\b"
    rf"|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?{_ASK}\b"
    rf"|\blet['’]?s\s+(?:just\s+)?{_ASK}\b"
    rf"|\bwe(?:['’]ll|\s+will|\s+have)\s+(?:decided|{_ASK})\b"
    r"|\b(?:make|record|log|take)\s+(?:a|the|this|that|our)?\s*decision\b"
    r"|^decision\s*:",
    re.I,
)


@dataclass(frozen=True)
class Request:
    """A question from Slack: the study it's for, its words, and whether it asks to decide."""

    study: str
    text: str
    deciding: bool = False


def parse(text: str, known: Iterable[str] = ()) -> Request:
    """The study and the question in a Slack message, without the bot's mention. A known
    short name or study id, then a colon, picks the study; otherwise it's the Ontario Line's."""
    text = MENTION.sub("", text or "").strip()
    study = DEFAULT_STUDY
    if match := PREFIX.match(text):
        name = match.group(1).lower()
        if name in STUDIES:
            study, text = STUDIES[name], text[match.end() :]
        elif name in set(known):
            study, text = name, text[match.end() :]
    text = text.strip()
    return Request(study, text, bool(DECIDING.search(text)))


def answer_in(entries: Sequence[dict[str, Any]], study: str, after: int) -> str | None:
    """The lead's answer to the message at log position `after`, from the log entries
    since, or None while there is none yet.

    The answer is the last message the lead writes in a run that starts after the
    question: a run already going when it was asked answers an earlier one. A run that
    ends without a message gives an empty answer. A line saying the lead is past its
    limits, which comes without a run, is an answer too.
    """
    running = False
    said: str | None = None
    for entry in entries:
        if entry.get("seq", 0) <= after or entry.get("studyId") != study or entry.get("audience"):
            continue
        actor = str(entry.get("actor", ""))
        if entry.get("type") != "activity" or not actor.startswith("agent:") or actor in NOT_THE_LEAD:
            continue
        data = entry.get("data") or {}
        kind = data.get("kind")
        if kind == "run.started":
            running, said = True, None
        elif kind == "message" and running:
            said = str(data.get("text", ""))
        elif kind == "message" and str(data.get("text", "")).startswith(HELD_BACK):
            return str(data["text"])
        elif kind == "run.finished" and running:
            return said or ""
    return None


def mrkdwn(text: str) -> str:
    """Plain or Markdown text as Slack's mrkdwn: &, < and > escaped, bold and links in
    Slack's form, and list items as bullets."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)", r"<\2|\1>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text)
    text = re.sub(r"^#{1,6}\s+(.+)$", r"*\1*", text, flags=re.M)
    text = re.sub(r"^(\s*)[-*]\s+", r"\1• ", text, flags=re.M)
    return text.strip()


def clip(text: str, limit: int = SLACK_LIMIT) -> str:
    """Text shortened to `limit` characters at a line or a word, marking the cut."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    at = max(cut.rfind("\n"), cut.rfind(" "))
    if at > limit // 2:
        cut = cut[:at]
    # Never leave half an escape, such as &am, or half a link.
    cut = re.sub(r"&[a-z]*$", "", cut)
    if cut.rfind("<") > cut.rfind(">"):
        cut = cut[: cut.rfind("<")]
    return cut.rstrip() + "…"


def link(public_url: str, study: str) -> str:
    return f"<{public_url.rstrip('/')}/#{study}|Open the study>"


def reply(answer: str, public_url: str, study: str) -> str:
    """The Slack reply for an answer: the answer in mrkdwn, clipped, then the study's link."""
    body = clip(mrkdwn(answer)) if answer.strip() else "The lead finished without an answer. Try again, or ask differently."
    return f"{body}\n\n{link(public_url, study)}"


def slack_token() -> str:
    """The service token the bridge posts with: TRANSIT_TOKEN_SLACK, or the demo's "slack" one."""
    if token := os.environ.get("TRANSIT_TOKEN_SLACK"):
        return token
    data = Path(os.environ.get("DATA_DIR") or HERE.parent / "data")
    try:
        token = json.loads((data / "demo-tokens.json").read_text()).get("slack")
    except FileNotFoundError:
        token = None
    if not token:
        sys.exit(
            "No token for the Slack bridge. Set TRANSIT_TOKEN_SLACK to a planner:slack token, "
            f'or start the demo, which writes a "slack" token to {data / "demo-tokens.json"}.'
        )
    return token


class Service:
    """The few calls the bridge makes to the service, as the slack planner."""

    def __init__(self, url: str, token: str, client: httpx.Client | None = None):
        self.url = url.rstrip("/")
        self.http = client or httpx.Client(timeout=15, headers={"authorization": f"Bearer {token}"})

    def studies(self) -> dict[str, str]:
        """Each study's id and title."""
        response = self.http.get(f"{self.url}/v1/studies")
        response.raise_for_status()
        return {study["id"]: study.get("title") or study["id"] for study in response.json()}

    def ask(self, study: str, text: str, key: str) -> int:
        """Post a message in the study's chat, once for each key, and return its log position."""
        response = self.http.post(
            f"{self.url}/v1/studies/{study}/activity",
            json={"kind": "message", "text": text[:MESSAGE_LIMIT]},
            headers={"idempotency-key": key},
        )
        response.raise_for_status()
        return int(response.json()["seq"])

    def log(self, after: int) -> list[dict[str, Any]]:
        response = self.http.get(f"{self.url}/v1/log", params={"after": after, "limit": 200})
        response.raise_for_status()
        return response.json()


class Bridge:
    """Answers one Slack message at a time, each in its own thread: Bolt runs each
    event's listener on a worker of its own."""

    def __init__(
        self,
        service: Service,
        public_url: str,
        *,
        wait_seconds: float = WAIT_SECONDS,
        poll_seconds: float = POLL_SECONDS,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.service = service
        self.public_url = public_url.rstrip("/")
        self.wait_seconds = wait_seconds
        self.poll_seconds = poll_seconds
        self.sleep = sleep
        self.clock = clock
        self.seen: set[str] = set()
        self.lock = threading.Lock()

    def first_time(self, key: str) -> bool:
        """Whether this Slack message is new: Slack may deliver an event again."""
        with self.lock:
            if key in self.seen:
                return False
            self.seen.add(key)
            return True

    def handle(self, event: dict[str, Any], client: Any) -> None:
        """Answer one mention or direct message, in its thread."""
        channel, ts = event.get("channel"), event.get("ts")
        if not channel or not ts or not self.first_time(f"{channel}:{ts}"):
            return
        thread = event.get("thread_ts") or ts

        def post(text: str) -> str:
            return client.chat_postMessage(channel=channel, thread_ts=thread, text=text, unfurl_links=False)["ts"]

        try:
            known = self.service.studies()
        except httpx.HTTPError as error:
            print(f"Can't list the studies: {type(error).__name__}", file=sys.stderr, flush=True)
            post(FAILED)
            return
        request = parse(event.get("text", ""), known)
        if not request.text:
            post(NO_QUESTION)
            return
        if request.study not in known:
            post(f"There's no study called {request.study} yet.")
            return
        if request.deciding:
            post(f"{DECISIONS}\n\n{link(self.public_url, request.study)}")
            return

        working = post(WORKING)

        def say(text: str) -> None:
            client.chat_update(channel=channel, ts=working, text=text)

        try:
            seq = self.service.ask(request.study, request.text, f"slack:{channel}:{ts}")
        except httpx.HTTPError as error:
            print(f"Can't post to {request.study}: {type(error).__name__}", file=sys.stderr, flush=True)
            say(FAILED)
            return
        print(f"{request.study}: asked from Slack at {seq}", flush=True)
        answer = self.wait(request.study, seq)
        if answer is None:
            say(f"{TIMED_OUT}\n\n{link(self.public_url, request.study)}")
            print(f"{request.study}: no answer to {seq} in time", flush=True)
        else:
            say(reply(answer, self.public_url, request.study))
            print(f"{request.study}: answered {seq} in Slack", flush=True)

    def wait(self, study: str, seq: int) -> str | None:
        """The lead's answer to the message at `seq`, or None after wait_seconds."""
        entries: list[dict[str, Any]] = []
        after = seq
        deadline = self.clock() + self.wait_seconds
        while self.clock() < deadline:
            try:
                page = self.service.log(after)
            except httpx.HTTPError:
                page = []
            if page:
                entries.extend(entry for entry in page if entry.get("studyId") == study)
                after = page[-1]["seq"]
                if (answer := answer_in(entries, study, seq)) is not None:
                    return answer
            if len(page) < 200:
                self.sleep(self.poll_seconds)
        return None


def wanted(event: dict[str, Any]) -> bool:
    """Whether a message event is a person's new direct message: not a bot's, nor an edit."""
    return event.get("channel_type") == "im" and not event.get("subtype") and not event.get("bot_id")


def main() -> int:
    dotenv.load_dotenv(HERE / ".env")
    bot, app_token = os.environ.get("SLACK_BOT_TOKEN"), os.environ.get("SLACK_APP_TOKEN")
    if not bot or not app_token:
        print("Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN, in the environment or agents/.env, to run the Slack bridge.", file=sys.stderr)
        return 1
    from slack_bolt import App
    from slack_bolt.adapter.socket_mode import SocketModeHandler

    url = (os.environ.get("TRANSIT_URL") or "http://127.0.0.1:4100").rstrip("/")
    bridge = Bridge(Service(url, slack_token()), os.environ.get("PUBLIC_URL") or url)
    # certifi's roots: python.org's Python on a Mac ships with none until its
    # "Install Certificates" step is run, and then every call to Slack fails.
    import ssl

    import certifi
    from slack_sdk import WebClient

    context = ssl.create_default_context(cafile=certifi.where())
    app = App(client=WebClient(token=bot, ssl=context))

    @app.event("app_mention")
    def mention(event: dict[str, Any], client: Any) -> None:
        if not event.get("bot_id") and not event.get("subtype"):
            bridge.handle(event, client)

    @app.event("message")
    def message(event: dict[str, Any], client: Any) -> None:
        # Channel messages that mention the bot come as app_mention too; only DMs are answered here.
        if wanted(event):
            bridge.handle(event, client)

    print(f"Listening on Slack for questions to {url}. Stop with Ctrl+C.", flush=True)
    try:
        handler = SocketModeHandler(app, app_token)
        handler.client.web_client.ssl = context
        handler.start()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
