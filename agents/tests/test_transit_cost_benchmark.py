"""The transit-cost-benchmark skill: its comparables are what the business case
prints, and the service takes each quote the skill tells agents to record with."""

import json
import unittest
import uuid

import core
from tests import support
from tests.support import INTEGRATION, ROOT
from tests.test_skills import SOURCES, normalize


def setUpModule():
    support.service.start()


IBC = "ontario-line-ibc-2019"


class ComparablesTest(unittest.TestCase):
    def test_each_range_runs_from_the_median_to_the_high_estimate(self):
        # Table 30's totals, median then high for each line, over Table 31's lengths.
        page = normalize(SOURCES[IBC][77])
        self.assertIn(normalize("Total Capital Costs $6,241 M $7,489 M $9,504 M $11,405 M"), page)
        self.assertIn(normalize("Median Estimate High Estimate Median Estimate High Estimate"), page)
        for total, length, per_km in [(6241, 7.5, 832), (7489, 7.5, 999), (9504, 15.5, 613), (11405, 15.5, 735)]:
            with self.subTest(total=total):
                self.assertLess(abs(total / length - per_km), 1)


class RecordingTest(unittest.IsolatedAsyncioTestCase):
    """The skill's quotes for Table 31, recorded as an agent records them, with the business case's pages."""

    def setUp(self):
        # A source of its own, so no other test sees it: the page with Table 31 and the one after it.
        self.source = f"ibc-{uuid.uuid4().hex[:6]}"
        pages = [page for page in json.loads((ROOT / "clients" / "fixtures" / f"{IBC}.pages.json").read_text()) if page["page"] in (77, 78)]
        support.api("POST", "/v1/context", {"id": self.source, "title": "Ontario Line IBC", "pages": pages}, token=INTEGRATION)
        self.study = support.open_study("cost")

    async def record(self, id, value, quote):
        citation = {"contextId": self.source, "page": 77, "quote": quote}
        figure = {"studyId": self.study, "id": id, "label": id, "unit": "$M/km", "value": value, "basis": {"kind": "cited", "citation": citation}}
        async with support.session() as session:
            return await core.call(session, "record_figure", figure)

    async def test_the_service_takes_each_quote_the_skill_gives(self):
        for id, value, quote in [
            ("rls-cost-per-km", 832, "Cost per km $832 M"),
            ("ol-cost-per-km", 613, "Cost per km $832 M to $999 M $613 M"),
            ("ol-length", 15.5, "Length (km) 7.5 15.5"),
        ]:
            with self.subTest(id):
                self.assertEqual((await self.record(id, value, quote))["value"], value)

    async def test_a_row_quoted_with_cells_skipped_isnt_on_the_page(self):
        with self.assertRaisesRegex(core.ToolError, "^record_figure: 422 quote_not_found"):
            await self.record("ol-cost-per-km", 613, "Cost per km $613 M")


if __name__ == "__main__":
    unittest.main()
