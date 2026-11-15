"""The business-case-template skill: every quote and table cell it lays out, on its page."""

import unittest

import skills
import specialists
from tests.on_pages import on_page, quotes, words_in_order
from tests.test_skills import normalize

SKILL = "business-case-template"
MANUAL = "metrolinx-bcm-vol2"

# Words the skill gives from tables, or columns, the page prints side by side, so they
# don't run on: Table 1.2's cells (p. 29), and each case's sections.
CELLS = {
    15: ["A business case should include eight chapters"],
    27: ["100% (investment has been delivered)"],
    29: [
        "Define a core problem and/or opportunity to be addressed by transportation investment, the types of benefits this investment can realize, and a range of potential solutions",
        "Update as required.",
        "Update as required and compare existing conditions to those forecasted in previous stages of the business case.",
        "Define a set of investment options based on variations of the preferred option in the strategic business case.",
        "Define specific refinements of the investment selected in the Initial Business Case.",
        "Define a single option that is proposed for delivery.",
        "Outline any differences between 'as built' and what was proposed in the Full Business Case.",
        "Detailed review of the strategic benefits of addressing a the problem with a proposed investment",
        "Update based on how changes/refinements to the option may alter performance. Note where performance increases or decreases and why. Update based on changes to base case, risks to achieving strategic performance, or other project shaping factors.",
        "Review annual and to date performance against strategic objectives to determine how accurate the business case was and what could be done to improve performance. Data collection should be used where possible.",
        "Appraisal of each option including, at a minimum: costs, user, external, and some wider benefits (as relevant).",
        "Update based on changes to option specification (runtimes, frequencies, reliability, costs). Note where performance increases or decreases and why. Update based on changes to base case, risks to project achieving economic performance, or other project shaping factors.",
        "Review annual and to date performance against proxy indicators for economic benefits/costs to determine how accurate the business case analysis was and what could be done to improve performance. Data collection should be used where possible.",
        "Appraisal of each option including, at a minimum: costs, direct revenue impacts, and indirect financial/revenue impacts.",
        "Update based on changes to option specification and emergent risks. Review range of financing approaches and their impact.",
        "Update based on changes to option specification and risks, and define financing approach.",
        "Review actual costs to deliver annual and to-date performance for all key financial metrics. Review benefits of selected financing program.",
        "High-level appraisal of risks and implementation requirements.",
        "Detailed review of specific delivery requirements and risks. Review of different procurement programs and their benefits/risks.",
        "Update risks based on option specification. Detail final delivery approach, risk management plan, and benefits realization plan.",
        "Review risk management, governance structure, and benefits realization plan.",
    ],
    30: ["All projects require a Post In-Service Business Case (PIBC) to be completed within two years from the time the project is operational"],
    79: [
        "Strategic Evaluation by Outcome Area",
        "one subsection per outcome",
        "Strategic Evaluation Summary",
        "Option Comparison (Initial Business Case and Preliminary Design Business Case only)",
        "Risks and Uncertainty",
        "Recommendations",
    ],
    110: [
        "Capital Costs",
        "Operating Costs",
        "User Impacts by Mode",
        "Wellbeing Impacts",
        "Environmental Impacts",
        "Wider Economic Impacts",
        "Productivity",
        "Imperfect Competition",
        "Labour Markets",
        "Land Value and Development",
        "Economic Analysis Summary",
        "Economic Appraisal Summary",
    ],
    184: [
        "Operating and Maintenance Costs",
        "Revenue Impacts",
        "Fare Revenue",
        "Non-Fare Revenue",
        "Labour Force Requirements",
        "Funding Sources",
        "Financial Analysis Summary",
        "Financial Impact Summary",
        "Funding Sources and Risks",
    ],
    200: [
        "Project Delivery",
        "Operations and Maintenance Plan",
        "Procurement Plan",
        "Deliverability and Operations Case Conclusion",
        "Risk Review",
    ],
    217: [
        "Each business case should prepare a concise executive summary that is placed prior to the Introduction Chapter",
        "Summary chapters do not need to identify a single preferred option",
    ],
}

STAGES = ["Initial Business Case:", "Preliminary Design Business Case:", "Full Business Case:", "Post In-Service Business Case:"]
PARTS = ["Context:", "Investment Options:", "Strategic Case", "Economic Case", "Financial Case:", "Deliverability and Operations:"]


class TemplateTest(unittest.TestCase):
    def setUp(self):
        self.skill = skills.load_skill(SKILL)

    def test_every_quote_is_on_its_page(self):
        found = quotes(self.skill.body)
        self.assertGreaterEqual(len(found), 4)
        for quote, source, pages in found:
            with self.subTest(quote=quote):
                self.assertIsNotNone(source, "cite the page after the quote, on its line")
                self.assertTrue(on_page(source, pages, quote))

    def test_every_table_cell_is_the_tables_own_words(self):
        body = normalize(self.skill.body)
        for page, cells in CELLS.items():
            for cell in cells:
                with self.subTest(page=page, cell=cell):
                    self.assertIn(normalize(cell), body, "the skill gives it word for word")
                    self.assertTrue(words_in_order(MANUAL, page, cell), "its words are on the page, in order")
                    self.assertIn(f"{MANUAL} p. {page}", self.skill.body, "the skill cites its page")

    def test_lays_out_each_part_at_each_stage(self):
        body = self.skill.body
        starts = [body.index(stage) for stage in STAGES]
        self.assertEqual(starts, sorted(starts))
        for stage, start, end in zip(STAGES, starts, starts[1:] + [body.index("## Each case's sections")], strict=True):
            for part in PARTS:
                with self.subTest(stage=stage, part=part):
                    self.assertIn(part, body[start:end])

    def test_fills_in_nothing_itself(self):
        self.assertEqual(specialists.script_tools(self.skill, "session", "study"), [])
        self.assertIn(SKILL, {skill["name"] for skill in skills.list_skills()})


if __name__ == "__main__":
    unittest.main()
