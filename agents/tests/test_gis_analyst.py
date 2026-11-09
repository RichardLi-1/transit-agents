"""The gis-analyst skill: its tools call the service's GIS operations for the
specialist's own study, and only a specialist with the skill gets them. The service
saves each result as a layer, and records its totals as figures that cite the dataset."""

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


def gis_analyst():
    """The gis-analyst skill's tools.py, as a module."""
    spec = importlib.util.spec_from_file_location("gis_analyst_tools", skills.SKILLS_DIR / "gis-analyst" / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The service's GIS tools, which only this skill gives a specialist.
GIS = {"list_datasets", "list_layers", "summarise_layer", "route_stops", "route_shape", "study_line", "named_area", "buffer", "overlay", "points_within"}


class ArgumentsTest(unittest.TestCase):
    def setUp(self):
        self.script = gis_analyst()

    def test_each_tool_works_in_the_runs_own_study(self):
        self.assertEqual(self.script.arguments("buffer", "s", {"layer": "a", "metres": 400}), {"studyId": "s", "layer": "a", "metres": 400})
        self.assertEqual(self.script.arguments("buffer", "s", {"layer": "a", "metres": 400, "studyId": "s"})["studyId"], "s")
        with self.assertRaisesRegex(ValueError, "this run works only on study s, so studyId must be 's'"):
            self.script.arguments("buffer", "s", {"layer": "a", "metres": 400, "studyId": "other"})

    def test_list_datasets_names_no_study(self):
        self.assertEqual(self.script.arguments("list_datasets", "s", {}), {})

    def test_refuses_inputs_a_tool_doesnt_take_and_names_what_it_needs(self):
        with self.assertRaisesRegex(ValueError, "^Unknown inputs: radius. buffer takes: layer, metres, id, title."):
            self.script.arguments("buffer", "s", {"layer": "a", "radius": 400})
        with self.assertRaisesRegex(ValueError, "^overlay needs dataset."):
            self.script.arguments("overlay", "s", {"layer": "a"})

    def test_leaves_out_inputs_given_as_nothing(self):
        self.assertEqual(self.script.arguments("points_within", "s", {"layer": "a", "dataset": "toronto-ksi", "from": None}), {"studyId": "s", "layer": "a", "dataset": "toronto-ksi"})

    def test_offers_the_service_s_gis_tools_and_no_others(self):
        self.assertEqual(set(self.script.SPECS), GIS)
        for name in GIS:
            schema = self.script.parameters(name)
            self.assertNotIn("studyId", schema["properties"], name)
            self.assertLessEqual(set(schema.get("required", [])), set(schema["properties"]), name)


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    """The skill's tools on the real service, with its committed datasets."""

    def setUp(self):
        self.study = f"gis-{uuid.uuid4().hex[:6]}"
        support.api("POST", "/v1/studies", {"id": self.study, "title": "GIS"}, token=AGENT)
        env = {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""}
        self.enterContext(mock.patch.dict(os.environ, env))

    async def tools(self, session):
        return {tool.name: tool.function for tool in skills.skill_tools(skills.load_skill("gis-analyst"), session, self.study)}

    async def test_buffers_a_routes_stops_and_totals_the_census_with_figures_that_cite_it(self):
        async with support.session() as session:
            tools = await self.tools(session)
            stops = await tools["route_stops"](route="52")
            buffered = await tools["buffer"](layer=stops["layer"]["id"], metres=400)
            census = await tools["overlay"](layer=buffered["layer"]["id"], dataset="census-da-2021", variables=["population", "lowIncome"])

        self.assertEqual(stops["layer"]["kind"], "points")
        self.assertEqual(buffered["layer"]["derivedFrom"], ["ttc-52-stops"])
        self.assertIn("spread evenly", census["method"])
        [outside] = [warning for warning in census["warnings"] if "outside the census areas" in warning]
        self.assertIn("these totals are for the part inside Toronto only", outside)
        figure = census["totals"]["population"]["figure"]
        study = support.api("GET", f"/v1/studies/{self.study}")
        [recorded] = [f for f in study["figures"] if f["id"] == figure]
        self.assertEqual(recorded["basis"], {"kind": "spatial", "layer": census["layer"]["id"], "total": "population"})
        self.assertEqual(recorded["value"], census["totals"]["population"]["value"])
        trace = support.api("GET", f"/v1/studies/{self.study}/figures/{figure}/trace")
        self.assertEqual(trace["layer"]["dataset"]["publisher"], "Statistics Canada")
        layers = support.api("GET", f"/v1/studies/{self.study}/layers")["layers"]
        self.assertEqual([layer["id"] for layer in layers], ["ttc-52-stops", "ttc-52-stops-400m", "ttc-52-stops-400m-census"])
        added = [a["layerId"] for a in support.activities(self.study, "layer.added")]
        self.assertEqual(added, [layer["id"] for layer in layers])

    async def test_passes_on_the_services_refusals_in_its_words(self):
        async with support.session() as session:
            tools = await self.tools(session)
            with self.assertRaisesRegex(ValueError, r"^422 unknown_route: No TTC route \"9999\""):
                await tools["route_stops"](route="9999")
            stops = await tools["route_stops"](route="52")
            buffered = await tools["buffer"](layer=stops["layer"]["id"], metres=200)
            with self.assertRaisesRegex(ValueError, r"^422 outside_coverage: \"toronto-heritage-corridor\" covers the Don Mills corridor only"):
                await tools["points_within"](layer=buffered["layer"]["id"], dataset="toronto-heritage-corridor")
            with self.assertRaisesRegex(ValueError, "^422 unknown_variable"):
                await tools["overlay"](layer=buffered["layer"]["id"], dataset="census-da-2021", variables=["lowIncomeHouseholds"])

    async def test_a_specialist_gets_the_tools_only_with_the_skill(self):
        def respond(request):
            if request.turn == 0:
                return reply(("route_stops", {"route": "52"}), ("list_datasets", {}))
            return reply(text="Saved route 52's stops as a layer (ttc-gtfs).")

        with_skill = FakeGemini(respond)
        async with support.session() as session:
            await specialists.run_specialist(session, with_skill, self.study, "Map the 52's stops.", "Save them as a layer.", skill="gis-analyst")
        self.assertLessEqual(GIS, with_skill.requests[0].tools)
        self.assertIn("Skill gis-analyst:", with_skill.requests[0].system)
        saved, datasets = [response["output"] for _, response in with_skill.requests[1].results]
        self.assertEqual(saved["layer"]["id"], "ttc-52-stops")
        self.assertIn("census-da-2021", [d["id"] for d in datasets["datasets"]])

        without = FakeGemini(lambda request: reply(("route_stops", {"route": "52"})) if request.turn == 0 else reply(text="Done."))
        async with support.session() as session:
            await specialists.run_specialist(session, without, self.study, "Map the 52's stops.", "Save them as a layer.")
        self.assertFalse(GIS & without.requests[0].tools)
        self.assertEqual(without.requests[1].results, [("route_stops", {"error": "You have no tool named route_stops."})])


if __name__ == "__main__":
    unittest.main()
