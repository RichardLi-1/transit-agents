"""The active-transportation skill: its tools make a layer as gis-analyst does, then
call the service's cycling network, sidewalks, bike share and first and last mile for
the specialist's own study, and only a specialist with the skill gets them."""

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


def active_transportation():
    """The active-transportation skill's tools.py, as a module."""
    spec = importlib.util.spec_from_file_location("active_transportation_tools", skills.SKILLS_DIR / "active-transportation" / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LAYERS = {"list_datasets", "list_layers", "summarise_layer", "route_stops", "route_shape", "study_line", "named_area", "buffer"}
ACTIVE = {"cycling_within", "sidewalks_within", "bike_share_within", "first_last_mile"}


class ArgumentsTest(unittest.TestCase):
    def setUp(self):
        self.script = active_transportation()

    def test_offers_the_layer_tools_and_its_own_and_no_others(self):
        self.assertEqual(set(self.script.SPECS), LAYERS | ACTIVE)
        for name in ACTIVE:
            self.assertNotIn("studyId", self.script.parameters(name)["properties"], name)
        self.assertEqual(self.script.parameters("first_last_mile")["required"], ["layer", "metres"])

    def test_refuses_inputs_a_tool_doesnt_take_and_names_what_it_needs(self):
        self.assertEqual(self.script.arguments("cycling_within", "s", {"layer": "a"}), {"studyId": "s", "layer": "a"})
        with self.assertRaisesRegex(ValueError, "^first_last_mile needs metres."):
            self.script.arguments("first_last_mile", "s", {"layer": "a"})
        with self.assertRaisesRegex(ValueError, "^Unknown inputs: riders. sidewalks_within takes: layer, id, title."):
            self.script.arguments("sidewalks_within", "s", {"layer": "a", "riders": True})


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    """The skill's tools on the real service, with its committed datasets."""

    def setUp(self):
        self.study = f"active-{uuid.uuid4().hex[:6]}"
        support.api("POST", "/v1/studies", {"id": self.study, "title": "Active"}, token=AGENT)
        env = {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))

    async def tools(self, session):
        return {tool.name: tool.function for tool in skills.skill_tools(skills.load_skill("active-transportation"), session, self.study)}

    async def test_measures_walking_and_cycling_near_a_routes_stops(self):
        async with support.session() as session:
            tools = await self.tools(session)
            stops = await tools["route_stops"](route="25")
            area = await tools["buffer"](layer=stops["layer"]["id"], metres=400)
            cycling = await tools["cycling_within"](layer=area["layer"]["id"])
            sidewalks = await tools["sidewalks_within"](layer=area["layer"]["id"])
            share = await tools["bike_share_within"](layer=area["layer"]["id"])
            mile = await tools["first_last_mile"](layer=stops["layer"]["id"], metres=400)

        self.assertEqual(cycling["layer"]["dataset"]["id"], "toronto-cycling-network")
        self.assertGreater(cycling["totals"]["bikewayKm"]["value"], 0)
        self.assertTrue(any("2017" in w for w in sidewalks["warnings"]))
        self.assertEqual(share["layer"]["dataset"]["id"], "bike-share-toronto")
        self.assertEqual(mile["bikeShare"]["layer"]["dataset"]["id"], "bike-share-toronto")
        self.assertEqual(mile["bikeways"]["layer"]["dataset"]["id"], "toronto-cycling-network")
        figure = mile["bikeways"]["totals"]["stopsWithBikeway"]["figure"]
        study = support.api("GET", f"/v1/studies/{self.study}")
        [recorded] = [f for f in study["figures"] if f["id"] == figure]
        self.assertEqual(recorded["basis"]["total"], "stopsWithBikeway")

    async def test_passes_on_the_services_refusals_in_its_words(self):
        async with support.session() as session:
            tools = await self.tools(session)
            stops = await tools["route_stops"](route="52")
            with self.assertRaisesRegex(ValueError, r"^422 not_polygons"):
                await tools["cycling_within"](layer=stops["layer"]["id"])
            area = await tools["buffer"](layer=stops["layer"]["id"], metres=200)
            with self.assertRaisesRegex(ValueError, r"^422 not_points"):
                await tools["first_last_mile"](layer=area["layer"]["id"], metres=400)

    async def test_a_specialist_gets_the_tools_only_with_the_skill(self):
        with_skill = FakeGemini(lambda request: reply(text="Nothing measured.") if request.turn else reply(("list_datasets", {})))
        async with support.session() as session:
            await specialists.run_specialist(session, with_skill, self.study, "Bikeways near the 25?", "Measure them.", skill="active-transportation")
        self.assertLessEqual(LAYERS | ACTIVE, with_skill.requests[0].tools)
        [(_, response)] = with_skill.requests[1].results
        self.assertIn("toronto-sidewalks", [d["id"] for d in response["output"]["datasets"]])

        without = FakeGemini(lambda request: reply(("cycling_within", {"layer": "x"})) if request.turn == 0 else reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, without, self.study, "Bikeways near the 25?", "Measure them.")
        self.assertFalse(ACTIVE & without.requests[0].tools)


if __name__ == "__main__":
    unittest.main()
