"""Checks that a skill's words are on the pages it cites, in the seeded sources.

A quote must be on its page word for word, as the service checks a citation. A table
cell printed beside another column can't be: its lines alternate with the other
column's. words_in_order checks only that its words are on the page in order, within
six times its length. That is looser than the service, which takes a quote with gaps
only within four times its length, and only if at least half its words are numbers.
So a cell or row a skill gives is for reading: its citation's quote is words that run
on the page.
"""

import dataclasses
import importlib.util
import re
import sys
from types import ModuleType

import skills
from tests.test_skills import SOURCES, normalize

QUOTE = re.compile(r'"([^"\n]+)"')
CITATION = re.compile(r"\(([a-z0-9-]+) pp?\. (\d+)(?:[–-](\d+))?")


def script(skill: str) -> ModuleType:
    """A skill's tools.py, as a module, registered as skills.skill_tools registers it."""
    name = f"test_skill_{skill.replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(name, skills.SKILLS_DIR / skill / "tools.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def quotes(body: str) -> list[tuple[str, str | None, list[int]]]:
    """Each quote in a skill's text, with the source and pages of the first citation after it on its line."""
    found = []
    for match in QUOTE.finditer(body):
        end = body.find("\n", match.end())
        cited = CITATION.search(body[match.end() : end if end != -1 else len(body)])
        if cited is None:
            found.append((match[1], None, []))
        else:
            first = int(cited[2])
            found.append((match[1], cited[1], list(range(first, int(cited[3] or first) + 1))))
    return found


def on_page(source: str, pages: list[int], quote: str) -> bool:
    """Whether the quote is word for word on one of the pages, as the service compares them."""
    return any(page in SOURCES[source] and normalize(quote) in normalize(SOURCES[source][page]) for page in pages)


def words(text: str) -> list[str]:
    """Words and numbers as the service splits a table row, without a full stop or comma after them."""
    return [word.rstrip(".,") for word in re.findall(r"[a-z0-9$%.,()']+", normalize(text)) if word.rstrip(".,")]


def words_in_order(source: str, page: int, text: str, spread: int = 6) -> bool:
    """Whether a table cell's words are on the page in order, within `spread` times as many words.

    Not the service's check: it would refuse most such cells as a citation's quote.
    """
    page_words, wanted = words(SOURCES[source][page]), words(text)
    for start, word in enumerate(page_words):
        if word != wanted[0]:
            continue
        found = 1
        for later in page_words[start + 1 : start + len(wanted) * spread]:
            if found < len(wanted) and later == wanted[found]:
                found += 1
        if found == len(wanted):
            return True
    return False


def citations(value: object) -> list[dict]:
    """Every citation in a script's constants: each dict with a source, a page and a quote."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return citations(vars(value))
    if isinstance(value, dict):
        own = [value] if {"source", "page", "quote"} <= value.keys() else []
        return own + [found for item in value.values() for found in citations(item)]
    if isinstance(value, (list, tuple)):
        return [found for item in value for found in citations(item)]
    return []
