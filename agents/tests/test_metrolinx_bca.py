"""The metrolinx-bca skill: its benefit-cost arithmetic, what it refuses, and every constant it cites, on its page."""

import json
import os
import re
import unittest
from unittest import mock

from mcp.types import CallToolResult, TextContent

import skills
import specialists
from tests import support
from tests.on_pages import citations, on_page, quotes, script, words_in_order
from tests.support import ROOT, FakeGemini, reply

SKILL = "metrolinx-bca"
OWN_WORDS = {"For a planner to decide:"}

# 60 years of 1 a year, from a year after the base year, at 3.5%: the annuity factor.
ANNUITY = (1 - 1.035**-60) / 0.035


def run(first, last, amount):
    return [{"from": first, "to": last, "amount": amount}]


# Built in 2021, the base year, at 50% design; 60 years of operation from 2022 to 2081.
# Its costs already include escalation, so they are used as given.
CASE = {
    "base_year": 2021,
    "opening_year": 2022,
    "design_completion": 50,
    "capital_costs": run(2021, 2021, 100),
    "operating_costs": run(2022, 2081, 1),
    "costs_escalated": True,
    "benefits": run(2022, 2081, 10),
}

# The same O&M of 1 a year from 2022 to 2081, grown 1% a year from the base year until
# 2051, 30 years on, and level after: the first 30 years are a geometric series at
# 1.01 / 1.035, and the last 30 an annuity of 1.01^30, 30 years out.
GROWN = 1.01 / 1.035
ANNUITY_30 = (1 - 1.035**-30) / 0.035
ESCALATED_OM = GROWN * (1 - GROWN**30) / (1 - GROWN) + GROWN**30 * ANNUITY_30


def setUpModule():
    support.service.start()


class AppraiseTest(unittest.TestCase):
    def setUp(self):
        self.tools = script(SKILL)
        self.appraise = self.tools.appraise

    def close(self, actual, expected):
        self.assertAlmostEqual(actual, expected, delta=0.006)

    def test_discounts_the_streams_to_an_npv_and_a_bcr(self):
        result = self.appraise(**CASE)
        self.assertTrue(result["computed"])
        self.assertEqual(result["years"], {"base": 2021, "opening": 2022, "last": 2081, "ofOperation": 60})
        values = result["presentValues"]
        self.close(values["benefits"], 10 * ANNUITY)
        self.close(values["capitalCostsWithoutOptimismBias"], 100)  # the base year isn't discounted
        self.close(values["capitalCosts"], 104)  # 4% at 31-100% design
        self.close(values["operatingCosts"], ANNUITY)
        self.close(values["costs"], 104 + ANNUITY)
        self.close(result["npv"], 10 * ANNUITY - 104 - ANNUITY)
        self.close(result["bcr"], 10 * ANNUITY / (104 + ANNUITY))
        self.close(result["npvPerCapitalCost"], (10 * ANNUITY - 104 - ANNUITY) / 104)
        self.close(result["withoutOptimismBias"]["bcr"], 10 * ANNUITY / (100 + ANNUITY))
        self.close(result["withoutOptimismBias"]["npv"], 10 * ANNUITY - 100 - ANNUITY)
        self.assertEqual(result["optimismBias"]["uplift"], 4)
        self.assertEqual(result["unit"], "$M, real 2021 dollars, discounted to 2021")
        self.assertEqual(result["notes"], [])
        self.assertFalse(result["costEscalation"]["applied"])

    def test_grows_costs_that_leave_escalation_out_by_1_percent_for_30_years(self):
        result = self.appraise(**{**CASE, "costs_escalated": False})
        self.assertAlmostEqual(ESCALATED_OM, 29.83, delta=0.005)  # from 24.94 as given
        values = result["presentValues"]
        self.close(values["operatingCosts"], ESCALATED_OM)
        self.close(values["capitalCosts"], 104)  # spent in the base year, before any growth
        self.close(values["benefits"], 10 * ANNUITY)  # benefits don't escalate
        self.close(result["npv"], 10 * ANNUITY - 104 - ESCALATED_OM)
        self.close(result["bcr"], 10 * ANNUITY / (104 + ESCALATED_OM))
        self.assertEqual(result["asReported"], {"npv": 120.0, "benefits": 250.0, "costs": 130.0, "bcr": 1.86})
        escalation = result["costEscalation"]
        self.assertTrue(escalation["applied"])
        self.assertIn("grow 1% a year in real terms from 2021 to 2051", escalation["rule"])
        quotes = [citation["quote"] for citation in escalation["citations"]]
        self.assertIn("Capital Cost Growth Rate 1% (real)", quotes)
        self.assertIn("Operating and Maintenance Cost Growth 1% Rate (real)", quotes)
        self.assertIn("Growth Cap 30 years from the base year of project evaluation", quotes)

        # Capital two years after the base year grows twice; any cost past 2051 grows 30 times.
        later = self.appraise(**{**CASE, "costs_escalated": False, "capital_costs": run(2023, 2023, 100) + run(2061, 2061, 100)})
        self.close(later["presentValues"]["capitalCostsWithoutOptimismBias"], 100 * 1.01**2 / 1.035**2 + 100 * 1.01**30 / 1.035**40)

    def test_needs_to_know_whether_costs_include_escalation(self):
        unsaid = self.appraise(**{**CASE, "costs_escalated": None})
        self.assertFalse(unsaid["computed"])
        [missing] = unsaid["missing"]
        self.assertTrue(missing.startswith("costs_escalated: whether the sources say the capital and operating costs already include escalation"))
        with self.assertRaisesRegex(ValueError, "costs_escalated must be true or false"):
            self.appraise(**{**CASE, "costs_escalated": "false"})

    def test_discounts_each_year_from_the_base_year(self):
        later = self.appraise(**{**CASE, "capital_costs": run(2023, 2023, 100), "operating_costs": run(2022, 2022, 0), "benefits": run(2081, 2081, 100)})
        self.close(later["presentValues"]["capitalCostsWithoutOptimismBias"], 100 / 1.035**2)
        self.close(later["presentValues"]["benefits"], 100 / 1.035**60)

    def test_reports_to_the_manuals_precision(self):
        reported = self.appraise(**CASE)["asReported"]
        self.assertEqual(reported, {"npv": 120.0, "benefits": 250.0, "costs": 130.0, "bcr": 1.93})
        two = self.tools.two_significant
        self.assertEqual((two(7526), two(-5.37), two(0.0), two(0.0456), two(125)), (7500.0, -5.4, 0.0, 0.046, 130.0))

    def test_optimism_bias_follows_the_level_of_design(self):
        for design, uplift in ((0, 64), (10, 64), (10.5, 18), (20, 18), (21, 9), (30, 9), (31, 4), (100, 4)):
            with self.subTest(design=design):
                result = self.appraise(**{**CASE, "design_completion": design, "contingency": "qcra"})
                self.assertEqual(result["optimismBias"]["uplift"], uplift)
                self.close(result["presentValues"]["capitalCosts"], 100 + uplift)

    def test_adjusts_the_initial_uplift_for_a_percent_contingency_for_a_planner_to_confirm(self):
        result = self.appraise(**{**CASE, "design_completion": 5, "contingency": "percent", "contingency_percent": 30, "capital_costs": run(2021, 2021, 130)})
        bias = result["optimismBias"]
        self.close(bias["uplift"], (1.64 / 1.30 - 1) * 100)
        self.close(result["presentValues"]["capitalCosts"], 164)  # contingency and uplift come to the published 64%
        self.assertIn("as printed it gives -20.73%", bias["toConfirm"])
        self.assertIn("A planner must confirm it", bias["toConfirm"])

        qcra = self.appraise(**{**CASE, "design_completion": 5, "contingency": "qcra"})
        self.close(qcra["presentValues"]["capitalCosts"], 164)
        self.assertNotIn("toConfirm", qcra["optimismBias"])

    def test_values_hours_saved_at_the_value_of_time_in_2021_dollars(self):
        result = self.appraise(**{**CASE, "benefits": None, "hours_saved": run(2022, 2022, 1_000_000)})
        self.close(result["presentValues"]["timeSavings"], 18.79 / 1.035)
        self.close(result["presentValues"]["userAndExternalImpacts"], 18.79 / 1.035)

        rebased = self.appraise(**{**CASE, "base_year": 2019, "capital_costs": run(2019, 2019, 100), "benefits": None, "hours_saved": run(2022, 2022, 1)})
        self.assertFalse(rebased["computed"])
        [missing] = rebased["missing"]
        self.assertIn("a value of time in 2019 dollars", missing)
        self.assertIn("price index the sources don't give", missing)

    def test_names_every_missing_input_and_computes_nothing(self):
        result = self.appraise(base_year=2021)
        self.assertFalse(result["computed"])
        self.assertEqual(
            [item.split(":")[0] for item in result["missing"]],
            ["opening_year", "capital_costs", "operating_costs", "costs_escalated", "benefits or hours_saved", "design_completion"],
        )
        self.assertNotIn("npv", result)
        self.assertNotIn("bcr", result)
        self.assertEqual(self.appraise(**{**CASE, "operating_costs": []})["missing"][0].split(":")[0], "operating_costs")

    def test_needs_the_contingency_at_initial_design(self):
        unsaid = self.appraise(**{**CASE, "design_completion": 8})
        self.assertEqual([item.split(":")[0] for item in unsaid["missing"]], ["contingency"])
        no_percent = self.appraise(**{**CASE, "design_completion": 8, "contingency": "percent"})
        self.assertEqual([item.split(":")[0] for item in no_percent["missing"]], ["contingency_percent"])

    def test_gives_all_loss_or_all_gain_instead_of_a_negative_ratio(self):
        loss = self.appraise(**{**CASE, "benefits": run(2022, 2081, -10)})
        self.assertIsNone(loss["bcr"])
        self.close(loss["allLoss"], 10 * ANNUITY / (104 + ANNUITY))

        gain = self.appraise(**{**CASE, "operating_costs": run(2022, 2081, -10)})  # the project saves more than it costs
        self.assertIsNone(gain["bcr"])
        self.close(gain["allGain"], 10 * ANNUITY / (10 * ANNUITY - 104))

    def test_gives_the_expanded_results_with_wider_impacts(self):
        result = self.appraise(**{**CASE, "wider_impacts": run(2022, 2081, 5)})
        self.close(result["presentValues"]["widerImpacts"], 5 * ANNUITY)
        self.close(result["expanded"]["npv"], 15 * ANNUITY - 104 - ANNUITY)
        self.close(result["expanded"]["bcr"], 15 * ANNUITY / (104 + ANNUITY))
        self.close(result["bcr"], 10 * ANNUITY / (104 + ANNUITY))  # the conventional ratio leaves them out
        self.assertNotIn("expanded", self.appraise(**CASE))

    def test_adds_up_overlapping_runs_of_years(self):
        result = self.appraise(**{**CASE, "capital_costs": run(2021, 2021, 60) + run(2021, 2021, 40)})
        self.close(result["presentValues"]["capitalCostsWithoutOptimismBias"], 100)

    def test_notes_scale_and_streams_that_stop_or_keep_growing(self):
        large = self.appraise(**{**CASE, "capital_costs": run(2021, 2021, 600)})
        self.assertIn("large scale, over $500M", large["notes"][0])
        small = self.appraise(**{**CASE, "capital_costs": run(2021, 2021, 10)})
        self.assertIn("small scale, under $50M", small["notes"][0])

        growing = self.appraise(**{**CASE, "benefits": run(2022, 2051, 10) + run(2052, 2081, 20)})
        self.assertIn("benefits still grow after 2051, 30 years from the base year", growing["notes"][0])
        stopping = self.appraise(**{**CASE, "benefits": run(2022, 2030, 10)})
        self.assertIn("benefits stop after 2030, though the appraisal runs to 2081", stopping["notes"][0])

    def test_refuses_years_outside_the_appraisal(self):
        with self.assertRaisesRegex(ValueError, "2020 is before the base year, 2021.*sunk"):
            self.appraise(**{**CASE, "capital_costs": run(2020, 2021, 50)})
        with self.assertRaisesRegex(ValueError, "2082 is after 2081, the 60th year of operation"):
            self.appraise(**{**CASE, "benefits": run(2022, 2082, 10)})
        with self.assertRaisesRegex(ValueError, "runs backwards"):
            self.appraise(**{**CASE, "benefits": run(2030, 2022, 10)})
        with self.assertRaisesRegex(ValueError, "opening_year, 2020, is before base_year, 2021"):
            self.appraise(**{**CASE, "opening_year": 2020})

    def test_refuses_to_take_the_manuals_values_as_inputs(self):
        with self.assertRaisesRegex(ValueError, "Unknown inputs: discount_rate.*can't be set here"):
            self.appraise(**CASE, discount_rate=5)
        with self.assertRaisesRegex(ValueError, "design_completion is a percent"):
            self.appraise(**{**CASE, "design_completion": 150})
        with self.assertRaisesRegex(ValueError, "base_year must be a whole number"):
            self.appraise(**{**CASE, "base_year": 2021.5})

    def test_takes_whole_numbers_sent_as_floats(self):
        result = self.appraise(**{**CASE, "base_year": 2021.0, "capital_costs": [{"from": 2021.0, "to": 2021.0, "amount": 100}]})
        self.assertTrue(result["computed"])

    def test_its_values_are_the_rules_the_service_seeds(self):
        seed = (ROOT / "clients" / "seed-ontario.ts").read_text()
        for key, value in self.tools.RULES.items():
            with self.subTest(key):
                seeded = re.search(rf'key: "{re.escape(key)}",.*?value: ([\d.]+),', seed, re.S)
                self.assertIsNotNone(seeded)
                self.assertEqual(float(seeded[1]), value)


class FakeSession:
    """Answers list_rules with the given rules, as the service does."""

    def __init__(self, rules):
        self.rules = rules
        self.calls = []

    async def call_tool(self, name, arguments):
        self.calls.append(name)
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(self.rules))])


def rule(key, value, unit):
    return {"key": key, "value": value, "unit": unit, "label": key, "reason": "Published standard"}


SEEDED = [
    rule("metrolinx.discount-rate", 3.5, "%"),
    rule("metrolinx.evaluation-period", 60, "years"),
    rule("metrolinx.value-of-time", 18.79, "$/hour (2021$)"),
    rule("metrolinx.optimism-bias-ibc", 64, "%"),
    rule("ttc.min-riders-per-100", 11, "riders"),
]


class RulesTest(unittest.IsolatedAsyncioTestCase):
    async def bca(self, rules, **arguments):
        session = FakeSession(rules)
        [tool] = skills.skill_tools(skills.load_skill(SKILL), session, "study")
        self.assertEqual(tool.name, "metrolinx_bca")
        result = await tool.function(**arguments)
        self.assertEqual(session.calls, ["list_rules"])
        return result

    async def test_computes_with_the_rules_planners_set(self):
        result = await self.bca(SEEDED, **CASE)
        self.assertTrue(result["computed"])
        self.assertAlmostEqual(result["bcr"], 1.93)

    async def test_computes_nothing_while_a_rule_differs_from_the_manual(self):
        rules = [*SEEDED[1:], rule("metrolinx.discount-rate", 4, "%")]
        result = await self.bca(rules, **CASE)
        self.assertFalse(result["computed"])
        self.assertEqual(result["rulesDiffer"], ["metrolinx.discount-rate is 4 %; the manual's is 3.5"])
        self.assertIn("A planner must confirm which applies", result["note"])
        self.assertNotIn("npv", result)


class CitationsTest(unittest.TestCase):
    def test_every_constant_is_cited_on_its_page(self):
        found = citations({name: value for name, value in vars(script(SKILL)).items() if name.isupper()})
        self.assertGreater(len(found), 25)
        for citation in found:
            with self.subTest(quote=citation["quote"], page=citation["page"]):
                self.assertTrue(on_page(citation["source"], [citation["page"]], citation["quote"]), "word for word")
                if "row" in citation:
                    self.assertTrue(words_in_order(citation["source"], citation["page"], citation["row"]), "the row's words, in order")

    def test_the_tool_says_to_cite_a_constants_quote_never_its_row(self):
        # A row's words don't run on its page, so the service refuses them as a quote.
        self.assertIn("use its quote, which is word for word on its page, never its row", script(SKILL).DESCRIPTION)

    def test_each_parameter_names_its_page(self):
        for name, parameter in script(SKILL).PARAMETERS_CITED.items():
            with self.subTest(name):
                self.assertTrue(parameter["citations"])

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
        self.study = support.open_study("bca")
        self.enterContext(
            mock.patch.dict(os.environ, {"SPECIALIST_MODEL": "specialist-model", "SPECIALIST_CONCURRENCY": "2", "MAX_MODEL_CALLS": ""})
        )

    async def test_a_specialist_with_the_skill_gets_what_is_missing(self):
        def respond(request):
            if request.turn == 0:
                return reply(("metrolinx_bca", {"base_year": 2019, "opening_year": 2031}))
            return reply(text="No BCR: the sources give no benefits or costs for the extension.")

        fake = FakeGemini(respond)
        async with support.session() as session:
            await specialists.run_specialist(session, fake, self.study, "What is the extension's benefit-cost ratio?", skill=SKILL)

        self.assertIn(f"Skill {SKILL}:", fake.requests[0].system)
        self.assertIn("metrolinx_bca", fake.requests[0].tools)
        [(name, response)] = fake.requests[1].results
        self.assertEqual(name, "metrolinx_bca")
        self.assertFalse(response["output"]["computed"])
        self.assertIn("capital_costs", " ".join(response["output"]["missing"]))


if __name__ == "__main__":
    unittest.main()
