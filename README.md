# Transit Agents

A service where AI agents do the first pass of transit planning studies. Every
number traces to the page it came from, and planners make every decision.

## What is real

- **Studies:** two proposals from the TTC's 2026 Annual Network Plan.
  Lawrence–Sunnybrook passed its tests and was adopted. Sherbourne–Castle Frank
  passed the travel-time test, but consultation was split, and it was not
  adopted. Every figure is checked against the plan's text.
- **Service** (log, guarantees, API, webhooks, watched folder): built and tested.
- **Collector:** built, measuring Lawrence–Sunnybrook's reliability live from
  the public TTC feed. The 12-month trial began on November 1, 2026.
- **Display:** built. Lighthouse, measured locally: performance 98 mobile and 99
  desktop; 100 for accessibility, best practices and SEO. No axe violations.
- **Agents and skills:** not built here. `npm run replay` stands in for an agent
  with an agent token, logged as `agent:replay`. It reports no tokens or cost
  because it spends none.

## Run it

Needs Node 24 or later. Poppler (`pdftotext`) is optional, for uploaded PDFs.

```sh
npm install
npm run build              # build the display
npm run collect            # in its own terminal: record live vehicles
npm run demo -- --fresh    # start the service and load the public sources
npm run replay             # play the scripted agent run
npm run decide             # a planner rates consultation and records decisions
```

Open http://127.0.0.1:4100. The demo switches on open access, so this machine
acts as a planner. Never use open access on a shared network.

Space plays time; the speed button steps from real time to a week a second.
Vehicles are live at the present moment, and scheduled otherwise until the
published timetable ends.

For a second screen, http://127.0.0.1:4100/spend shows what the agents have
spent: dollars, tokens and model calls. Use the browser's full screen.

Checks: `npm test` (233 tests) and `npm run typecheck`.

## Plug in your agents

Agents call the same API as every other client. Schema: `GET /openapi.json`.
Routes and roles: [docs/system.md](docs/system.md). Planner-only calls return
403 to agents.

Start the service with one token per role:

```sh
TRANSIT_TOKENS=agent:lead:SECRET1,planner:ana:SECRET2,integration:hastus:SECRET3 npm run serve
```

An agent's working loop:

```sh
# Open a study
curl -X POST localhost:4100/v1/studies -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' -d '{"id":"my-study","title":"My study"}'

# Report activity and spend
curl -X POST localhost:4100/v1/studies/my-study/activity -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' \
  -d '{"kind":"usage","model":"gemini-3.8-flash","inputTokens":1200,"outputTokens":300,"costUsd":0.01}'

# Add a figure: rejected unless the quote is on that page and contains the value
curl -X POST localhost:4100/v1/studies/my-study/figures -H 'authorization: Bearer SECRET1' \
  -H 'content-type: application/json' \
  -d '{"id":"riders","label":"Riders","value":1680,"basis":{"kind":"cited","citation":{"contextId":"ttc-anp-2026","page":118,"quote":"weekly system ridership increase of 1,680 customers"}}}'

# Hear about everything, live
curl -N 'localhost:4100/v1/events?access_token=SECRET1'
```

Python agents can connect over MCP instead, at `/v1/mcp`. Every route except
the event stream, webhook subscriptions and file upload is a tool, and an agent
sees only the tools its role may call. With `pip install mcp google-genai`
(mcp 2.3, google-genai 3.0), and `TRANSIT_TOKEN_AGENT` and `GEMINI_API_KEY` set:

```python
import asyncio
import os

import httpx2
from google import genai
from google.genai import types
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

MODEL = "gemini-3.8-flash"
STUDY = "route-52"


async def main():
    token = os.environ["TRANSIT_TOKEN_AGENT"]
    async with (
        httpx2.AsyncClient(headers={"authorization": f"Bearer {token}"}) as http,
        streamable_http_client("http://127.0.0.1:4100/v1/mcp", http_client=http) as (read, write),
        ClientSession(read, write) as session,
        # Hold the client: google-genai closes its connections once it's dropped.
        genai.Client().aio as gemini,
    ):
        server = await session.initialize()
        await session.call_tool("open_study", {"id": STUDY, "title": "Route 52"})
        # A dict, with client.aio.models. A GenerateContentConfig or the chat API
        # copies the config, which fails with a live session, and the sync
        # client refuses MCP sessions. Gemini gets the server's rules as
        # instructions. The tool loop runs here, not in google-genai, so this
        # code can report each model call's tokens: the model can't see them.
        config = {
            "tools": [session],
            "system_instruction": server.instructions,
            "automatic_function_calling": {"disable": True},
        }
        prompt = f"Add route 52's weekly riders to study {STUDY}, with a citation."
        contents = [types.Content(role="user", parts=[types.Part(text=prompt)])]
        for _ in range(30):
            response = await gemini.models.generate_content(model=MODEL, contents=contents, config=config)
            usage = response.usage_metadata
            await session.call_tool("report_activity", {
                "studyId": STUDY, "kind": "usage", "model": MODEL,
                "inputTokens": usage.prompt_token_count or 0,
                # Thinking is billed as output. Add "costUsd" at your model's prices.
                "outputTokens": (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0),
            })
            if not response.function_calls:
                print(response.text)
                break
            contents.append(response.candidates[0].content)
            parts = []
            for call in response.function_calls:
                result = await session.call_tool(call.name, call.args or {})
                # Each result once: structured when it's an object, else the text.
                answer = result.structured_content or result.content[0].text
                key = "error" if result.is_error else "output"
                parts.append(types.Part.from_function_response(name=call.name, response={key: answer}))
            contents.append(types.Content(role="user", parts=parts))
        else:
            print("Stopped after 30 model calls")


asyncio.run(main())
```

## Repo

- `services/api`: the service and the collector (`collect.ts`)
- `apps/display`: the display, Preact with a WebGL map in a worker
- `packages/contracts`: types and schemas shared by every client
- `clients`: seed, replay and decide, via the public API
- `evals`: eval cases, inputs and scorer
- `scripts`: data pipelines from GTFS and the plan PDFs
- `docs`: [system and API](docs/system.md),
  [decisions, made and open](docs/decisions.md),
  [what agents should do](docs/queries.md), [eval set](docs/evals.md),
  [PNNL-style benchmark](docs/benchmark.md), [skills to build](docs/skills.md),
  [fast rollout](docs/rollout.md), [corrections to the report](docs/report-corrections.md)

## Data

TTC schedules and live positions come from the City of Toronto's
[Open Data portal](https://open.toronto.ca/), under the Open Government
Licence – Toronto. Plan and standards pages are from public TTC documents,
included as text and page images for checking citations.
