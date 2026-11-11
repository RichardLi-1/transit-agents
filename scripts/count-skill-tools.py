"""Prints how many tools each skill's scripts give a specialist, as JSON: {skill: count}.

Loads each skill's tools.py as a specialist would (agents/skills.py), so a tool a skill
shares from gis-analyst counts for it too. scripts/build-docs-data.ts runs this with the
agents' Python, for the docs' Skills page.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agents"))

from skills import SKILLS_DIR, read_skill, skill_tools  # noqa: E402

counts = {}
for path in sorted(SKILLS_DIR.glob("*/SKILL.md")):
    skill = read_skill(path)
    if (skill.folder / "tools.py").is_file():
        counts[skill.name] = len(skill_tools(skill, None, "docs"))
print(json.dumps(counts))
