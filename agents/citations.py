"""Citations in an agent's text, as (source-id p. N), and the pages that back them.

The lead's prompt asks for that form, the eval runner scores it, and the listener
checks each one before an answer reaches the chat.
"""

import re
from collections.abc import Collection, Iterable
from typing import Any

_PAGES = re.compile(r"[\s,:(]*(?:pp?\.?|pages?)\s*(?=\d)", re.I)
_NUMBER = re.compile(r"(\d+)(?:\s*[-–—]\s*(\d+))?")
_MORE = re.compile(r"\s*(?:,|;|&|\band\b)\s*((?:pp?\.?|pages?)\s*)?(?=\d)", re.I)
_ENDS = re.compile(r"\s*(?:$|[,;&.)\]]|and\b)", re.I)


def citations(text: str, sources: Collection[str]) -> list[dict[str, Any]]:
    """The pages the text cites, as (source-id p. N), for the given source ids, in order.

    It reads "pp. 127–128", "p. 115, 118" and "p. 115; p. 134" too. A number after the
    first that has no "p." of its own counts only if punctuation or "and" follows it, so
    "p. 115 and 11 riders" cites p. 115 alone.
    """
    names = {name.lower(): name for name in sources}
    if not names:
        return []
    ids = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True))
    found: dict[tuple[str, int], None] = {}
    for match in re.finditer(rf"(?<![\w.-])({ids})(?![\w-])", text, re.I):
        source = names[match.group(1).lower()]
        pages = _PAGES.match(text, match.end())
        if not pages:
            continue
        position, marked = pages.end(), True
        while number := _NUMBER.match(text, position):
            if not marked and not _ENDS.match(text, number.end()):
                break
            first = int(number.group(1))
            last = int(number.group(2) or first)
            for page in range(first, last + 1) if first <= last <= first + 20 else (first,):
                found[(source, page)] = None
            more = _MORE.match(text, number.end())
            if not more:
                break
            position, marked = more.end(), bool(more.group(1))
    return [{"source": source, "page": page} for source, page in found]


def pages_in(value: Any) -> Iterable[tuple[str, int]]:
    """Every (contextId, page) in a service result, however deep: the citations on a
    study's figures, findings and rules, which the service checked against their pages."""
    if isinstance(value, dict):
        if isinstance(value.get("contextId"), str) and isinstance(value.get("page"), int):
            yield value["contextId"], value["page"]
        for inner in value.values():
            yield from pages_in(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from pages_in(inner)
