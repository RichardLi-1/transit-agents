import asyncio
import base64
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from google.genai import types

import computer_use
import core
from computer_use import Screen, act, combo, key_name, pixel, without_old_screenshots
from tests import support
from tests.support import FakeGemini, reply

HOME = "http://legacy-app.test/"
SIM_HOME = "http://intersection-sim.test/"
SAVED = [{"route": "605 Elm", "day": "Weekday", "period": "Peak", "field": "headway", "from": 8, "to": 6}]
TIMING = {
    "intersection": "Don Mills Rd & Eglinton Ave E", "controller": "SC1", "plan": "AM peak",
    "phase": 2, "movements": "NB/SB left", "field": "green", "from": 12, "to": 20,
}  # fmt: skip
PNG = b"\x89PNG\r\n\x1a\n"


async def at(screen: Screen, selector: str) -> dict[str, int]:
    """The middle of an element, as Gemini gives points: from 0 to 999 across the screen."""
    box = (await screen.send("box", selector=selector))["box"]
    return {
        "x": round((box["x"] + box["width"] / 2) / screen.width * 1000),
        "y": round((box["y"] + box["height"] / 2) / screen.height * 1000),
    }


def planner(screen: Screen):
    """A fake Gemini that does the task as a person would: pick the route, open the
    peak period, type 6, press Enter, save with Control+S, then say so."""

    async def respond(request):
        turn = request.turn
        if turn == 0:
            return reply(("click", {**await at(screen, "#route-605"), "intent": "Pick 605 Elm"}))
        if turn == 1:
            return reply(("double_click", {**await at(screen, "tbody tr:nth-child(2)"), "intent": "Open Weekday Peak"}))
        if turn == 2:
            return reply(("type", {"text": "6", "intent": "Type 6"}))
        if turn == 3:
            return reply(("press_key", {"key": "Enter", "intent": "OK"}))
        if turn == 4:
            return reply(("hotkey", {"keys": ["Control", "s"], "intent": "Save"}))
        return reply(text="I changed route 605 Elm's weekday peak headway from 8 to 6 minutes and saved it.")

    return respond


def engineer(screen: Screen, *, save: bool = True):
    """A fake Gemini that does the microsim's task as a person would: open Signal Timing,
    type 20 for phase 2's green, press Enter for OK, pick Quick, run, then save with Control+S."""

    async def respond(request):
        steps = [
            ("click", "#timing-button", {"intent": "Open Signal Timing"}),
            ("type", "#p2-green", {"text": "20", "press_enter": True, "intent": "Phase 2 green 20 s, OK"}),
            ("click", "#speed-quick", {"intent": "Quick mode"}),
            ("click", "#run-button", {"intent": "Run the simulation"}),
        ]
        if save:
            steps.append(("hotkey", None, {"keys": ["Control", "s"], "intent": "Save"}))
        if request.turn < len(steps):
            name, selector, args = steps[request.turn]
            return reply((name, {**(await at(screen, selector) if selector else {}), **args}))
        return reply(text="I lengthened phase 2's green from 12 to 20 s; the northbound left went from LOS F to D.")

    return respond


def evaluation(before_delay=221.3, after_delay=43.9, *, matches=True, ran=True):
    """The microsim's evaluation, as its page reports it, with the northbound left's and intersection's delays."""

    def summary(run, delay, los, node, node_los):
        return {"run": run, "northboundLeft": {"delay": delay, "queue": 100, "los": los}, "intersection": {"delay": node, "los": node_los}}

    return {
        "before": summary(1, before_delay, "F", 63.2, "E"),
        "after": summary(2, after_delay, "D", 44.4, "D") if ran else None,
        "afterMatchesSaved": matches and ran,
    }


def quiet(_line: str) -> None:
    pass


class ActionTest(unittest.IsolatedAsyncioTestCase):
    """Gemini's actions, as commands for the browser. No browser runs."""

    class Recorder(Screen):
        def __init__(self):
            super().__init__(size=(1000, 500))
            self.commands = []

        async def send(self, command, **args):
            self.commands.append((command, args))
            return {"ok": True}

    class Captioned(Screen):
        """A screen being recorded with captions, without a browser: it keeps each caption."""

        def __init__(self):
            super().__init__(record=Path("never-written.mp4"), pace=False)
            self.captions = []

        async def send(self, command, **args):
            if command == "caption":
                self.captions.append(args["text"])
            if command == "screenshot":
                return {"ok": True, "png": base64.b64encode(PNG).decode(), "url": HOME}
            if command == "state":
                return {"ok": True, "changes": [], "unsaved": []}
            return {"ok": True}

    async def test_the_recording_says_the_agent_asks_and_who_confirmed_and_when(self):
        def respond(request):
            if request.turn == 0:
                check = {"decision": "require_confirmation", "explanation": "This saves the schedule."}
                return reply(("click", {"x": 500, "y": 500, "safety_decision": check}))
            return reply(text="Done.")

        async def yes(explanation):
            return True

        said = {
            computer_use.confirmed: "Approved in advance with --confirm by the planner who set the task.",
            yes: "Confirmed.",
        }
        for confirm, caption in said.items():
            with self.subTest(caption):
                screen = self.Captioned()
                lines = []
                result = await computer_use.run(screen, FakeGemini(respond), model="test-model", confirm=confirm, log=lines.append)
                self.assertTrue(result.finished)
                # Gemini's safety check asks a person, as before Save. Nobody confirms during a
                # run with --confirm: the planner said yes before it.
                self.assertEqual(screen.captions[1:3], ["The agent asks. The planner confirms.", caption])
                self.assertIn("1. click waits for a person: This saves the schedule.", lines)  # Gemini's reason
        self.assertEqual(
            computer_use.CONFIRMATIONS[computer_use.ask_at_terminal], "Confirmed at the terminal by the person running the agent."
        )

        # Nobody says yes: the agent asked, and the run stops with nothing saved.
        screen = self.Captioned()
        result = await computer_use.run(screen, FakeGemini(respond), model="test-model", log=quiet)
        self.assertFalse(result.finished)
        self.assertEqual(screen.captions[1:], ["The agent asks. The planner confirms.", "Stopped. Saved in the app: nothing saved."])

    def test_the_microsims_task_is_done_only_by_a_saved_phase_2_green_of_20_after_a_better_run(self):
        done = computer_use.MICROSIM.did_task
        good = computer_use.Result(True, "", 6, saved=[TIMING], evaluation=evaluation())
        self.assertTrue(done(good))
        self.assertEqual(
            computer_use.MICROSIM.outcome(good),
            "Northbound left: 221.3 → 43.9 s/veh, LOS F → D. Intersection: 63.2 → 44.4 s/veh, LOS E → D (Run 1 → Run 2).",
        )
        self.assertEqual(computer_use.describe_timing(TIMING), "SC1 AM peak: phase 2 (NB/SB left) green 12 → 20 s")
        cases = {
            "nothing saved": dict(saved=[], evaluation=evaluation()),
            "another green": dict(saved=[{**TIMING, "to": 18}], evaluation=evaluation()),
            "another change too": dict(saved=[TIMING, {**TIMING, "phase": 3, "from": 36, "to": 30}], evaluation=evaluation()),
            "never run": dict(saved=[TIMING], evaluation=evaluation(ran=False)),
            "run on another plan": dict(saved=[TIMING], evaluation=evaluation(matches=False)),
            "no better": dict(saved=[TIMING], evaluation=evaluation(after_delay=230.0)),
            "no evaluation": dict(saved=[TIMING], evaluation=None),
        }
        for name, fields in cases.items():
            with self.subTest(name):
                self.assertFalse(done(computer_use.Result(True, "", 6, **fields)))
        never = computer_use.Result(True, "", 6, saved=[TIMING], evaluation=evaluation(ran=False))
        self.assertEqual(computer_use.MICROSIM.outcome(never), "The simulation wasn't run after the change.")
        stale = computer_use.Result(True, "", 6, saved=[TIMING], evaluation=evaluation(matches=False))
        self.assertTrue(computer_use.MICROSIM.outcome(stale).endswith("The last run wasn't on the plan as saved."))
        # The scheduler's check is as it was, and says nothing more than what was saved.
        self.assertTrue(computer_use.SCHEDULER.did_task(computer_use.Result(True, "", 6, saved=SAVED)))
        self.assertEqual(computer_use.SCHEDULER.outcome(computer_use.Result(True, "", 6, saved=SAVED)), "")

    async def test_app_picks_the_page_its_address_task_and_instructions(self):
        opened = []

        class Offline(Screen):
            """A screen with no browser: it keeps what it was opened with, and shows nothing."""

            async def __aenter__(self):
                opened.append(self)
                return self

            async def __aexit__(self, *exc):
                pass

            async def send(self, command, **args):
                if command == "screenshot":
                    return {"ok": True, "png": base64.b64encode(PNG).decode(), "url": self.app.origin + "/"}
                if command == "state":
                    return {"ok": True, "changes": [], "unsaved": [], "evaluation": evaluation(ran=False)}
                return {"ok": True}

        fake = FakeGemini(lambda request: reply(text="Nothing to do."))

        class Client:
            @property
            def aio(self):
                @contextlib.asynccontextmanager
                async def given():
                    yield fake

                return given()

        self.enterContext(mock.patch.dict(os.environ, {"COMPUTER_USE_MODEL": "test-model"}))
        self.enterContext(mock.patch.object(core, "gemini", Client))
        self.enterContext(mock.patch.object(computer_use, "Screen", Offline))
        for name, app in (("microsim", computer_use.MICROSIM), (None, computer_use.SCHEDULER)):
            with self.subTest(name):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    code = await computer_use.main(["--confirm", *(["--app", name] if name else [])])
                screen, request = opened[-1], fake.requests[-1]
                self.assertIs(screen.app, app)
                self.assertEqual(screen.options["page"], str(app.page.resolve()))
                self.assertEqual(screen.options["origin"], app.origin)
                self.assertEqual((request.task, request.config.system_instruction), (app.task, app.instructions))
                # Nothing was saved, so the default task wasn't done.
                self.assertEqual(code, 1)
                self.assertIn(app.missed, output.getvalue())
                # Only the microsim has an evaluation to report.
                self.assertEqual("The simulation wasn't run after the change." in output.getvalue(), app is computer_use.MICROSIM)
        self.assertEqual(computer_use.MICROSIM.page.parent.name, "microsim-mock")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            await computer_use.main(["--app", "vissim"])

    def test_points_go_from_0_to_999_across_the_screen(self):
        self.assertEqual(pixel(0, 1920), 0)
        self.assertEqual(pixel(500, 1008), 504)
        self.assertEqual(pixel(999, 1920), 1918)
        self.assertEqual(pixel(1500, 100), 100)
        self.assertEqual(pixel(-4, 100), 0)

    def test_names_keys_as_playwright_does(self):
        self.assertEqual(
            [key_name(key) for key in ("ctrl", "Return", "esc", "f5", "a", "PageDown", " ", "arrow_up")],
            ["Control", "Enter", "Escape", "F5", "a", "PageDown", "Space", "ArrowUp"],
        )

    def test_presses_keys_together(self):
        with mock.patch.object(sys, "platform", "linux"):
            self.assertEqual(combo("ctrl+s"), "Control+s")
            self.assertEqual(combo(["Shift", "Tab"]), "Shift+Tab")
            self.assertEqual(combo("ctrl++"), "Control++")
            self.assertEqual(combo("+"), "+")
        with mock.patch.object(sys, "platform", "darwin"):
            # The app is Windows-style: Control+S saves on a Mac too.
            self.assertEqual(combo(["Control", "s"]), "ControlOrMeta+s")
            self.assertEqual(combo("Control"), "Control")

    async def test_maps_each_action_to_the_browser(self):
        screen = self.Recorder()
        self.assertEqual(await act(screen, "double_click", {"x": 500, "y": 500}), {})
        await act(screen, "type", {"text": "6", "press_enter": True, "x": 100, "y": 200})
        await act(screen, "scroll", {"x": 0, "y": 0, "direction": "up", "magnitude_in_pixels": 120})
        await act(screen, "drag_and_drop", {"start_x": 0, "start_y": 0, "end_x": 999, "end_y": 999})
        await act(screen, "key_down", {"key": "shift"})
        await act(screen, "wait", {"seconds": 0})
        await act(screen, "take_screenshot", {})
        self.assertEqual(
            screen.commands,
            [
                ("click", {"x": 500, "y": 250, "button": "left", "count": 2}),
                ("click", {"x": 100, "y": 100}),
                ("type", {"text": "6", "enter": True, "clear": True}),
                ("scroll", {"x": 0, "y": 0, "dx": 0, "dy": -120}),
                ("drag", {"x1": 0, "y1": 0, "x2": 999, "y2": 500}),
                ("keydown", {"key": "Shift"}),
            ],
        )

    async def test_refuses_to_leave_the_app_and_says_why(self):
        screen = self.Recorder()
        for name, args in (("navigate", {"url": "https://example.com"}), ("go_back", {}), ("open_web_browser", {})):
            with self.subTest(name):
                result = await act(screen, name, args)
                self.assertIn("only the scheduling app is open", result["error"])
        self.assertIn("missing or has a wrong argument", (await act(screen, "click", {"x": 1}))["error"])
        self.assertEqual(screen.commands, [])

    async def test_refuses_a_model_with_no_price_before_anything_starts(self):
        # Its calls would count as free, so the cap in dollars would never stop it.
        screen = self.Recorder()
        fake = FakeGemini(lambda request: reply(("wait", {"seconds": 0})))
        with self.assertRaisesRegex(core.SetupError, r"^No price for gemini-3\.8-flash-preview, so the run's cap"):
            await computer_use.run(screen, fake, model="gemini-3.8-flash-preview", log=quiet)
        self.assertEqual((fake.requests, screen.commands), ([], []))

        with mock.patch.object(computer_use, "Screen") as opened, self.assertRaisesRegex(core.SetupError, "No price for unpriced-model"):
            await computer_use.main(["--model", "unpriced-model"])
        opened.assert_not_called()

        with mock.patch.dict(os.environ, {"MODEL_PRICES": "gemini-3.8-flash-preview=0.75/3.75"}):
            computer_use.priced("gemini-3.8-flash-preview")
        with mock.patch.dict(os.environ, {"MODEL_PRICES": "no-equals-sign"}), self.assertRaisesRegex(core.SetupError, "MODEL_PRICES"):
            computer_use.priced(computer_use.MODEL)

    def test_keeps_only_the_newest_screenshots(self):
        image = types.FunctionResponsePart(inline_data=types.FunctionResponseBlob(mime_type="image/png", data=PNG))
        task = [types.Part(text="task"), types.Part.from_bytes(data=PNG, mime_type="image/png")]
        contents = [types.Content(role="user", parts=task)]
        for n in range(4):
            click = types.Part(function_call=types.FunctionCall(name="click"))
            result = types.FunctionResponse(name="click", response={"url": HOME, "n": n}, parts=[image])
            contents.append(types.Content(role="model", parts=[click]))
            contents.append(types.Content(role="user", parts=[types.Part(function_response=result)]))
        trimmed = without_old_screenshots(contents, keep=3)
        self.assertEqual(trimmed[0].parts[0].text, "task")
        self.assertEqual(trimmed[0].parts[1].text, "(An earlier screenshot, left out.)")
        kept = [content.parts[0].function_response for content in trimmed[2::2]]
        self.assertEqual([bool(response.parts) for response in kept], [False, True, True, True])
        self.assertEqual([response.response["n"] for response in kept], [0, 1, 2, 3])
        self.assertIs(trimmed[-1], contents[-1])
        # The conversation it was given keeps every screenshot.
        self.assertTrue(contents[0].parts[1].inline_data and contents[2].parts[0].function_response.parts)


class BrowserTest(unittest.IsolatedAsyncioTestCase):
    """The loop on the mock app in Chrome for Testing, with a fake Gemini."""

    @classmethod
    def setUpClass(cls):
        async def probe():
            async with Screen():
                pass

        try:
            asyncio.run(probe())
        except core.SetupError as error:
            raise unittest.SkipTest(f"No browser for computer use: {error}") from None

    async def test_a_fake_gemini_changes_the_headway_and_saves_it(self):
        async with Screen() as screen:
            fake = FakeGemini(planner(screen))
            result = await computer_use.run(screen, fake, model="test-model", log=quiet)
        self.assertTrue(result.finished, result.text)
        self.assertEqual(result.saved, SAVED)
        self.assertEqual(result.unsaved, [])
        self.assertEqual(result.steps, 6)
        self.assertEqual((result.input_tokens, result.output_tokens), (600, 90))
        first = fake.requests[0]
        self.assertEqual(first.task, computer_use.TASK)
        self.assertTrue(first.contents[0].parts[1].inline_data.data.startswith(PNG))
        tool = first.config.tools[0].computer_use
        self.assertEqual(tool.environment, types.Environment.ENVIRONMENT_BROWSER)
        self.assertEqual(tool.excluded_predefined_functions, ["navigate", "go_back", "go_forward"])
        for request in fake.requests[1:]:
            [part] = request.contents[-1].parts
            self.assertEqual(part.function_response.id, "call-0")
            self.assertEqual(part.function_response.response, {"url": HOME})
            self.assertTrue(part.function_response.parts[0].inline_data.data.startswith(PNG))
        parts = [part for content in fake.requests[-1].contents for part in content.parts or []]
        images = [part.inline_data or (part.function_response and part.function_response.parts) for part in parts]
        self.assertEqual(len([image for image in images if image]), computer_use.KEEP_SCREENSHOTS)

    @unittest.skipUnless(shutil.which(os.environ.get("FFMPEG") or "ffmpeg") and shutil.which("ffprobe"), "no ffmpeg")
    async def test_records_the_run_at_1920x1080(self):
        video = Path(self.enterContext(tempfile.TemporaryDirectory())) / "run.mp4"
        async with Screen(record=video, pace=False) as screen:
            # The captions take the bottom of the screen, so Gemini sees the rest.
            self.assertEqual((screen.width, screen.height), (1920, 1008))
            result = await computer_use.run(screen, FakeGemini(planner(screen)), model="test-model", log=quiet)
            self.assertEqual(await screen.close(), str(video.resolve()))
        self.assertEqual(result.saved, SAVED)
        fields = "stream=codec_name,width,height,pix_fmt"
        probe = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", fields, "-of", "csv=p=0"]
        found = subprocess.run([*probe, str(video)], capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(found, "h264,1920,1080,yuv420p")

    async def test_a_fake_gemini_lengthens_phase_2_runs_the_simulation_and_saves(self):
        async with Screen(app=computer_use.MICROSIM) as screen:
            fake = FakeGemini(engineer(screen))
            result = await computer_use.run(screen, fake, model="test-model", log=quiet)
            state = await screen.state()
        self.assertTrue(result.finished, result.text)
        self.assertEqual(result.saved, [TIMING])
        self.assertEqual(result.unsaved, [])
        self.assertEqual(fake.requests[0].task, computer_use.MICROSIM_TASK)
        self.assertEqual(fake.requests[1].results[0][1], {"url": SIM_HOME})
        self.assertEqual((state["url"], state["blocked"], state["left"]), (SIM_HOME, [], 0))
        # The run is repeatable: the sample data's northbound left goes from F to D.
        self.assertTrue(computer_use.MICROSIM.did_task(result))
        before, after = result.evaluation["before"], result.evaluation["after"]
        self.assertEqual((before["run"], before["cycle"], after["run"], after["cycle"]), (1, 116, 2, 124))
        self.assertEqual((before["northboundLeft"]["los"], after["northboundLeft"]["los"]), ("F", "D"))
        self.assertLess(after["intersection"]["delay"], before["intersection"]["delay"])

        # Run but not saved: the change is left unsaved, and the task isn't done.
        async with Screen(app=computer_use.MICROSIM) as screen:
            result = await computer_use.run(screen, FakeGemini(engineer(screen, save=False)), model="test-model", log=quiet)
        self.assertEqual((result.saved, result.unsaved), ([], [TIMING]))
        self.assertTrue(result.evaluation["afterMatchesCurrent"])
        self.assertFalse(computer_use.MICROSIM.did_task(result))

    async def test_each_app_reaches_only_its_own_address(self):
        page = Path(self.enterContext(tempfile.TemporaryDirectory())) / "other.html"
        page.write_text('<!doctype html><title>Other</title><img src="http://legacy-app.test/logo.png" alt="">')
        async with Screen(app=computer_use.MICROSIM, page=page) as screen:
            await screen.screenshot()
            state = await screen.state()
        # The scheduler's address is another app's, so the microsim's browser refuses it.
        self.assertEqual((state["url"], state["blocked"]), (SIM_HOME, ["http://legacy-app.test/logo.png"]))

    async def test_stops_after_15_model_calls(self):
        async with Screen() as screen:
            fake = FakeGemini(lambda request: reply(("wait", {"seconds": 0})))
            result = await computer_use.run(screen, fake, model="test-model", log=quiet)
        self.assertFalse(result.finished)
        self.assertEqual(result.steps, 15)
        self.assertEqual(len(fake.requests), 15)
        self.assertEqual(result.text, "Stopped after 15 model calls, the most a run may make.")

    async def test_a_try_that_timed_out_takes_a_step_and_counts_from_an_estimate(self):
        # Gemini may have run it, and billed it.
        async with Screen() as screen:
            fake = FakeGemini(
                lambda request: core.httpx2.ReadTimeout("timed out") if len(fake.requests) == 1 else reply(("wait", {"seconds": 0}))
            )
            result = await computer_use.run(screen, fake, model="test-model", log=quiet)
        self.assertEqual(result.text, "Stopped after 15 model calls, the most a run may make.")
        self.assertEqual((result.steps, len(fake.requests)), (15, 15))
        # 14 answered calls, and the one that timed out, from its text alone: a screenshot's bytes aren't text.
        self.assertEqual(result.output_tokens, 14 * 15 + core.STOPPED_OUTPUT_TOKENS)
        self.assertGreater(result.input_tokens, 14 * 100)
        self.assertLess(result.input_tokens, 14 * 100 + 1000)

    async def test_stops_before_a_call_that_could_pass_150_dollars(self):
        self.enterContext(mock.patch.dict(os.environ, {"MODEL_PRICES": "pricey-model=10000/0"}))
        async with Screen() as screen:
            fake = FakeGemini(lambda request: reply(("wait", {"seconds": 0}), usage=(100, 0, 0)))
            result = await computer_use.run(screen, fake, model="pricey-model", log=quiet)
        # A call costs $1.00, so a second would likely reach $2.00.
        self.assertEqual((result.steps, result.cost_usd), (1, 1.0))
        self.assertEqual(result.text, "Stopped at US$1.00: another call would likely pass the run's US$1.50.")

    async def test_a_step_gemini_wants_confirmed_waits_for_a_person(self):
        async def respond(request):
            if request.turn == 0:
                check = {"decision": "require_confirmation", "explanation": "This saves the schedule."}
                return reply(("click", {**await at(screen, "#route-605"), "safety_decision": check}))
            return reply(text="Done.")

        async with Screen() as screen:
            fake = FakeGemini(respond)
            result = await computer_use.run(screen, fake, model="test-model", log=quiet)
        self.assertFalse(result.finished)
        self.assertIn("asked a person to confirm a step (This saves the schedule.)", result.text)
        self.assertEqual((result.steps, len(fake.requests)), (1, 1))

        asked = []

        async def yes(explanation):
            asked.append(explanation)
            return True

        async with Screen() as screen:
            fake = FakeGemini(respond)
            result = await computer_use.run(screen, fake, model="test-model", confirm=yes, log=quiet)
        self.assertTrue(result.finished)
        self.assertEqual(asked, ["This saves the schedule."])
        self.assertEqual(fake.requests[1].results, [("click", {"url": HOME, "safety_acknowledgement": "true"})])

    async def test_the_page_cant_be_left_or_reach_anything_else(self):
        page = Path(self.enterContext(tempfile.TemporaryDirectory())) / "away.html"
        page.write_text(
            '<!doctype html><title>Away</title><img src="https://example.com/pixel.png" alt="">'
            '<p><a id="away" href="https://example.com/">Leave</a></p>'
        )
        async with Screen(page=page) as screen:

            async def respond(request):
                if request.turn == 0:
                    return reply(("click", await at(screen, "#away")))
                return reply(text="It didn't go anywhere.")

            fake = FakeGemini(respond)
            result = await computer_use.run(screen, fake, model="test-model", log=quiet)
            state = await screen.state()
        self.assertTrue(result.finished)
        self.assertEqual(state["url"], HOME)
        self.assertEqual(state["blocked"][:2], ["https://example.com/pixel.png", "https://example.com/"])
        self.assertEqual(state["left"], 1)
        self.assertEqual(fake.requests[1].results[0][1]["url"], HOME)


class CommandTest(unittest.IsolatedAsyncioTestCase):
    """The command line, reporting each model call's tokens and cost to a study on the test service."""

    @classmethod
    def setUpClass(cls):
        BrowserTest.setUpClass()
        support.service.start()

    async def test_does_the_task_and_reports_usage_to_the_study(self):
        study = support.open_study("computer-use")

        class Client:
            @property
            def aio(self):
                @contextlib.asynccontextmanager
                async def opened():
                    yield fake

                return opened()

        screens = []

        class Recording(Screen):
            async def __aenter__(self):
                screens.append(self)
                return await super().__aenter__()

        async def respond(request):
            return await planner(screens[0])(request)

        fake = FakeGemini(respond)
        env = {"TRANSIT_TOKEN_AGENT": support.AGENT, "COMPUTER_USE_MODEL": "test-model"}
        self.enterContext(mock.patch.dict(os.environ, env))
        self.enterContext(mock.patch.object(core, "gemini", Client))
        self.enterContext(mock.patch.object(computer_use, "Screen", Recording))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = await computer_use.main(["--study", study, "--service", support.URL, "--confirm"])
        self.assertEqual(code, 0, output.getvalue())
        self.assertIn("The app saved: 605 Elm: Weekday Peak headway 8 → 6 min.", output.getvalue())
        self.assertIn(f"6 model calls, 600 tokens in and 90 out, US$0.0000, reported to {study}.", output.getvalue())
        usage = support.activities(study, "usage")
        self.assertEqual(len(usage), 6)
        self.assertEqual(
            {(entry["model"], entry["inputTokens"], entry["outputTokens"], entry["costUsd"]) for entry in usage},
            {("test-model", 100, 15, 0.0)},
        )


if __name__ == "__main__":
    unittest.main()
