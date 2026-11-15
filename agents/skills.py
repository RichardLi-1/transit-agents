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
scripts compute, and the model reads their results. They never run in the agent's
process: each call runs in a sandboxed process of its own (sandbox.py).

A skill's version is the SHA-256 of its folder, every file's path and bytes
(skill_runner.files_hash), computed as it is loaded. A planner approves a version as the
skill's one current version, replacing the one before, and the agents offer only skills
whose version now is their current one.
"""

import contextlib
import re
import shutil
import tempfile
from collections.abc import Collection, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import sandbox
from skill_runner import files_hash, folder_files

SKILLS_DIR = Path(__file__).parent / "skills"

# A folder name, so a model can't name a path outside the skills folder.
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")

# The skills whose scripts load another skill's tools.py, and which ones. Their
# sandbox lets them read those folders, and they're offered only while those are
# approved too. Scripts change only by code review, so this list does too.
USES: dict[str, tuple[str, ...]] = {
    name: ("gis-analyst",)
    for name in ("active-transportation", "economic-development", "equity-analysis", "safety-audit", "stop-accessibility")
}


# Each skill's current approved version, by name, from the service (approved_from).
Approved = Mapping[str, str]


class SkillError(ValueError):
    """A skill that doesn't exist, whose SKILL.md can't be read, or that isn't approved."""


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    body: str  # the instructions, after the frontmatter
    folder: Path  # with any scripts the instructions name
    hash: str = ""  # the folder's SHA-256 as it was read: the skill's version


def skill_hash(folder: Path) -> str:
    """A skill's version: the SHA-256 of its folder's files, paths and bytes."""
    return files_hash(folder_files(folder))


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


def approved_from(answer: Any) -> dict[str, str]:
    """Each skill's current approved version, from the service's GET /v1/skills
    (list_approved_skills). Nothing else counts: not an older approval, nor an answer in
    another shape, which approves nothing."""
    current = answer.get("current") if isinstance(answer, dict) else None
    if not isinstance(current, dict):
        return {}
    return {str(name): version for name, version in current.items() if isinstance(version, str)}


def is_approved(skill: Skill, approved: Approved, root: Path | None = None, *, _seen: frozenset[str] = frozenset()) -> bool:
    """Whether a skill's version now is its current approved one, and the version of each
    skill whose scripts it loads, which it would run too."""
    if skill.name in _seen or not skill.hash or skill.hash != approved.get(skill.name):
        return False
    for name in USES.get(skill.name, ()):
        try:
            used = load_skill(name, root or skill.folder.parent)
        except SkillError:
            return False
        if not is_approved(used, approved, root, _seen=_seen | {skill.name}):
            return False
    return True


def offered(root: Path | None, approved: Approved) -> list[Skill]:
    """The skills the agents may use, by name: those whose version now a planner approved."""
    root = root or SKILLS_DIR
    files = sorted(root.glob("*/SKILL.md")) if root.is_dir() else []
    return [skill for skill in map(read_skill, files) if is_approved(skill, approved, root)]


def waiting(root: Path | None, approved: Approved) -> list[Skill]:
    """The skills waiting for a planner to approve their version now, by name: agents can't use them."""
    root = root or SKILLS_DIR
    files = sorted(root.glob("*/SKILL.md")) if root.is_dir() else []
    return [skill for skill in map(read_skill, files) if not is_approved(skill, approved, root)]


def offer(name: str, root: Path | None, approved: Approved) -> Skill:
    """The skill with this name, for an agent to use, only if a planner approved its version now."""
    skill = load_skill(name, root)
    if not is_approved(skill, approved, root):
        raise SkillError(
            f"Skill {name} is waiting for a planner to approve its current version ({skill.hash[:12]}), "
            "so no agent can use it yet. Tell the planner, and answer without it."
        )
    return skill


def read_skill(path: Path) -> Skill:
    """Read one SKILL.md, checking its name matches its folder, with its folder's hash.

    The instructions and the hash come from the same read of the folder, so the hash
    names exactly the instructions given."""
    files = folder_files(path.parent)
    if path.name not in files:
        raise SkillError(f"No SKILL.md in {path.parent}")
    fields, body = _split(files[path.name].decode("utf-8"), path)
    name, description = fields.get("name", ""), fields.get("description", "")
    if name != path.parent.name:
        raise SkillError(f"{path}: name is {name!r}, but the folder is {path.parent.name!r}")
    if not NAME.match(name):
        raise SkillError(f"{path}: name it with lowercase letters, numbers and dashes")
    if not description:
        raise SkillError(f"{path}: give a description in the frontmatter")
    if not body:
        raise SkillError(f"{path}: write the instructions after the frontmatter")
    return Skill(name=name, description=description, body=body, folder=path.parent, hash=files_hash(files))


def skill_tools(skill: Skill, session: Any, study: str, *, allowed: Collection[str]) -> list[Any]:
    """The tools a skill's scripts give the specialist using it, from its tools.py. None without one.

    tools.py defines tools(session, study), which returns LocalTools. It never runs here:
    a sandboxed process runs the tools.py of the version this skill was read at, once to
    declare its tools, and once for each call (sandbox.py). Its calls to the service come
    back here, and are made with `session` only if `allowed` names the tool.
    """
    if not (skill.folder / "tools.py").is_file():
        return []
    root = skill.folder.parent
    script = sandbox.Script(
        skill=skill.name,
        folder=skill.folder,
        version=skill.hash or skill_hash(skill.folder),
        study=study,
        allowed=frozenset(allowed),
        # The skills its scripts load, at the versions they have now: the script's process
        # checks each still has it before it runs.
        reads=tuple((root / name, skill_hash(root / name)) for name in USES.get(skill.name, ())),
    )
    try:
        declared = sandbox.describe(script)
    except Exception as error:  # a script that won't load is a skill that can't be used
        raise SkillError(str(error)) from None
    return sandbox.tools(script, session, declared)


def with_instructions(folder: Path, text: str) -> str:
    """The version the skill in `folder` would have with `text` as its SKILL.md: what a
    planner approves for a candidate, whose instructions alone change."""
    files = folder_files(folder)
    files["SKILL.md"] = text.encode("utf-8")
    return files_hash(files)


def candidate_hash(folder: Path, root: Path | None = None) -> str:
    """The version a candidate's folder, holding only a SKILL.md, would give the live skill
    it would replace: the live folder's files, with the candidate's instructions."""
    root = root or SKILLS_DIR
    name = candidate_name(folder, root)
    return with_instructions(root / name, (folder / "SKILL.md").read_text(encoding="utf-8"))


def short(version: str) -> str:
    """A version as people read it: the start of its hash."""
    return version[:12]


def candidate_name(folder: Path, root: Path | None = None) -> str:
    """The name of the live skill a candidate's folder, holding only a SKILL.md, would replace.

    It is read from the candidate's frontmatter, and a live skill must have it."""
    root = root or SKILLS_DIR
    path = folder / "SKILL.md"
    if not path.is_file():
        raise SkillError(f"No SKILL.md in {folder}")
    fields, body = _split(path.read_text(encoding="utf-8"), path)
    name = fields.get("name", "")
    if not NAME.match(name) or not (root / name / "SKILL.md").is_file():
        raise SkillError(f"{path}: its name, {name!r}, isn't a live skill's")
    if not fields.get("description") or not body:
        raise SkillError(f"{path}: give a description and the instructions")
    return name


@contextlib.contextmanager
def with_candidate(folder: Path, root: Path | None = None) -> Iterator[Path]:
    """A skills folder like `root`, but with one skill's instructions taken from the
    SKILL.md in `folder`, a candidate's, for an eval run. It is deleted afterwards.

    Only the instructions change. The skill's scripts and every other skill are the
    live ones, linked rather than copied, so a script finds its files as it would."""
    root = (root or SKILLS_DIR).resolve()
    name = candidate_name(folder, root)
    made = Path(tempfile.mkdtemp(prefix="skills-with-candidate-"))
    try:
        for live in sorted(root.iterdir()):
            if live.is_dir() and live.name != name:
                (made / live.name).symlink_to(live, target_is_directory=True)
        swapped = made / name
        swapped.mkdir()
        for live in (root / name).iterdir():
            if live.name != "SKILL.md":
                (swapped / live.name).symlink_to(live, target_is_directory=live.is_dir())
        shutil.copyfile(folder / "SKILL.md", swapped / "SKILL.md")
        read_skill(swapped / "SKILL.md")  # its name must be its folder's, as for any skill
        yield made
    finally:
        shutil.rmtree(made, ignore_errors=True)


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
