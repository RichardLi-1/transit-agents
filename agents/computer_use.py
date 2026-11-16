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

    python computer_use.py --study <id>                  change route 605 Elm's weekday peak headway from 8 to 6 minutes, and save
    python computer_use.py --study <id> --app microsim   lengthen a left-turn phase, run the simulation, and save if it helps
    python computer_use.py --study <id> "<task>"         another task in the mock app
    python computer_use.py --study <id> --record run.mp4 also record the screen at 1920x1080, with a caption for each step

Every run works in a study's record, through the agent's own session to the service.
Each step is logged in the study before it is done, as a computer.action activity: what
the agent looked at, by the screenshot's SHA-256 (never the image), and what it clicked,
typed or pressed. A step the log doesn't take isn't done.

Reads are free. A write, as the app's manifest (manifest.json beside its page) names its
writes, such as Save, is done only if the service logs it, which it does only with a
planner's decision in the study that authorises that write and hasn't been used. The
harness decides what is a write, never the model. Without such a decision the step is
blocked, a question goes to a planner with ask_planner, and the run stops. Nothing
confirms a write but that decision: not Gemini, the chat or a flag. When Gemini asks a
person to confirm a step, the confirmation is a planner's unused decision that
authorises a write in the app, which the service names in the step's entry; with none,
the run stops and asks a planner. After each step the harness also checks what the app
saved, and stops the run, and asks a planner, if the app saved anything no decision
authorised.

A run stops after 15 model calls, or before a call likely to take it past US$1.50,
judged by what the last call cost. It refuses a model with no price, in prices.py or
MODEL_PRICES, since its calls would count as free. COMPUTER_USE_MODEL picks the model,
CHROME_PATH the browser and FFMPEG the encoder.
"""
import argparse
import asyncio
import base64
import contextlib
import functools
import hashlib
import json
import os
import secrets
import shutil
import sys
from collections.abc import Callable, Mapping, Sequence
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


# Keys as the harness compares them with an app's manifest. The apps are Windows-style
# and take Control or Command for a shortcut, so both are "mod".
MODIFIERS = {"control": "mod", "meta": "mod", "controlormeta": "mod", "shift": "shift", "alt": "alt"}
# Keys that press a focused button, such as Save.
ACTIVATE = frozenset({"enter", "space"})


@dataclass(frozen=True)
class Write:
    """One write an app's manifest names: an action that changes what the app holds.

    `selectors` are the controls that do it, and `keys` the shortcuts, each a set of
    keys pressed together as the harness compares them.
    """

    name: str  # such as save, as a planner's decision names it
    says: str  # what it does, in words: "save the schedule"
    selectors: tuple[str, ...]
    keys: tuple[frozenset[str], ...]


@functools.cache
def manifest(path: Path) -> dict[str, Write]:
    """The writes an app's manifest.json names, by name. Read once, when first needed."""
    if not path.is_file():
        raise SetupError(f"No manifest at {path}, so computer use can't tell the app's writes from its reads.")
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        name: Write(name, str(write["says"]), tuple(write.get("selectors", ())), tuple(keyset(names(keys)) for keys in write.get("keys", ())))
        for name, write in data["writes"].items()
    }


class Unauthorised(RuntimeError):
    """The service didn't log a write: no planner's decision in the study authorises it unused."""


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
    decisions: list[int] = field(default_factory=list)  # the log positions of the decisions its writes used
    blocked: str | None = None  # the write it stopped before, for want of a decision
    asked: str | None = None  # the question it handed a planner, if it stopped to ask one
    unauthorised: str | None = None  # what the app saved that no decision authorised, if it did


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
    manifest: Path | None = None  # its manifest.json, which names its writes

    @property
    def writes(self) -> Mapping[str, Write]:
        """What in the app changes what it holds, by its manifest: everything else only reads."""
        return manifest(self.manifest) if self.manifest else {}


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
        """Show a caption: under a recorded screen, or in a watched window's transcript."""
        if (self.options["record"] or self.options["headed"]) and self.options["captions"]:
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


def names(keys: str | Sequence[str]) -> list[str]:
    """Keys pressed together, such as "ctrl+s" or ["Control", "s"], each as Playwright names it."""
    if isinstance(keys, str):
        parts, current = [], ""
        for character in keys:
            if character == "+" and current:
                parts.append(current)
                current = ""
            else:
                current += character
        keys = [*parts, current] if current else parts
    return [key_name(str(key)) for key in keys if str(key)]


def combo(keys: str | Sequence[str]) -> str:
    """Keys pressed together, such as "ctrl+s" or ["Control", "s"], as Playwright writes them.

    The app is Windows-style, so on a Mac, Control with another key does what it does on
    Windows: Control+S saves and Control+A selects all.
    """
    pressed = names(keys)
    if sys.platform == "darwin" and len(pressed) > 1:
        pressed = ["ControlOrMeta" if name == "Control" else name for name in pressed]
    return "+".join(pressed)


def key(name: str) -> str:
    """One key as the harness compares it: lowercase, with Control and Command both "mod"."""
    folded = {" ": "space", "\n": "enter", "\r": "enter"}.get(name) or key_name(name).lower()
    return MODIFIERS.get(folded, folded)


def keyset(pressed: Sequence[str]) -> frozenset[str]:
    """Keys pressed together, as the harness compares them with a manifest's shortcuts."""
    return frozenset(key(name) for name in pressed)


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


def _reach(screen: Screen, name: str, args: dict[str, Any], held: frozenset[str]) -> tuple[list[dict[str, int] | None], list[frozenset[str]]]:
    """What an action touches, as act() would do it: the points it presses or releases
    the mouse at (None for where the pointer is), and the keys it presses together."""
    has_point = "x" in args and "y" in args
    if name in CLICKS:
        return [screen.point(args)], []
    if name == "mouse_up":
        return [screen.point(args) if has_point else None], []
    if name == "drag_and_drop":
        return [screen.point(args, "start_x", "start_y"), screen.point(args, "end_x", "end_y")], []
    if name == "type":
        typed = [*str(args["text"]), *(["Enter"] if args.get("press_enter") else [])]
        return ([screen.point(args)] if has_point else []), [held | {key(k)} for k in typed]
    if name == "press_key":
        return [], [held | keyset(names(str(args["key"])))]
    if name == "hotkey":
        return [], [held | keyset(names([str(k) for k in args["keys"]]))]
    if name == "key_down" and (down := key(str(args["key"]))) not in MODIFIERS.values():
        return [], [held | {down}]
    return [], []


async def write_of(screen: Screen, name: str, args: dict[str, Any], held: frozenset[str] = frozenset()) -> Write | None:
    """The app's write an action would do, by its manifest, or None for a read.

    The harness decides this, never the model: a click or a release on one of a write's
    controls, Enter or Space on one that has the focus, or its shortcut, with any
    modifier held down by key_down. An action with arguments act() can't use does
    nothing, so it's a read.
    """
    writes = screen.app.writes
    if not writes:
        return None
    try:
        points, pressed = _reach(screen, name, args, held)
    except (KeyError, TypeError, ValueError):
        return None
    for keys in pressed:
        for write in writes.values():
            if any(shortcut <= keys for shortcut in write.keys):
                return write
    presses = any(keys & ACTIVATE for keys in pressed)
    if not points and not presses:
        return None
    # The browser says which write's controls are at each point, and has the focus.
    selectors = {write.name: list(write.selectors) for write in writes.values()}
    found = await screen.send("writes", points=[None if p is None else [p["x"], p["y"]] for p in points], selectors=selectors)
    hits = [*(found.get("at") or []), *([found.get("focused")] if presses else [])]
    return next((writes[hit] for hit in hits if hit in writes), None)


def held_after(name: str, args: dict[str, Any], held: frozenset[str]) -> frozenset[str]:
    """The modifiers held down after an action: key_down presses one, key_up lets it go."""
    if name not in ("key_down", "key_up"):
        return held
    try:
        changed = key(str(args["key"]))
    except (KeyError, TypeError, ValueError):
        return held
    if changed not in MODIFIERS.values():
        return held
    return held | {changed} if name == "key_down" else held - {changed}


def digest(shot: Screenshot) -> str:
    """A screenshot as the log keeps it: its SHA-256, never the image."""
    return hashlib.sha256(shot.png).hexdigest()


def said(name: str, args: dict[str, Any], intent: str) -> str:
    """An action in a line for the log: what it clicked, typed or pressed, and why."""
    where = ", ".join(f"{k}={args[k]}" for k in ("x", "y", "key", "keys", "text", "direction") if k in args)
    line = f"{name}{f' ({where})' if where else ''}: {intent}"
    return line if len(line) <= 300 else line[:299] + "…"


class Record:
    """A run's place in a study's log, through the agent's own session to the service.

    Each step is logged before it's done. A write is logged only with a planner's
    decision in the study that authorises it, which the service finds and names; with
    none, the service refuses it and `step` raises Unauthorised.
    """

    def __init__(self, session: Any, study: str):
        self.session = session
        self.study = study

    @staticmethod
    def _whose() -> dict[str, str]:
        sub = core.working_for.get()
        return {"subagentId": sub} if sub else {}

    async def step(self, **fields: Any) -> dict[str, Any]:
        """Log one step of computer use. Returns the service's answer: its log position,
        and for a write, the decision it used."""
        arguments = {"studyId": self.study, "kind": "computer.action", **fields, **self._whose()}
        try:
            answer = await core.call(self.session, "report_activity", arguments)
        except core.ToolError as error:
            if error.message.startswith("403 needs_decision"):
                raise Unauthorised(error.message) from None
            raise
        return answer if isinstance(answer, dict) else {}

    async def ask(self, question: str, detail: str) -> str:
        """Hand a question to a planner as its own entry in the log, kind decision. Returns its id."""
        asked = f"computer-{secrets.token_hex(4)}"
        arguments = {"studyId": self.study, "id": asked, "kind": "decision", "question": clip(question, 300), "detail": clip(detail, 600)}
        await core.call(self.session, "ask_planner", arguments)
        return asked

    async def usage(self, model: str, fields: dict[str, Any]) -> None:
        """Report a model call's tokens and cost to the study."""
        await core.report(self.session, self.study, "usage", model=model, **fields, **self._whose())


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


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
    manifest=PAGE.parent / "manifest.json",
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
    manifest=MICROSIM_PAGE.parent / "manifest.json",
)

APPS = {app.name: app for app in (SCHEDULER, MICROSIM)}


async def run(
    screen: Screen,
    client: Any,
    task: str | None = None,
    *,
    record: Record,
    model: str | None = None,
    max_steps: int = MAX_STEPS,
    max_usd: float = MAX_USD,
    log: Callable[[str], Any] = print,
) -> Result:
    """Carry out a task in the app on `screen`, with Gemini's computer use, and say how it went.

    The task is the app's own unless given. `client` is Gemini's async client. `record`
    is the study's log: each step goes there before it's done, and a step it doesn't take
    isn't done. A write, by the app's manifest, is done only with a planner's decision
    that authorises it; without one the run asks a planner and stops. So does a step
    Gemini wants a person to confirm, with no unused decision for a write in the app,
    and a step after which the app saved something no decision authorised. Each model
    call's tokens and cost go to the study too. A model with no price is refused before
    anything starts.
    The run stops before a call that would likely pass `max_usd`, judged by what the last
    call cost: an estimate, not a bound. A try Gemini didn't answer in time takes one of
    `max_steps`, and counts from an estimate.
    """
    model = model or os.environ.get("COMPUTER_USE_MODEL") or MODEL
    priced(model)
    app = screen.app
    writes = app.writes  # an app whose writes aren't known is refused before anything starts
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
    # What the app had saved before the run, so a save nobody authorised shows.
    saved = len((await screen.state()).get("changes") or [])
    await record.step(app=app.name, step=0, action="look", summary=clip(f"Opened the {app.noun}. Task: {task}", 300), screenshot=digest(shot))
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
    held: frozenset[str] = frozenset()  # modifiers held down with key_down
    done_steps = 0  # actions, numbered in the log from 1; 0 is the screen it opened on

    async def count(usage: Any) -> float:
        """Add a call's tokens and cost to the result, and report them. Returns its cost."""
        fields = tokens_and_cost(model, usage)
        result.cost_usd += fields.get("costUsd", 0.0)
        result.input_tokens += fields["inputTokens"]
        result.output_tokens += fields["outputTokens"]
        try:
            await record.usage(model, fields)
        except Exception as error:  # the run goes on; the terminal says what's missing
            log(f"Couldn't report {model}'s usage: {core.redact(str(error))}")
        return fields.get("costUsd", 0.0)

    async def lost() -> None:
        await count(core.estimated_usage(contents, settings))

    async def stop_for_planner(entry: dict[str, Any], why: str, question: str, detail: str, write: Write | None = None) -> str:
        """Log the step as blocked, hand the question to a planner, and say why the run stopped."""
        blocked = {key: value for key, value in entry.items() if key != "confirm"}
        await record.step(**blocked, **({"write": write.name} if write else {}), outcome="blocked")
        result.asked = await record.ask(question, detail)
        result.blocked = write.name if write else None
        log(f"   Blocked: {why} Asked a planner ({result.asked}).")
        await screen.caption(who, f"Stopped: {why} A planner was asked.", f"step {result.steps}")
        await screen.pause(4)
        return f"Stopped: {why} A planner was asked (question {result.asked})."

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
            check = args.pop("safety_decision", None) or {}
            if check.get("decision") == "blocked":
                stop = f"Gemini's safety check stopped the run: {check.get('explanation') or 'blocked'}"
                break
            done_steps += 1
            entry = {"app": app.name, "step": done_steps, "action": call.name[:40], "summary": said(call.name, args, intent), "screenshot": digest(shot)}
            # The harness, never the model, says whether this step writes.
            write = await write_of(screen, call.name, args, held)
            confirm = check.get("decision") == "require_confirmation"
            if confirm:
                entry["confirm"] = True
            meta = f"step {result.steps} · US${result.cost_usd:.3f}"
            if write:
                try:
                    logged = await record.step(**entry, write=write.name)
                except Unauthorised:
                    why = f"It would {write.says}, a write to the {app.noun}, and no planner's decision in this study authorises it."
                    question = f"May the agent {write.says} in the {app.noun}?"
                    detail = (
                        f"Computer use stopped before it would {write.says}, for the task: {task} "
                        f'To allow one write, record an adopt or amend decision with authorizes {{"app": "{app.name}", "action": "{write.name}"}}.'
                    )
                    stop = await stop_for_planner(entry, why, question, detail, write)
                    break
                decision = logged.get("decision")
                result.decisions.append(decision)
                log(f"{result.steps}. {call.name} is a write ({write.name}), authorised by the planner's decision at log {decision}.")
                meta = f"{meta} · authorised by decision {decision}"
            elif confirm:
                # A person must confirm it, and the only one who can is a planner, by a
                # recorded decision that authorises a write in this app. The service
                # names it, and leaves it for the write.
                try:
                    logged = await record.step(**entry)
                except Unauthorised:
                    explanation = str(check.get("explanation") or "Gemini wants a person to check this step.")
                    why = f"Gemini asked a person to confirm a step ({explanation}), and no planner's decision in this study authorises a change in the {app.noun}."
                    question = f"Gemini asked a person to confirm a step in the {app.noun}: {explanation} May the agent go on?"
                    detail = (
                        f"Step: {entry['summary']} Task: {task} "
                        f"To allow it, record an adopt or amend decision that authorises a write in the {app.noun}, "
                        f'such as authorizes {{"app": "{app.name}", "action": "{next(iter(writes), "save")}"}}.'
                    )
                    stop = await stop_for_planner(entry, why, question, detail)
                    break
                meta = f"{meta} · confirmed by decision {logged.get('decision')}"
            else:
                await record.step(**entry)
            log(f"{result.steps}. {entry['summary']}")
            await screen.caption(who, intent, meta)
            done = await act(screen, call.name, args)
            if "error" in done:
                log(f"   {done['error']}")
            held = held_after(call.name, args, held)
            shot = await screen.screenshot()
            # Whatever the manifest says, a save nobody authorised stops the run.
            now = (await screen.state()).get("changes") or []
            if len(now) > saved and not write:
                result.unauthorised = unseen = "; ".join(app.describe(change) for change in now[saved:])
                why = f"The {app.noun} saved a change no planner's decision authorised: {unseen}."
                found = next(iter(writes.values()), None)
                await record.step(
                    app=app.name, step=done_steps, action="check", summary=clip(why, 300), screenshot=digest(shot),
                    **({"write": found.name} if found else {}), outcome="unauthorised",
                )  # fmt: skip
                result.asked = await record.ask(f"{why} Keep it, or undo it?", f"Step: {entry['summary']} Task: {task}")
                log(f"   {why} Asked a planner ({result.asked}).")
                stop = f"Stopped: {why} A planner was asked (question {result.asked})."
                break
            saved = len(now)
            parts.append(answer(call, {**done, **({"safety_acknowledgement": "true"} if confirm else {})}, shot))
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
    said_now = f"{'Done' if result.finished else 'Stopped'}. Saved in the app: {ending}."
    with contextlib.suppress(core.ToolError):  # the run is over: this only closes its record
        await record.step(app=app.name, step=done_steps + 1, action="finish", summary=clip(f"{said_now} {outcome}".strip(), 300), screenshot=digest(shot))
    await screen.caption(who, f"{said_now} {outcome}" if outcome else said_now, meta)
    await screen.pause(4)
    return result


TOOL = "use_computer"

TOOL_PARAMETERS = {
    "type": "object",
    "properties": {
        "task": {
            "type": "string",
            "description": "The change a planner decided, as they would say it, such as \"Change route 605 Elm's weekday peak headway from 8 to 6 minutes and save.\"",
        }
    },
    "required": ["task"],
}


def tool(session: Any, study: str, app: App, *, gemini: Callable[[], Any] | None = None) -> core.LocalTool:
    """use_computer, for a specialist whose skill works `app`: one run of computer use on
    the task, by this agent with its own session and Gemini's key, never in a skill's
    sandboxed script, which has neither. Each step is logged in the study and each write
    waits for a planner's decision, as run() says. `gemini` makes the Gemini client
    (core.gemini, unless given)."""

    async def use_computer(task: str) -> dict[str, Any]:
        model = os.environ.get("COMPUTER_USE_MODEL") or MODEL
        priced(model)
        async with (gemini or core.gemini)().aio as aio, Screen(app=app) as screen:
            result = await run(screen, aio, task.strip() or app.task, record=Record(session, study), model=model, log=lambda line: None)
        answer: dict[str, Any] = {
            "finished": result.finished,
            "said": result.text,
            "saved": [app.describe(change) for change in result.saved],
            "unsaved": [app.describe(change) for change in result.unsaved],
            "writesAuthorisedBy": result.decisions,
        }
        if result.asked:
            answer["askedPlanner"] = result.asked
        if outcome := app.outcome(result):
            answer["outcome"] = outcome
        return answer

    description = (
        f"Work the {app.noun} by sight, with computer use, to carry out a change a planner decided. "
        "Every step is logged in the study. Reading is free; a write, such as Save, goes ahead only under a planner's "
        "recorded decision that authorises it, and without one the run stops and asks a planner. One run at a time."
    )
    return core.LocalTool(TOOL, description, use_computer, TOOL_PARAMETERS, at_once=1)


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
        "--study",
        required=True,
        help="the study whose log records each step and model call, and whose planners' decisions authorise writes",
    )
    parser.add_argument("--service", help="the service (default: TRANSIT_URL, or http://127.0.0.1:4100)")
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
        # The agent's own session: an agent's token, so the run can't decide anything.
        session = await stack.enter_async_context(core.open_session(args.service))
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
            record=Record(session, args.study),
            max_steps=args.steps,
            max_usd=args.max_usd,
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
    for decision in result.decisions:
        print(f"A write authorised by the planner's decision at log {decision}.")
    if result.unauthorised:
        print(f"Unauthorised: {result.text.removeprefix('Stopped: ')}")
    elif result.asked:
        print(f"Blocked: {result.text.removeprefix('Stopped: ')}")
    print(
        f"{result.steps} model calls, {result.input_tokens:,} tokens in and {result.output_tokens:,} out, "
        f"US${result.cost_usd:.4f}, each step and call logged in {args.study}."
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
