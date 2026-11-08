"""Computer use: Gemini works a legacy desktop app by sight, as a planner would.

Agencies still schedule service and time signals in old desktop tools that have no API.
This agent works one through its screen: it shows Gemini a screenshot, Gemini's computer
use tool picks the next click or keystroke, the agent does it, and it shows Gemini the
result, until the task is done. There are two apps, both mocks with sample data, which
computer_use_browser.mjs shows in Chrome for Testing with Playwright, each at its own
address. The agent can touch nothing else.

  scheduler  apps/legacy-mock, an old trip scheduler (the default)
  microsim   apps/microsim-mock, an old traffic microsimulator for one signalized
             intersection, a stand-in for tools like Vissim or Synchro

    python computer_use.py                     change route 605 Elm's weekday peak headway from 8 to 6 minutes, and save
    python computer_use.py --app microsim      lengthen a left-turn phase, run the simulation, and save if it helps
    python computer_use.py "<task>"            another task in the mock app
    python computer_use.py --record run.mp4    also record the screen at 1920x1080, with a caption for each step
    python computer_use.py --study <id>        report each model call's tokens and cost to that study

A planner decides the change; the agent only carries it out. A run stops after 15
model calls, or before a call likely to take it past US$1.50, judged by what the last
call cost. It refuses a model with no price, in prices.py or MODEL_PRICES, since its
calls would count as free. When Gemini asks for a person to confirm a step, as it does
before saving, the agent asks at the terminal and stops unless told yes. --confirm says
yes for the planner who set the task. A recording captions that moment "The agent
asks. The planner confirms." COMPUTER_USE_MODEL picks the model, CHROME_PATH the
browser and FFMPEG the encoder.
"""

import argparse
import asyncio
import base64
import contextlib
import json
import os
import shutil
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from google.genai import types

import core
import prices
from core import SetupError, _final_text, _generate, tokens_and_cost

HERE = Path(__file__).parent
PAGE = HERE.parent / "apps" / "legacy-mock" / "index.html"
MICROSIM_PAGE = HERE.parent / "apps" / "microsim-mock" / "index.html"
BRIDGE = HERE / "computer_use_browser.mjs"

# Google's pick for computer use, priced in prices.py.
MODEL = "gemini-3.8-flash"
TASK = "Change route 605 Elm's weekday peak headway from 8 to 6 minutes and save."
MAX_STEPS = 15  # model calls in a run
MAX_USD = 1.50  # for a run, as priced in prices.py
SCREEN = (1920, 1080)
# Only the newest screenshots go back to Gemini with each call: older ones cost tokens and add nothing.
KEEP_SCREENSHOTS = 3
MAX_WAIT_SECONDS = 5
# Bounds what one call can cost. An action takes a few dozen tokens, and its thinking a few hundred.
MAX_OUTPUT_TOKENS = 4096
# The app is the whole screen: going to a web address, back or forward isn't offered.
ENVIRONMENT = types.Environment.ENVIRONMENT_BROWSER
EXCLUDED = ["navigate", "go_back", "go_forward"]

INSTRUCTIONS = """You work one desktop app through its screen: Trip Scheduler, an old \
trip-scheduling tool. It is a mock with sample data. Use only this app.

A planner has decided the change in the task. Make exactly that change, nothing else, and \
save it. Look at each screenshot before the next step. Typing into a field replaces what it \
holds. Once it's saved, stop, and say in one plain sentence what you changed. If you can't \
do it, or the task is unclear, stop and say why rather than guess."""

# Said as an edit to a simulation model: Gemini's safety filter refused the same change
# said as if to a real intersection's signals.
MICROSIM_TASK = (
    "In this simulation model of Don Mills & Eglinton, with sample data, the northbound left queue is too long. "
    "In the model's signal plan, lengthen phase 2's green time from 12 to 20 seconds, run the simulation, "
    "and save the model if the northbound left delay improves."
)

MICROSIM_INSTRUCTIONS = """You work one desktop app through its screen: Intersection Simulator, an \
old traffic simulation tool. It is a mock with sample data. Use only this app.

A planner has decided the change in the task. Make exactly that change, nothing else. Look at \
each screenshot before the next step. Typing into a field replaces what it holds. A simulation \
run takes about 10 seconds: wait until the status bar says it is complete, then compare the \
Before and After columns of the evaluation results. Save only if the task's condition holds; if \
it doesn't, stop without saving and say so. Once it's saved, stop, and say in one plain sentence \
what you changed and what the results showed. If you can't do it, or the task is unclear, stop \
and say why rather than guess."""

CLICKS = {
    "click": ("left", 1),
    "double_click": ("left", 2),
    "triple_click": ("left", 3),
    "middle_click": ("middle", 1),
    "right_click": ("right", 1),
}

# Key names as Gemini may write them, in the names Playwright uses.
KEYS = {
    "ctrl": "Control", "control": "Control", "cmd": "Meta", "command": "Meta", "meta": "Meta",
    "win": "Meta", "windows": "Meta", "super": "Meta", "alt": "Alt", "option": "Alt", "shift": "Shift",
    "enter": "Enter", "return": "Enter", "esc": "Escape", "escape": "Escape", "tab": "Tab",
    "space": "Space", "spacebar": "Space", "backspace": "Backspace", "delete": "Delete", "del": "Delete",
    "insert": "Insert", "home": "Home", "end": "End", "pageup": "PageUp", "pagedown": "PageDown",
    "pgup": "PageUp", "pgdn": "PageDown", "up": "ArrowUp", "down": "ArrowDown", "left": "ArrowLeft",
    "right": "ArrowRight", "arrowup": "ArrowUp", "arrowdown": "ArrowDown", "arrowleft": "ArrowLeft",
    "arrowright": "ArrowRight",
}  # fmt: skip


class ScreenError(RuntimeError):
    """The browser couldn't do a command. The message is Playwright's first line."""


@dataclass(frozen=True)
class Screenshot:
    png: bytes
    url: str


@dataclass
class Result:
    finished: bool  # Gemini said it was done, rather than the run being stopped
    text: str  # Gemini's last words, or why the run stopped
    steps: int  # model calls
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    saved: list[dict[str, Any]] = field(default_factory=list)  # what the app saved, oldest first
    unsaved: list[dict[str, Any]] = field(default_factory=list)  # changes left unsaved
    evaluation: dict[str, Any] | None = None  # the microsim's runs: before (Run 1) and after (the latest)


@dataclass(frozen=True)
class App:
    """A mock app the agent can work: its page, the address it's served at, and its own task.

    The browser refuses every address but the app's own. `describe` puts a saved change
    in words, `outcome` sums up the result in a sentence, if the app has more to say than
    what it saved, and `did_task` says whether a run did the default task.
    """

    name: str
    page: Path
    origin: str
    noun: str  # what Gemini is told is open, when it tries to leave
    task: str
    instructions: str
    describe: Callable[[dict[str, Any]], str]
    did_task: Callable[[Result], bool]
    missed: str  # what the terminal says when a run of the default task didn't do it
    outcome: Callable[[Result], str] = lambda result: ""


class Screen:
    """The mock app in Chrome for Testing, through computer_use_browser.mjs. Points are pixels.

    With `record`, the screen is recorded to that .mp4, with captions under the part
    Gemini sees unless `captions` is false, and moves are slowed so people can follow.
    """

    def __init__(
        self,
        *,
        app: App | None = None,
        page: Path | None = None,
        record: Path | None = None,
        captions: bool = True,
        headed: bool = False,
        pace: bool | None = None,
        size: tuple[int, int] = SCREEN,
    ):
        self.app = app or SCHEDULER
        self.options = {
            "page": str(Path(page or self.app.page).resolve()),
            "origin": self.app.origin,
            "width": size[0],
            "height": size[1],
            "headed": headed,
            # Slowed so people can follow it, in a recording or a window they watch.
            "pace": (record is not None or headed) if pace is None else pace,
            "record": str(Path(record).resolve()) if record else None,
            "captions": captions,
        }
        self.pace = bool(self.options["pace"])
        self.width, self.height = size
        self.url = ""
        self.video: str | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.closed = False
        self.sent = 0
        self.lock = asyncio.Lock()

    async def __aenter__(self) -> "Screen":
        if not shutil.which("node"):
            raise SetupError("Computer use needs Node 24 or later on the PATH, for Playwright.")
        self.process = await asyncio.create_subprocess_exec(
            "node",
            str(BRIDGE),
            json.dumps(self.options),
            cwd=HERE.parent,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            limit=64 * 1024 * 1024,  # a screenshot comes as one line
        )
        try:
            ready = await self._read()
        except ScreenError as error:
            await self._stop()
            raise SetupError(f"The browser didn't start: {error} Its error is above.") from None
        self.width, self.height = ready["screen"]["width"], ready["screen"]["height"]
        self.url = ready["url"]
        return self

    async def __aexit__(self, *exc: object) -> None:
        with contextlib.suppress(ScreenError, OSError):
            await self.close()
        await self._stop()

    async def _stop(self) -> None:
        if self.process and self.process.returncode is None:
            with contextlib.suppress(OSError):
                self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 60)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()

    async def _read(self) -> dict[str, Any]:
        line = await self.process.stdout.readline()
        if not line:
            raise ScreenError(f"the browser stopped (exit {await self.process.wait()}).")
        return json.loads(line)

    async def send(self, command: str, **args: Any) -> dict[str, Any]:
        """Run one command in the browser and return its reply, or raise ScreenError."""
        async with self.lock:
            if self.process is None or self.process.returncode is not None:
                raise ScreenError("the browser isn't running.")
            self.sent += 1
            self.process.stdin.write((json.dumps({"id": self.sent, "do": command, **args}) + "\n").encode())
            await self.process.stdin.drain()
            reply = await self._read()
        if not reply.get("ok"):
            raise ScreenError(reply.get("error") or f"{command} failed")
        return reply

    def point(self, args: dict[str, Any], x: str = "x", y: str = "y") -> dict[str, int]:
        """A point Gemini gives from 0 to 999 on each axis, in pixels on this screen."""
        return {"x": pixel(args[x], self.width), "y": pixel(args[y], self.height)}

    async def screenshot(self) -> Screenshot:
        reply = await self.send("screenshot")
        return Screenshot(base64.b64decode(reply["png"]), reply["url"])

    async def caption(self, who: str, text: str, meta: str = "") -> None:
        """Show a caption under the screen, if it's being recorded with captions."""
        if self.options["record"] and self.options["captions"]:
            with contextlib.suppress(ScreenError):
                await self.send("caption", who=who, text=text, meta=meta)

    async def pause(self, seconds: float) -> None:
        """Hold still while a recording shows a caption. Without one, go on at once."""
        if self.pace:
            await asyncio.sleep(seconds)

    async def state(self) -> dict[str, Any]:
        """What the app saved and has unsaved, the page's address, and any request it refused."""
        return await self.send("state")

    async def close(self) -> str | None:
        """Close the browser, and return the recording's path, if there is one."""
        if not self.closed:
            self.closed = True
            self.video = (await self.send("close")).get("video")
        return self.video


def pixel(value: Any, size: int) -> int:
    """A coordinate from 0 to 999, as Gemini gives them, in pixels across `size`."""
    return round(min(max(float(value), 0.0), 999.0) / 1000 * size)


def key_name(key: str) -> str:
    """One key, as Playwright names it: "ctrl" is Control, "esc" is Escape, "f5" is F5."""
    if key == " ":
        return "Space"
    folded = key.strip().lower().replace("_", "").replace(" ", "")
    if folded in KEYS:
        return KEYS[folded]
    if folded[:1] == "f" and folded[1:].isdigit() and 1 <= int(folded[1:]) <= 12:
        return folded.upper()
    return key.strip()  # a letter, a digit, or a name Playwright knows


def combo(keys: str | list[str]) -> str:
    """Keys pressed together, such as "ctrl+s" or ["Control", "s"], as Playwright writes them.

    The app is Windows-style, so on a Mac, Control with another key does what it does on
    Windows: Control+S saves and Control+A selects all.
    """
    if isinstance(keys, str):
        parts, current = [], ""
        for character in keys:
            if character == "+" and current:
                parts.append(current)
                current = ""
            else:
                current += character
        keys = [*parts, current] if current else parts
    names = [key_name(str(key)) for key in keys if str(key)]
    if sys.platform == "darwin" and len(names) > 1:
        names = ["ControlOrMeta" if name == "Control" else name for name in names]
    return "+".join(names)


async def act(screen: Screen, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Do one of Gemini's actions. Returns what goes back with the screenshot: nothing, or an error."""
    try:
        if name in CLICKS:
            button, count = CLICKS[name]
            await screen.send("click", **screen.point(args), button=button, count=count)
        elif name == "move":
            await screen.send("move", **screen.point(args))
        elif name in ("mouse_down", "mouse_up"):
            where = screen.point(args) if "x" in args and "y" in args else {}
            await screen.send("down" if name == "mouse_down" else "up", **where)
        elif name == "type":
            if "x" in args and "y" in args:
                await screen.send("click", **screen.point(args))
            # As in Google's examples, typing replaces what the focused field holds.
            await screen.send("type", text=str(args["text"]), enter=bool(args.get("press_enter")), clear=True)
        elif name == "drag_and_drop":
            start, end = screen.point(args, "start_x", "start_y"), screen.point(args, "end_x", "end_y")
            await screen.send("drag", x1=start["x"], y1=start["y"], x2=end["x"], y2=end["y"])
        elif name == "scroll":
            where = screen.point(args) if "x" in args and "y" in args else screen.point({"x": 500, "y": 500})
            amount = int(args.get("magnitude_in_pixels") or 300)
            direction = str(args.get("direction", "down")).lower()
            dx = {"left": -amount, "right": amount}.get(direction, 0)
            dy = {"up": -amount, "down": amount}.get(direction, 0)
            await screen.send("scroll", **where, dx=dx, dy=dy)
        elif name == "press_key":
            await screen.send("press", keys=combo(str(args["key"])))
        elif name == "hotkey":
            await screen.send("press", keys=combo([str(key) for key in args["keys"]]))
        elif name in ("key_down", "key_up"):
            await screen.send("keydown" if name == "key_down" else "keyup", key=key_name(str(args["key"])))
        elif name == "wait":
            seconds = 1.0 if args.get("seconds") is None else float(args["seconds"])
            await asyncio.sleep(min(max(seconds, 0.0), MAX_WAIT_SECONDS))
        elif name != "take_screenshot":  # every result has a screenshot
            return {"error": f"{name} isn't available here: only the {screen.app.noun} is open, and it can't be left."}
    except (KeyError, TypeError, ValueError) as error:
        return {"error": f"{name} is missing or has a wrong argument: {error}"}
    except ScreenError as error:
        return {"error": str(error)}
    return {}


def answer(call: types.FunctionCall, result: dict[str, Any], shot: Screenshot) -> types.Part:
    """The result of an action, as Gemini's computer use takes it: the address, and the screen after it."""
    screen = types.FunctionResponseBlob(mime_type="image/png", data=shot.png)
    return types.Part(
        function_response=types.FunctionResponse(
            id=call.id,
            name=call.name,
            response={"url": shot.url, **result},
            parts=[types.FunctionResponsePart(inline_data=screen)],
        )
    )


def without_old_screenshots(contents: list[types.Content], keep: int = KEEP_SCREENSHOTS) -> list[types.Content]:
    """The conversation with all but the newest `keep` screenshots left out. What it's given stays as it was."""
    seen = 0
    kept: list[types.Content] = []
    for content in reversed(contents):
        parts = []
        for part in reversed(content.parts or []):
            response = part.function_response
            if content.role == "user" and response and response.parts:
                seen += 1
                if seen > keep:
                    part = part.model_copy(update={"function_response": response.model_copy(update={"parts": None})})
            elif content.role == "user" and part.inline_data:
                seen += 1
                if seen > keep:
                    part = types.Part(text="(An earlier screenshot, left out.)")
            parts.append(part)
        parts.reverse()
        same = all(new is old for new, old in zip(parts, content.parts or [], strict=True))
        kept.append(content if same else content.model_copy(update={"parts": parts}))
    kept.reverse()
    return kept


def display_name(model: str) -> str:
    """"gemini-3.8-flash" as people write it: "Gemini 3.8 Flash"."""
    words = model.removeprefix("models/").split("-")
    return " ".join(word if word[:1].isdigit() else word.capitalize() for word in words)


def priced(model: str) -> None:
    """Refuse a model with no price. Its calls would count as free, so no cap on dollars would hold."""
    try:
        price = prices.price(model)
    except ValueError as error:  # MODEL_PRICES is malformed
        raise SetupError(str(error)) from None
    if price is None:
        raise SetupError(
            f"No price for {model}, so the run's cap in US dollars can't hold. Use a model prices.py lists, or add one "
            f"with MODEL_PRICES={model}=<input>/<output>, in US dollars per million tokens."
        )


def describe(change: dict[str, Any]) -> str:
    """One saved change, in words: "605 Elm: Weekday Peak headway 8 → 6 min"."""
    where = f"{change['route']}: {change['day']} {change['period']}"
    return f"{where} {change['field']} {change['from']} → {change['to']} min"


def headway_changed(result: Result) -> bool:
    """Whether the scheduler saved the default task's change: 605 Elm's weekday peak headway, 8 → 6 minutes."""
    return any(
        (c["route"], c["day"], c["period"], c["from"], c["to"]) == ("605 Elm", "Weekday", "Peak", 8, 6)
        for c in result.saved
    )


def describe_timing(change: dict[str, Any]) -> str:
    """One saved signal timing change, in words: "SC1 AM peak: phase 2 (NB/SB left) green 12 → 20 s"."""
    field_name = "all-red" if change["field"] == "red" else change["field"]
    where = f"{change['controller']} {change['plan']}: phase {change['phase']} ({change['movements']})"
    return f"{where} {field_name} {change['from']} → {change['to']} s"


def los_outcome(result: Result) -> str:
    """The microsim's before and after, in a sentence: the northbound left's delay and LOS, and the intersection's."""
    evaluation = result.evaluation or {}
    before, after = evaluation.get("before"), evaluation.get("after")
    if not before:
        return ""
    if not after:
        return "The simulation wasn't run after the change."
    def change(key: str) -> str:
        was, now = before[key], after[key]
        return f"{was['delay']:.1f} → {now['delay']:.1f} s/veh, LOS {was['los']} → {now['los']}"

    stale = "" if evaluation.get("afterMatchesSaved") else " The last run wasn't on the plan as saved."
    runs = f"(Run {before['run']} → Run {after['run']})"
    return f"Northbound left: {change('northboundLeft')}. Intersection: {change('intersection')} {runs}.{stale}"


def left_turn_fixed(result: Result) -> bool:
    """Whether the microsim did the default task: saved phase 2's green at 20 s, and nothing else,
    after a run on that plan that lowered the northbound left's delay."""
    wanted = [("SC1", "AM peak", 2, "green", 12, 20)]
    keys = ("controller", "plan", "phase", "field", "from", "to")
    saved = [tuple(change.get(key) for key in keys) for change in result.saved]
    evaluation = result.evaluation or {}
    before, after = evaluation.get("before"), evaluation.get("after")
    if saved != wanted or not before or not after or not evaluation.get("afterMatchesSaved"):
        return False
    return after["northboundLeft"]["delay"] < before["northboundLeft"]["delay"]


SCHEDULER = App(
    name="scheduler",
    page=PAGE,
    origin="http://legacy-app.test",
    noun="scheduling app",
    task=TASK,
    instructions=INSTRUCTIONS,
    describe=describe,
    did_task=headway_changed,
    missed="The app didn't save the change the task asks for.",
)

MICROSIM = App(
    name="microsim",
    page=MICROSIM_PAGE,
    origin="http://intersection-sim.test",
    noun="simulation app",
    task=MICROSIM_TASK,
    instructions=MICROSIM_INSTRUCTIONS,
    describe=describe_timing,
    did_task=left_turn_fixed,
    missed="The app didn't save phase 2's green at 20 s after a run that lowered the northbound left's delay.",
    outcome=los_outcome,
)

APPS = {app.name: app for app in (SCHEDULER, MICROSIM)}


async def run(
    screen: Screen,
    client: Any,
    task: str | None = None,
    *,
    model: str | None = None,
    max_steps: int = MAX_STEPS,
    max_usd: float = MAX_USD,
    report: Callable[[dict[str, Any]], Awaitable[Any]] | None = None,
    confirm: Callable[[str], Awaitable[bool]] | None = None,
    log: Callable[[str], Any] = print,
) -> Result:
    """Carry out a task in the app on `screen`, with Gemini's computer use, and say how it went.

    The task is the app's own unless given. `client` is Gemini's async client. Each model
    call's tokens and cost go to `report`, if given. A step Gemini wants confirmed runs
    only if `confirm` says yes. A model with no price is refused before anything starts. The run stops before a call that would
    likely pass `max_usd`, judged by what the last call cost: an estimate, not a bound.
    A try Gemini didn't answer in time takes one of `max_steps`, and counts from an estimate.
    """
    model = model or os.environ.get("COMPUTER_USE_MODEL") or MODEL
    priced(model)
    app = screen.app
    task = task or app.task
    who = f"{display_name(model)} · computer use"
    computer = types.ComputerUse(environment=ENVIRONMENT, excluded_predefined_functions=EXCLUDED)
    settings = types.GenerateContentConfig(
        system_instruction=app.instructions,
        tools=[types.Tool(computer_use=computer)],
        max_output_tokens=MAX_OUTPUT_TOKENS,
    )
    await screen.caption(who, f"Task: {task}")
    shot = await screen.screenshot()
    contents = [
        types.Content(
            role="user", parts=[types.Part(text=task), types.Part.from_bytes(data=shot.png, mime_type="image/png")]
        )
    ]
    result = Result(finished=False, text="", steps=0)
    last = 0.0  # what the last call cost: the next one, with more to read, costs about as much
    # Every try at a call takes a step. One that timed out may have run, and been
    # billed, so it counts as a step too, and its cost from an estimate.
    tries = core.Budget(max_steps)

    async def count(usage: Any) -> float:
        """Add a call's tokens and cost to the result, and report them. Returns its cost."""
        fields = tokens_and_cost(model, usage)
        result.cost_usd += fields.get("costUsd", 0.0)
        result.input_tokens += fields["inputTokens"]
        result.output_tokens += fields["outputTokens"]
        if report is not None:
            try:
                await report(fields)
            except Exception as error:  # the run goes on; the terminal says what's missing
                log(f"Couldn't report {model}'s usage: {core.redact(str(error))}")
        return fields.get("costUsd", 0.0)

    async def lost() -> None:
        await count(core.estimated_usage(contents, settings))

    while True:
        if tries.left < 1:
            result.text = f"Stopped after {result.steps} model calls, the most a run may make."
            break
        if result.cost_usd + last > max_usd:
            result.text = f"Stopped at US${result.cost_usd:.2f}: another call would likely pass the run's US${max_usd:.2f}."
            break
        tries.take()
        response = await _generate(client, model, contents, settings, tries, lost)
        result.steps = max_steps - tries.left
        last = await count(response.usage_metadata)
        calls = response.function_calls or []
        if not calls:
            result.text = _final_text(response) or "Gemini stopped without a word."
            result.finished = bool(response.candidates)
            break
        # The model's turn goes back as it came, with its thought signatures.
        contents.append(response.candidates[0].content)
        parts: list[types.Part] = []
        stop = ""
        for call in calls:
            args = dict(call.args or {})
            intent = str(args.pop("intent", "") or call.name)
            decision = args.pop("safety_decision", None) or {}
            extra = {}
            if decision.get("decision") == "require_confirmation":
                explanation = str(decision.get("explanation") or "Gemini wants a person to check this step.")
                log(f"{result.steps}. {call.name} waits for a person: {explanation}")
                await screen.caption(who, ASKS, f"step {result.steps}")
                await screen.pause(4)
                if confirm is None or not await confirm(explanation):
                    stop = f"Gemini asked a person to confirm a step ({explanation}), and nobody did, so it stopped."
                    break
                await screen.caption(who, CONFIRMATIONS.get(confirm, "Confirmed."), f"step {result.steps}")
                await screen.pause(2)
                extra["safety_acknowledgement"] = "true"
            elif decision.get("decision") == "blocked":
                stop = f"Gemini's safety check stopped the run: {decision.get('explanation') or 'blocked'}"
                break
            where = ", ".join(f"{key}={args[key]}" for key in ("x", "y", "key", "keys", "text") if key in args)
            log(f"{result.steps}. {call.name}{f' ({where})' if where else ''}: {intent}")
            await screen.caption(who, intent, f"step {result.steps} · US${result.cost_usd:.3f}")
            done = await act(screen, call.name, args)
            if "error" in done:
                log(f"   {done['error']}")
            shot = await screen.screenshot()
            parts.append(answer(call, {**done, **extra}, shot))
        if stop:
            result.text = stop
            break
        contents = without_old_screenshots([*contents, types.Content(role="user", parts=parts)])
    state = await screen.state()
    result.saved = state.get("changes", [])
    result.unsaved = state.get("unsaved", [])
    result.evaluation = state.get("evaluation")
    ending = "; ".join(app.describe(change) for change in result.saved) or "nothing saved"
    outcome = app.outcome(result)
    meta = f"{result.steps} steps · US${result.cost_usd:.3f}"
    said = f"{'Done' if result.finished else 'Stopped'}. Saved in the app: {ending}."
    await screen.caption(who, f"{said} {outcome}" if outcome else said, meta)
    await screen.pause(4)
    return result


async def ask_at_terminal(explanation: str) -> bool:
    """Ask the person at the terminal to confirm a step. No terminal, no yes."""
    if not sys.stdin.isatty():
        return False
    question = f"Gemini wants a person to confirm the next step: {explanation}\nGo ahead? [y/N] "
    reply = await asyncio.to_thread(input, question)
    return reply.strip().lower() in ("y", "yes")


async def confirmed(explanation: str) -> bool:
    """--confirm: the planner who set the task said yes, before the run, to the steps Gemini asks about."""
    return True


# What a recording shows when Gemini's safety check asks a person to confirm a step,
# as it does before Save. Gemini's reason goes to the terminal.
ASKS = "The agent asks. The planner confirms."

# What it shows once the step is confirmed: who said yes, and when. Nobody confirms
# during a run with --confirm, so the caption says it was approved in advance.
CONFIRMATIONS = {
    confirmed: "Approved in advance with --confirm by the planner who set the task.",
    ask_at_terminal: "Confirmed at the terminal by the person running the agent.",
}


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Gemini works a mock legacy app by sight.")
    parser.add_argument(
        "task", nargs="?", help="what to do in the app, as a planner would say it (default: the app's own task)"
    )
    parser.add_argument(
        "--app",
        choices=list(APPS),
        default=SCHEDULER.name,
        help="the mock app: scheduler, a trip scheduler (the default), or microsim, a traffic microsimulator",
    )
    parser.add_argument("--record", type=Path, help="record the screen to this .mp4, at 1920x1080")
    parser.add_argument("--no-captions", action="store_true", help="record without the captions under the screen")
    parser.add_argument("--headed", action="store_true", help="show the browser window")
    parser.add_argument("--size", help="the screen as WIDTHxHEIGHT, such as 1440x810 to fit a laptop (default 1920x1080)")
    parser.add_argument("--hold", type=float, default=0, help="with --headed, keep the window open this many seconds after the run")
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="say yes, as the planner who set the task, when Gemini asks a person to confirm a step",
    )
    parser.add_argument("--study", help="report each model call's tokens and cost to this study")
    parser.add_argument("--service", help="the service for --study (default: TRANSIT_URL, or http://127.0.0.1:4100)")
    parser.add_argument("--model", help=f"the Gemini model (default: COMPUTER_USE_MODEL, or {MODEL})")
    parser.add_argument("--steps", type=int, default=MAX_STEPS, help=f"the most model calls (default {MAX_STEPS})")
    parser.add_argument(
        "--max-usd",
        type=float,
        default=MAX_USD,
        help=f"stop before a call likely to pass this, in US dollars (default {MAX_USD:.2f})",
    )
    args = parser.parse_args(argv)
    app = APPS[args.app]
    task = args.task or app.task
    model = args.model or os.environ.get("COMPUTER_USE_MODEL") or MODEL
    if args.record and args.record.suffix.lower() != ".mp4":
        parser.error("--record takes a path ending in .mp4")
    if args.steps < 1 or not args.max_usd > 0:
        parser.error("--steps must be at least 1, and --max-usd above 0")
    size = SCREEN
    if args.size:
        try:
            width, height = (int(n) for n in args.size.lower().split("x"))
        except ValueError:
            parser.error("--size takes WIDTHxHEIGHT, such as 1440x810")
        size = (width, height)
    priced(model)  # before the browser or the service starts

    async with contextlib.AsyncExitStack() as stack:
        report = None
        if args.study:
            session = await stack.enter_async_context(core.open_session(args.service))

            async def report(fields: dict[str, Any]) -> None:
                await core.report(session, args.study, "usage", model=model, **fields)

        aio = await stack.enter_async_context(core.gemini().aio)
        screen = await stack.enter_async_context(
            Screen(app=app, record=args.record, captions=not args.no_captions, headed=args.headed, size=size)
        )
        print(f"{display_name(model)} works the mock {app.noun}: {task}")
        result = await run(
            screen,
            aio,
            task,
            model=model,
            max_steps=args.steps,
            max_usd=args.max_usd,
            report=report,
            confirm=confirmed if args.confirm else ask_at_terminal,
        )
        if args.headed and args.hold > 0:
            await asyncio.sleep(args.hold)  # so people watching see where it ended
        video = await screen.close()

    print(f"\nGemini: {result.text}")
    print("The app saved: " + ("; ".join(app.describe(change) for change in result.saved) or "nothing") + ".")
    if result.unsaved:
        print("Left unsaved: " + "; ".join(app.describe(change) for change in result.unsaved) + ".")
    if outcome := app.outcome(result):
        print(outcome)
    print(
        f"{result.steps} model calls, {result.input_tokens:,} tokens in and {result.output_tokens:,} out, "
        f"US${result.cost_usd:.4f}{f', reported to {args.study}' if args.study else ''}."
    )
    if video:
        print(f"Recording: {video}")
    if task == app.task:
        wanted = app.did_task(result)
        if not wanted:
            print(app.missed)
        return 0 if result.finished and wanted else 1
    return 0 if result.finished else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except SetupError as error:
        sys.exit(str(error))
    except core.ModelError as error:
        sys.exit(str(error))
    except KeyboardInterrupt:
        sys.exit(130)
