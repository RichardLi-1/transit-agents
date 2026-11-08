"""The engagement-needs skill: its script pins a need to the study's line, and a
specialist with the skill proposes a need that waits for a planner. Only the skill's
own tool adds a need: with a citation, and on the study's line."""

import importlib.util
import os
import unittest
import uuid
from unittest import mock

import skills
import specialists
from tests import support
from tests.support import AGENT, SOURCE, FakeGemini, reply


def setUpModule():
    support.service.start()


def engagement_needs():
    """The engagement-needs skill's script, as a module."""
    spec = importlib.util.spec_from_file_location("engagement_needs_tools", skills.SKILLS_DIR / "engagement-needs" / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Points on the lines the display draws: a seeded need's, at the loop at the hospital,
# and the end of the Ontario Line's proposed extension.
SUNNYBROOK = (-79.375262, 43.722663)
DON_MILLS = (-79.347039, 43.775094)
MONTREAL = (-73.554, 45.509)  # about 500 km from any study's line

CITATION = {"contextId": SOURCE, "page": 1, "quote": "a weekly ridership increase of 1,680 customers"}
REASON = "Riders could reach the hospital without a transfer."


def poster(at, **changes):
    """A need for a poster at Sunnybrook Hospital, at the point given."""
    need = {"id": "sunnybrook-poster", "title": "Engagement poster", "place": "Sunnybrook Hospital", "lon": at[0], "lat": at[1]}
    return {**need, "kinds": ["image"], "reason": REASON, "citations": [CITATION], **changes}


class PinTest(unittest.TestCase):
    def setUp(self):
        self.script = engagement_needs()
        self.lines = self.script.lines()

    def pin(self, line, lon, lat):
        return self.script.pin(self.lines, line, lon, lat)

    def test_a_point_on_the_line_stays_put(self):
        self.assertEqual(
            self.pin("lawrence-sunnybrook", *SUNNYBROOK),
            {"lon": SUNNYBROOK[0], "lat": SUNNYBROOK[1], "metresMoved": 0, "onProposedPart": False},
        )

    def test_a_point_near_the_line_moves_onto_it(self):
        pinned = self.pin("lawrence-sunnybrook", SUNNYBROOK[0], SUNNYBROOK[1] + 0.001)  # about 110 m north
        self.assertGreater(pinned["metresMoved"], 0)
        self.assertLessEqual(pinned["metresMoved"], 111)
        self.assertEqual(self.pin("lawrence-sunnybrook", pinned["lon"], pinned["lat"])["metresMoved"], 0)

    def test_says_when_a_point_is_on_the_part_not_built(self):
        self.assertEqual(self.pin("ontario-line-don-mills", *DON_MILLS), {"lon": DON_MILLS[0], "lat": DON_MILLS[1], "metresMoved": 0, "onProposedPart": True})
        thorncliffe = self.pin("ontario-line-don-mills", -79.349138, 43.706122)  # Thorncliffe Park, on the line being built
        self.assertEqual((thorncliffe["metresMoved"], thorncliffe["onProposedPart"]), (0, False))

    def test_refuses_a_point_far_from_the_line(self):
        with self.assertRaisesRegex(ValueError, r"^That point is [\d,]+ m from this study's line, more than 500 m"):
            self.pin("ontario-line-don-mills", *SUNNYBROOK)  # the hospital isn't on the Ontario Line

    def test_a_study_without_a_line_has_nowhere_to_pin(self):
        for line in (None, "no-such-line"):
            with self.subTest(line), self.assertRaisesRegex(ValueError, "no line on the map"):
                self.pin(line, *SUNNYBROOK)


class SpecialistTest(unittest.IsolatedAsyncioTestCase):
    """A specialist with the skill, on the real service, with the fake Gemini."""

    def setUp(self):
        self.study = f"needs-{uuid.uuid4().hex[:6]}"
        support.api("POST", "/v1/studies", {"id": self.study, "title": "Needs", "line": "lawrence-sunnybrook"}, token=AGENT)
        env = {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))

    async def test_proposes_a_need_on_the_line_that_waits_for_a_planner(self):
        other = support.open_study("other")

        def need(study, at, quote=CITATION["quote"], id="sunnybrook-poster"):
            citation = {**CITATION, "quote": quote}
            return {"studyId": study, **poster((at["lon"], at["lat"]), id=id, citations=[citation])}

        def respond(request):
            if request.turn == 0:
                return reply(
                    ("get_study", {"studyId": self.study}),
                    ("read_page", {"contextId": SOURCE, "page": 1}),
                    ("pin_to_line", {"lon": SUNNYBROOK[0] + 0.0005, "lat": SUNNYBROOK[1]}),  # about 40 m east
                )
            if request.turn == 1:
                at = request.results[2][1]["output"]
                return reply(
                    ("add_engagement_need", need(other, at)),
                    ("add_engagement_need", need(self.study, at, "a weekly ridership increase of 9,999 customers", "made-up")),
                    ("add_engagement_need", need(self.study, at)),
                )
            return reply(text="Proposed a poster at Sunnybrook Hospital (test-plan p. 1). A planner decides whether to make it.")

        fake = FakeGemini(respond)
        async with support.session() as session:
            summary = await specialists.run_specialist(
                session, fake, self.study, "Where do people need to hear about this?", "Propose engagement needs.", skill="engagement-needs"
            )

        first = fake.requests[0]
        self.assertIn("Skill engagement-needs:", first.system)
        self.assertIn("Only a planner asks for it to be made.", first.system)
        self.assertTrue({"get_study", "read_page", "pin_to_line", "add_engagement_need"} <= first.tools)
        self.assertNotIn("request_engagement_media", first.tools)

        pinned = fake.requests[1].results[2][1]["output"]
        self.assertGreater(pinned["metresMoved"], 0)
        self.assertFalse(pinned["onProposedPart"])
        other_study, made_up, added = [response for _, response in fake.requests[2].results]
        self.assertEqual(other_study["error"], f"add_engagement_need: this run writes only to study {self.study}, so studyId must be {self.study!r}.")
        self.assertTrue(made_up["error"].startswith("add_engagement_need: 422 quote_not_found"), made_up)
        self.assertEqual((added["output"]["id"], added["output"]["status"]), ("sunnybrook-poster", "needed"))
        self.assertEqual(added["output"]["pinned"], {"metresMoved": 0, "onProposedPart": False})

        # It waits: nothing is asked for or made until a planner asks.
        [proposed] = support.api("GET", f"/v1/studies/{self.study}")["needs"]
        self.assertEqual((proposed["status"], proposed["addedBy"], proposed["media"]), ("needed", "agent:lead", []))
        self.assertEqual((proposed["lon"], proposed["lat"]), (pinned["lon"], pinned["lat"]))
        self.assertNotIn("requestedBy", proposed)
        self.assertEqual(support.api("GET", f"/v1/studies/{other}")["needs"], [])
        self.assertIn("A planner decides", summary)

    async def test_a_specialist_without_the_skill_cant_add_a_need(self):
        # As a source might ask: no citation, a free-text reason, and a place far off the line.
        need = {"studyId": self.study, **poster(MONTREAL, place="Montreal City Hall", citations=[])}

        def respond(request):
            return reply(("add_engagement_need", need)) if request.turn == 0 else reply(text="Done.")

        fake = FakeGemini(respond)
        async with support.session() as session:
            await specialists.run_specialist(session, fake, self.study, "Anything?", "Record nothing.")

        self.assertNotIn("add_engagement_need", fake.requests[0].tools)
        self.assertEqual(fake.requests[1].results, [("add_engagement_need", {"error": "You have no tool named add_engagement_need."})])
        self.assertEqual(support.api("GET", f"/v1/studies/{self.study}")["needs"], [])

    async def test_adds_a_need_only_with_a_citation_and_on_the_line(self):
        async with support.session() as session:
            tools = {tool.name: tool.function for tool in skills.skill_tools(skills.load_skill("engagement-needs"), session, self.study)}
            add = tools["add_engagement_need"]
            near = (SUNNYBROOK[0] + 0.0005, SUNNYBROOK[1])  # about 40 m east of the line
            for citations in ([], None):
                with self.subTest(citations=citations), self.assertRaisesRegex(ValueError, "^No citation, no need"):
                    await add(**poster(near, citations=citations))
            with self.assertRaisesRegex(ValueError, r"^That point is [\d,]+ m from this study's line, more than 500 m"):
                await add(**poster(MONTREAL))
            with self.assertRaisesRegex(ValueError, "^Give lon and lat as numbers"):
                await add(**poster(("-79.37", True)))
            with self.assertRaisesRegex(ValueError, "^Unknown inputs: status"):
                await add(**poster(near, status="ready"))
            with self.assertRaisesRegex(ValueError, f"studyId must be {self.study!r}"):
                await add(**poster(near), studyId="other")
            self.assertEqual(support.api("GET", f"/v1/studies/{self.study}")["needs"], [])

            added = await add(**poster(near), studyId=self.study)
            pinned = await tools["pin_to_line"](lon=near[0], lat=near[1])

        self.assertEqual((added["id"], added["status"]), ("sunnybrook-poster", "needed"))
        self.assertEqual(added["pinned"], {"metresMoved": pinned["metresMoved"], "onProposedPart": False})
        self.assertGreater(pinned["metresMoved"], 0)
        # Pinned to the line, where the model's point was off it.
        [need] = support.api("GET", f"/v1/studies/{self.study}")["needs"]
        self.assertEqual((need["lon"], need["lat"]), (pinned["lon"], pinned["lat"]))
        self.assertEqual(need["citations"], [CITATION])

    async def test_pin_to_line_reads_the_studys_own_line(self):
        def pin_to_line(study):
            tools = {tool.name: tool for tool in skills.skill_tools(skills.load_skill("engagement-needs"), session, study)}
            self.assertEqual(set(tools), {"pin_to_line", "add_engagement_need"})
            return tools["pin_to_line"].function

        async with support.session() as session:
            self.assertEqual((await pin_to_line(self.study)(lon=SUNNYBROOK[0], lat=SUNNYBROOK[1]))["metresMoved"], 0)

            lineless = support.open_study("lineless")
            with self.assertRaisesRegex(ValueError, "no line on the map"):
                await pin_to_line(lineless)(lon=SUNNYBROOK[0], lat=SUNNYBROOK[1])


if __name__ == "__main__":
    unittest.main()
