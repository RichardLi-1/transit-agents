"""Context intake: when a planner or an agency system adds a source, through
POST /v1/context or the watched folder, the listener triages it without anyone asking.

In each open study, up to INTAKE_STUDIES of them (default 3, the newest; 0 turns intake
off), the lead says whether the source bears on the study, what it changes and which
open questions it reopens, and the answer goes to the study's chat, as an answer to a
planner's question would. Sources that arrive together are triaged together, in one run
a study. Each run counts against MAX_RUNS_PER_HOUR and MAX_DAILY_USD as a planner's
does, makes at most INTAKE_RUN_CALLS model calls (default 20), and waits its turn
behind planners' questions. An agent's own uploads, which can't be cited, and visitors'
sandboxes start nothing.
"""

from collections.abc import Sequence
from typing import Any

# Who adds citable context, by the start of the log entry's actor, and how the chat names them.
ADDERS = {"planner:": "a planner", "integration:inbox": "the watched folder", "integration:": "an agency system"}

TRIAGE = """\
New context has arrived, and nobody has asked about it yet: {sources}. Triage it for this study, for a planner.
- First, does it bear on this study? Search it, and read the pages that might. If it doesn't, answer in one line, "{titles} doesn't bear on this study.", and nothing more.
- If it does: what it changes, each point cited (source-id p. N): a figure, rule or assumption the study holds that it updates, contradicts or supports.
- Which open questions it reopens or settles: the gaps under "Not known yet" earlier in the chat, if there are any.
Decide nothing, and keep it brief: say what a planner should look at."""


def arrived(entry: dict[str, Any]) -> dict[str, Any] | None:
    """A source added to the shared record by a planner or an agency system, as
    {id, title, pages, by}, or None for any other log entry."""
    data = entry.get("data") or {}
    actor = str(entry.get("actor", ""))
    if entry.get("type") != "context.added" or entry.get("audience") or not isinstance(data.get("id"), str):
        return None
    by = next((name for start, name in ADDERS.items() if actor.startswith(start)), None)
    if by is None:  # an agent's, which can't be cited
        return None
    return {"id": data["id"], "title": str(data.get("title") or data["id"]), "pages": data.get("pageCount"), "by": by}


def describe(source: dict[str, Any]) -> str:
    pages = source.get("pages")
    size = f", {pages} {'page' if pages == 1 else 'pages'}" if isinstance(pages, int) and pages else ""
    title = "" if source["title"] == source["id"] else f"{source['title']}"
    inside = ", ".join(part for part in (title, size.lstrip(", ")) if part)
    return f"{source['id']}{f' ({inside})' if inside else ''}, added by {source['by']}"


def triage_task(sources: Sequence[dict[str, Any]], history: list[str] | None = None) -> list[str]:
    """The lead's task for a study: the chat so far, if any, then what to triage."""
    titles = " and ".join(source["title"] for source in sources)
    task = TRIAGE.format(sources="; ".join(map(describe, sources)), titles=titles)
    return [*(history or []), task]


def chosen(studies: Sequence[dict[str, Any]], most: int) -> list[str]:
    """The studies to triage in: the newest `most`, as list_studies gives them, oldest first."""
    ids = [study["id"] for study in studies if isinstance(study, dict) and isinstance(study.get("id"), str)]
    return ids[-most:] if most > 0 else []
