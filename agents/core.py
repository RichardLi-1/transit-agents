"""The agent core: settings, the service's MCP session, the Gemini client and one tool loop.

Every agent runs through work(): the lead with its local tools, ask_specialist and
list_skills, and each specialist with its share of the service's tools and any scripts
its skill gives.
"""

import asyncio
import contextlib
import inspect
import json
import os
import random
import re
import sys
from collections.abc import Awaitable, Callable, Collection, Sequence
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, NoReturn

import anyio
import dotenv
import httpx2
from google import genai
from google.genai import errors, types
from google.genai.client import AsyncClient
from mcp import ClientSession, MCPError
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult, PaginatedRequestParams, Tool

import prices

HERE = Path(__file__).parent
dotenv.load_dotenv(HERE / ".env")

DEFAULT_MODEL = "gemini-3.6-flash"  # 3.8 Flash is often overloaded

# Code reports activity and tokens, and checks the visitors' budget, so models never see
# these tools: a model can't know its own token counts.
CODE_ONLY = frozenset({"report_activity", "get_budget"})

# The header that has the service's own agents act for one visitor, in that visitor's
# sandbox. "*" reads every visitor's entries from read_log, and writes nothing.
ON_BEHALF_OF = "x-on-behalf-of"
EVERYONE = "*"
AUDIENCE = re.compile(r"^(guest|user):[A-Za-z0-9_-]{22}$")

# The service's words when visitors have spent today's budget.
BUDGET_SPENT = "Visitors have used today's agent budget. Sign in, or come back tomorrow."

# Tools the service lists only for planners. An agent's token never has them.
PLANNER_ONLY = frozenset(
    {"record_decision", "set_rule", "approve_skill", "accept_figure", "rate_finding", "remove_content"}
)

# The service's tools that write to a study, with the argument naming it. A run writes
# only to its own study, whatever a document or a mistake tells the model.
WRITES = {
    "open_study": "id",
    "record_figure": "studyId",
    "record_check": "studyId",
    "record_finding": "studyId",
    "add_engagement_need": "studyId",
    "propose_alignment": "studyId",
    "create_document": "studyId",
    "report_activity": "studyId",
}

# Retry busy (503), rate-limit (429) and server errors, and a connection that failed,
# waiting about 2, 4, 8, 16, 32, then 60 seconds. Gemini refused those calls, so they
# cost nothing. The free tier allows 5 requests a minute and can ask for a wait of a
# minute. Retries happen here, not in google-genai, which would also retry a call that
# timed out up to the same number of times.
RETRY = {"attempts": 8, "initial_delay": 2, "max_delay": 60}

# A call that timed out may have run, and been billed, so it's tried again only this
# many times, each try takes a call from the run's budget, and each one that timed out
# is counted from an estimate.
TIMEOUT_RETRIES = 1

# Gemini's errors that are retried, and what to check for some that aren't.
RETRIED = frozenset({408, 429, 500, 502, 503, 504})
HINTS = {
    401: " Check GEMINI_API_KEY.",
    403: " Check GEMINI_API_KEY, and that the key may use this model.",
    404: " Check LEAD_MODEL and SPECIALIST_MODEL.",
}

# A model call still unanswered after 5 minutes has stalled: give up on it, in
# milliseconds, so the retries take over. google-genai sets no limit of its own.
TIMEOUT_MS = 300_000

# The most of one service result a model gets back, in characters. Every later call
# in the loop sends it again, so a huge page would be paid for on every call after it.
RESULT_LIMIT = 30_000

# The most a model call may write, thinking included. It bounds what one call costs.
MAX_OUTPUT_TOKENS = 16_384

# A model call stopped before Gemini answered is counted from an estimate: its request
# at this many characters a token, and this many tokens of answer and thought.
CHARS_PER_TOKEN = 4
STOPPED_OUTPUT_TOKENS = 2_000

# What the MCP transport raises as it closes, when a reply comes after the session has
# closed: a cancelled call's, say. Nothing waits for that reply.
LATE_REPLY = (anyio.BrokenResourceError, anyio.ClosedResourceError)

# Added to the instructions for an agent's last model call, which has its tools off.
LAST_CALL = (
    "This is your last model call, and your tools are off. Answer now from what you have, "
    "and say what you couldn't find or check."
)


# What work() returns when the model gave no answer, instead of one.
NO_ANSWER = re.compile(r"(Stopped after \d+ model calls|Gemini gave no answer|Gemini stopped without an answer)")


def answered(text: str) -> bool:
    """Whether text from work() is an answer, not empty or a line saying there was none."""
    return bool(text.strip()) and not NO_ANSWER.match(text.strip())


class SetupError(RuntimeError):
    """Something to fix before an agent can run: a token, a key, a setting or the service."""


# A Google API key, as Google writes them, and the key Gemini names as a caller's.
KEY_SHAPE = re.compile(r"AIza[0-9A-Za-z_-]{35}|(?<=api_key:)[^\s'\"]+")


def redact(text: str) -> str:
    """Text with any Gemini key hidden: the ones set in the environment, anything shaped like
    one, and whatever Gemini names as the caller's api_key. Every agent's errors go through it."""
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if len(key := os.environ.get(name, "").strip()) >= 8:
            text = text.replace(key, "[key]")
    return KEY_SHAPE.sub("[key]", text)


class ModelError(RuntimeError):
    """Gemini refused a call even after retries, or couldn't be reached. The message says why, in one line.

    Gemini's own text can name the key, as for one that's suspended, so any key in the
    message is hidden: the message goes to the terminal, the log and eval runs.

    `everywhere` is true when every other call in the run would fail the same way: out
    of quota, overloaded, a key or model that's wrong, or no way to reach Gemini. Then
    the run stops. Otherwise, as for a 500, only that agent's work stops.
    """

    def __init__(self, message: str, *, everywhere: bool = True):
        super().__init__(redact(message))
        self.everywhere = everywhere


class SpendCapReached(ModelError):
    """Visitors have spent today's budget, so the run stops: every other call would go over it."""

    def __init__(self, message: str = BUDGET_SPENT):
        super().__init__(message, everywhere=True)


def for_planners(error: BaseException) -> str:
    """A plain line on why the agent stopped, for the chat. The detail, with setting
    names a planner can't act on, goes to the agent's terminal. The service's words
    for visitors' spent budget are for people already, so they go as they are."""
    if isinstance(error, SpendCapReached):
        return str(error)
    if isinstance(error, ModelError):
        return "Gemini couldn't answer. Try again in a few minutes; the agent's terminal says why."
    return "Something went wrong. The agent's terminal says what."


class ToolError(RuntimeError):
    """The service refused a tool call. The message is the service's own."""

    def __init__(self, tool: str, message: str):
        super().__init__(f"{tool}: {message}")
        self.tool = tool
        self.message = message


@dataclass(frozen=True)
class Config:
    service_url: str
    lead_model: str
    specialist_model: str
    max_model_calls: int  # for each agent's tool loop
    max_run_calls: int  # for one run: the lead's and all its specialists' together
    specialist_concurrency: int  # specialists working at once, in this process
    runs_at_once: int = 2  # visitors' runs the listener answers at once; a planner's never waits for them
    guest_run_calls: int = 20  # max_run_calls for a visitor's run
    max_run_usd: float = 2.0  # for one run, in US dollars, as priced in prices.py
    max_daily_usd: float = 10.0  # for this process in a UTC day, while it listens
    max_runs_per_hour: int = 20  # runs started while it listens, in any hour
    max_run_minutes: int = 10  # for one run, while it listens


def config() -> Config:
    """Settings from the environment, read on each call."""
    try:
        prices.overrides()  # read again for each model call: a mistake shows here, before any
    except ValueError as error:
        raise SetupError(str(error)) from None
    return Config(
        service_url=(os.environ.get("TRANSIT_URL") or "http://127.0.0.1:4100").rstrip("/"),
        lead_model=os.environ.get("LEAD_MODEL") or DEFAULT_MODEL,
        specialist_model=os.environ.get("SPECIALIST_MODEL") or DEFAULT_MODEL,
        max_model_calls=_count("MAX_MODEL_CALLS", 30),
        max_run_calls=_count("MAX_RUN_CALLS", 60),
        # 2, because the free tier allows 5 requests a minute.
        specialist_concurrency=_count("SPECIALIST_CONCURRENCY", 2),
        runs_at_once=_count("RUNS_AT_ONCE", 2),
        guest_run_calls=_count("GUEST_RUN_CALLS", 20),
        max_run_usd=_dollars("MAX_RUN_USD", 2.0),
        max_daily_usd=_dollars("MAX_DAILY_USD", 10.0),
        max_runs_per_hour=_count("MAX_RUNS_PER_HOUR", 20),
        max_run_minutes=_count("MAX_RUN_MINUTES", 10),
    )


def _count(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    if not value.isdigit() or int(value) < 1:
        raise SetupError(f"{name} must be a whole number of at least 1, not {value!r}")
    return int(value)


def _dollars(name: str, default: float) -> float:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    try:
        amount = float(value)
    except ValueError:
        amount = -1
    if not amount > 0 or amount == float("inf"):
        raise SetupError(f"{name} must be an amount in US dollars above 0, such as 2 or 0.50, not {value!r}")
    return amount


def agent_token() -> str:
    """The agent's service token: TRANSIT_TOKEN_AGENT, or else the demo's "lead" token."""
    # For Fly, set TRANSIT_TOKEN_AGENT. Locally, the demo writes new tokens each time it
    # starts, in its data folder (DATA_DIR, as for the service), and "lead" is the one
    # for your own agents.
    if token := os.environ.get("TRANSIT_TOKEN_AGENT"):
        return token
    data = Path(os.environ.get("DATA_DIR") or HERE.parent / "data")
    try:
        token = json.loads((data / "demo-tokens.json").read_text()).get("lead")
    except FileNotFoundError:
        token = None
    if not token:
        raise SetupError(
            "No agent token. Set TRANSIT_TOKEN_AGENT, or start the demo with npm run demo, "
            f'which writes a "lead" token to {data / "demo-tokens.json"}.'
        )
    return token


def gemini(api_key: str | None = None, **http_options: Any) -> genai.Client:
    """A Gemini client that times out a stalled call. The key comes from GEMINI_API_KEY
    unless given. It doesn't retry: work() does, so it can count each try.

    Other http_options go to google-genai as they are: tests pass a transport.
    """
    if not (api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
        raise SetupError("No Gemini key. Set GEMINI_API_KEY, in the environment or in agents/.env.")
    return genai.Client(api_key=api_key, http_options={"timeout": TIMEOUT_MS, **http_options})


@asynccontextmanager
async def open_session(url: str | None = None, token: str | None = None, on_behalf_of: str | None = None):
    """Open an MCP session to the service as an agent, and hold it open.

    The session's instructions are the service's rules for agents. A token that isn't
    an agent's is a SetupError: a planner's would let agents decide. With `on_behalf_of`,
    a visitor's audience, every call reads and writes in that visitor's sandbox; with
    "*", read_log reads every visitor's entries, and every write is refused.
    """
    url = (url or config().service_url).rstrip("/")
    headers = {"authorization": f"Bearer {token or agent_token()}"}
    if on_behalf_of:
        headers[ON_BEHALF_OF] = on_behalf_of
    ready = done = False
    try:
        async with (
            httpx2.AsyncClient(headers=headers, timeout=httpx2.Timeout(30, read=120)) as http,
            streamable_http_client(f"{url}/v1/mcp", http_client=http) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            await check_agent(session)
            ready = True
            yield session
            done = True
    except BaseException as error:
        if _only(error, LATE_REPLY):
            if done:
                return
            # The transport can drop a cancel when a late reply breaks its close, and
            # anyio can uncancel the task as it does. The session's own work stopped
            # part-way with no error of its own, so it was cancelled.
            if ready or ((task := asyncio.current_task()) is not None and task.cancelling()):
                raise asyncio.CancelledError from None
        # The MCP transport wraps every error in task groups, even one raised by the
        # code using the session. Unwrap it, so callers can catch what they raised.
        alone = _alone(error)
        if not ready and isinstance(alone, (httpx2.TransportError, MCPError)):
            raise SetupError(
                f"Can't connect to the service at {url}: {alone}. Is it running, and is the agent token right?"
            ) from alone
        if alone is error:
            raise
        _reraise(alone)


async def check_agent(session: ClientSession) -> None:
    """Refuse a session whose token isn't an agent's, by the tools the service lists for it."""
    names = {tool.name for tool in await _list_tools(session)}
    if names & PLANNER_ONLY:
        raise SetupError(
            "The agent token is a planner's, so agents could decide, and could answer their own chat replies. "
            "Give agents an agent token: set TRANSIT_TOKEN_AGENT to one."
        )
    if "report_activity" not in names:
        raise SetupError(
            "The agent token isn't an agent's: it can't report activity or record figures. "
            "Set TRANSIT_TOKEN_AGENT to an agent's token."
        )


@asynccontextmanager
async def connect(
    client: genai.Client | None = None,
    *,
    url: str | None = None,
    token: str | None = None,
    on_behalf_of: str | None = None,
):
    """Open the MCP session to the service and the Gemini client, and hold both open.

    Yields (session, client): the initialized session, whose instructions are the
    service's rules for agents, and Gemini's async client.
    """
    client = client or gemini()
    async with (
        open_session(url, token, on_behalf_of) as session,
        # Hold the client open: google-genai closes its connections once it's dropped.
        client.aio as aio,
    ):
        yield session, aio


async def call(session: ClientSession, tool: str, arguments: dict[str, Any] | None = None) -> Any:
    """Call a service tool and return its JSON, or raise ToolError with the service's message."""
    try:
        result = await session.call_tool(tool, arguments or {})
    except MCPError as error:  # such as an unknown tool
        raise ToolError(tool, str(error)) from error
    if result.is_error:
        raise ToolError(tool, _text(result))
    return _output(result)


async def report(session: ClientSession, study: str, kind: str, **fields: Any) -> int | None:
    """Report an activity to the study's log: usage, a message, a subagent or a run.

    Returns its position in the log.
    """
    entry = await call(session, "report_activity", {"studyId": study, "kind": kind, **fields})
    return entry.get("seq") if isinstance(entry, dict) else None


def clip(text: str, limit: int) -> str:
    """Shorten text to the limit the service allows, marking the cut."""
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# The pages a run has read with read_page, the lead's and its specialists' alike, so
# the answer's citations can be checked against them. Whoever starts a run sets it.
pages_read: ContextVar[set[tuple[str, int]] | None] = ContextVar("pages_read", default=None)

# The specialist whose work this is, set while one works, so its reading and usage
# say whose they are and the display can show each specialist's progress.
working_for: ContextVar[str | None] = ContextVar("working_for", default=None)


def _whose() -> dict[str, str]:
    """The subagentId field for an activity, while a specialist works."""
    sub = working_for.get()
    return {"subagentId": sub} if sub else {}


class Budget:
    """The model calls one run may make, and the dollars it may spend, shared by the lead
    and all its specialists.

    An agent takes its first call before it starts. It may call tools only once it has
    taken its next call too, so a model call is always left to read their results.
    Without one, its call is its last, with tools off. Once the run has spent its
    dollars, no more calls are given out. Calls with no price count no dollars.

    Once visitors' budget runs out, `capped` is set, and every agent in the run stops
    before its next model call. One already sent finishes, so its usage is counted.
    """

    def __init__(self, calls: int, usd: float | None = None):
        self.left = calls
        self.usd = usd
        self.spent = 0.0
        self.capped = False

    def check(self) -> None:
        """Raise SpendCapReached once visitors' budget has run out in this run."""
        if self.capped:
            raise SpendCapReached(BUDGET_SPENT)

    def take(self) -> bool:
        """Take one call, if one is left and the run hasn't spent its dollars."""
        if self.left < 1 or (self.usd is not None and self.spent >= self.usd):
            return False
        self.left -= 1
        return True

    def spend(self, usd: float | None) -> None:
        """Count what a call cost, if it has a price."""
        self.spent += usd or 0.0

    def give_back(self) -> None:
        """Return a call taken and never made."""
        self.left += 1


@dataclass(frozen=True)
class LocalTool:
    """A Python function a model can call, declared with JSON Schema.

    It runs here, not in the service. It gets the model's arguments as keywords, may be
    async, and returns anything JSON can hold.
    """

    name: str
    description: str
    function: Callable[..., Any]
    parameters: dict[str, Any] = field(default_factory=lambda: {"type": "object", "properties": {}})
    at_once: int | None = None  # the most calls one model turn may make; the rest get an error

    def declaration(self) -> types.FunctionDeclaration:
        # Converted the way google-genai converts the service's tools, so Gemini gets one format.
        schema = types.Schema.from_json_schema(json_schema=types.JSONSchema(**self.parameters))
        return types.FunctionDeclaration(name=self.name, description=self.description, parameters=schema)


async def service_tools(session: ClientSession, allowed: Collection[str] | None = None) -> list[Tool]:
    """The service's tools for this agent's role, without the ones only code calls.

    With `allowed`, only those. An allowed tool the service doesn't list is skipped:
    search_sources, for one, isn't on every service yet.
    """
    tools = await _list_tools(session)
    return [tool for tool in tools if tool.name not in CODE_ONLY and (allowed is None or tool.name in allowed)]


async def _list_tools(session: ClientSession) -> list[Tool]:
    """Every tool the service lists for this session's token."""
    tools: list[Tool] = []
    cursor = None
    while True:
        page = await session.list_tools(params=PaginatedRequestParams(cursor=cursor) if cursor else None)
        tools += page.tools
        cursor = page.next_cursor
        if not cursor:
            return tools


async def work(
    session: ClientSession,
    client: AsyncClient,
    *,
    study: str,
    model: str,
    instructions: str,
    task: str | Sequence[str],
    local: Sequence[LocalTool] = (),
    allowed: Collection[str] | None = None,
    max_calls: int | None = None,
    budget: Budget | None = None,
) -> str:
    """Run one agent's tool loop on a task, and return its final text.

    The model gets the service's tools (only the allowed ones, if given) and the local
    tools, and each call goes to the side that has the tool. It writes only to
    `study`: a call that names another study gets an error. After every model call,
    its tokens are reported to the study as usage, with the model's name. The last
    allowed call has its tools off, so the model answers from what it has: a tool it
    called then would run with no model call left to read the result.

    `budget` is the run's, shared with the other agents in it. The caller has taken
    this agent's first call from it. A task given as several texts goes in the first
    user turn as one part each.
    """
    remote = await service_tools(session, allowed)
    service_names = {tool.name for tool in remote}
    local_tools = {tool.name: tool for tool in local}
    if clash := service_names & local_tools.keys():
        raise ValueError(f"Local tools {sorted(clash)} have the names of service tools")
    tools: list[Any] = list(remote)
    if local_tools:
        tools.append(types.Tool(function_declarations=[tool.declaration() for tool in local]))
    settings = types.GenerateContentConfig(
        system_instruction=instructions,
        tools=tools or None,
        # The loop runs here, not in google-genai, so each model call's tokens get
        # reported: the model can't see them.
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        max_output_tokens=MAX_OUTPUT_TOKENS,
    )
    texts = [task] if isinstance(task, str) else list(task)
    contents = [types.Content(role="user", parts=[types.Part(text=text) for text in texts])]
    limit = max_calls or config().max_model_calls

    async def count(usage: Any) -> None:
        """Report a model call's tokens and cost, and take the cost from the run's budget."""
        try:
            usd = await _report_usage(session, study, model, usage)
        except SpendCapReached:
            if budget is not None:
                budget.capped = True
            raise
        if budget is not None:
            budget.spend(usd)

    spare = False  # the run's call taken for this agent's next turn
    try:
        for turn in range(limit):
            spare = False  # the one taken last turn is the one made now
            if budget is not None:
                budget.check()
            last = turn == limit - 1
            if not last and budget is not None:
                spare = budget.take()
                last = not spare
            sent = _last_call(settings) if last else settings

            # A try that timed out, which Gemini may have run and billed anyway.
            async def lost(sent: types.GenerateContentConfig = sent) -> None:
                await count(estimated_usage(contents, sent))

            try:
                response = await _generate(client, model, contents, sent, budget, lost)
            except asyncio.CancelledError:
                # Stopped with the call sent, as on SIGTERM or when another agent's error
                # stops the run. Gemini may bill it anyway, so it's counted from an estimate.
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(10):
                        await _report_usage(session, study, model, estimated_usage(contents, sent))
                raise
            await count(response.usage_metadata)
            calls = response.function_calls
            if last:
                # Calls made anyway are never run: no model call is left to read them.
                return _final_text(response) or f"Stopped after {turn + 1} model calls."
            if not calls:
                return _final_text(response)
            # The model's turn goes back as it came, with its thought signatures.
            contents.append(response.candidates[0].content)
            parts = await _answer_calls(session, study, calls, service_names, local_tools)
            contents.append(types.Content(role="user", parts=parts))
    finally:
        if spare and budget is not None:
            budget.give_back()
    raise AssertionError("unreachable: the last call returns")


def _last_call(settings: types.GenerateContentConfig) -> types.GenerateContentConfig:
    """The settings for an agent's last model call: tools off, and told so."""
    if not settings.tools:
        return settings
    off = types.FunctionCallingConfig(mode=types.FunctionCallingConfigMode.NONE)
    # The tools stay declared, since earlier turns call them; the mode stops new calls.
    return settings.model_copy(
        update={
            "system_instruction": f"{settings.system_instruction}\n\n{LAST_CALL}",
            "tool_config": types.ToolConfig(function_calling_config=off),
        }
    )


async def _generate(
    client: AsyncClient,
    model: str,
    contents: list[types.Content],
    settings: types.GenerateContentConfig,
    budget: Budget | None = None,
    lost: Callable[[], Awaitable[None]] | None = None,
) -> types.GenerateContentResponse:
    """One model call, tried again as RETRY and TIMEOUT_RETRIES allow.

    A try that timed out may have run, and been billed, so `lost` is awaited for each
    one, to count it from an estimate, before the call is tried again or given up."""
    attempt = timeouts = 0
    while True:
        attempt += 1
        try:
            return await _generate_once(client, model, contents, settings)
        except ModelError as error:
            cause = error.__cause__
            timed_out = isinstance(cause, httpx2.TimeoutException)
            if timed_out and lost is not None:
                await lost()
            if attempt >= RETRY["attempts"]:
                raise
            if isinstance(cause, errors.APIError) and cause.code in RETRIED:
                pass
            elif timed_out:
                timeouts += 1
                if timeouts > TIMEOUT_RETRIES or (budget is not None and not budget.take()):
                    raise
            elif not isinstance(cause, httpx2.ConnectError):  # never sent, so retried as a refusal is
                raise
        await asyncio.sleep(_backoff(attempt))


def _backoff(attempt: int) -> float:
    """Seconds to wait after a failed try: doubling from RETRY's first wait up to its
    most, with up to a second of jitter."""
    wait = min(RETRY["initial_delay"] * 2 ** (attempt - 1), RETRY["max_delay"])
    return wait + (random.random() if wait else 0)


async def _generate_once(
    client: AsyncClient, model: str, contents: list[types.Content], settings: types.GenerateContentConfig
) -> types.GenerateContentResponse:
    try:
        return await client.models.generate_content(model=model, contents=contents, config=settings)
    except errors.APIError as error:
        said = clip(f" Gemini said: {error.message}", 400) if error.message else ""
        if error.code == 429:
            raise ModelError(
                f"Gemini refused {model} with 429 {error.status or 'RESOURCE_EXHAUSTED'} after retries: the key's "
                "rate limit or quota is used up. Wait a minute and try again, lower SPECIALIST_CONCURRENCY, "
                f"or raise the key's quota.{said}"
            ) from error
        if error.code == 503:
            raise ModelError(
                f"{model} is overloaded (503 {error.status or 'UNAVAILABLE'}), even after retries. Try again in "
                f"a few minutes, or set LEAD_MODEL and SPECIALIST_MODEL to another model.{said}"
            ) from error
        retried = ", even after retries" if error.code in RETRIED else ""
        hint = HINTS.get(error.code, "")
        raise ModelError(
            f"Gemini refused {model} with {error.code} {error.status or 'ERROR'}{retried}.{hint}{said}",
            everywhere=error.code in HINTS,
        ) from error
    except httpx2.TimeoutException as error:
        raise ModelError(
            f"Gemini didn't answer {model} in time, even after retries ({type(error).__name__}). Try again later."
        ) from error
    except httpx2.TransportError as error:
        raise ModelError(
            f"Can't reach Gemini for {model}, even after retries: {str(error) or type(error).__name__}. "
            "Check the network, and GOOGLE_GEMINI_BASE_URL if it's set."
        ) from error


async def _report_usage(session: ClientSession, study: str, model: str, usage: Any) -> float | None:
    """Report a model call's tokens and cost, and return its cost, if it has a price.

    For a visitor, the service answers with what is left of today's budget. Once that
    is less than this call cost, the next would likely go past it, so the run stops
    after this call."""
    fields = tokens_and_cost(model, usage)
    day = datetime.now(UTC).date()
    _spent[day] = _spent.get(day, 0.0) + fields.get("costUsd", 0.0)
    answer = await call(session, "report_activity", {"studyId": study, "kind": "usage", "model": model, **fields, **_whose()})
    left = answer.get("budgetLeftUsd") if isinstance(answer, dict) else None
    if isinstance(left, (int, float)) and (left <= 0 or left < fields.get("costUsd", 0)):
        raise SpendCapReached(BUDGET_SPENT)
    return fields.get("costUsd")


# What this process has spent on model calls with a price, by UTC day, in US dollars.
_spent: dict[date, float] = {}


def spent_today() -> float:
    """What this process has spent today (UTC) on model calls with a price, in US dollars."""
    return _spent.get(datetime.now(UTC).date(), 0.0)


def estimated_usage(
    contents: list[types.Content], settings: types.GenerateContentConfig
) -> types.GenerateContentResponseUsageMetadata:
    """What a model call stopped before Gemini answered is counted as: its request's text at
    about CHARS_PER_TOKEN characters a token, and STOPPED_OUTPUT_TOKENS of answer and thought.
    An inline file's bytes, such as a screenshot's, aren't text, so they're left out: as
    text, one screenshot would count as tens of thousands of tokens."""
    sent = [_without_bytes(content.model_dump(exclude_none=True)) for content in contents]
    sent += [str(settings.system_instruction or "")]
    sent += [tool.model_dump_json(exclude_none=True) for tool in settings.tools or [] if hasattr(tool, "model_dump_json")]
    return types.GenerateContentResponseUsageMetadata(
        prompt_token_count=sum(map(len, sent)) // CHARS_PER_TOKEN + 1, candidates_token_count=STOPPED_OUTPUT_TOKENS
    )


def _without_bytes(value: Any) -> str:
    """A request's content as compact JSON, with every inline file's bytes left out."""
    return json.dumps(value, separators=(",", ":"), default=lambda item: "" if isinstance(item, bytes) else str(item))


def tokens_and_cost(model: str, usage: types.GenerateContentResponseUsageMetadata | None) -> dict[str, Any]:
    """A model call's tokens, and its cost in US dollars when the model has a price."""
    usage = usage or types.GenerateContentResponseUsageMetadata()
    tokens = {
        "inputTokens": usage.prompt_token_count or 0,
        # Thinking is billed as output.
        "outputTokens": (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0),
    }
    usd = prices.cost(model, tokens["inputTokens"], tokens["outputTokens"], usage.cached_content_token_count or 0)
    if usd is None:
        _unpriced(model)
        return tokens
    return {**tokens, "costUsd": usd}


_warned: set[str] = set()


def _unpriced(model: str) -> None:
    """Say once that a model has no price, so its calls go without a cost."""
    if model not in _warned:
        _warned.add(model)
        print(
            f"No price for {model}, so its calls are reported without a cost. Add one with "
            f"MODEL_PRICES={model}=<input>/<output>, in US dollars per million tokens.",
            file=sys.stderr,
            flush=True,
        )


def _final_text(response: types.GenerateContentResponse) -> str:
    candidate = response.candidates[0] if response.candidates else None
    if candidate is None:
        feedback = response.prompt_feedback
        reason = feedback.block_reason if feedback and feedback.block_reason else None
        return f"Gemini gave no answer: {getattr(reason, 'value', reason)}." if reason else "Gemini gave no answer."
    # Read the parts directly: response.text warns about the thought signatures Gemini
    # attaches to them.
    parts = candidate.content.parts if candidate.content and candidate.content.parts else []
    text = "".join(part.text for part in parts if part.text and not part.thought).strip()
    reason = candidate.finish_reason
    if not text and reason not in (None, types.FinishReason.STOP):
        return f"Gemini stopped without an answer: {getattr(reason, 'value', reason)}."
    return text


async def _answer_calls(
    session: ClientSession,
    study: str,
    calls: list[types.FunctionCall],
    service_names: set[str],
    local_tools: dict[str, LocalTool],
) -> list[types.Part]:
    """Answer one model turn's calls, in the order the model made them.

    Service calls run one at a time, since a model may send calls that depend on each
    other in one turn. Local tools run at once, so specialists work in parallel. Calls
    past a local tool's at_once get an error instead.
    """
    answers: dict[int, dict[str, Any]] = {}
    local: dict[int, tuple[LocalTool, dict[str, Any]]] = {}
    made: dict[str, int] = {}
    for i, function_call in enumerate(calls):
        tool = local_tools.get(function_call.name or "")
        if tool is None:
            answers[i] = await _call_service(session, study, function_call, service_names)
            continue
        made[tool.name] = made.get(tool.name, 0) + 1
        if tool.at_once is not None and made[tool.name] > tool.at_once:
            answers[i] = {
                "error": f"Call {tool.name} at most {tool.at_once} times in one turn. "
                "Make the other calls once these answers are back."
            }
        else:
            local[i] = (tool, function_call.args or {})
    spent: list[SpendCapReached] = []

    async def run(tool: LocalTool, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            return await _call_local(tool, arguments)
        except SpendCapReached as error:
            # Visitors' budget ran out. The other calls aren't cancelled: each finishes
            # the model call it has sent, so what Gemini bills is counted, then stops.
            spent.append(error)
            return {"error": str(error)}

    try:
        async with asyncio.TaskGroup() as group:
            tasks = {i: group.create_task(run(tool, arguments)) for i, (tool, arguments) in local.items()}
    except* ModelError as failed:
        # Out of quota, say: every other call would fail too, and the other local calls
        # have been cancelled, so stop the run.
        _reraise(failed.exceptions[0])
    if spent:
        raise spent[0]
    answers.update((i, task.result()) for i, task in tasks.items())
    return [
        types.Part(function_response=types.FunctionResponse(id=c.id, name=c.name, response=answers[i]))
        for i, c in enumerate(calls)
    ]


async def _call_service(
    session: ClientSession, study: str, function_call: types.FunctionCall, service_names: set[str]
) -> dict[str, Any]:
    name, arguments = function_call.name or "", function_call.args or {}
    if name not in service_names:
        return {"error": f"You have no tool named {name}."}
    if (key := WRITES.get(name)) and arguments.get(key) != study:
        return {"error": f"{name}: this run writes only to study {study}, so {key} must be {study!r}."}
    if name == "record_figure" and (arguments.get("basis") or {}).get("kind") == "computed":
        # A planner approves a skill's code, so a computed value comes from the code:
        # its own tool records it. One a model types in could be any number.
        return {"error": "record_figure: a computed figure comes from a skill's own tool, which records its result. Don't type one in."}
    try:
        result = await session.call_tool(name, arguments)
    except MCPError as error:
        return {"error": str(error)}
    # The service's message, with its status and code, so the model can correct itself.
    if result.is_error:
        return {"error": _text(result)}
    if name == "read_page":
        await _report_reading(session, study, arguments)
    return _within_limit(_output(result))


def _within_limit(output: Any) -> dict[str, Any]:
    """A service result for the model, cut at RESULT_LIMIT characters with a note saying so."""
    text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    if len(text) <= RESULT_LIMIT:
        return {"output": output}
    return {
        "output": text[:RESULT_LIMIT],
        "note": f"Cut at {RESULT_LIMIT:,} of {len(text):,} characters. Ask for less at once, such as a narrower search.",
    }


async def _report_reading(session: ClientSession, study: str, arguments: dict[str, Any]) -> None:
    # Lights up the source on the display. It only shows the work, so a refusal here
    # doesn't stop it.
    fields: dict[str, Any] = {"contextId": arguments.get("contextId"), **_whose()}
    with contextlib.suppress(KeyError, TypeError, ValueError):
        fields["page"] = int(arguments["page"])
    if (read := pages_read.get()) is not None and "page" in fields:
        read.add((str(fields["contextId"]), fields["page"]))
    with contextlib.suppress(ToolError):
        await report(session, study, "reading", **fields)


async def _call_local(tool: LocalTool, arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        result = tool.function(**arguments)
        if inspect.isawaitable(result):
            result = await result
    except ModelError as error:
        if error.everywhere:
            raise
        return {"error": f"{tool.name}: {error}"}
    except Exception as error:  # the model sees it, and can correct itself
        return {"error": f"{tool.name}: {error}"}
    return {"output": result}


def _text(result: CallToolResult) -> str:
    return "".join(getattr(part, "text", "") for part in result.content)


def _output(result: CallToolResult) -> Any:
    # Structured when the service answered with an object, else the parsed JSON (an
    # array, say), else the text.
    if result.structured_content is not None:
        return result.structured_content
    text = _text(result)
    try:
        return json.loads(text)
    except ValueError:
        return text


def _alone(error: BaseException) -> BaseException:
    """The one exception inside nested exception groups, leaving out late replies, or
    else the error itself."""
    if isinstance(error, BaseExceptionGroup):
        rest = error.split(LATE_REPLY)[1]
        error = error if rest is None else rest
    while isinstance(error, BaseExceptionGroup) and len(error.exceptions) == 1:
        error = error.exceptions[0]
    return error


def _only(error: BaseException, kinds: tuple[type[BaseException], ...]) -> bool:
    """Whether the error, or every error in its groups, is one of these kinds."""
    if isinstance(error, BaseExceptionGroup):
        return all(_only(inner, kinds) for inner in error.exceptions)
    return isinstance(error, kinds)


def _reraise(error: BaseException) -> NoReturn:
    """Raise an exception taken out of an exception group as it was, cause and all."""
    # Raising it while handling the group would make the group its context, and print
    # the error twice.
    context = error.__context__
    try:
        raise error
    finally:
        error.__context__ = context
