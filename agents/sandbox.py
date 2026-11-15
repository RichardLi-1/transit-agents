"""Runs skills' scripts outside the agent's process, each call in a new sandboxed Python.

A skill's tools.py never runs in the agent, which holds the service session, API keys in
its environment and a disk with planners' tokens, the eval cases and the log. Each call
to a script's tool starts skill_runner.py in a new process:

- with an empty environment: no API keys, no tokens;
- in the skill's folder, which it checks still has the version the loader approved;
- on macOS, inside sandbox-exec, with no network, no writes, and nothing to read in the
  user's home but the repo, and in the repo nothing of data/ (or DATA_DIR), evals/, any
  .env file, git or the other skills, except the skills its scripts load. Without
  sandbox-exec, as on Linux, it runs with the empty environment only, and says so once.

The script's calls to the service come back over a pipe. The agent makes each with its
own session, only if it's on the specialist's allowlist and writes only to the run's
study, and stamps a computed figure with the skill's name and the content hash the loader
approved: a script can't name its own version.
"""

import asyncio
import builtins
import json
import os
import subprocess
import sys
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import core
from skill_runner import LIMIT

RUNNER = Path(__file__).resolve().with_name("skill_runner.py")
REPO = RUNNER.parent.parent
LIVE_SKILLS = RUNNER.parent / "skills"

# The longest a call to a script may take, its service calls included.
TIMEOUT_S = 300

SANDBOX_EXEC = "/usr/bin/sandbox-exec"

_said_unsandboxed = False


@dataclass(frozen=True)
class Script:
    """A skill's scripts as the loader approved them, and what they may reach."""

    skill: str
    folder: Path
    version: str  # the folder's content hash, which a planner approved
    study: str
    allowed: frozenset[str]  # the service tools their calls may make
    reads: tuple[tuple[Path, str], ...] = ()  # other skills' folders their scripts load, and their versions


class ScriptError(RuntimeError):
    """A script that couldn't start, or stopped without an answer."""


def sandboxed() -> bool:
    """Whether scripts run inside sandbox-exec: on macOS, where it is."""
    return sys.platform == "darwin" and os.access(SANDBOX_EXEC, os.X_OK)


def environment() -> dict[str, str]:
    """A script's whole environment: a PATH, and the time zone, for dates. No keys or tokens."""
    env = {"PATH": "/usr/bin:/bin"}
    if zone := os.environ.get("TZ"):
        env["TZ"] = zone
    return env


def _quoted(path: Path | str) -> str:
    return json.dumps(str(path), ensure_ascii=False)


def _paths(rule: str, kind: str, paths: Collection[Path]) -> str:
    """One rule over several paths, each as given and as its links resolve."""
    every: list[str] = []
    for path in paths:
        for one in (Path(path), Path(path).resolve()):
            if (text := f"({kind} {_quoted(one)})") not in every:
                every.append(text)
    return f"({rule} file-read* {' '.join(every)})" if every else ""


def _with_links(folder: Path) -> list[Path]:
    """A folder, and what the links in it point to, as in a candidate's folder of links."""
    found = [folder]
    if folder.is_dir():
        found += [entry.resolve() for entry in folder.iterdir() if entry.is_symlink()]
    return found


def profile(script: Script) -> str:
    """The sandbox-exec profile for a script. The last rule that matches a path wins."""
    data = Path(os.environ.get("DATA_DIR") or REPO / "data")
    secret = [REPO / "data", data, REPO / "evals", REPO / ".git", REPO / "agents" / "skill-candidates", LIVE_SKILLS, script.folder.parent]
    # The private test split, wherever it is, in the eval runner's process, the only one
    # that has it.
    if private := os.environ.get("EVAL_PRIVATE_DIR", "").strip():
        secret.append(Path(private).expanduser())
    own = [*_with_links(script.folder), *(path for folder, _ in script.reads for path in _with_links(folder))]
    python = [Path(sys.prefix), Path(sys.base_prefix), Path(sys.executable).resolve().parent]
    rules = [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        "(deny file-write*)",
        '(allow file-write* (literal "/dev/null"))',
        # Nothing of the user's: keys, other checkouts and their data.
        _paths("deny", "subpath", [Path.home()]),
        # The repo, for files scripts read, such as the timetable, but not its secrets,
        # the eval cases, the log or other skills.
        _paths("allow", "subpath", [REPO]),
        _paths("deny", "subpath", secret),
        _paths("allow", "subpath", [*own, *python]),
        _paths("allow", "literal", [RUNNER]),
        # Finding a file by its path needs its folders' metadata, never their contents.
        "(allow file-read-metadata)",
        '(deny file-read* (regex #"/\\.env(\\.[^/]*)?$"))',
    ]
    return "\n".join(rule for rule in rules if rule)


def command(script: Script) -> list[str]:
    """The command that runs skill_runner.py for this script."""
    python = [sys.executable, "-I", "-B", "-X", "utf8", str(RUNNER)]
    if sandboxed():
        return [SANDBOX_EXEC, "-p", profile(script), *python]
    global _said_unsandboxed
    if not _said_unsandboxed:
        _said_unsandboxed = True
        print(
            "Skill scripts run without sandbox-exec, which this system doesn't have: only their environment is "
            "scrubbed, so they can still read and write what this user can, and reach the network.",
            file=sys.stderr,
            flush=True,
        )
    return python


def describe(script: Script) -> list[dict[str, Any]]:
    """The tools the script declares: name, description, parameters and at_once. Making
    them calls no service tool, so this waits for its process, as loading tools.py did."""
    start = {**_start(script), "call": None}
    try:
        done = subprocess.run(
            command(script),
            input=(json.dumps(start) + "\n").encode("utf-8"),
            stdout=subprocess.PIPE,
            cwd=script.folder,
            env=environment(),
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ScriptError(f"{script.skill}'s scripts couldn't start: {error}") from error
    lines = done.stdout.decode("utf-8").splitlines()
    message = json.loads(lines[-1]) if lines else {}
    if "error" in message:
        raise _as_raised(message)
    if not isinstance(message.get("tools"), list):
        raise ScriptError(f"{script.skill}'s scripts stopped without declaring their tools. The agent's terminal says why.")
    return message["tools"]


def _start(script: Script) -> dict[str, Any]:
    """What the script's process is told first: what to load, at which versions, for which study."""
    uses = [{"folder": str(folder), "hash": version} for folder, version in script.reads]
    return {"folder": str(script.folder), "hash": script.version, "study": script.study, "uses": uses}


async def call(script: Script, session: Any, tool: str, arguments: dict[str, Any]) -> Any:
    """Call one of the script's tools in a new sandboxed process, and return what it returns."""
    return (await _run(script, session, {"tool": tool, "arguments": arguments}))["output"]


async def _run(script: Script, session: Any, asked: dict[str, Any] | None) -> dict[str, Any]:
    try:
        process = await asyncio.create_subprocess_exec(
            *command(script),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            cwd=script.folder,
            env=environment(),
            limit=LIMIT,
        )
    except OSError as error:
        raise ScriptError(f"{script.skill}'s scripts couldn't start: {error}") from error
    assert process.stdin is not None and process.stdout is not None
    stdin, stdout = process.stdin, process.stdout

    async def send(message: dict[str, Any]) -> None:
        stdin.write((json.dumps(message, ensure_ascii=False, default=str) + "\n").encode("utf-8"))
        await stdin.drain()

    async def answer(message: dict[str, Any]) -> None:
        try:
            output = await _serve(script, session, str(message.get("service")), message.get("arguments") or {})
            reply: dict[str, Any] = {"id": message.get("id"), "output": output}
        except core.ToolError as error:
            reply = {"id": message.get("id"), "error": error.message}
        except Exception as error:  # such as the session dropping: the script says so
            reply = {"id": message.get("id"), "error": f"{type(error).__name__}: {error}"}
        try:
            await send(reply)
        except (BrokenPipeError, ConnectionResetError):  # the script stopped meanwhile
            pass

    async def converse() -> dict[str, Any]:
        await send({**_start(script), "call": asked})
        answering: set[asyncio.Task[None]] = set()
        try:
            while line := await stdout.readline():
                message = json.loads(line)
                if "service" not in message:
                    return message
                task = asyncio.create_task(answer(message))
                answering.add(task)
                task.add_done_callback(answering.discard)
        finally:
            for task in answering:
                task.cancel()
            await asyncio.gather(*answering, return_exceptions=True)
        raise ScriptError(f"{script.skill}'s script stopped without an answer. The agent's terminal says why.")

    answered = False
    try:
        async with asyncio.timeout(TIMEOUT_S):
            message = await converse()
        answered = True
    except TimeoutError:
        raise ScriptError(f"{script.skill}'s script took over {TIMEOUT_S} s, so it was stopped.") from None
    finally:
        if process.returncode is None and answered:
            stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                answered = False
        if process.returncode is None and not answered:
            process.kill()
            await process.wait()
    if "error" in message:
        raise _as_raised(message)
    return message


async def _serve(script: Script, session: Any, tool: str, arguments: dict[str, Any]) -> Any:
    """Make a script's service call with the agent's session, if it may make it."""
    if tool in core.CODE_ONLY or tool not in script.allowed:
        raise core.ToolError(tool, f"{script.skill}'s scripts may not call {tool}.")
    if (key := core.WRITES.get(tool)) and arguments.get(key) != script.study:
        raise core.ToolError(tool, f"this run writes only to study {script.study}, so {key} must be {script.study!r}.")
    basis = arguments.get("basis")
    if tool == "record_figure" and isinstance(basis, dict) and basis.get("kind") == "computed":
        # The version the loader hashed and a planner approved, never one the script names.
        arguments = {**arguments, "basis": {**basis, "skill": script.skill, "version": script.version}}
    return await core.call(session, tool, arguments)


def _as_raised(message: dict[str, Any]) -> Exception:
    """The script's error, as the script raised it where that's a built-in error."""
    kind, said = str(message.get("kind")), str(message.get("error"))
    if kind == "ToolError":
        return core.ToolError(str(message.get("tool")), str(message.get("message")))
    found = getattr(builtins, kind, None)
    if isinstance(found, type) and issubclass(found, Exception) and found is not KeyError:
        try:
            return found(said)
        except TypeError:  # one that takes other arguments
            pass
    return RuntimeError(f"{kind}: {said}")


def tools(script: Script, session: Any, declared: Sequence[dict[str, Any]]) -> list[core.LocalTool]:
    """The script's tools for the specialist: each call runs in a sandboxed process of its own."""

    def tool(spec: dict[str, Any]) -> core.LocalTool:
        name = str(spec["name"])

        async def run(**arguments: Any) -> Any:
            return await call(script, session, name, arguments)

        parameters = spec.get("parameters") or {"type": "object", "properties": {}}
        return core.LocalTool(name, str(spec.get("description") or ""), run, parameters, spec.get("at_once"))

    return [tool(spec) for spec in declared]
