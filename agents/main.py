"""The lead agent on Gemini, working through the Transit Agents service's tools over MCP.

    python agents/main.py [listen]                          answer each message a planner or a visitor sends from the display's chat
    python agents/main.py run "task" --study ID [--title T]  run one task on a study, opening it if it's new
    python agents/main.py eval [args]                        run the eval set, with agents/evals.py

Settings come from the environment, or agents/.env: GEMINI_API_KEY, TRANSIT_URL,
TRANSIT_TOKEN_AGENT (or DATA_DIR, the demo's data folder, for the demo's token),
LEAD_MODEL, SPECIALIST_MODEL, MAX_MODEL_CALLS (for each agent), MAX_RUN_CALLS and
MAX_RUN_USD (for a run: the lead and its specialists; default 60 calls and US$2),
MAX_DAILY_USD, MAX_RUNS_PER_HOUR and MAX_RUN_MINUTES (while it listens; default US$10
a UTC day, 20 runs an hour and 10 minutes a run), SPECIALIST_CONCURRENCY, RUNS_AT_ONCE
(visitors' runs the listener answers at once), GUEST_RUN_CALLS (MAX_RUN_CALLS for a
visitor's run) and MODEL_PRICES (see agents/prices.py).
"""

import argparse
import asyncio
import contextlib
import os
import re
import signal
import sys
import time
from collections import deque
from collections.abc import Awaitable, Sequence
from typing import Any, TypeVar

import httpx2
from google.genai.client import AsyncClient
from mcp import ClientSession, MCPError

from computer_listen import wants_computer
from core import (
    AUDIENCE,
    BUDGET_SPENT,
    EVERYONE,
    ModelError,
    SetupError,
    SpendCapReached,
    ToolError,
    call,
    clip,
    config,
    connect,
    for_planners,
    model_client,
    open_session,
    pages_read,
    report,
    spent_today,
)
from citations import citations, pages_in
from lead import run_lead

POLL_SECONDS = 3
PAGE = 200  # log entries read at a time

# The chat a run is given with a message, so a follow-up makes sense: the study's
# last few messages, as whoever asks sees the chat, each shortened. A listener that
# starts reads this far back in the log for them.
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


# Small talk, answered at once, with no model and no study tools: a greeting, thanks, or
# asking what the agent can do, and nothing else in the message. "hi" used to get the
# study's cost. Anything more goes to the lead, whose instructions cover other small talk.
GREETING = re.compile(r"^(?:h+i+|h+e+l+o+|h+e+y+|hiya|yo|howdy|good (?:morning|afternoon|evening))(?: there)?$")
THANKS = re.compile(r"^(?:ok(?:ay)? )?(?:thanks?(?: you)?(?: so much)?|thx|ty|cheers)$")
CAN_DO = re.compile(
    r"^(?:help|what (?:can|do) you do|what can i ask(?: you)?|what can you help (?:me )?with|who are you|what are you|how does this work)$"
)
CAPABILITIES = """I lead a team of specialist agents that do the first pass of a transit study, from the documents and open data here. Ask in plain words, for example:
- What would this cost, and what's the figure based on? Each figure links to its page.
- Does a service change pass the TTC's Service Standards?
- Who lives, works and travels near the route: income, jobs, collisions, cycling.
- Compare the options, or make a TPAP brief as a PDF.
Planners decide: I hand every judgement to one."""


def small_talk(text: str) -> str | None:
    """The reply to a message that is only small talk, or None for anything else."""
    words = " ".join(re.sub(r"[^a-z ]+", " ", text.lower()).split())
    if GREETING.match(words):
        return f"Hi! {CAPABILITIES}"
    if CAN_DO.match(words):
        return CAPABILITIES
    if THANKS.match(words):
        return "You're welcome. Ask me anything else about the study."
    return None


# Who wrote a chat message, by the start of its actor, and how its history names them.
WRITERS = {"planner:": "planner", "guest:": "visitor"}
NAMES = {"planner": "Planner", "visitor": "Visitor", "agent": "Agent"}


def chat_message(entry: dict[str, Any]) -> tuple[str, str] | None:
    """Who wrote a chat message in a study, "planner", "visitor" or "agent", and its text,
    or None for any other log entry."""
    data = entry.get("data") or {}
    if entry.get("type") != "activity" or data.get("kind") != "message" or not entry.get("studyId"):
        return None
    actor = str(entry.get("actor", ""))
    who = next((writer for start, writer in WRITERS.items() if actor.startswith(start)), "agent")
    return who, str(data.get("text", ""))


def with_history(question: str, earlier: Sequence[tuple[str, str]], asker: str = "planner") -> list[str]:
    """A run's task: the study's earlier chat, marked as such, then the question, a
    planner's or a visitor's."""
    line = f"A {asker} asks: {question}"
    if not earlier:
        return [line]
    lines = "\n".join(f"{NAMES.get(who, 'Agent')}: {clip(text, HISTORY_CHARS)}" for who, text in earlier)
    return [f"Earlier in this study's chat, oldest first, for context:\n<chat>\n{lines}\n</chat>", line]


def asked(entry: dict[str, Any]) -> tuple[str, str | None] | None:
    """A chat message to answer, as (text, audience), or None for any other log entry.

    A planner's message is in the shared record, so its audience is None. A visitor's
    is in their own sandbox: its audience comes from the entry, never from the actor.
    """
    data = entry.get("data") or {}
    if entry.get("type") != "activity" or data.get("kind") != "message" or not entry.get("studyId"):
        return None
    text, actor, audience = data.get("text"), str(entry.get("actor", "")), entry.get("audience")
    if not isinstance(text, str):
        return None
    if actor.startswith("planner:") and not audience:
        # With the chat's computer use running (npm run dev), it answers asks for the simulator.
        if os.environ.get("COMPUTER_USE_CHAT") and wants_computer(text):
            return None
        return text, None
    if actor.startswith("guest:") and isinstance(audience, str) and AUDIENCE.match(audience):
        return text, audience
    return None


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
    seconds: float | None = None,
    max_run_calls: int | None = None,
) -> str:
    """Run the lead on a task, in the study's chat: the run shows, then its answer, with
    any citation it couldn't check marked.

    A failure is posted in the chat too, in plain words, then raised with its detail
    for the terminal, and so is a stop. When visitors' budget runs out part-way, the
    chat gets the service's words for it, as they are. A run still going after
    `seconds`, if given, is stopped, and the chat says so. `max_run_calls` limits the
    run's model calls (default MAX_RUN_CALLS).
    """

    async def say(text: str) -> None:
        await report(session, study, "message", text=clip(text, 4000))

    await report(session, study, "run.started")
    try:
        try:
            read: set[tuple[str, int]] = set()
            reading = pages_read.set(read)
            try:
                async with asyncio.timeout(seconds):
                    text = (await run_lead(session, client, study, task, max_run_calls=max_run_calls)).strip() or NO_ANSWER
            finally:
                pages_read.reset(reading)
            text = await check_citations(session, study, text, read)
        except TimeoutError:
            minutes = round(seconds / MINUTE) if seconds else 0
            await say(f"That took more than {minutes} {'minute' if minutes == 1 else 'minutes'}, so the agent stopped. Try again, or ask something narrower.")
            raise
        except SpendCapReached as error:
            await say(str(error))
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
    """Answers each message a planner or a visitor sends, from log position `after`
    (default: the log's head when it starts).

    It reads the log in a session that acts for everyone ("*"), which can't write, and
    answers each message in a session of its own: a visitor's acts for that visitor,
    so the run reads and writes only in their sandbox. RUNS_AT_ONCE visitors' runs go
    at once, and a planner's never waits for them. Each person's messages are answered
    in order, planners' as one person's, and messages one person sent in a study while
    they waited get one answer, to the last of them, with the others in its history.
    Only the service's own agents may act for everyone, and their messages are an
    agent's, so it never answers its own replies.

    Each run gets the study's last few chat messages before the question, as the person
    asking sees the chat, so a follow-up makes sense. It keeps its place in the log,
    and the chat, so it can carry on in a new session.
    """

    def __init__(
        self,
        client: AsyncClient,
        *,
        url: str | None = None,
        token: str | None = None,
        after: int | None = None,
        poll_seconds: float = POLL_SECONDS,
    ):
        self.client = client
        self.url = url
        self.token = token
        self.after = after
        self.poll_seconds = poll_seconds
        # Chat messages by study and audience, None for the shared record: (seq, who, text),
        # with room for the question and what came in after it.
        self.chats: dict[tuple[str, str | None], deque[tuple[int, str, str]]] = {}
        self.read_back = False
        self.latest: dict[tuple[str, str | None], int] = {}  # each person's last message in each study
        self.started: deque[float] = deque()  # when each run started, for MAX_RUNS_PER_HOUR
        self.told: set[tuple[str, str | None]] = set()  # told a limit stops their runs, until a run starts
        self.runs: set[asyncio.Task] = set()
        self._slots: asyncio.Semaphore | None = None
        self._turns: dict[str | None, tuple[asyncio.Lock, int]] = {}

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
        """Keep a chat message for its study's history, in the sandbox it was written in."""
        if (message := chat_message(entry)) is not None:
            key = (entry["studyId"], entry.get("audience"))
            self.chats.setdefault(key, deque(maxlen=2 * HISTORY)).append((entry["seq"], *message))

    def _history(self, study: str, audience: str | None, seq: int) -> list[tuple[str, str]]:
        """The study's chat before a message, as whoever sent it sees it: the shared
        record's, and their own sandbox's."""
        seen = [*self.chats.get((study, None), ()), *(self.chats.get((study, audience), ()) if audience else ())]
        return [(who, text) for at, who, text in sorted(seen) if at < seq][-HISTORY:]

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
        """Listen in this session until stopped, or until the service can't be reached.
        The session acts for everyone, to read every visitor's messages."""
        head = (await call(session, "get_log_head"))["seq"]
        if self.after is None or head < self.after:  # a new log starts again from 0
            self.after = head
        if not self.read_back:
            await self._read_back(session, self.after)
            self.read_back = True
        while True:
            entries = await call(session, "read_log", {"after": self.after, "limit": PAGE})
            for entry in entries:
                self.after = entry["seq"]
                self._hear(entry)
                if (question := asked(entry)) is None:
                    continue
                text, audience = question
                study = entry["studyId"]
                self.latest[(study, audience)] = entry["seq"]
                task = asyncio.create_task(self.reply(study, entry["seq"], text, audience))
                self.runs.add(task)
                task.add_done_callback(self.runs.discard)
            if len(entries) < PAGE:
                await asyncio.sleep(self.poll_seconds)

    async def reply(self, study: str, seq: int, text: str, audience: str | None) -> None:
        """Answer one message, after that person's earlier ones, once a run may start. One
        they sent in the study meanwhile is answered instead, with this one in its history."""
        who = audience[:8] if audience else "planner"
        key = (study, audience)
        try:
            async with self._turn(audience):
                if self.latest.get(key) != seq:
                    return
                async with self._slot(audience):
                    # A planner's words are in the shared record; a visitor's never go in the log here.
                    print(f"{study}, {who}" + ("" if audience else f": {text}"), flush=True)
                    async with open_session(self.url, self.token, on_behalf_of=audience) as session:
                        said = await self._answer(session, study, seq, text, audience)
        except Exception as error:  # it's in the chat; keep listening
            print(f"  {study}, {who}: that failed: {error}", file=sys.stderr, flush=True)
        else:
            print(f"  {clip(said, 300)}" if not audience else f"  {study}, {who}: {said}", flush=True)
        finally:
            if self.latest.get(key) == seq:
                del self.latest[key]

    async def _answer(self, session: ClientSession, study: str, seq: int, text: str, audience: str | None) -> str:
        """The lead's answer, for a planner; for a visitor, only how it went: their words
        stay out of the terminal. Past the listener's limits, the person is told once.
        Small talk is answered at once, as a run of its own, and costs nothing."""
        if (said := small_talk(text)) is not None:
            await report(session, study, "run.started")
            await report(session, study, "message", text=said)
            await report(session, study, "run.finished")
            return "small talk"
        if audience:
            budget = await call(session, "get_budget")
            if isinstance(budget, dict) and budget.get("capped") and budget.get("leftUsd", 0) <= 0:
                await report(session, study, "message", text=BUDGET_SPENT)
                return "budget spent"
        if (reason := self._held_back()) is not None:
            if (study, audience) not in self.told:
                self.told.add((study, audience))
                await report(session, study, "message", text=reason)
            return f"Not answered: {reason}"
        self.started.append(time.monotonic())
        self.told.discard((study, audience))
        task = with_history(text, self._history(study, audience, seq), "visitor" if audience else "planner")
        seconds = config().max_run_minutes * MINUTE
        if not audience:
            return await answer(session, self.client, study, task, seconds=seconds)
        try:
            await answer(session, self.client, study, task, seconds=seconds, max_run_calls=config().guest_run_calls)
        except SpendCapReached:
            return "budget spent part-way"  # it's in their chat
        return "answered"

    def _slot(self, audience: str | None) -> contextlib.AbstractAsyncContextManager:
        """A visitor's run takes one of RUNS_AT_ONCE slots. A planner's needs none: planners'
        runs go one at a time already, in their own turn, and never wait for visitors'."""
        if audience is None:
            return contextlib.nullcontext()
        if self._slots is None:
            self._slots = asyncio.Semaphore(config().runs_at_once)
        return self._slots

    @contextlib.asynccontextmanager
    async def _turn(self, audience: str | None):
        """One person's turn: their messages are answered one at a time, in order.
        Planners share one turn."""
        lock, waiting = self._turns.get(audience) or (asyncio.Lock(), 0)
        self._turns[audience] = (lock, waiting + 1)
        try:
            async with lock:
                yield
        finally:
            lock, waiting = self._turns[audience]
            if waiting > 1:
                self._turns[audience] = (lock, waiting - 1)
            else:
                del self._turns[audience]

    async def stop(self) -> None:
        """Stop every run, so each says it stopped before answering, and wait for them."""
        runs = list(self.runs)
        for task in runs:
            task.cancel()
        await asyncio.gather(*runs, return_exceptions=True)


async def listen(
    session: ClientSession,
    client: AsyncClient,
    *,
    url: str | None = None,
    token: str | None = None,
    after: int | None = None,
    poll_seconds: float = POLL_SECONDS,
) -> None:
    """Answer each message a planner or a visitor sends, from log position `after`
    (default: now), until stopped. `session` acts for everyone; each run opens its own
    at `url` with `token`."""
    listener = Listener(client, url=url, token=token, after=after, poll_seconds=poll_seconds)
    try:
        await listener.run(session)
    finally:
        await listener.stop()


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
    listener = Listener(client, url=url, token=token, poll_seconds=poll_seconds)
    connected = lost = False
    wait = retry_seconds
    try:
        while True:
            try:
                async with open_session(url, token, on_behalf_of=EVERYONE) as session:
                    if lost:
                        print(f"Back on {url}. Listening again.", flush=True)
                    elif not connected:
                        print(f"Listening for messages on {url}. Stop with Ctrl+C.", flush=True)
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
    finally:
        await listener.stop()


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
    async with model_client().aio as client:
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
    commands.add_parser("listen", help="answer planners' and visitors' chat messages until stopped (the default)")
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
