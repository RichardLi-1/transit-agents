"""Skills: folders of instructions, and any scripts, loaded only when a specialist needs one.

Each skill is a folder, agents/skills/<name>, holding a SKILL.md: frontmatter with the
skill's name and a one-line description, then its instructions.

    ---
    name: quote-check
    description: Check that a quote is on the page it cites, word for word.
    ---
    Read the cited page with read_page, then ...

The lead sees only names and descriptions, from list_skills. It picks one for a
specialist, and only that specialist gets the full text.

A skill that computes something keeps its scripts in a tools.py beside SKILL.md.
Its tools(session, study) returns LocalTools, which only that specialist gets:
scripts compute, and the model reads their results.
"""

import importlib.util
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SKILLS_DIR = Path(__file__).parent / "skills"

# A folder name, so a model can't name a path outside the skills folder.
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


class SkillError(ValueError):
    """A skill that doesn't exist, or whose SKILL.md can't be read."""


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    body: str  # the instructions, after the frontmatter
    folder: Path  # with any scripts the instructions name


def list_skills(root: Path | None = None) -> list[dict[str, str]]:
    """Each skill's name and description, by name. Their instructions aren't read out."""
    root = root or SKILLS_DIR
    files = sorted(root.glob("*/SKILL.md")) if root.is_dir() else []
    return [{"name": skill.name, "description": skill.description} for skill in map(read_skill, files)]


def load_skill(name: str, root: Path | None = None) -> Skill:
    """The skill with this name, instructions and all."""
    root = root or SKILLS_DIR
    path = root / name / "SKILL.md"
    if not NAME.match(name) or not path.is_file():
        names = ", ".join(skill["name"] for skill in list_skills(root)) or "none yet"
        raise SkillError(f"No skill named {name!r}. Skills: {names}.")
    return read_skill(path)


def read_skill(path: Path) -> Skill:
    """Read one SKILL.md, checking its name matches its folder."""
    fields, body = _split(path.read_text(encoding="utf-8"), path)
    name, description = fields.get("name", ""), fields.get("description", "")
    if name != path.parent.name:
        raise SkillError(f"{path}: name is {name!r}, but the folder is {path.parent.name!r}")
    if not NAME.match(name):
        raise SkillError(f"{path}: name it with lowercase letters, numbers and dashes")
    if not description:
        raise SkillError(f"{path}: give a description in the frontmatter")
    if not body:
        raise SkillError(f"{path}: write the instructions after the frontmatter")
    return Skill(name=name, description=description, body=body, folder=path.parent)


def skill_tools(skill: Skill, session: Any, study: str) -> list[Any]:
    """The tools a skill's scripts give the specialist using it, from its tools.py. None without one.

    tools.py defines tools(session, study), which returns LocalTools. It is loaded here,
    only when a specialist takes the skill.
    """
    path = skill.folder / "tools.py"
    if not path.is_file():
        return []
    name = f"skill_{skill.name.replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SkillError(f"{path}: can't load it")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # so code in it that looks itself up, as dataclasses do, finds it
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    make = getattr(module, "tools", None)
    if not callable(make):
        raise SkillError(f"{path}: define tools(session, study), returning the skill's tools")
    return list(make(session, study))


def _split(text: str, path: Path) -> tuple[dict[str, str], str]:
    """Frontmatter fields and the body. Fields are `key: value`; indented lines continue one."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SkillError(f"{path}: start with frontmatter between --- lines")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise SkillError(f"{path}: close the frontmatter with a --- line")
    fields: dict[str, str] = {}
    key = None
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line[0] in " \t" and key:
            fields[key] = f"{fields[key]} {line.strip()}".strip()
            continue
        key, colon, value = (part.strip() for part in line.partition(":"))
        if not colon:
            raise SkillError(f"{path}: write frontmatter as key: value, not {line.strip()!r}")
        # A YAML block marker, such as "description: >", starts an indented value.
        if value in (">", "|", ">-", "|-"):
            value = ""
        elif len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        fields[key] = value
    return fields, "\n".join(lines[end + 1 :]).strip()
