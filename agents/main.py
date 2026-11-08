"""The lead agent on Gemini, working through the Transit Agents service's tools over MCP.

    python agents/main.py [listen]                          answer each message a planner sends from the display's chat
    python agents/main.py run "task" --study ID [--title T]  run one task on a study, opening it if it's new
    python agents/main.py eval [args]                        run the eval set, with agents/evals.py

Settings come from the environment, or agents/.env: GEMINI_API_KEY, TRANSIT_URL,
TRANSIT_TOKEN_AGENT (or DATA_DIR, the demo's data folder, for the demo's token),
LEAD_MODEL, SPECIALIST_MODEL, MAX_MODEL_CALLS (for each agent), MAX_RUN_CALLS and
MAX_RUN_USD (for a run: the lead and its specialists; default 60 calls and US$2),
MAX_DAILY_USD, MAX_RUNS_PER_HOUR and MAX_RUN_MINUTES (while it listens; default US$10
a UTC day, 20 runs an hour and 10 minutes a run), SPECIALIST_CONCURRENCY and
MODEL_PRICES (see agents/prices.py).
"""

import argparse
import asyncio
import contextlib
import signal
import sys
import time
from collections import deque
from collections.abc import Awaitable, Sequence
from typing import Any, TypeVar

import httpx2
from google.genai.client import AsyncClient
from mcp import ClientSession, MCPError

from core import (
    ModelError,
    SetupError,
    ToolError,
    call,
    clip,
    config,
    connect,
    for_planners,
    gemini,
    open_session,
    pages_read,
    report,
    spent_today,
)
from citations import citations, pages_in
from lead import run_lead

POLL_SECONDS = 3
PAGE = 200  # log entries read at a time

# The chat a run is given with a planner's message, so a follow-up makes sense: the
# study's last few messages, each shortened. A listener that starts reads this far
# back in the log for them.
HISTORY = 8
HISTORY_CHARS = 1000
BACKLOG = 1000

# Posted when the lead finishes without a word, so the planner doesn't take it for an answer.
NO_ANSWER = "The lead gave no answer. Try again, or ask differently."

# Added to an answer whose citations the run didn't read.
UNCHECKED = "Not checked: this run didn't read"
NO_SUCH_PAGE = "No such page:"

# Posted when the agent is stopped mid-run, as by Ctrl+C or SIGTERM.
STOPPED = "Stopped before answering."

# A run the listener starts stops after MAX_RUN_MINUTES of these, in seconds, so one
# that stalls doesn't hold up every other study's messages.
MINUTE = 60

# Posted, once a study, instead of starting a run past a listener's limits.
SPENT = "The agent has reached today's spending limit, so it won't answer again today."
BUSY = "The agent has answered as many messages as it may this hour. Try again later."
HOUR = 3600


def chat_message(entry: dict[str, Any]) -> tuple[str, str] | None:
    """Who wrote a chat message in a study, "planner" or "agent", and its text, or None for any other log entry."""
    data = entry.get("data") or {}
    if entry.get("type") != "activity" or data.get("kind") != "message" or not entry.get("studyId"):
        return None
    who = "planner" if str(entry.get("actor", "")).startswith("planner:") else "agent"
    return who, str(data.get("text", ""))


def with_history(question: str, earlier: Sequence[tuple[str, str]]) -> list[str]:
    """A run's task: the study's earlier chat, marked as such, then the planner's question."""
    asked = f"A planner asks: {question}"
    if not earlier:
        return [asked]
    lines = "\n".join(f"{'Planner' if who == 'planner' else 'Agent'}: {clip(text, HISTORY_CHARS)}" for who, text in earlier)
    return [f"Earlier in this study's chat, oldest first, for context:\n<chat>\n{lines}\n</chat>", asked]


def planner_message(entry: dict[str, Any]) -> str | None:
    """The text of a planner's chat message in a study, or None for any other log entry."""
    data = entry.get("data") or {}
    is_planner_message = (
        entry.get("type") == "activity"
        and data.get("kind") == "message"
        and str(entry.get("actor", "")).startswith("planner:")
        and entry.get("studyId")
    )
    return data.get("text") if is_planner_message else None


async def check_citations(session: ClientSession, study: str, text: str, read: set[tuple[str, int]]) -> str:
    """The answer, with a line naming any page it cites that the run didn't read and the
    service hasn't checked, and any page that doesn't exist.

    A page counts as checked when the run read it, or when a figure, finding or rule in
    the study cites it: the service checked those quotes against their pages.
    """
    sources = {source["id"]: source.get("pageCount") for source in await call(session, "list_sources")}
    cited = [(c["source"], c["page"]) for c in citations(text, sources)]
    if not cited:
        return text
    checked = set(read)
    checked |= set(pages_in(await call(session, "get_study", {"studyId": study})))
    checked |= set(pages_in(await call(session, "list_rules")))
    missing = [(source, page) for source, page in cited if isinstance(sources[source], int) and page > sources[source]]
    unread = [(source, page) for source, page in cited if (source, page) not in checked and (source, page) not in missing]
    lines = [text]
    if unread:
        lines.append(f"{UNCHECKED} " + ", ".join(f"({source} p. {page})" for source, page in unread) + ".")
    if missing:
        lines.append(f"{NO_SUCH_PAGE} " + ", ".join(f"{source} has no page {page}" for source, page in missing) + ".")
    return "\n\n".join(lines)


async def answer(
    session: ClientSession,
    client: AsyncClient,
    study: str,
    task: str | Sequence[str],
    *,
    posted: set[int] | None = None,
    seconds: float | None = None,
) -> str:
    """Run the lead on a task, in the study's chat: the run shows, then its answer, with
    any citation it couldn't check marked.

    A failure is posted in the chat too, in plain words, then raised with its detail
    for the terminal, and so is a stop. A run still going after `seconds`, if given, is
    stopped, and the chat says so. The log position of each message it posts goes in
    `posted`, if given.
    """

    async def say(text: str) -> None:
        seq = await report(session, study, "message", text=clip(text, 4000))
        if posted is not None and seq is not None:
            posted.add(seq)

    await report(session, study, "run.started")
    try:
        try:
            read: set[tuple[str, int]] = set()
            reading = pages_read.set(read)
            try:
                async with asyncio.timeout(seconds):
                    text = (await run_lead(session, client, study, task)).strip() or NO_ANSWER
            finally:
                pages_read.reset(reading)
            text = await check_citations(session, study, text, read)
        except TimeoutError:
            minutes = round(seconds / MINUTE) if seconds else 0
            await say(f"That took more than {minutes} {'minute' if minutes == 1 else 'minutes'}, so the agent stopped. Try again, or ask something narrower.")
            raise
        except Exception as error:
            await say(f"That failed. {for_planners(error)}")
            raise
        except (asyncio.CancelledError, KeyboardInterrupt):
            with contextlib.suppress(Exception):
                async with asyncio.timeout(10):
                    await say(STOPPED)
            raise
        await say(text)
        return text
    finally:
        await report(session, study, "run.finished")


class Listener:
    """Answers each message a planner sends, from log position `after` (default: the
    log's head when it starts). It never answers a message it posted itself.

    Each run gets the study's last few chat messages with the question, so a follow-up
    makes sense. It keeps its place in the log, and the chat, so it can carry on in a
    new session.
    """

    def __init__(self, client: AsyncClient, *, after: int | None = None, poll_seconds: float = POLL_SECONDS):
        self.client = client
        self.after = after
        self.poll_seconds = poll_seconds
        self.posted: set[int] = set()
        self.chats: dict[str, deque[tuple[str, str]]] = {}
        self.read_back = False
        self.started: deque[float] = deque()  # when each run started, for MAX_RUNS_PER_HOUR
        self.told: set[str] = set()  # studies told a limit stops their runs, until a run starts

    def _held_back(self) -> str | None:
        """Why a run mustn't start now, past MAX_DAILY_USD or MAX_RUNS_PER_HOUR, or None."""
        settings = config()
        if spent_today() >= settings.max_daily_usd:
            return SPENT
        now = time.monotonic()
        while self.started and now - self.started[0] >= HOUR:
            self.started.popleft()
        return BUSY if len(self.started) >= settings.max_runs_per_hour else None

    def _hear(self, entry: dict[str, Any]) -> None:
        """Keep a chat message for its study's history."""
        if (message := chat_message(entry)) is not None:
            self.chats.setdefault(entry["studyId"], deque(maxlen=HISTORY)).append(message)

    async def _read_back(self, session: ClientSession, head: int) -> None:
        """Keep the chat messages from before it started, up to BACKLOG entries back."""
        after = max(0, head - BACKLOG)
        while after < head:
            entries = await call(session, "read_log", {"after": after, "limit": PAGE})
            for entry in entries:
                if entry["seq"] <= head:
                    self._hear(entry)
            if not entries:
                break
            after = entries[-1]["seq"]

    async def run(self, session: ClientSession) -> None:
        """Listen in this session until stopped, or until the service can't be reached."""
        head = (await call(session, "get_log_head"))["seq"]
        if self.after is None or head < self.after:  # a new log starts again from 0
            self.after = head
        if not self.read_back:
            await self._read_back(session, self.after)
            self.read_back = True
        while True:
            entries = await call(session, "read_log", {"after": self.after, "limit": PAGE})
            # One run a study at a time: messages that came in while it was busy get one
            # answer, to the last of them, with the others in its history.
            last = {
                entry["studyId"]: entry["seq"]
                for entry in entries
                if entry["seq"] not in self.posted and planner_message(entry) is not None
            }
            for entry in entries:
                self.after = entry["seq"]
                if self.after in self.posted:
                    self.posted.discard(self.after)
                    self._hear(entry)
                    continue
                if (question := planner_message(entry)) is None:
                    self._hear(entry)
                    continue
                study = entry["studyId"]
                task = with_history(question, list(self.chats.get(study, ())))
                self._hear(entry)
                if last[study] != entry["seq"]:
                    continue
                if (reason := self._held_back()) is not None:
                    print(f"{study}: {question}\n  Not answered: {reason}", flush=True)
                    if study not in self.told:
                        self.told.add(study)
                        if (seq := await report(session, study, "message", text=reason)) is not None:
                            self.posted.add(seq)
                    continue
                self.started.append(time.monotonic())
                self.told.discard(study)
                print(f"{study}: {question}", flush=True)
                try:
                    seconds = config().max_run_minutes * MINUTE
                    text = await answer(session, self.client, study, task, posted=self.posted, seconds=seconds)
                except Exception as error:  # it's in the chat; keep listening
                    print(f"  That failed: {error}", file=sys.stderr, flush=True)
                else:
                    print(f"  {clip(text, 300)}", flush=True)
            if len(entries) < PAGE:
                await asyncio.sleep(self.poll_seconds)


async def listen(
    session: ClientSession, client: AsyncClient, *, after: int | None = None, poll_seconds: float = POLL_SECONDS
) -> None:
    """Answer each message a planner sends, from log position `after` (default: now), until stopped."""
    await Listener(client, after=after, poll_seconds=poll_seconds).run(session)


async def keep_listening(
    client: AsyncClient,
    *,
    url: str | None = None,
    token: str | None = None,
    poll_seconds: float = POLL_SECONDS,
    retry_seconds: float = 1,
    most_seconds: float = 60,
) -> None:
    """Listen until stopped, through outages: when the service goes away, say so once,
    then connect again, waiting longer each time up to `most_seconds`, and carry on
    where it left off. It must connect the first time."""
    url = (url or config().service_url).rstrip("/")
    listener = Listener(client, poll_seconds=poll_seconds)
    connected = lost = False
    wait = retry_seconds
    while True:
        try:
            async with open_session(url, token) as session:
                if lost:
                    print(f"Back on {url}. Listening again.", flush=True)
                elif not connected:
                    print(f"Listening for planners' messages on {url}. Stop with Ctrl+C.", flush=True)
                connected, lost, wait = True, False, retry_seconds
                await listener.run(session)
        except Exception as error:
            if not connected or not outage(error):
                raise
            if not lost:
                said = plainly(error, url) or str(error)
                print(f"{said} Trying again until it's back.", file=sys.stderr, flush=True)
                lost = True
            await asyncio.sleep(wait)
            wait = min(wait * 2, most_seconds)


async def run_task(session: ClientSession, client: AsyncClient, task: str, study: str, title: str | None = None) -> str:
    """Run one task on a study, opening the study first if it's new."""
    try:
        await call(session, "get_study", {"studyId": study})
    except ToolError as error:
        if not error.message.startswith("404"):
            raise
        # Usage is recorded per study, so it has to be open before the first model call.
        await call(session, "open_study", {"id": study, "title": title or study})
    return await answer(session, client, study, task)


async def _listen() -> None:
    # Hold the client open: google-genai closes its connections once it's dropped.
    async with gemini().aio as client:
        await keep_listening(client)


async def _run(task: str, study: str, title: str | None) -> str:
    async with connect() as (session, client):
        return await run_task(session, client, task, study, title)


T = TypeVar("T")


async def until_stopped(work: Awaitable[T]) -> T:
    """Await `work`, which SIGTERM stops as Ctrl+C does. Docker, systemd and most
    process managers stop a process with SIGTERM.

    Either way the run is cancelled, so it still reports its end and each specialist's,
    then KeyboardInterrupt is raised.
    """
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    assert task is not None
    stopped = False

    def stop() -> None:
        nonlocal stopped
        stopped = True
        task.cancel()

    loop.add_signal_handler(signal.SIGTERM, stop)
    try:
        return await work
    except asyncio.CancelledError:
        if stopped:
            raise KeyboardInterrupt from None
        raise
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["eval"]:
        import evals

        return evals.main(argv[1:]) or 0

    parser = argparse.ArgumentParser(prog="python agents/main.py", description="Run the lead agent.")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("listen", help="answer planners' chat messages until stopped (the default)")
    one = commands.add_parser("run", help="run one task on a study")
    one.add_argument("task", help="what to do, in plain words")
    one.add_argument("--study", required=True, help="the study's id; it's opened if it's new")
    one.add_argument("--title", help="a new study's title (default: its id)")
    commands.add_parser("eval", help="run the eval set: python agents/main.py eval [args]")
    args = parser.parse_args(argv)

    try:
        if args.command == "run":
            print(asyncio.run(until_stopped(_run(args.task, args.study, args.title))))
        else:
            asyncio.run(until_stopped(_listen()))
    except KeyboardInterrupt:
        return 130 if args.command == "run" else 0
    except Exception as error:
        if (said := plainly(error)) is None:
            raise  # a bug: keep its traceback
        print(said, file=sys.stderr)
        return 1
    return 0


def plainly(error: BaseException, url: str | None = None) -> str | None:
    """One line on an error a person can act on, such as an outage of the service at
    `url` (default: TRANSIT_URL), or None for a bug."""
    error = _first(error)
    if isinstance(error, (SetupError, ModelError, ToolError)):
        return str(error)
    if isinstance(error, (httpx2.TransportError, MCPError)):
        said = str(error) or type(error).__name__
        return f"Lost the service at {url or config().service_url}: {said}. Is it still running?"
    return None


def outage(error: BaseException) -> bool:
    """Whether the service couldn't be reached: gone away, or not back yet."""
    error = _first(error)
    unreachable = (httpx2.TransportError, MCPError)
    if isinstance(error, SetupError):  # it couldn't connect again
        error = error.__cause__ or error
    return isinstance(error, unreachable)


def _first(error: BaseException) -> BaseException:
    while isinstance(error, BaseExceptionGroup):  # several requests failed at once, say
        error = error.exceptions[0]
    return error


if __name__ == "__main__":
    sys.exit(main())
