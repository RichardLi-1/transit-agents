"""The equity-analysis skill: its tools call the service's GIS operations for the
specialist's own study, only with the skill, and its rules quote their pages."""

import importlib.util
import json
import os
import re
import unittest
import uuid
from unittest import mock

import skills
import specialists
from tests import support
from tests.support import AGENT, ROOT, FakeGemini, reply
from tests.test_skills import SOURCES, normalize


def setUpModule():
    support.service.start()


def load(name: str):
    """A skill's tools.py, as a module."""
    spec = importlib.util.spec_from_file_location(f"{name.replace('-', '_')}_tools", skills.SKILLS_DIR / name / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def spelled_out(test: unittest.TestCase, skill: str, given: dict[str, str]):
    """The cases whose answer or behaviour a skill spells out are dev, and no test case's value is in it."""
    body = skills.load_skill(skill).body
    cases = [json.loads(line) for line in (ROOT / "evals" / "cases.jsonl").read_text().splitlines()]
    own = {case["id"]: case for case in cases if case.get("skill") == skill}
    for case, words in given.items():
        with test.subTest(case):
            test.assertRegex(body, words)
            test.assertEqual(own[case]["split"], "dev")
    # A count under 10 is too common a number to look for.
    for case in own.values():
        value = case["expect"].get("value")
        if case["split"] == "test" and value is not None and not (float(value).is_integer() and abs(value) < 10):
            test.assertNotRegex(body, rf"(?<![\d.]){re.escape(str(case['expect']['value']))}(?![\d.])", case["id"])


TOOLS = {"list_datasets", "list_layers", "summarise_layer", "route_stops", "route_shape", "study_line", "named_area", "buffer", "equity_profile"}

# The words the skill quotes, and the page each is on.
QUOTES = [
    ("ttc-standards-2024", 10, "90% of the population and employment is within a 400 metre (5 minute) walk of transit service"),
    ("ontario-line-ibc-2019", 38, "an 800m radius buffer (as the crow flies distance) around stations"),
    (
        "ttc-anp-2026",
        114,
        "boardings at all stops within 400m of a Neighbourhood Improvement Area (NIA), as designated by the City of Toronto, "
        "will be weighted at 125% of a standard boarding",
    ),
    ("ttc-standards-2024", 33, "in or within 400-metres of residential parts of Neighbourhood Improvement Areas (NIAs)"),
    ("ttc-standards-2024", 33, "the NIAs were narrowed to exclude non-residential areas such as ravines and industrial lands"),
    ("ttc-standards-2024", 24, "people with low income, women and shift workers"),
]


class SkillTest(unittest.TestCase):
    def test_quotes_each_rule_from_its_page(self):
        body = normalize(skills.load_skill("equity-analysis").body)
        for source, page, quote in QUOTES:
            with self.subTest(quote=quote[:50]):
                self.assertIn(normalize(quote), body)
                self.assertIn(normalize(quote), normalize(SOURCES[source][page]))

    def test_says_when_another_skill_fits_better(self):
        description = skills.load_skill("equity-analysis").description
        for other in ("gis-analyst", "ttc-standards", "engagement-needs"):
            self.assertIn(other, description)

    def test_never_infers_a_persons_traits_or_judges_fairness(self):
        body = skills.load_skill("equity-analysis").body
        self.assertIn("Infer anything about a person.", body)
        self.assertIn("never say that a rider, a household or anyone near a stop is in low income", body)
        self.assertIn("say a change is equitable or not", body)
        self.assertIn("The tool counts stops, never boardings.", body)
        self.assertIn("Name no one to ask about the rest", body)

    def test_the_cases_it_spells_out_are_dev(self):
        spelled_out(self, "equity-analysis", {"eq-007": r"Infer anything about a person", "eq-008": r"The tool counts stops, never boardings", "eq-009": r"say a change is equitable or not"})

    def test_offers_the_layer_tools_and_equity_profile(self):
        script = load("equity-analysis")
        self.assertEqual(set(script.SPECS), TOOLS)
        self.assertEqual(script.arguments("equity_profile", "s", {"layer": "a", "stops": "b"}), {"studyId": "s", "layer": "a", "stops": "b"})
        with self.assertRaisesRegex(ValueError, "^equity_profile needs layer."):
            script.arguments("equity_profile", "s", {"stops": "b"})
        with self.assertRaisesRegex(ValueError, "^Unknown inputs: metres."):
            script.arguments("equity_profile", "s", {"layer": "a", "metres": 400})
        for name in TOOLS:
            self.assertNotIn("studyId", script.parameters(name)["properties"], name)


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    """The skill's tools on the real service, with its committed datasets."""

    def setUp(self):
        self.study = f"eq-{uuid.uuid4().hex[:6]}"
        support.api("POST", "/v1/studies", {"id": self.study, "title": "Equity"}, token=AGENT)
        env = {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))

    async def test_profiles_a_routes_catchment_beside_the_city_with_figures_citing_the_census(self):
        async with support.session() as session:
            tools = {tool.name: tool.function for tool in skills.skill_tools(skills.load_skill("equity-analysis"), session, self.study)}
            stops = await tools["route_stops"](route="52")
            buffered = await tools["buffer"](layer=stops["layer"]["id"], metres=400)
            profile = await tools["equity_profile"](layer=buffered["layer"]["id"], stops=stops["layer"]["id"])

        totals = profile["totals"]
        self.assertEqual(profile["layer"]["id"], "ttc-52-stops-400m-equity")
        self.assertEqual(profile["layer"]["dataset"]["id"], "census-da-2021")
        self.assertEqual(totals["cityLowIncomeShare"]["value"], 13.2)
        self.assertEqual(totals["lowIncomeShareGap"]["value"], round(totals["lowIncomeShare"]["value"] - 13.2, 1))
        self.assertEqual([n["name"] for n in profile["nias"]], ["Kingsview Village-The Westway", "Weston", "Rustic"])
        self.assertIn("residential parts of NIAs", " ".join(profile["warnings"]))
        study = support.api("GET", f"/v1/studies/{self.study}")
        [recorded] = [f for f in study["figures"] if f["id"] == totals["stopsNearNia"]["figure"]]
        self.assertEqual(recorded["basis"], {"kind": "spatial", "layer": "ttc-52-stops-400m-equity", "total": "stopsNearNia"})

    async def test_a_specialist_gets_the_tool_only_with_the_skill(self):
        with_skill = FakeGemini(lambda request: reply(("list_datasets", {})) if request.turn == 0 else reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, with_skill, self.study, "Who lives near the 52?", "Profile it.", skill="equity-analysis")
        self.assertLessEqual(TOOLS, with_skill.requests[0].tools)

        without = FakeGemini(lambda request: reply(("equity_profile", {"layer": "x"})) if request.turn == 0 else reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, without, self.study, "Who lives near the 52?", "Profile it.")
        self.assertNotIn("equity_profile", without.requests[0].tools)
        self.assertEqual(without.requests[1].results, [("equity_profile", {"error": "You have no tool named equity_profile."})])


if __name__ == "__main__":
    unittest.main()
