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
]


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
        self.assertLessEqual({"ttc-standards", "consultation", "trial-monitor", "handover", "metrolinx-business-case"}, listed.keys())
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
        }
        text = "\n".join(skill.body for skill in self.skills)
        cases = {case["id"]: case for case in map(json.loads, (ROOT / "evals" / "cases.jsonl").read_text().splitlines())}
        for case, words in given.items():
            with self.subTest(case):
                self.assertRegex(text, words)
                self.assertEqual(cases[case]["split"], "dev")

    def test_every_quote_is_on_its_page(self):
        text = normalize("\n".join(skill.body for skill in self.skills))
        for source, page, quote in QUOTES:
            with self.subTest(quote=quote, page=page):
                self.assertIn(normalize(quote), text, "a skill quotes it")
                self.assertIn(normalize(quote), normalize(SOURCES[source][page]))


if __name__ == "__main__":
    unittest.main()
