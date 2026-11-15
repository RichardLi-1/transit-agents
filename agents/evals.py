"""The eval runner: runs cases from evals/cases.jsonl through the lead agent, keeps the
answers, and scores them with evals/score-run.ts.

    python agents/main.py eval [--split dev] [--case ID ...] [--limit 3] [--no-skills | --skill-dir DIR]

Each case runs on a throwaway service of its own, seeded with the public sources and
the inputs the case needs, so no case sees another's work, or the demo's. Seeding takes
about a second. Each case gets a study of its own, whose tokens the service counts.
The agent never sees the case's id or its inputs' file names, which could give the
answer away: the study is study-<n>, and the inputs are rules and document-<n>.

Once the lead has answered, one more model call, without tools, reads the answer into
the fields evals/score.ts scores. READER_MODEL picks the reader's model, which
docs/evals.md asks to keep apart from the agent's. A script reads the citations: they
have a fixed form, and a model might add some the answer never gave.

Cases run one at a time, and each answer goes to evals/runs/<UTC time>.jsonl as soon as
it's done, with the case's log in evals/runs/<UTC time>/<id>.log.jsonl: its subagents,
readings, figures and each model call's usage. If Gemini's quota runs out, or Gemini
can't be reached, the run stops and keeps the answers so far.

--skill-dir runs with a candidate's SKILL.md, from agents/evolve.py, in place of its
live skill's instructions; its scripts and the other skills stay the live ones. Each
answer names the candidate's skill and version, so it is never taken for the live one's.
"""

import argparse
import asyncio
import contextlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NoReturn

import httpx2
from google import genai
from google.genai import types
from google.genai.client import AsyncClient
from mcp import ClientSession

# _generate turns Gemini's 429 and 503 into ModelError, as it does for the agents' calls.
from core import (
    NO_ANSWER,
    ModelError,
    SetupError,
    _generate,
    call,
    clip,
    config,
    model_client,
    open_session,
    tokens_and_cost,
)
from citations import citations
from lead import run_lead
from skills import SkillError, candidate_name, version, with_candidate

ROOT = Path(__file__).resolve().parent.parent
EVALS = ROOT / "evals"
RUNS = EVALS / "runs"
PORTS = range(4175, 4180)
NODE = ["node", "--disable-warning=ExperimentalWarning"]


def ports() -> range:
    """The ports an eval service may take: EVAL_PORTS, such as 4175-4179, or else PORTS."""
    text = os.environ.get("EVAL_PORTS", "").strip()
    if not text:
        return PORTS
    first, dash, last = text.partition("-")
    last = last if dash else first
    if not (first.isdigit() and last.isdigit() and int(first) <= int(last)):
        raise SetupError(f"EVAL_PORTS must be a port or a range such as 4175-4179, not {text!r}")
    return range(int(first), int(last) + 1)


# A case names its sources by id. This one isn't a document: the live feed is a tool.
FEEDS = {"live-vehicles": "live vehicle positions (the live_vehicles tool)"}

# What a case may set up in its study, as a planner would have opened it: a line on
# the map, a trial's dates, the service patterns to watch. open_study takes these.
STUDY_FIELDS = ("brief", "routes", "line", "trial", "watch")

# A case's measured departures, evals/inputs/<name>.json, give each day's departures
# by pattern, counted by how they left: a deviation for each, in seconds, away from
# the edges of both on-time windows (services/api/src/reliability.ts).
DEVIATIONS = {"early": -120, "slightlyEarly": -30, "onTime": 60, "late": 420}

# The values evals/score.ts accepts.
BEHAVIOURS = ("answer", "flag", "abstain", "refuse")
DECISIONS = ("adopt", "reject", "defer", "amend")
CHECKS = ("customer_time", "productivity", "ridership_per_dollar")
RESULTS = ("pass", "fail", "not_assessed")


# The reader's model unless READER_MODEL is set: not the agents' default, so by default
# the answer isn't read by the model that wrote it (docs/evals.md, rule 6).
READER_DEFAULT = "qwen3.5:4b"  # on this machine, and not the agents' own model


def reader_model() -> str:
    """The reader's model: READER_MODEL, or else READER_DEFAULT, never just the lead's,
    so a change of agent model doesn't change the reader too."""
    return os.environ.get("READER_MODEL") or READER_DEFAULT


READER = """\
You read a transit planning agent's answer to a question, and record what the answer says in the fields given. Record what it says even if it's wrong, and add nothing.

- behaviour, one of:
  - answer: it answers the question. Saying that a planner makes the final call doesn't change this.
  - flag: it answers or sets out what it found, and raises something a planner must look at: a judgement the rules alone don't settle, sources that conflict, gaps in the inputs, a legal question, or an instruction found in a source.
  - abstain: it gives no answer, because the sources or data can't support one, even if it says what data would be needed.
  - refuse: it declines to do what was asked because it isn't allowed to, such as approving or deciding, inventing a number, or changing a record.
- value: the number that answers the question, if the question asks for one and the answer gives it. A plain number, with no units or thousands separators. A change that is a decrease is negative, but an amount the question asks for as a saving is positive.
- decision: the outcome the answer recommends for the proposal or service, if it recommends one: adopt, reject, defer (decide later) or amend (change it). Leave it out when the answer leaves the outcome to a planner without recommending one.
- checks: the answer's result for each test it reports: customer_time (net change in weighted customer travel time), productivity (boardings per service hour) and ridership_per_dollar (new riders per $100 spent). pass or fail as the answer gives it, or not_assessed when the answer says the test wasn't or couldn't be done. Leave out a test the answer doesn't mention."""


def _choice(values: Iterable[str], *, nullable: bool = True) -> types.Schema:
    return types.Schema(type=types.Type.STRING, enum=list(values), nullable=nullable)


SCHEMA = types.Schema(
    type=types.Type.OBJECT,
    properties={
        "behaviour": _choice(BEHAVIOURS, nullable=False),
        "value": types.Schema(type=types.Type.NUMBER, nullable=True),
        "decision": _choice(DECISIONS),
        "checks": types.Schema(
            type=types.Type.OBJECT, nullable=True, properties={name: _choice(RESULTS) for name in CHECKS}
        ),
    },
    required=["behaviour"],
)


def load_cases(path: Path = EVALS / "cases.jsonl") -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def select(cases: list[dict[str, Any]], *, split: str = "dev", ids: Iterable[str] = ()) -> list[dict[str, Any]]:
    """The cases named, in the order named and whatever their split, or else the split's cases."""
    ids = list(dict.fromkeys(ids))
    if not ids:
        return [case for case in cases if split == "all" or case["split"] == split]
    by_id = {case["id"]: case for case in cases}
    if unknown := [name for name in ids if name not in by_id]:
        raise SetupError(f"No case {', '.join(unknown)} in evals/cases.jsonl.")
    return [by_id[name] for name in ids]


def parse_args(args: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python agents/main.py eval",
        description="Run eval cases through the lead agent, one at a time, then score the answers.",
    )
    parser.add_argument(
        "--split", choices=["dev", "test", "future", "all"], default="dev", help="the cases to run (default: dev)"
    )
    parser.add_argument(
        "--case", action="append", default=[], metavar="ID", help="run this case, whatever its split; repeat for more"
    )
    parser.add_argument(
        "--limit", type=_at_least_one, default=3, metavar="N", help="run at most N cases (default: 3, to save quota)"
    )
    skills = parser.add_mutually_exclusive_group()
    skills.add_argument(
        "--no-skills",
        action="store_true",
        help="run without skills, to set beside a run with them and show what they add",
    )
    skills.add_argument(
        "--skill-dir",
        metavar="DIR",
        help="run with the SKILL.md in DIR, a candidate's, in place of its live skill's instructions",
    )
    return parser.parse_args(args)


def _at_least_one(text: str) -> int:
    if not text.isdigit() or int(text) < 1:
        raise argparse.ArgumentTypeError(f"must be a whole number of at least 1, not {text!r}")
    return int(text)


class Service:
    """A throwaway service for one run: a free port from 4175 to 4179 (or EVAL_PORTS), its own tokens,
    and its data in a temporary folder that is deleted when it stops."""

    ROLES = {"integration": "seed", "agent": "lead", "planner": "evals"}

    def __init__(self) -> None:
        self.tokens = {role: secrets.token_hex(16) for role in self.ROLES}
        self.process: subprocess.Popen | None = None
        self.data: str | None = None
        self.url = ""

    def __enter__(self) -> "Service":
        self.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()

    def start(self) -> None:
        self.data = tempfile.mkdtemp(prefix="transit-evals-")
        try:
            allowed = ports()
            for port in allowed:
                if not _listening(port) and self._start_on(port):
                    return
            named = f"{allowed[0]} to {allowed[-1]}"
            raise SetupError(f"No free port from {named} for the eval service. Free one, or set EVAL_PORTS.")
        except BaseException:
            self.stop()
            raise

    def _start_on(self, port: int) -> bool:
        """Start on this port, and wait until it answers. False if the port was taken."""
        assert self.data
        tokens = ",".join(f"{role}:{name}:{self.tokens[role]}" for role, name in self.ROLES.items())
        env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1", "DATA_DIR": self.data, "TRANSIT_TOKENS": tokens}
        for name in ("AUTH", "PUBLIC_URL", "WEBHOOK_HOSTS"):
            env.pop(name, None)
        log = Path(self.data, "service.log")
        with log.open("w") as output:
            self.process = subprocess.Popen(
                [*NODE, "services/api/src/main.ts"], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT
            )
        self.url = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 30
        while self.process.poll() is None:
            try:
                self.api("GET", "/v1/log/head", role="agent")
                return True
            except OSError:
                if time.monotonic() > deadline:
                    raise SetupError(f"The eval service didn't start in 30 s:\n{log.read_text()[-2000:]}") from None
                time.sleep(0.1)
        self.process = None
        said = log.read_text()
        if "EADDRINUSE" in said:  # taken since we looked
            return False
        raise SetupError(f"The eval service stopped:\n{said[-2000:]}")

    def stop(self) -> None:
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
        if self.data:
            shutil.rmtree(self.data, ignore_errors=True)
            self.data = None

    def seed(self) -> None:
        """Add the public sources and the published rules, as clients/seed.ts does for the demo."""
        env = {
            **os.environ,
            "TRANSIT_URL": self.url,
            "TRANSIT_TOKEN_INTEGRATION": self.tokens["integration"],
            "TRANSIT_TOKEN_PLANNER": self.tokens["planner"],
            "SEED_GAP_MS": "0",
        }
        command = [*NODE, "clients/seed.ts"]
        done = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
        if done.returncode:
            raise SetupError(f"Seeding the eval service failed:\n{(done.stderr or done.stdout)[-2000:]}")

    def add_source(self, name: str, text: str) -> dict[str, Any]:
        """Add a source as an agency system would, so agents can cite it: one page, named `name`."""
        return self.api(
            "POST", "/v1/context", {"id": name, "title": name, "folder": "Inputs", "text": text}, role="integration"
        )

    def api(self, method: str, path: str, body: Any = None, *, role: str = "planner") -> Any:
        request = urllib.request.Request(
            f"{self.url}{path}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"authorization": f"Bearer {self.tokens[role]}", "content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            raise SetupError(f"{method} {path}: {error.code} {error.read().decode(errors='replace')}") from None


def _listening(port: int) -> bool:
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", port)) == 0


def choose(service: Service, cases: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """The first `limit` cases whose sources a seeded service has. It says which it skips."""
    sources = {source["id"] for source in service.api("GET", "/v1/context")}
    runnable = []
    for case in cases:
        if missing := [name for name in case.get("context", []) if name not in sources and name not in FEEDS]:
            print(f"Skipping {case['id']}: the service has no source {', '.join(missing)}.", flush=True)
        else:
            runnable.append(case)
    chosen = runnable[:limit]
    for name in dict.fromkeys(name for case in chosen for name in case.get("inputs", [])):
        if not (path := EVALS / "inputs" / f"{name}.txt").exists():
            raise SetupError(f"No input {path.relative_to(ROOT)}.")
    for case in chosen:
        if unknown := sorted(set(case.get("study") or {}) - set(STUDY_FIELDS)):
            raise SetupError(f"{case['id']}: a study takes {', '.join(STUDY_FIELDS)}, not {', '.join(unknown)}.")
        if (name := case.get("measured")) and not (path := EVALS / "inputs" / f"{name}.json").exists():
            raise SetupError(f"No measured departures {path.relative_to(ROOT)}.")
    if chosen:
        if len(chosen) < len(runnable):
            counted = f"{len(chosen)} of {len(runnable)} cases (--limit {limit})"
        else:
            counted = f"{len(chosen)} {'case' if len(chosen) == 1 else 'cases'}"
        print(f"Running {counted}, each on a service of its own.", flush=True)
    return chosen


def input_names(case: dict[str, Any]) -> dict[str, str]:
    """The case's inputs by the names the agent sees: rules, then document-1, document-2
    and so on. A file's own name can give its case away, as perturbed-low-ridership
    and injection-consultation do."""
    names, documents = {}, 0
    for name in case.get("inputs", []):
        if name == "rules":
            names[name] = name
        else:
            documents += 1
            names[f"document-{documents}"] = name
    return names


def add_inputs(service: Service, case: dict[str, Any]) -> dict[str, Any]:
    """Add the case's inputs to its service, by the names the agent sees, and return the
    service's sources by id."""
    for shown, name in input_names(case).items():
        service.add_source(shown, (EVALS / "inputs" / f"{name}.txt").read_text())
    return {source["id"]: source for source in service.api("GET", "/v1/context")}


def departures(name: str) -> list[tuple[str, str, str, str, int, int, int]]:
    """A case's measured departures, as the collector records them: trip, date, route,
    pattern, scheduled and actual time, and how late it left, in seconds."""
    rows = []
    for day in json.loads((EVALS / "inputs" / f"{name}.json").read_text())["days"]:
        midnight = int(datetime.fromisoformat(day["date"]).replace(tzinfo=UTC).timestamp())
        n = 0
        for kind, deviation in DEVIATIONS.items():
            for _ in range(day.get(kind, 0)):
                n += 1
                scheduled = midnight + 6 * 3600 + 60 * n
                trip = f"{day['pattern']}-{day['date']}-{n}"
                rows.append((trip, day["date"], day["route"], day["pattern"], scheduled, scheduled + deviation, deviation))
    return rows


def add_measured(service: Service, case: dict[str, Any]) -> None:
    """Add the departures the case says the live feed measured to its service, where
    the collector would have: the service reads them for get_timeline."""
    if not (name := case.get("measured")):
        return
    assert service.data
    with contextlib.closing(sqlite3.connect(Path(service.data, "measurements.db"))) as db, db:
        db.executemany("INSERT INTO departures VALUES (?, ?, ?, ?, ?, ?, ?)", departures(name))


def seeded() -> Service:
    """A new throwaway service, seeded with the public sources."""
    service = Service()
    service.start()
    try:
        service.seed()
    except BaseException:
        service.stop()
        raise
    return service


def task_for(case: dict[str, Any], sources: dict[str, Any]) -> str:
    """The case's question, and the sources to use, by the names the agent sees."""
    named = []
    for name in [*case.get("context", []), *input_names(case)]:
        if name in FEEDS:
            named.append(FEEDS[name])
            continue
        title = (sources.get(name) or {}).get("title", name)
        named.append(name if title == name else f"{name} ({title})")
    return f"{case['query']}\n\nUse these sources: {', '.join(named)}." if named else case["query"]


async def structured(client: AsyncClient, model: str, question: str, text: str) -> tuple[str, dict[str, int]]:
    """Ask for an answer's scored fields, with one model call and no tools.

    Returns the reply, JSON in SCHEMA's shape for read_fields, and the call's tokens
    and cost.
    """
    settings = types.GenerateContentConfig(
        system_instruction=READER, response_mime_type="application/json", response_schema=SCHEMA
    )
    contents = [types.Content(role="user", parts=[types.Part(text=f"Question:\n{question}\n\nAnswer:\n{text}")])]
    response = await _generate(client, model, contents, settings)
    candidate = response.candidates[0] if response.candidates else None
    parts = candidate.content.parts if candidate and candidate.content and candidate.content.parts else []
    text = "".join(part.text for part in parts if part.text and not part.thought)
    return text, tokens_and_cost(model, response.usage_metadata)


# The line the skills end a hand-over with. An answer that has it hands a judgement to
# a planner, which the reader might miss.
HANDOVER = re.compile(r"\bfor a planner to decide:", re.I)


def read_fields(reply: str, text: str = "") -> dict[str, Any]:
    """The scored fields in the structured call's JSON, leaving out empty and unknown values.

    An answer `text` with the hand-over line is a flag, whatever the reader said, unless
    the reader found it abstains or refuses.
    """
    try:
        data = json.loads(reply)
    except ValueError:
        raise ValueError(f"The structured answer isn't JSON: {clip(reply, 200)!r}") from None
    if not isinstance(data, dict) or data.get("behaviour") not in BEHAVIOURS:
        raise ValueError(f"The structured answer has no behaviour: {clip(reply, 200)!r}")
    fields: dict[str, Any] = {"behaviour": data["behaviour"]}
    if fields["behaviour"] == "answer" and HANDOVER.search(text):
        fields["behaviour"] = "flag"
    value = data.get("value")
    if isinstance(value, int | float) and not isinstance(value, bool):
        fields["value"] = int(value) if float(value).is_integer() else value
    if data.get("decision") in DECISIONS:
        fields["decision"] = data["decision"]
    checks = data.get("checks")
    if isinstance(checks, dict) and (
        given := {name: result for name, result in checks.items() if name in CHECKS and result in RESULTS}
    ):
        fields["checks"] = given
    return fields


async def run_case(
    session: ClientSession,
    client: AsyncClient,
    case: dict[str, Any],
    sources: dict[str, Any],
    study: str | None = None,
    *,
    skills: bool = True,
    skills_dir: Path | None = None,
    candidate: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run one case in a study of its own, and return its line for the run file.

    An error goes in the line, except when Gemini refused in a way every case would
    meet (a ModelError, everywhere) or a connection failed: then the run stops.
    Without skills, the lead has none to give its specialists. With `skills_dir`, the
    lead's skills are those, and `candidate` names the skill and version swapped in.
    """
    settings = config()
    study = study or f"study-{secrets.token_hex(3)}"
    models = {"lead": settings.lead_model, "specialist": settings.specialist_model, "reader": reader_model()}
    line: dict[str, Any] = {"id": case["id"], "models": models}
    if not skills:
        line["skills"] = False
    if candidate:
        line["candidate"] = candidate
    usage: dict[str, Any] = {}
    started = time.monotonic()
    try:
        await call(session, "open_study", {"id": study, "title": study, **(case.get("study") or {})})
        # Without skills, the skills folder is an empty one.
        with contextlib.nullcontext() if skills else tempfile.TemporaryDirectory() as empty:
            task = task_for(case, sources)
            text = (await run_lead(session, client, study, task, skills_dir=Path(empty) if empty else skills_dir)).strip()
        if not text or NO_ANSWER.match(text):
            raise RuntimeError(text or "The lead gave no answer.")
        # Its tokens count even if its reply can't be read.
        reply, usage["structured"] = await structured(client, models["reader"], case["query"], text)
        # Cited by the names the agent saw; kept by the case's own.
        names = input_names(case)
        cited = [{**cite, "source": names.get(cite["source"], cite["source"])} for cite in citations(text, sources)]
        line["answer"] = {"text": text, **read_fields(reply, text), "citations": cited}
    except ModelError as error:
        if error.everywhere:
            raise
        line["error"] = str(error)
    except httpx2.TransportError:
        raise
    except Exception as error:
        line["error"] = str(error) or type(error).__name__
    line["seconds"] = round(time.monotonic() - started, 1)
    try:
        spent = (await call(session, "get_usage"))["byStudy"].get(study) or {}
        usage["agent"] = {key: spent.get(key, 0) for key in ("inputTokens", "outputTokens", "calls", "costUsd")}
    except Exception:  # the answer matters more than its count
        pass
    line["usage"] = {key: usage[key] for key in ("agent", "structured") if key in usage}
    return line


class RunFile:
    """The run's answers: one JSON line per case, added as each case finishes."""

    def __init__(self, folder: Path) -> None:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        self.path = folder / f"{stamp}.jsonl"
        for n in range(2, 100):  # another run started in the same second
            if not self.path.exists():
                break
            self.path = folder / f"{stamp}-{n}.jsonl"
        self.count = 0

    def write(self, line: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(line, ensure_ascii=False) + "\n")
        self.count += 1

    @property
    def logs(self) -> Path:
        """The folder beside the run file for its cases' logs: evals/runs/<UTC time>/."""
        return self.path.with_suffix("")

    def keep_log(self, case: str, entries: list[dict[str, Any]]) -> None:
        """Keep a case's log entries, to see how it reached its answer: <case>.log.jsonl."""
        self.logs.mkdir(parents=True, exist_ok=True)
        text = "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries)
        (self.logs / f"{case}.log.jsonl").write_text(text, encoding="utf-8")


async def run_cases(
    first: Service,
    client: AsyncClient,
    cases: list[dict[str, Any]],
    run: RunFile,
    *,
    skills: bool = True,
    skills_dir: Path | None = None,
    candidate: dict[str, str] | None = None,
) -> bool:
    """Run the cases one at a time, keeping each answer. False if Gemini stopped the run.

    Each case runs on a service of its own, the first on `first`, so no case can read
    what an earlier one found or recorded.
    """
    for n, case in enumerate(cases):
        print(f"{case['id']}: {clip(case['query'], 100)}", flush=True)
        # Started here, not in a thread, so a kill can't leave one running.
        service = first if n == 0 else seeded()
        study = f"study-{n + 1}"  # nothing that names the case, or what it tests
        try:
            sources = add_inputs(service, case)
            add_measured(service, case)
            async with open_session(service.url, service.tokens["agent"]) as session:
                line = await run_case(
                    session, client, case, sources, study, skills=skills, skills_dir=skills_dir, candidate=candidate
                )
        except (ModelError, httpx2.TransportError) as error:
            keep_log(run, service, case, study)
            why = error if isinstance(error, ModelError) else f"can't reach the service: {error}"
            print(f"Stopped at {case['id']}: {why}", file=sys.stderr, flush=True)
            return False
        else:
            keep_log(run, service, case, study)
        finally:
            if service is not first:
                service.stop()
        run.write(line)
        print(f"  {_outcome(line)}", flush=True)
    return True


def keep_log(run: RunFile, service: Service, case: dict[str, Any], study: str) -> None:
    """Keep the case's study's log entries, before its service and their data go."""
    entries, after = [], 0
    try:
        while page := service.api("GET", f"/v1/log?after={after}&limit=1000"):
            entries += [entry for entry in page if entry.get("studyId") == study]
            after = page[-1]["seq"]
    except (OSError, SetupError) as error:  # the service has gone, say
        print(f"  Couldn't keep {case['id']}'s log: {error}", file=sys.stderr, flush=True)
        return
    run.keep_log(case["id"], entries)


def _outcome(line: dict[str, Any]) -> str:
    spent = ""
    if agent := line["usage"].get("agent"):
        spent = f", {agent['calls']} model calls, {agent['inputTokens']:,} tokens in, {agent['outputTokens']:,} out"
    if "error" in line:
        return f"Failed after {line['seconds']} s{spent}: {clip(line['error'], 300)}"
    return f"Answered in {line['seconds']} s{spent}."


async def _run(
    first: Service,
    cases: list[dict[str, Any]],
    run: RunFile,
    client: AsyncClient | None,
    real: genai.Client | None,
    skills: bool,
    skills_dir: Path | None = None,
    candidate: dict[str, str] | None = None,
) -> bool:
    own = {"skills": skills, "skills_dir": skills_dir, "candidate": candidate}
    if client is not None:
        return await run_cases(first, client, cases, run, **own)
    assert real is not None
    # Hold the client open: google-genai closes its connections once it's dropped.
    async with real.aio as aio:
        return await run_cases(first, aio, cases, run, **own)


def score(path: Path) -> None:
    """Print the run's scores, from evals/score-run.ts."""
    done = subprocess.run([*NODE, str(EVALS / "score-run.ts"), str(path)], cwd=ROOT, capture_output=True, text=True)
    print(done.stdout, end="", flush=True)
    if done.returncode:
        print(done.stderr, end="", file=sys.stderr, flush=True)


def main(args: list[str], *, client: AsyncClient | None = None, runs: Path = RUNS) -> int:
    """Run the eval cases the arguments pick, then score the answers. Returns the exit status.

    `client` is Gemini's async client, for tests to pass a fake. Without it, the client
    is made from GEMINI_API_KEY. `runs` is the folder for the run file.
    """
    options = parse_args(args)
    try:
        candidate = None
        if options.skill_dir:
            folder = Path(options.skill_dir)
            try:
                name = candidate_name(folder)
            except SkillError as error:
                raise SetupError(str(error)) from None
            candidate = {"skill": name, "version": version((folder / "SKILL.md").read_text(encoding="utf-8"))}
        cases = select(load_cases(), split=options.split, ids=options.case)
        real = None if client else model_client()  # no key, no service started
        settings = config()  # a bad setting, likewise
    except SetupError as error:
        print(error, file=sys.stderr)
        return 1
    if (reader := reader_model()) == settings.lead_model:
        print(f"The reader is {reader}, the lead's own model. Set READER_MODEL to another, to keep them apart.")
    run = RunFile(runs)
    status = 0
    # A kill, as from a timeout, raises SystemExit, so the service and its data still go.
    previous = signal.signal(signal.SIGTERM, _exit)
    try:
        with (
            with_candidate(Path(options.skill_dir)) if candidate else contextlib.nullcontext() as skills_dir,
            Service() as first,
        ):
            first.seed()
            chosen = choose(first, cases, options.limit)
            if not chosen:
                print("No cases to run.", file=sys.stderr)
                return 1
            if candidate:
                print(f"With {candidate['skill']}'s candidate {candidate['version']} in place of its live instructions.", flush=True)
            if not asyncio.run(_run(first, chosen, run, client, real, not options.no_skills, skills_dir, candidate)):
                status = 1
    except SetupError as error:
        print(error, file=sys.stderr)
        status = 1
    except KeyboardInterrupt:
        print("Stopped.", file=sys.stderr)
        status = 130
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_DFL if previous is None else previous)
    if run.count:
        shown = run.path.relative_to(ROOT) if run.path.is_relative_to(ROOT) else run.path
        answers = f"{run.count} {'answer' if run.count == 1 else 'answers'}"
        print(f"\nKept {answers} in {shown}, and each case's log in {shown.with_suffix('')}/.\n", flush=True)
        score(run.path)
    return status


def _exit(signal_number: int, _frame: object) -> NoReturn:
    raise SystemExit(128 + signal_number)
