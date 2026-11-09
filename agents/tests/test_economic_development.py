"""The economic-development skill: its tools call the service's GIS operations for the
specialist's own study, only with the skill; it forecasts nothing, and its rules
quote their pages."""

import os
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


TOOLS = {"list_datasets", "list_layers", "summarise_layer", "route_stops", "route_shape", "study_line", "named_area", "buffer", "jobs_within", "zoning_within"}

QUOTES = [
    ("ontario-line-ibc-2019", 38, "an 800m radius buffer (as the crow flies distance) around stations"),
    ("ttc-standards-2024", 10, "90% of the population and employment"),
    ("metrolinx-bcm-vol2", 84, "Number of jobs within access distance of transit"),
    ("metrolinx-bcm-vol2", 108, "Wider Economic Impacts – analyzing how the investment in the transport network impacts economic activity"),
    ("metrolinx-bcm-vol2", 159, "Areas i and j should be at TAZ level"),
]


class SkillTest(unittest.TestCase):
    def test_quotes_each_rule_from_its_page(self):
        body = normalize(skills.load_skill("economic-development").body)
        for source, page, quote in QUOTES:
            with self.subTest(quote=quote[:50]):
                self.assertIn(normalize(quote), body)
                self.assertIn(normalize(quote), normalize(SOURCES[source][page]))

    def test_names_the_parts_of_wider_economic_impacts_on_the_pages_it_cites(self):
        # Paraphrased pages, checked for the words they rest on.
        pages = {110: ["Productivity", "Imperfect Competition", "Labour Markets"], 152: ["additional", "WEIs"], 154: ["Agglomeration"], 171: ["Land Value Uplift", "BCR or NPV"]}
        for page, words in pages.items():
            text = normalize(SOURCES["metrolinx-bcm-vol2"][page])
            for word in words:
                self.assertIn(normalize(word), text, (page, word))

    def test_says_when_another_skill_fits_better_and_forecasts_nothing(self):
        skill = skills.load_skill("economic-development")
        for other in ("gis-analyst", "equity-analysis", "metrolinx-bca"):
            self.assertIn(other, skill.description)
        self.assertIn("Forecasts no growth.", skill.description)
        self.assertIn("Forecast. Never say how many jobs, businesses, homes or dollars a line will bring", skill.body)
        self.assertIn("never this study's figure", skill.body)

    def test_offers_the_layer_tools_jobs_and_zoning(self):
        script = load("economic-development")
        self.assertEqual(set(script.SPECS), TOOLS)
        with self.assertRaisesRegex(ValueError, "^zoning_within needs layer."):
            script.arguments("zoning_within", "s", {})


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.study = f"econ-{uuid.uuid4().hex[:6]}"
        support.api("POST", "/v1/studies", {"id": self.study, "title": "Jobs"}, token=AGENT)
        env = {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))

    async def test_counts_people_working_near_stations_and_refuses_zoning_beyond_the_corridor(self):
        async with support.session() as session:
            tools = {tool.name: tool.function for tool in skills.skill_tools(skills.load_skill("economic-development"), session, self.study)}
            stops = await tools["route_stops"](route="4")
            buffered = await tools["buffer"](layer=stops["layer"]["id"], metres=800)
            jobs = await tools["jobs_within"](layer=buffered["layer"]["id"])
            zoning = await tools["zoning_within"](layer=buffered["layer"]["id"])
            far = await tools["buffer"](layer=(await tools["route_stops"](route="52"))["layer"]["id"], metres=400)
            with self.assertRaisesRegex(ValueError, r"^422 outside_coverage: \"toronto-zoning-corridor\" covers the Don Mills corridor only"):
                await tools["zoning_within"](layer=far["layer"]["id"])

        self.assertEqual(jobs["layer"]["dataset"]["id"], "statcan-pow-ct-2021")
        self.assertGreater(jobs["totals"]["jobs"]["value"], 0)
        self.assertIn("COVID-19", " ".join(jobs["warnings"]))
        self.assertEqual(zoning["layer"]["dataset"]["id"], "toronto-zoning-corridor")
        self.assertIn("beyond the Don Mills corridor", " ".join(zoning["warnings"]))
        study = support.api("GET", f"/v1/studies/{self.study}")
        [recorded] = [f for f in study["figures"] if f["id"] == jobs["totals"]["jobs"]["figure"]]
        self.assertEqual(recorded["basis"]["kind"], "spatial")

    async def test_a_specialist_gets_the_tools_only_with_the_skill(self):
        with_skill = FakeGemini(lambda request: reply(("list_datasets", {})) if request.turn == 0 else reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, with_skill, self.study, "Jobs near Line 4?", "Count them.", skill="economic-development")
        self.assertLessEqual(TOOLS, with_skill.requests[0].tools)

        without = FakeGemini(lambda request: reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, without, self.study, "Jobs near Line 4?", "Count them.")
        self.assertFalse({"jobs_within", "zoning_within"} & without.requests[0].tools)


if __name__ == "__main__":
    unittest.main()
