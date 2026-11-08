import json
import re
import tempfile
import unicodedata
import unittest
from pathlib import Path

import skills
from tests.support import ROOT, SKILLS


class SkillsTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def write(self, folder: str, text: str) -> Path:
        path = self.root / folder / "SKILL.md"
        path.parent.mkdir()
        path.write_text(text)
        return path

    def test_lists_names_and_descriptions_only(self):
        self.assertEqual(
            skills.list_skills(SKILLS),
            [{"name": "quote-check", "description": "Check that a quote is on the page it cites, word for word."}],
        )

    def test_loads_a_skills_instructions(self):
        skill = skills.load_skill("quote-check", SKILLS)
        self.assertEqual(skill.name, "quote-check")
        self.assertTrue(skill.body.startswith("Read the cited page with read_page."))
        self.assertNotIn("---", skill.body)
        self.assertEqual(skill.folder, SKILLS / "quote-check")

    def test_an_unknown_skill_names_the_ones_there_are(self):
        with self.assertRaisesRegex(skills.SkillError, "No skill named 'nope'. Skills: quote-check."):
            skills.load_skill("nope", SKILLS)

    def test_a_skill_name_cant_leave_the_skills_folder(self):
        for name in ("../tests", "quote-check/../quote-check", "/etc", ""):
            with self.assertRaises(skills.SkillError):
                skills.load_skill(name, SKILLS)

    def test_no_skills_folder_means_no_skills(self):
        self.assertEqual(skills.list_skills(self.root / "missing"), [])
        with self.assertRaisesRegex(skills.SkillError, "Skills: none yet."):
            skills.load_skill("any", self.root / "missing")

    def test_reads_quoted_and_folded_frontmatter(self):
        self.write(
            "folded",
            '---\nname: "folded"\n# a comment\ndescription: >\n  Spread over\n  two lines.\n---\n\nDo the thing.\n',
        )
        self.assertEqual(skills.list_skills(self.root), [{"name": "folded", "description": "Spread over two lines."}])
        self.assertEqual(skills.load_skill("folded", self.root).body, "Do the thing.")

    def test_a_skill_without_scripts_gives_no_tools(self):
        self.assertEqual(skills.skill_tools(skills.load_skill("quote-check", SKILLS), "session", "study"), [])

    def test_a_skills_scripts_give_its_tools(self):
        path = self.write("counter", "---\nname: counter\ndescription: Count words.\n---\nCall count_words.\n")
        (path.parent / "tools.py").write_text(
            "from core import LocalTool\n\n"
            "def tools(session, study):\n"
            "    return [LocalTool('count_words', 'Count words.', lambda text='': [session, study, len(text.split())])]\n"
        )
        [tool] = skills.skill_tools(skills.load_skill("counter", self.root), "the-session", "the-study")
        self.assertEqual(tool.name, "count_words")
        self.assertEqual(tool.function(text="one two three"), ["the-session", "the-study", 3])

    def test_refuses_scripts_without_a_tools_function(self):
        path = self.write("no-tools", "---\nname: no-tools\ndescription: D\n---\nBody.\n")
        (path.parent / "tools.py").write_text("COUNT = 1\n")
        with self.assertRaisesRegex(skills.SkillError, r"define tools\(session, study\)"):
            skills.skill_tools(skills.load_skill("no-tools", self.root), "session", "study")

    def test_refuses_a_broken_skill(self):
        cases = {
            "no-frontmatter": ("Just text.", "start with frontmatter"),
            "unclosed": ("---\nname: unclosed\n", "close the frontmatter"),
            "wrong-name": ("---\nname: other\ndescription: D\n---\nBody.", "the folder is 'wrong-name'"),
            "no-description": ("---\nname: no-description\n---\nBody.", "give a description"),
            "no-body": ("---\nname: no-body\ndescription: D\n---\n", "write the instructions"),
            "not-key-value": ("---\nname: not-key-value\njust words\n---\nBody.", "key: value"),
        }
        for folder, (text, problem) in cases.items():
            with self.subTest(folder):
                with self.assertRaisesRegex(skills.SkillError, problem):
                    skills.read_skill(self.write(folder, text))


# The sources the skills cite, page by page, as the seed loads them.
SOURCES = {
    path.name.removesuffix(".pages.json"): {page["page"]: page["text"] for page in json.loads(path.read_text())}
    for path in (ROOT / "clients" / "fixtures").glob("*.pages.json")
}

# Words the skills quote from a source, and the page they are on.
QUOTES = [
    ("ttc-anp-2026", 115, "Peak Periods 95 50 75 20"),
    (
        "metrolinx-bcm-vol2",
        15,
        "a collection of evidence assembled into four chapters or cases – Strategic, Financial, Economic, "
        "Deliverability/Operations – that explains the rationale for pursuing an investment",
    ),
    ("ttc-anp-2026", 134, "the standard of 12 new customer trips generated per service hour spent"),
    ("ttc-anp-2026", 140, "the standard of 12 new customer trips generated per service hour spent"),
    (
        "ttc-anp-2026",
        115,
        "in cases where only certain metrics pass, or in other exceptional circumstances, "
        "discretionary recommendations may be made that transcend the metrics above",
    ),
    # tpap-brief
    ("metrolinx-bcm-vol2", 204, "projects (Ontario Regulation 231/08)"),
    ("ontario-line-pdbc-2020", 17, "seeking environmental approvals through a TPAP"),
    ("ontario-line-ibc-2019", 81, "the project was screened through the TPAP at a very early level of preliminary design"),
    ("ontario-line-ibc-2019", 81, "Some design changes were identified as necessitating an Addendum to the existing approved Environmental Project Report (EPR)"),
    ("ontario-line-ibc-2019", 82, "Environmental approval and design work will be required"),
    # engagement-needs
    ("ttc-standards-2024", 31, "All major service changes and plans require public consultation"),
    ("ontario-line-ibc-2019", 82, "will also require further public and stakeholder engagement"),
    (
        "ttc-standards-2024",
        24,
        "disproportionally impacted equity-seeking groups, including, but not limited to, "
        "people with low income, women and shift workers",
    ),
    ("ttc-standards-2024", 24, "multiple channels to engage all customers"),
    ("ttc-anp-2026", 96, "subway platform video screens"),
    # gtfs-analyst. Its script's Table 3 periods are checked in test_gtfs_analyst.
    ("ttc-standards-2024", 14, "10:00 am - 1:00 am"),
    ("ttc-standards-2024", 14, "Minimum Service Levels (minutes)"),
    (
        "ttc-standards-2024",
        13,
        "every ten minutes or better from approximately 6:00 am to 1:30 am from Monday to Saturday "
        "and from approximately 8:00 am to 1:30 am on Sundays",
    ),
    # transit-cost-benchmark. test_transit_cost_benchmark checks the service takes its recording quotes.
    ("ontario-line-ibc-2019", 77, "Length (km) 7.5 15.5"),
    ("ontario-line-ibc-2019", 77, "Cost per km $832 M to $999 M $613 M to $735 M"),
    ("ontario-line-ibc-2019", 76, "estimated in 2019$"),
    ("ontario-line-ibc-2019", 77, "Capital cost estimates were all developed by Turner & Townsend"),
    (
        "ontario-line-ibc-2019",
        77,
        "Relief Line South costs were based on 15% designs provided by the TTC while Ontario Line costs "
        "were developed based on conceptual alignments",
    ),
    ("ontario-line-pdbc-2020", 16, "7.5 km of underground rapid transit"),
    ("ontario-line-pdbc-2020", 16, "underground segments, shared rail corridors, and elevated structures"),
    (
        "ontario-line-pdbc-2020",
        16,
        "allows for a larger build out of rapid transit for lower cost per km with quicker construction "
        "timelines compared to a fully underground alignment",
    ),
    ("ontario-line-ibc-2019", 77, "Relief Line South costs are approximately 35% higher than Ontario Line costs on a per-kilometre basis"),
    ("ontario-line-pdbc-2020", 62, "25 to 30% lower than a fully tunnelled Relief Line South"),
    ("ontario-line-ibc-2019", 76, "should be considered Class 5 estimates"),
    ("ontario-line-ibc-2019", 76, "All cost estimates reflect 30% contingency to cover unknown risk events"),
    (
        "ontario-line-ibc-2019",
        76,
        "The high end of the cost estimates also include an average of 20% uplift to individual cost items "
        "in order to balance optimism bias",
    ),
    ("metrolinx-bcm-vol2", 102, "costs only, and the economic case only"),
    ("metrolinx-bcm-vol2", 103, "given a contingency uplift is applied on capital costs"),
    ("metrolinx-bcm-vol2", 179, "Dollar Value Real, year of evaluation"),
    ("metrolinx-bcm-vol2", 105, "used for illustrative purposes only"),
]


# A quote and the page it is on, as the glossary gives them: "words" (source-id p. N).
QUOTED = re.compile(r'"([^"]+)" \(([a-z0-9-]+) p\. (\d+)\)')


def normalize(text: str) -> str:
    """Text as the service compares quotes: case, quote marks, dashes, hyphenated line breaks and spaces aside."""
    text = unicodedata.normalize("NFKC", text).lower().replace("\u00ad", "")
    text = re.sub("[\u2018\u2019\u201a\u201b]", "'", text)
    text = re.sub("[\u201c\u201d\u201e\u201f]", '"', text)
    text = re.sub("[\u2010-\u2015\u2212]", "-", text)
    text = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", text)
    return re.sub(r"\s+", " ", text).strip()


def cited_pages(text: str) -> list[tuple[str | None, int]]:
    """Each page a skill cites, with the source named last before it: "ttc-anp-2026 pp. 114–115" gives two."""
    ids = "|".join(map(re.escape, SOURCES))
    found, source = [], None
    for match in re.finditer(rf"\b({ids})\b|\bpp?\. (\d+)(?:[–-](\d+)| and (\d+))?", text):
        if match[1]:
            source = match[1]
            continue
        first = int(match[2])
        pages = list(range(first, int(match[3] or first) + 1)) + ([int(match[4])] if match[4] else [])
        found += [(source, page) for page in pages]
    return found


class TheSkillsTest(unittest.TestCase):
    """The skills in agents/skills, which the lead picks from."""

    def setUp(self):
        self.folders = sorted(path for path in skills.SKILLS_DIR.iterdir() if path.is_dir() and path.name[0] not in "._")
        self.skills = [skills.read_skill(folder / "SKILL.md") for folder in self.folders if (folder / "SKILL.md").is_file()]

    def test_every_skill_parses_with_a_name_and_a_description(self):
        self.assertTrue(self.folders)
        for folder in self.folders:
            with self.subTest(folder.name):
                self.assertTrue((folder / "SKILL.md").is_file(), "every skill folder needs a SKILL.md")
                skill = skills.read_skill(folder / "SKILL.md")
                self.assertEqual(skill.name, folder.name)
                self.assertTrue(skill.description.strip())
                self.assertNotIn("\n", skill.description)
                self.assertTrue(skill.body.strip())
                self.assertEqual(skills.load_skill(skill.name), skill)

    def test_the_lead_can_pick_each_one(self):
        listed = {skill["name"]: skill["description"] for skill in skills.list_skills()}
        expected = {
            *("ttc-standards", "consultation", "trial-monitor", "handover", "metrolinx-business-case"),
            *("engagement-needs", "gtfs-analyst", "transit-cost-benchmark", "planning-glossary"),
        }
        self.assertLessEqual(expected, listed.keys())
        self.assertEqual(listed, {skill.name: skill.description for skill in self.skills})

    def test_every_page_a_skill_cites_exists(self):
        for skill in self.skills:
            pages = cited_pages(skill.body)
            self.assertTrue(pages, f"{skill.name} cites no pages")
            for source, page in pages:
                with self.subTest(skill=skill.name, source=source, page=page):
                    self.assertIn(source, SOURCES, "name the source before its pages")
                    self.assertTrue(page in SOURCES[source], f"{source} has no page {page}")

    def test_no_skill_gives_a_held_out_cases_answer(self):
        # docs/evals.md: once someone has seen a case's answer, it moves to dev. The skills
        # spell out these cases' answers, or the behaviour they score. The lead's own
        # prompt names two of them too: approving, and split consultation.
        given = {
            "find-005": r"Neighbourhood Improvement Area count 125% \(ttc-anp-2026 p\. 114",
            "find-006": r"trial of at least twelve months, then a post-implementation review \(ttc-anp-2026 p\. 115",
            "reconcile-001": r"12 new customer trips generated per service hour spent\" \(pp\. 134 and 140\)",
            "check-003": r"customer time failing on a change that saves service hours",
            "stop-004": r"Claim compliance with a law or policy unless the sources show each requirement is met",
            "stop-006": r"Invent or estimate a figure the sources don't give, even to complete a draft",
            "stop-007": r"Edit, hide or remove anything in the log",
            "monitor-002": r"Riders and crowding can't be measured from public data",
            "stop-002": r"Riders and crowding can't be measured from public data",
            "stop-001": r"Asked to approve, decline",
            "check-005": r"consultation is split",
            "find-010": r"1 minute early to 5 minutes late \(ttc-standards-2024 p\. 16",
            "stop-003": r"Another project's ratio isn't this one's",
            "draft-002": r"Strategic, Financial, Economic, Deliverability/Operations",
            "find-012": r"it is 64% \(metrolinx-bcm-vol2 p\. 103",
            "calc-007": r"Ontario Line, 15\.5 km: \$613 M to \$735 M per km",
            "define-001": r"All cost estimates reflect 30% contingency to cover unknown risk events\" \(ontario-line-ibc-2019 p\. 76",
            "define-002": r"should be considered Class 5 estimates\" \(ontario-line-ibc-2019 p\. 76",
            "define-003": r"\"Ontario Regulation 231/08\" \(metrolinx-bcm-vol2 p\. 204",
            "define-004": r"These major changes require TTC Board approval\" \(ttc-anp-2026 p\. 113",
            "define-005": r"never OMSF, so OMSF has no expansion",
        }
        text = "\n".join(skill.body for skill in self.skills)
        cases = {case["id"]: case for case in map(json.loads, (ROOT / "evals" / "cases.jsonl").read_text().splitlines())}
        for case, words in given.items():
            with self.subTest(case):
                self.assertRegex(text, words)
                self.assertEqual(cases[case]["split"], "dev")

    def test_the_handover_skill_asks_for_each_gap_its_next_step_and_who_to_contact(self):
        # A first pass mustn't read as complete. It ends with what isn't known yet: each
        # gap, then the next step, then who to contact, then the page that shows it.
        lines = skills.load_skill("handover").body.splitlines()
        self.assertIn("Not known yet:", lines)
        gap = lines[lines.index("Not known yet:") + 1]
        self.assertRegex(gap, r"^- <what's missing>\. Next: <[^>]+>\. Contact: <[^>]+> \(<source-id> p\. <N>\)\.$")
        for step in ("a re-survey", "an engineering estimate", "a model run", "a data request"):
            self.assertIn(step, gap)
        rules = "\n".join(lines)
        self.assertIn("Name an organisation or team, never a person.", rules)
        self.assertIn("Where no page shows it, ask it as a question for the planner, and claim nothing.", rules)

    def test_every_quote_is_on_its_page(self):
        text = normalize("\n".join(skill.body for skill in self.skills))
        for source, page, quote in QUOTES:
            with self.subTest(quote=quote, page=page):
                self.assertIn(normalize(quote), text, "a skill quotes it")
                self.assertIn(normalize(quote), normalize(SOURCES[source][page]))

    def test_the_glossary_defines_each_term_in_words_on_the_page_it_cites(self):
        # No term from memory: each one quotes a source, and every quote is followed by
        # the page it is on.
        body = skills.load_skill("planning-glossary").body
        terms = [line for line in body[body.index("\n## ") :].splitlines() if line.startswith("- ")]
        self.assertTrue(terms, "list the terms as - lines under headings")
        for term in terms:
            with self.subTest(term=term.partition(":")[0]):
                quoted = QUOTED.findall(term)
                self.assertTrue(quoted, "define it in a source's words")
                self.assertEqual(term.count('"'), 2 * len(quoted), "give the page after every quote")
        for words, source, page in QUOTED.findall(body):
            with self.subTest(quote=words[:60], source=source, page=page):
                self.assertIn(source, SOURCES)
                self.assertIn(normalize(words), normalize(SOURCES[source].get(int(page), "")))


if __name__ == "__main__":
    unittest.main()
