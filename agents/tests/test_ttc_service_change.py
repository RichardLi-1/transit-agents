"""The ttc-service-change skill: its classifier, and every rule it cites, on its page."""

import asyncio
import os
import unittest
from unittest import mock

import skills
import specialists
from tests import support
from tests.on_pages import citations, on_page, quotes, script, words_in_order
from tests.support import ROOT, FakeGemini, reply

SKILL = "ttc-service-change"
# Words a skill puts in quotes that aren't from a source: the hand-over line.
OWN_WORDS = {"For a planner to decide:"}


def setUpModule():
    support.service.start()


class ClassifyTest(unittest.TestCase):
    def setUp(self):
        self.tools = script(SKILL)
        self.classify = self.tools.classify

    def rules(self, result):
        return [reason["rule"] for reason in result["because"]]

    def steps(self, result):
        return " ".join(step["step"] for step in result["steps"])

    def test_a_major_kind_makes_it_major_and_needs_the_board(self):
        for kind in ("new-route", "route-extension", "added-period", "restructure", "route-onto-new-road", "route-off-only-service", "period-removed-only-option"):
            with self.subTest(kind):
                result = self.classify([kind])
                self.assertEqual(result["class"], "major")
                self.assertEqual(result["because"][0]["change"], kind)
                self.assertEqual(result["because"][0]["rule"]["page"], 22)
                self.assertIn("TTC Board approval", self.steps(result))
                self.assertIn("trial of at least twelve months", self.steps(result))
                self.assertNotIn("missing", result)

    def test_resources_dont_matter_once_a_part_is_major(self):
        result = self.classify(["service-level", "route-extension"], existing_equipment=True, within_budget=True)
        self.assertEqual(result["class"], "major")
        self.assertEqual([reason["change"] for reason in result["because"]], ["route-extension"])

    def test_minor_needs_existing_equipment_and_the_adopted_budget(self):
        result = self.classify(["reliability-schedule"])
        self.assertIsNone(result["class"])
        self.assertNotIn("steps", result)
        [missing] = result["missing"]
        self.assertTrue(missing.startswith("existing_equipment and within_budget"))

        result = self.classify(["reliability-schedule", "seasonal"], existing_equipment=True, within_budget=True)
        self.assertEqual(result["class"], "minor")
        self.assertEqual([reason["change"] for reason in result["because"]], ["reliability-schedule", "seasonal", "resources"])
        self.assertIn("within the adopted budget", result["because"][-1]["rule"]["row"])
        self.assertIn("Board Period", self.steps(result))
        self.assertNotIn("TTC Board approval", self.steps(result))

    def test_needing_more_resources_goes_to_a_planner(self):
        # The standards don't settle it: p. 22's text gives a change needing more resources a
        # more rigorous review, Table 7's major column is a significant effect on resources,
        # and p. 29 has minor changes wait on operating resources in the budget.
        for equipment, budget in ((True, False), (False, True), (False, None)):
            with self.subTest(existing_equipment=equipment, within_budget=budget):
                result = self.classify(["service-level"], existing_equipment=equipment, within_budget=budget)
                self.assertIsNone(result["class"])
                self.assertNotIn("steps", result)
                self.assertNotIn("missing", result)
                self.assertEqual([reason["change"] for reason in result["because"]], ["service-level"])
                self.assertIn("the standards don't settle whether that makes it major", result["forPlanner"])
                self.assertTrue(result["forPlanner"].endswith("A planner must classify it."))
                substantial, significant, budgeted = result["forPlannerCitations"]
                self.assertIn("requiring additional resources for operation", substantial["quote"])
                self.assertIn("significant effect on resources", significant["row"])
                self.assertEqual(budgeted["page"], 29)
                self.assertIn("subject to the availability of operating resources in the budget", budgeted["quote"])
                self.assertIn("give significant_resource_effect", result["note"])

        span = self.classify(["span"], span_minutes=30, existing_equipment=False, within_budget=True)
        self.assertIsNone(span["class"])
        self.assertIn("A planner must classify it", span["forPlanner"])

        unlisted = self.classify(["other"], existing_equipment=True, within_budget=False)
        self.assertTrue(unlisted["forPlanner"].startswith("Table 7 doesn't classify a change Table 7 doesn't list. It needs more"))

    def test_a_significant_effect_on_resources_makes_it_major(self):
        for equipment, budget in ((True, False), (None, None), (True, True)):
            with self.subTest(existing_equipment=equipment, within_budget=budget):
                result = self.classify(
                    ["service-level"], existing_equipment=equipment, within_budget=budget, significant_resource_effect=True
                )
                self.assertEqual(result["class"], "major")
                [reason] = result["because"]
                self.assertEqual(reason["change"], "resources")
                self.assertIn("significant effect on resources", reason["rule"]["row"])
                self.assertIn("requiring additional resources for operation", reason["alsoSee"]["quote"])
                self.assertIn("TTC Board approval", self.steps(result))
        not_significant = self.classify(["service-level"], existing_equipment=True, within_budget=True, significant_resource_effect=False)
        self.assertEqual(not_significant["class"], "minor")
        self.assertIsNone(self.classify(["service-level"], existing_equipment=False, significant_resource_effect=False)["class"])

    def test_a_span_change_is_minor_within_90_minutes(self):
        self.assertEqual(self.classify(["span"], span_minutes=90, existing_equipment=True, within_budget=True)["class"], "minor")

        longer = self.classify(["span"], span_minutes=120, existing_equipment=True, within_budget=True)
        self.assertIsNone(longer["class"])
        self.assertIn("a span change of 120 minutes", longer["forPlanner"])
        self.assertNotIn("missing", longer)

        unsaid = self.classify(["span"])
        self.assertIsNone(unsaid["class"])
        self.assertEqual([item.split(":")[0] for item in unsaid["missing"]], ["span_minutes", "existing_equipment and within_budget"])

    def test_a_change_table_7_doesnt_list_goes_to_a_planner(self):
        result = self.classify(["other"])
        self.assertIsNone(result["class"])
        self.assertIn("A planner must classify it", result["forPlanner"])
        self.assertNotIn("missing", result)

        with_a_major_part = self.classify(["other", "new-route"])
        self.assertEqual(with_a_major_part["class"], "major")
        self.assertIn("its major parts make it major", with_a_major_part["note"])

    def test_nothing_given_is_missing_not_minor(self):
        result = self.classify()
        self.assertIsNone(result["class"])
        self.assertEqual(result["missing"], ["changes: what kinds of change the proposal makes"])

    def test_refuses_what_it_doesnt_know(self):
        with self.assertRaisesRegex(ValueError, "Unknown kinds of change: bus-lane"):
            self.classify(["bus-lane"])
        with self.assertRaisesRegex(ValueError, "Unknown inputs: magnitude"):
            self.classify(["new-route"], magnitude="minor")
        with self.assertRaisesRegex(ValueError, "span_minutes"):
            self.classify(["span"], span_minutes=-10)

    def test_refuses_inputs_of_the_wrong_type(self):
        # The text "false" would read as true, and minor needs both to be true.
        wrong = (
            {"existing_equipment": "false", "within_budget": True},
            {"existing_equipment": True, "within_budget": 0},
            {"existing_equipment": True, "within_budget": True, "significant_resource_effect": "yes"},
        )
        for flags in wrong:
            with self.subTest(**flags), self.assertRaisesRegex(ValueError, "must be true or false, or left out"):
                self.classify(["service-level"], **flags)
        for minutes in (True, float("nan"), float("inf"), "30"):
            with self.subTest(span_minutes=minutes), self.assertRaisesRegex(ValueError, "span_minutes must be a number of minutes"):
                self.classify(["span"], span_minutes=minutes, existing_equipment=True, within_budget=True)
        for changes in ("new-route", [["new-route"]]):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "changes must be a list of kinds of change"):
                self.classify(changes)

    def test_lists_the_conditions_on_a_kind_of_change(self):
        result = self.classify(["service-level"], existing_equipment=True, within_budget=True)
        conditions = " ".join(condition["quote"] for condition in result["conditions"])
        self.assertIn("consistently greater than 95% for a period of six months", conditions)
        self.assertIn("headway widening greater than 25%", conditions)
        self.assertNotIn("conditions", self.classify(["new-route"]))

    def test_every_step_is_cited(self):
        for step in self.tools.MINOR_STEPS + self.tools.MAJOR_STEPS:
            with self.subTest(step["step"]):
                self.assertTrue(step["citations"])

    def test_the_fare_test_names_the_planners_rule_not_its_value(self):
        # Planners may set the threshold to another value than the page's 11, so the step names the rule.
        step = self.tools.FARE_TEST["step"]
        self.assertNotIn("11", step)
        self.assertIn(f"the rule {self.tools.RIDERS_PER_100} from list_rules", step)
        seed = (ROOT / "clients" / "seed-data.ts").read_text()
        self.assertIn(f'key: "{self.tools.RIDERS_PER_100}"', seed)
        for steps in (self.tools.MINOR_STEPS, self.tools.MAJOR_STEPS):
            self.assertIn(self.tools.FARE_TEST, steps)

    def test_the_tool_offers_each_kind(self):
        [tool] = specialists.script_tools(skills.load_skill(SKILL), "session", "study")
        self.assertEqual(tool.name, "classify_service_change")
        self.assertEqual(tool.parameters["properties"]["changes"]["items"]["enum"], list(self.tools.KINDS))
        self.assertNotIn("required", tool.parameters)  # so a model never has to invent one
        self.assertEqual(asyncio.run(tool.function(changes=["new-route"]))["class"], "major")


class CitationsTest(unittest.TestCase):
    def test_every_citation_in_the_script_is_on_its_page(self):
        found = citations({name: value for name, value in vars(script(SKILL)).items() if name.isupper()})
        self.assertGreater(len(found), 25)
        for citation in found:
            with self.subTest(quote=citation["quote"], page=citation["page"]):
                self.assertTrue(on_page(citation["source"], [citation["page"]], citation["quote"]), "word for word")
                if "row" in citation:
                    self.assertTrue(words_in_order(citation["source"], citation["page"], citation["row"]), "the row's words, in order")

    def test_the_tool_says_to_cite_a_rules_quote_never_its_row(self):
        # A row's words don't run on its page, so the service refuses them as a quote.
        self.assertIn("use its quote, which is word for word on its page, never its row", script(SKILL).DESCRIPTION)

    def test_every_quote_in_the_skill_is_on_its_page(self):
        body = skills.load_skill(SKILL).body
        found = [found for found in quotes(body) if found[0] not in OWN_WORDS]
        self.assertGreater(len(found), 10)
        for quote, source, pages in found:
            with self.subTest(quote=quote):
                self.assertIsNotNone(source, "cite the page after the quote, on its line")
                self.assertTrue(on_page(source, pages, quote))

    def test_the_lead_can_pick_it(self):
        self.assertIn(SKILL, {skill["name"] for skill in skills.list_skills()})


class OnTheServiceTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.study = support.open_study("service-change")
        self.enterContext(
            mock.patch.dict(os.environ, {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""})
        )

    async def test_a_specialist_with_the_skill_classifies_with_it(self):
        def respond(request):
            if request.turn == 0:
                return reply(("classify_service_change", {"changes": ["route-extension"]}))
            return reply(text="Major: a route extension (ttc-standards-2024 p. 22).")

        fake = FakeGemini(respond)
        async with support.session() as session:
            await specialists.run_specialist(session, fake, self.study, "Is extending the 52 a major change?", skill=SKILL)

        self.assertIn(f"Skill {SKILL}:", fake.requests[0].system)
        self.assertIn("classify_service_change", fake.requests[0].tools)
        [(name, response)] = fake.requests[1].results
        self.assertEqual(name, "classify_service_change")
        self.assertEqual(response["output"]["class"], "major")


if __name__ == "__main__":
    unittest.main()
