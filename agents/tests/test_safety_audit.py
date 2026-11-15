"""The safety-audit skill: its tools make a layer as gis-analyst does, then call the
service's KSI profile, hot spots and trend for the specialist's own study, and only a
specialist with the skill gets them. The service counts; the figures cite the dataset."""

import importlib.util
import os
import unittest
import uuid
from unittest import mock

import skills
import specialists
from tests import support
from tests.support import AGENT, FakeGemini, reply


def setUpModule():
    support.service.start()


def safety_audit():
    """The safety-audit skill's tools.py, as a module."""
    spec = importlib.util.spec_from_file_location("safety_audit_tools", skills.SKILLS_DIR / "safety-audit" / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The layer tools it shares with gis-analyst, and its own.
LAYERS = {"list_datasets", "list_layers", "summarise_layer", "route_stops", "route_shape", "study_line", "named_area", "buffer"}
SAFETY = {"ksi_profile", "ksi_hotspots", "ksi_trend"}


class ArgumentsTest(unittest.TestCase):
    def setUp(self):
        self.script = safety_audit()

    def test_offers_the_layer_tools_and_the_ksi_tools_and_no_others(self):
        self.assertEqual(set(self.script.SPECS), LAYERS | SAFETY)
        for name in SAFETY:
            schema = self.script.parameters(name)
            self.assertNotIn("studyId", schema["properties"], name)
            self.assertEqual(schema["required"], ["layer"])
        self.assertEqual(self.script.parameters("ksi_profile")["properties"]["involving"]["enum"], ["pedestrian", "cyclist", "motorcyclist"])

    def test_works_in_the_runs_own_study_only(self):
        self.assertEqual(self.script.arguments("ksi_trend", "s", {"layer": "a", "split": 2021}), {"studyId": "s", "layer": "a", "split": 2021})
        with self.assertRaisesRegex(ValueError, "this run works only on study s"):
            self.script.arguments("ksi_profile", "s", {"layer": "a", "studyId": "other"})

    def test_refuses_inputs_a_tool_doesnt_take_and_names_what_it_needs(self):
        with self.assertRaisesRegex(ValueError, "^Unknown inputs: cause. ksi_profile takes: layer, from, to, involving, id, title."):
            self.script.arguments("ksi_profile", "s", {"layer": "a", "cause": "speeding"})
        with self.assertRaisesRegex(ValueError, "^ksi_hotspots needs layer."):
            self.script.arguments("ksi_hotspots", "s", {})


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    """The skill's tools on the real service, with its committed datasets."""

    def setUp(self):
        self.study = f"safety-{uuid.uuid4().hex[:6]}"
        support.api("POST", "/v1/studies", {"id": self.study, "title": "Safety"}, token=AGENT)
        env = {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))

    async def tools(self, session):
        return {tool.name: tool.function for tool in specialists.script_tools(skills.load_skill("safety-audit"), session, self.study)}

    async def test_audits_a_corridor_with_figures_that_cite_the_dataset(self):
        async with support.session() as session:
            tools = await self.tools(session)
            shape = await tools["route_shape"](route="25")
            corridor = await tools["buffer"](layer=shape["layer"]["id"], metres=50)
            profile = await tools["ksi_profile"](layer=corridor["layer"]["id"], **{"from": 2016, "to": 2025})
            spots = await tools["ksi_hotspots"](layer=corridor["layer"]["id"], **{"from": 2016, "to": 2025})
            trend = await tools["ksi_trend"](layer=corridor["layer"]["id"])

        self.assertEqual(profile["layer"]["dataset"]["id"], "toronto-ksi-detail")
        self.assertTrue(profile["warnings"][0].startswith("Police-reported only"))
        self.assertEqual(sum(profile["breakdown"]["byYear"].values()), profile["totals"]["collisions"]["value"])
        figure = profile["totals"]["pedestrianKsi"]["figure"]
        study = support.api("GET", f"/v1/studies/{self.study}")
        [recorded] = [f for f in study["figures"] if f["id"] == figure]
        self.assertEqual(recorded["basis"], {"kind": "spatial", "layer": profile["layer"]["id"], "total": "pedestrianKsi"})
        self.assertEqual(spots["hotspots"][0]["rank"], 1)
        # The service reads the trend, and never says why.
        self.assertRegex(trend["test"]["reading"], r"^(Too few to tell|No clear change|.* This says the rate changed, not why\.$)")
        self.assertIn("cityChangePct", trend["totals"])

    async def test_passes_on_the_services_refusals_in_its_words(self):
        async with support.session() as session:
            tools = await self.tools(session)
            stops = await tools["route_stops"](route="52")
            buffered = await tools["buffer"](layer=stops["layer"]["id"], metres=100)
            with self.assertRaisesRegex(ValueError, r"^422 partial_year: 2026 is partial"):
                await tools["ksi_trend"](layer=buffered["layer"]["id"], to=2026)
            with self.assertRaisesRegex(ValueError, r"^422 not_polygons"):
                await tools["ksi_profile"](layer=stops["layer"]["id"])

    async def test_a_specialist_gets_the_ksi_tools_only_with_the_skill(self):
        def respond(request):
            if request.turn == 0:
                return reply(("route_shape", {"route": "25"}))
            return reply(text="Saved the 25's shape (ttc-gtfs).")

        with_skill = FakeGemini(respond)
        async with support.session() as session:
            await specialists.run_specialist(session, with_skill, self.study, "Audit the 25.", "Profile its KSI collisions.", skill="safety-audit")
        self.assertLessEqual(LAYERS | SAFETY, with_skill.requests[0].tools)
        self.assertIn("Skill safety-audit:", with_skill.requests[0].system)

        without = FakeGemini(lambda request: reply(("ksi_profile", {"layer": "x"})) if request.turn == 0 else reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, without, self.study, "Audit the 25.", "Profile its KSI collisions.")
        self.assertFalse(SAFETY & without.requests[0].tools)
        self.assertEqual(without.requests[1].results, [("ksi_profile", {"error": "You have no tool named ksi_profile."})])


if __name__ == "__main__":
    unittest.main()
