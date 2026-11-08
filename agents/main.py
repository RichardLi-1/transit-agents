"""Lead agent: Gemini, working through the Transit Agents service's tools over MCP.

    python main.py           listen: answer each message a planner sends from the display's chat
    python main.py "task"    run one task on study route-52, then stop
"""

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import dotenv
import httpx2
from google import genai
from google.genai import types
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

HERE = Path(__file__).parent
dotenv.load_dotenv(HERE / ".env")

SERVICE_URL = os.environ.get("TRANSIT_URL", "http://127.0.0.1:4100")
MODEL = "gemini-3.6-flash"  # 3.8 Flash is often overloaded
MAX_MODEL_CALLS = 30
POLL_SECONDS = 3


def agent_token() -> str:
    # For Fly, set TRANSIT_TOKEN_AGENT. Locally, the demo writes new tokens each time it
    # starts; "lead" is the one for your own agents.
    if token := os.environ.get("TRANSIT_TOKEN_AGENT"):
        return token
    tokens = json.loads((HERE.parent / "data/demo-tokens.json").read_text())
    return tokens.get("lead") or tokens["agent"]


def gemini() -> genai.Client:
    # Retry busy (503) and rate-limit (429) errors, waiting 2, 4, 8, 16, 32, then 60 seconds.
    # The free tier allows 5 requests a minute and can ask for a wait of about a minute.
    retry = types.HttpRetryOptions(attempts=8, initial_delay=2, max_delay=60)
    return genai.Client(http_options=types.HttpOptions(retry_options=retry))


@asynccontextmanager
async def connect():
    """Open the MCP session to the service and the Gemini client, and hold both open."""
    async with (
        httpx2.AsyncClient(headers={"authorization": f"Bearer {agent_token()}"}) as http,
        streamable_http_client(f"{SERVICE_URL}/v1/mcp", http_client=http) as (read, write),
        ClientSession(read, write) as session,
        # Hold the client open: google-genai closes its connections once it's dropped.
        gemini().aio as client,
    ):
        server = await session.initialize()
        yield session, client, server.instructions


async def call(session: ClientSession, tool: str, arguments: dict):
    """Call a service tool and return its JSON, or raise with the service's message."""
    result = await session.call_tool(tool, arguments)
    text = result.content[0].text if result.content else ""
    if result.is_error:
        raise RuntimeError(f"{tool}: {text}")
    return result.structured_content if result.structured_content is not None else json.loads(text or "null")


async def work(session: ClientSession, client, instructions: str, study: str, task: str) -> str:
    """Run Gemini on one task, with the service's tools, reporting each model call's tokens."""
    # A dict, not GenerateContentConfig: the SDK copies config objects, and a live
    # session can't be copied. The tool loop runs here, not in the SDK, so each
    # model call's tokens get reported: the model can't see them itself.
    config = {
        "tools": [session],
        "system_instruction": instructions,
        "automatic_function_calling": {"disable": True},
    }
    contents = [types.Content(role="user", parts=[types.Part(text=task)])]
    for _ in range(MAX_MODEL_CALLS):
        response = await client.models.generate_content(model=MODEL, contents=contents, config=config)
        if usage := response.usage_metadata:
            await session.call_tool("report_activity", {
                "studyId": study,
                "kind": "usage",
                "model": MODEL,
                "inputTokens": usage.prompt_token_count or 0,
                # Thinking is billed as output.
                "outputTokens": (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0),
            })
        if not response.function_calls:
            return response.text or ""
        contents.append(response.candidates[0].content)
        parts = []
        for function_call in response.function_calls:
            result = await session.call_tool(function_call.name, function_call.args or {})
            # Send each result once: structured when it's an object, else the text.
            answer = result.structured_content or (result.content[0].text if result.content else "")
            key = "error" if result.is_error else "output"
            parts.append(types.Part.from_function_response(name=function_call.name, response={key: answer}))
        contents.append(types.Content(role="user", parts=parts))
    return f"Stopped after {MAX_MODEL_CALLS} model calls."


async def reply(session: ClientSession, client, instructions: str, study: str, question: str) -> None:
    """Answer one planner message in the study's chat, showing the run while it works."""
    await session.call_tool("report_activity", {"studyId": study, "kind": "run.started"})
    try:
        text = await work(session, client, instructions, study, f"A planner asked, in study {study}: {question}")
    except Exception as error:  # say so in the chat, and keep listening
        text = f"That failed: {error}"
    await session.call_tool("report_activity", {"studyId": study, "kind": "message", "text": (text or "Done.")[:4000]})
    await session.call_tool("report_activity", {"studyId": study, "kind": "run.finished"})


async def listen() -> None:
    """Answer each message a planner sends from the display, until stopped."""
    async with connect() as (session, client, instructions):
        after = (await call(session, "get_log_head", {}))["seq"]
        print(f"Listening for planners' messages on {SERVICE_URL}. Stop with Ctrl+C.")
        while True:
            for entry in await call(session, "read_log", {"after": after, "limit": 100}):
                after = entry["seq"]
                data = entry.get("data") or {}
                is_planner_message = (
                    entry["type"] == "activity"
                    and data.get("kind") == "message"
                    and entry["actor"].startswith("planner:")
                    and entry.get("studyId")
                )
                if is_planner_message:
                    print(f"{entry['studyId']}: {data['text']}")
                    await reply(session, client, instructions, entry["studyId"], data["text"])
            await asyncio.sleep(POLL_SECONDS)


async def run_once(study: str, title: str, task: str) -> str:
    async with connect() as (session, client, instructions):
        # Usage is recorded per study, so open it first. An error here means it's already open.
        await session.call_tool("open_study", {"id": study, "title": title})
        return await work(session, client, instructions, study, task)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        print(asyncio.run(run_once("route-52", "Route 52", " ".join(sys.argv[1:]))))
    else:
        try:
            asyncio.run(listen())
        except KeyboardInterrupt:
            pass
