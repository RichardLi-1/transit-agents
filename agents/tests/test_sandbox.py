"""Skills' scripts run in a sandboxed process of their own, never in the agent's: no
secrets in their environment, no session, service calls only through the agent and only
those the specialist may make, and, on macOS, nothing of the repo's secrets to read."""

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from mcp.types import CallToolResult, TextContent

import core
import sandbox
import skills
import specialists

REPO = Path(__file__).resolve().parents[2]

SCRIPT = """\
import json
import os
import socket
import sys
from pathlib import Path

from core import LocalTool, call


def tools(session, study):
    async def ask(tool, arguments=None):
        return await call(session, tool, arguments or {})

    def environment():
        return {"environ": dict(os.environ), "modules": sorted(name for name in sys.modules if name.startswith(("google", "mcp", "httpx")))}

    def read(path):
        try:
            return {"read": Path(path).read_text()[:40]}
        except OSError as error:
            return {"refused": type(error).__name__}

    def write(path):
        Path(path).write_text("planted")
        return "written"

    def connect(port):
        socket.create_connection(("127.0.0.1", int(port)), timeout=2).close()
        return "connected"

    return [
        LocalTool("ask", "Call a service tool.", ask),
        LocalTool("environment", "The environment.", environment),
        LocalTool("read", "Read a file.", read),
        LocalTool("write", "Write a file.", write),
        LocalTool("connect", "Connect.", connect),
    ]
"""


class FakeSession:
    """Answers every tool call with its arguments, and keeps the calls it was asked to make."""

    def __init__(self):
        self.calls = []

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return CallToolResult(content=[TextContent(type="text", text=json.dumps({"tool": name, "arguments": arguments}))])


class SandboxTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        folder = self.root / "probe"
        folder.mkdir()
        (folder / "SKILL.md").write_text("---\nname: probe\ndescription: Probe the sandbox.\n---\nProbe.\n")
        (folder / "tools.py").write_text(SCRIPT)
        (folder / "notes.txt").write_text("the skill's own file")
        self.skill = skills.load_skill("probe", self.root)
        self.session = FakeSession()

    def tools(self, allowed=("get_study", "record_figure")):
        made = skills.skill_tools(self.skill, self.session, "study-a", allowed=allowed)
        return {tool.name: tool.function for tool in made}

    async def test_makes_only_the_service_calls_the_specialist_may(self):
        ask = self.tools()["ask"]
        self.assertEqual(await ask(tool="get_study", arguments={"studyId": "study-a"}), {"tool": "get_study", "arguments": {"studyId": "study-a"}})
        for tool in ("record_decision", "approve_skill", "set_rule", "report_activity", "read_log"):
            with self.subTest(tool), self.assertRaisesRegex(core.ToolError, f"probe's scripts may not call {tool}"):
                await ask(tool=tool, arguments={"studyId": "study-a"})
        with self.assertRaisesRegex(core.ToolError, "writes only to study study-a"):
            await ask(tool="record_figure", arguments={"studyId": "study-b"})
        # Refused here, so the session never saw them.
        self.assertEqual([name for name, _ in self.session.calls], ["get_study"])

    async def test_the_specialists_allowlist_is_its_tools_and_its_skills_own(self):
        self.assertIn("add_engagement_need", specialists.SCRIPT_TOOLS["engagement-needs"])
        self.assertNotIn("add_engagement_need", specialists.TOOLS)
        for allowed in specialists.SCRIPT_TOOLS.values():
            self.assertFalse(allowed & core.PLANNER_ONLY)
            self.assertFalse(allowed & core.CODE_ONLY)
        ask = {tool.name: tool.function for tool in specialists.script_tools(self.skill, self.session, "study-a")}["ask"]
        with self.assertRaisesRegex(core.ToolError, "may not call add_engagement_need"):
            await ask(tool="add_engagement_need", arguments={"studyId": "study-a"})

    async def test_a_computed_figure_names_the_version_the_loader_hashed(self):
        basis = {"kind": "computed", "skill": "trial-monitor", "version": "a" * 64, "run": "weeks 1-2"}
        figure = {"studyId": "study-a", "id": "x", "label": "X", "value": 1, "basis": basis}
        await self.tools()["ask"](tool="record_figure", arguments=figure)
        [(_, sent)] = self.session.calls
        self.assertEqual(sent["basis"], {**basis, "skill": "probe", "version": self.skill.hash})

    async def test_runs_with_no_secrets_and_none_of_the_agents_packages(self):
        secrets = {
            "GEMINI_API_KEY": "AIza-secret",
            "TRANSIT_TOKEN_AGENT": "agent-secret",
            "TRANSIT_TOKEN_PLANNER": "planner-secret",
            "MODEL_API_KEY": "model-secret",
            "SLACK_BOT_TOKEN": "slack-secret",
            "TZ": "America/Toronto",
        }
        with mock.patch.dict(os.environ, secrets):
            seen = await self.tools()["environment"]()
        # Python and macOS add their locale settings, nothing more.
        self.assertLessEqual(set(seen["environ"]), {"PATH", "TZ", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"})
        self.assertEqual(seen["environ"]["TZ"], "America/Toronto")
        self.assertFalse(set(secrets.values()) - {"America/Toronto"} & set(seen["environ"].values()))
        self.assertEqual(seen["modules"], [])

    async def test_runs_only_the_version_it_was_loaded_at(self):
        tools = self.tools()
        (self.skill.folder / "tools.py").write_text(SCRIPT + "\n# changed\n")
        with self.assertRaisesRegex(RuntimeError, "probe changed after it was loaded"):
            await tools["environment"]()

    async def test_a_scripts_error_comes_back_as_it_raised_it(self):
        with self.assertRaises(FileNotFoundError):
            await self.tools()["write"](path=str(self.root / "missing" / "x.txt"))

    @unittest.skipUnless(sandbox.sandboxed(), "sandbox-exec is macOS's")
    async def test_on_macos_reads_nothing_of_the_repos_secrets_or_other_skills(self):
        data = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (data / "demo-tokens.json").write_text('{"planner": "planner-secret"}')
        (data / ".env").write_text("GEMINI_API_KEY=AIza-secret")
        (data / ".env.local").write_text("GEMINI_API_KEY=AIza-secret")
        elsewhere = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (elsewhere / "settings.env").write_text("not a dotenv file")
        (elsewhere / ".env").write_text("GEMINI_API_KEY=AIza-secret")
        with mock.patch.dict(os.environ, {"DATA_DIR": str(data)}):
            read = self.tools()["read"]
            refused = {
                "data": await read(path=str(data / "demo-tokens.json")),
                "evals": await read(path=str(REPO / "evals" / "cases.jsonl")),
                "repo data": await read(path=str(REPO / "data" / "demo-tokens.json")),
                "skill": await read(path=str(skills.SKILLS_DIR / "handover" / "SKILL.md")),
                "home": await read(path=str(Path.home() / ".zshrc")),
                "env": await read(path=str(elsewhere / ".env")),
                "env.local": await read(path=str(data / ".env.local")),
            }
            allowed = {
                "own": await read(path=str(self.skill.folder / "notes.txt")),
                "repo": await read(path=str(REPO / "apps" / "display" / "public" / "data" / "studies.json")),
                "not a .env": await read(path=str(elsewhere / "settings.env")),
            }
        self.assertTrue((REPO / "evals" / "cases.jsonl").is_file())
        for name in ("data", "evals", "skill", "env", "env.local"):
            self.assertEqual(refused[name], {"refused": "PermissionError"}, name)
        self.assertNotIn("read", refused["repo data"])
        self.assertNotIn("read", refused["home"])
        self.assertEqual(allowed["own"], {"read": "the skill's own file"})
        self.assertIn("read", allowed["repo"])
        self.assertEqual(allowed["not a .env"], {"read": "not a dotenv file"})

    @unittest.skipUnless(sandbox.sandboxed(), "sandbox-exec is macOS's")
    async def test_on_macos_writes_nothing_and_reaches_no_network(self):
        tools = self.tools()
        with self.assertRaises(PermissionError):
            await tools["write"](path=str(self.root / "planted.txt"))
        self.assertFalse((self.root / "planted.txt").exists())
        with self.assertRaises(PermissionError):
            await tools["connect"](port=4171)

    def test_without_sandbox_exec_says_it_runs_with_the_environment_scrubbed_only(self):
        with mock.patch.object(sandbox, "sandboxed", return_value=False), mock.patch.object(sandbox, "_said_unsandboxed", False):
            with mock.patch("sys.stderr") as stderr:
                command = sandbox.command(sandbox.Script("probe", self.skill.folder, self.skill.hash, "s", frozenset()))
                sandbox.command(sandbox.Script("probe", self.skill.folder, self.skill.hash, "s", frozenset()))
        self.assertEqual(command[0], sandbox.sys.executable)
        said = "".join(call.args[0] for call in stderr.write.call_args_list)
        self.assertEqual(said.count("Skill scripts run without sandbox-exec"), 1)


if __name__ == "__main__":
    unittest.main()
