"""Runs a skill's script in a process of its own, for agents/sandbox.py, and hashes skill folders.

The agents never import a skill's tools.py. sandbox.py starts this file in a new Python,
with an empty environment, the skill's folder as its working directory and, on macOS,
inside sandbox-exec, then talks to it over stdin and stdout, one JSON message a line:

    agent -> script   {"folder", "hash", "study", "uses", "call": {"tool", "arguments"} or null}
    script -> agent   {"service", "arguments", "id"}   a service tool call, which
    agent -> script   {"id", "output"} or {"id", "error"}   the agent makes, or refuses
    script -> agent   {"tools": [...]}, {"output": ...} or {"error", "kind"}   the end

It checks that the folder still hashes to the version the agent loaded, and runs those
bytes. The script gets what it imports from core, LocalTool, ToolError and call, from
here: call sends each service call to the agent, which holds the session, checks the
call against the specialist's allowlist and makes it. The script never holds a session
or a token. Only the standard library is used, so the agent's packages are never loaded.

A skill's version is the SHA-256 of its folder (files_hash): each file, in the order of
its path's bytes, adds its path in the folder (with "/"), a NUL, its length in bytes, a
NUL, then its bytes. __pycache__ folders, .pyc files and .DS_Store are left out: Python
and Finder write them, and nobody reviews them. clients/skill-hash.ts computes the same.
"""

import asyncio
import hashlib
import inspect
import itertools
import json
import os
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# The longest message either side sends: a study, or a layer's summary, can be long.
LIMIT = 64 * 1024 * 1024

# Never a folder: so code loaded from a skill's folder is compiled from its source,
# never from bytecode beside it, which the hash leaves out.
NO_BYTECODE = "/var/empty/transit-agents-skill-bytecode"


def left_out(name: str, folder: bool) -> bool:
    """Whether a file or folder in a skill's folder is left out of its hash."""
    return name == "__pycache__" if folder else name == ".DS_Store" or name.endswith(".pyc")


def folder_files(folder: Path) -> dict[str, bytes]:
    """The files in a skill's folder that its hash covers, by path in the folder, in the
    order they're hashed. Links are followed, so a folder of links hashes as a copy would."""
    found: dict[str, bytes] = {}
    for top, folders, names in os.walk(folder, followlinks=True):
        folders[:] = [name for name in folders if not left_out(name, True)]
        for name in names:
            path = Path(top, name)
            if not left_out(name, False) and path.is_file():
                found[path.relative_to(folder).as_posix()] = path.read_bytes()
    return dict(sorted(found.items(), key=lambda item: item[0].encode("utf-8")))


def files_hash(files: dict[str, bytes]) -> str:
    """The version of a skill whose folder holds these files, as folder_files reads them."""
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda name: name.encode("utf-8")):
        data = files[path]
        digest.update(path.encode("utf-8") + b"\0" + str(len(data)).encode() + b"\0" + data)
    return digest.hexdigest()


# --- What a script imports from core -------------------------------------------------


class ToolError(RuntimeError):
    """The service refused a tool call, or the agent refused to make it. The message is theirs."""

    def __init__(self, tool: str, message: str):
        super().__init__(f"{tool}: {message}")
        self.tool = tool
        self.message = message


@dataclass(frozen=True)
class LocalTool:
    """A function a model can call, declared with JSON Schema, as core.LocalTool is."""

    name: str
    description: str
    function: Any
    parameters: dict[str, Any] = field(default_factory=lambda: {"type": "object", "properties": {}})
    at_once: int | None = None


class NoSession:
    """What a script gets for the session: the agent keeps the real one."""

    def __repr__(self) -> str:
        return "<the agent's session, which this process never holds>"


class Agent:
    """The pipe to the agent: service calls out, their answers back."""

    def __init__(self, reader: asyncio.StreamReader, out: Any):
        self.reader = reader
        self.out = out
        self.ids = itertools.count(1)
        self.waiting: dict[int, asyncio.Future[dict[str, Any]]] = {}

    def send(self, message: dict[str, Any]) -> None:
        self.out.write(json.dumps(message, ensure_ascii=False, default=str) + "\n")
        self.out.flush()

    async def listen(self) -> None:
        """Hand each answer to the call waiting for it, until the agent closes the pipe."""
        while line := await self.reader.readline():
            message = json.loads(line)
            waiting = self.waiting.pop(message.get("id"), None)
            if waiting is not None and not waiting.done():
                waiting.set_result(message)
        for waiting in self.waiting.values():
            if not waiting.done():
                waiting.set_exception(ConnectionError("The agent closed the pipe."))

    async def call(self, tool: str, arguments: dict[str, Any]) -> Any:
        number = next(self.ids)
        answer = self.waiting[number] = asyncio.get_running_loop().create_future()
        self.send({"service": tool, "arguments": arguments, "id": number})
        reply = await answer
        if "error" in reply:
            raise ToolError(tool, str(reply["error"]))
        return reply.get("output")


AGENT: Agent | None = None


async def call(session: Any, tool: str, arguments: dict[str, Any] | None = None) -> Any:
    """Call a service tool through the agent, and return its JSON, or raise ToolError."""
    if AGENT is None:
        raise RuntimeError("No agent to call the service through.")
    return await AGENT.call(tool, dict(arguments or {}))


def as_core() -> types.ModuleType:
    """The core module a skill's script imports here: only what scripts use, and call through the agent."""
    module = types.ModuleType("core", "What a skill's script gets from the agent's core, in its own process.")
    module.LocalTool = LocalTool  # type: ignore[attr-defined]
    module.ToolError = ToolError  # type: ignore[attr-defined]
    module.call = call  # type: ignore[attr-defined]
    return module


# --- The script's process ------------------------------------------------------------


def load(folder: Path, version: str, study: str, uses: list[dict[str, str]] | None = None) -> list[LocalTool]:
    """The skill's tools, from the tools.py whose bytes hash, with the rest of its folder,
    to `version`, once each skill its scripts load still has the version it was loaded at."""
    files = folder_files(folder)
    if files_hash(files) != version:
        raise RuntimeError(f"{folder.name} changed after it was loaded, so it no longer has the version a planner approved.")
    for used in uses or []:
        if files_hash(folder_files(Path(used["folder"]))) != used["hash"]:
            raise RuntimeError(f"{Path(used['folder']).name}, whose scripts {folder.name} loads, changed after it was loaded.")
    source = files.get("tools.py")
    if source is None:
        return []
    sys.modules["core"] = as_core()
    # Anything the script loads from here on, such as another skill's tools.py, is
    # compiled from source, never from bytecode the hash doesn't cover.
    sys.pycache_prefix = NO_BYTECODE
    sys.dont_write_bytecode = True
    name = f"skill_{folder.name.replace('-', '_')}"
    module = types.ModuleType(name)
    module.__file__ = str(folder / "tools.py")
    sys.modules[name] = module  # so code in it that looks itself up, as dataclasses do, finds it
    exec(compile(source, module.__file__, "exec", dont_inherit=True), module.__dict__)
    make = getattr(module, "tools", None)
    if not callable(make):
        raise RuntimeError(f"{folder.name}/tools.py: define tools(session, study), returning the skill's tools")
    return list(make(NoSession(), study))


def declared(tool: LocalTool) -> dict[str, Any]:
    return {"name": tool.name, "description": tool.description, "parameters": tool.parameters, "at_once": tool.at_once}


def failed(error: BaseException) -> dict[str, Any]:
    """An error, for the agent to raise again as the script raised it."""
    said: dict[str, Any] = {"error": str(error), "kind": type(error).__name__}
    if isinstance(error, ToolError):
        said.update(tool=error.tool, message=error.message)
    return said


async def serve(out: Any) -> None:
    global AGENT
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=LIMIT)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    agent = AGENT = Agent(reader, out)
    start = json.loads(await reader.readline())
    listening = asyncio.create_task(agent.listen())
    try:
        tools = load(Path(start["folder"]), start["hash"], start["study"], start.get("uses") or [])
        asked = start.get("call")
        if asked is None:
            agent.send({"tools": [declared(tool) for tool in tools]})
            return
        found = {tool.name: tool for tool in tools}.get(asked["tool"])
        if found is None:
            raise RuntimeError(f"The skill has no tool named {asked['tool']}.")
        result = found.function(**(asked.get("arguments") or {}))
        if inspect.isawaitable(result):
            result = await result
        agent.send({"output": result})
    except Exception as error:
        agent.send(failed(error))
    finally:
        listening.cancel()


def main() -> None:
    # stdout carries only messages to the agent. What the script prints goes to stderr.
    out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    asyncio.run(serve(out))


if __name__ == "__main__":
    main()
