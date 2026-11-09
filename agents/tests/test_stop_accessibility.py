"""The stop-accessibility skill: its tools inventory a route's stops through the
service, only with the skill; it never claims compliance, and every requirement it
states quotes O. Reg. 191/11 on its page."""

import os
import re
import unittest
import uuid
from unittest import mock

import skills
import specialists
from tests import support
from tests.support import AGENT, FakeGemini, reply
from tests.test_equity_analysis import load
from tests.test_skills import SOURCES, normalize


def setUpModule():
    support.service.start()


TOOLS = {"list_datasets", "list_layers", "summarise_layer", "route_stops", "named_area", "buffer", "points_within", "stop_accessibility", "stop_shelters"}


class SkillTest(unittest.TestCase):
    def setUp(self):
        self.body = skills.load_skill("stop-accessibility").body

    def test_quotes_every_requirement_word_for_word_on_its_page(self):
        quoted = re.findall(r'"([^"]+)" \(([a-z0-9-]+) p\. (\d+)\)', self.body)
        self.assertGreaterEqual(len([q for q in quoted if q[1] == "o-reg-191-11"]), 5)
        for words, source, page in quoted:
            with self.subTest(quote=words[:50]):
                self.assertIn(normalize(words), normalize(SOURCES[source][int(page)]))
        # Two quotes share one citation: the requirement on transit stops, p. 17.
        self.assertIn(normalize("if the official stop is not accessible and the safe location is along the same transit route"), normalize(SOURCES["o-reg-191-11"][17]))
        self.assertIn(normalize("in the development of accessible design criteria"), normalize(SOURCES["o-reg-191-11"][33]))

    def test_the_regulation_is_a_source_with_its_transportation_part(self):
        pages = SOURCES["o-reg-191-11"]
        self.assertIn("ONTARIO REGULATION 191/11", pages[1])
        self.assertIn("PART IV TRANSPORTATION STANDARDS", pages[12])

    def test_never_claims_compliance(self):
        self.assertIn("never says whether anything complies with the law", skills.load_skill("stop-accessibility").description)
        self.assertIn("Say that a stop, station, route or the TTC complies, or fails to comply", self.body)
        self.assertIn("an inventory, not a finding of compliance; a planner confirms", self.body)
        self.assertIn("The sources here give no date by which every existing stop or station must be accessible.", self.body)

    def test_offers_the_stop_tools(self):
        script = load("stop-accessibility")
        self.assertEqual(set(script.SPECS), TOOLS)
        self.assertEqual(script.arguments("stop_shelters", "s", {"layer": "a", "metres": 30}), {"studyId": "s", "layer": "a", "metres": 30})


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.study = f"acc-{uuid.uuid4().hex[:6]}"
        support.api("POST", "/v1/studies", {"id": self.study, "title": "Access"}, token=AGENT)
        env = {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))

    async def test_inventories_a_lines_platforms_and_a_routes_shelters(self):
        async with support.session() as session:
            tools = {tool.name: tool.function for tool in skills.skill_tools(skills.load_skill("stop-accessibility"), session, self.study)}
            line = await tools["route_stops"](route="2")
            access = await tools["stop_accessibility"](layer=line["layer"]["id"])
            route = await tools["route_stops"](route="25")
            shelters = await tools["stop_shelters"](layer=route["layer"]["id"])
            buffered = await tools["buffer"](layer=route["layer"]["id"], metres=100)
            with self.assertRaisesRegex(ValueError, "^422 not_stops"):
                await tools["stop_accessibility"](layer=buffered["layer"]["id"])

        self.assertEqual(access["layer"]["dataset"]["id"], "ttc-gtfs")
        self.assertIn("Old Mill Station", access["gaps"]["stations"])
        self.assertEqual(access["totals"]["stationsNotAccessible"]["value"], len(access["gaps"]["stations"]))
        self.assertIn("not a finding of compliance", " ".join(access["warnings"]))
        self.assertEqual(shelters["layer"]["dataset"]["id"], "toronto-transit-shelters")
        self.assertLessEqual(shelters["totals"]["sheltered"]["value"], shelters["totals"]["stops"]["value"])

    async def test_a_specialist_gets_the_tools_only_with_the_skill(self):
        with_skill = FakeGemini(lambda request: reply(("list_datasets", {})) if request.turn == 0 else reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, with_skill, self.study, "Which Line 2 stations are accessible?", "Inventory them.", skill="stop-accessibility")
        self.assertLessEqual(TOOLS, with_skill.requests[0].tools)

        without = FakeGemini(lambda request: reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, without, self.study, "Which Line 2 stations are accessible?", "Inventory them.")
        self.assertFalse({"stop_accessibility", "stop_shelters"} & without.requests[0].tools)


if __name__ == "__main__":
    unittest.main()
