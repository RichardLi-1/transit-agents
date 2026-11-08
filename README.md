# Transit Agents

A service where AI agents do the first pass of transit planning studies. Every
number traces to the page it came from, and planners make every decision.

## What is real

- **Studies:** the lead study, Ontario Line: Don Mills extension, is
  hypothetical. Its figures come from the Ontario Line's business cases and TTC
  counts, or from formulas over them, Metrolinx's appraisal rules and values
  planners set. It waits for planners: no decision. Two more are real proposals
  from the TTC's 2026 Annual Network Plan. Lawrence–Sunnybrook passed its tests
  and was adopted. Sherbourne–Castle Frank passed the travel-time test, but
  consultation was split, and it was not adopted. Every cited figure is checked
  against its page.
- **Service** (log, guarantees, API, webhooks, watched folder): built and tested.
- **Collector:** built, measuring Lawrence–Sunnybrook's reliability live from
  the public TTC feed. The 12-month trial began on November 1, 2026.
- **Display:** built. Lighthouse, measured locally: performance 98 mobile and 99
  desktop; 100 for accessibility, best practices and SEO. No axe violations.
- **Agents and skills:** built, in Python on Gemini, working through the
  service's tools over MCP (`agents/`). A lead agent splits each question among
  specialists, who read the sources with skills such as the TTC's tests and
  record figures with their pages; the lead checks the citations and hands any
  judgement to a planner. Before an answer reaches the chat, any page it cites
  that the run didn't read, and no recorded figure or rule cites, is marked.
  The replay's work is scripted, and the display labels it so.

## Run it

Needs Node 24 or later, and Python 3.11 or later for the agents. Poppler
(`pdftotext`) is optional, for uploaded PDFs.

```sh
npm install
npm run build              # build the display
npm run collect            # in its own terminal: record live vehicles
npm run demo -- --fresh    # start the service and load the public sources
npm run replay             # play the scripted agent run, which needs no model
npm run decide             # a planner rates consultation and records decisions
npm run agent              # in its own terminal: Gemini answers the chat
```

For the agents, make `agents/.venv` with `agents/requirements.txt` installed,
and put `GEMINI_API_KEY` in `agents/.env`. If the demo runs with `DATA_DIR` or
`PORT` set, give the agent the same `DATA_DIR` and its `TRANSIT_URL`: the demo
prints the commands. A message sent while no agent runs gets no answer. To have
Gemini do a study's first pass instead of the replay:
`npm run agent -- run "<what to find>" --study <id>`. Agent runs stop at 60
model calls or US$2 each, and a listening agent at US$10 a day and 20 runs an
hour (see `agents/main.py` for the settings).

Open http://127.0.0.1:4100. The demo switches on open access, so this machine
acts as a planner. Never use open access on a shared network.

On studies with a trial, Space plays time; the speed button steps from real time
to a week a second. Other studies show the present. Vehicles are live at the
present moment, and scheduled otherwise until the published timetable ends.

Cards on the map are what a neighbourhood needs to hear about a change. A
planner presses Create, an agent makes the image or video, and the card shows
it; click it to view it.

For a second screen, http://127.0.0.1:4100/spend shows what the agents have
spent: dollars, tokens and model calls. Use the browser's full screen.

Checks: `npm test` (353 tests), `npm run typecheck`, and `npm run agent:test`
(198 Python tests, which never call Gemini; set `AGENT_TEST_PORT` and
`EVAL_PORTS` if ports 4171-4174 or 4175-4179 are taken).

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
the event stream, webhook subscriptions, and file uploads and downloads is a
tool, and an agent sees only the tools its role may call. A video is larger
than an MCP message may be, so an agent posts media to
`POST /v1/studies/{id}/needs/{need}/media` as a form, with its token. With `pip install mcp google-genai`
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

`agents/media.py` is one such agent. Once a planner asks for an engagement need
to be made, it has Gemini 3.6 Flash write prompts from the study's cited facts,
makes the image with Nano Banana 2 and the video with Omni Flash, has Gemini read
each one back, makes it once more if it shows words or numbers beyond its
headline, and attaches each file to the need. It claims each request before it spends anything, so two
agents never both pay for one. When it can't make something, it says why, and
nothing more is made until a planner asks again. It reports every call's tokens and cost, priced from
one table at the top of the file. At those prices an image costs about $0.07 and
a 4-second video about $0.28, so a need with both is about $0.35 with its prompts.
It spends at most $5 a day (`MEDIA_DAILY_LIMIT_USD`).

```sh
agents/.venv/bin/python agents/media.py listen  # until stopped
npm run agent:test                              # with a stand-in for Gemini
```

## Repo

- `services/api`: the service and the collector (`collect.ts`)
- `apps/display`: the display, Preact with a WebGL map in a worker
- `packages/contracts`: types and schemas shared by every client
- `agents`: the Gemini lead and specialists, their skills, the media agent and the eval runner
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
Licence – Toronto. Plan, standards and ridership pages are from public TTC
documents, and business case pages from public Metrolinx documents, included
as text and page images for checking citations. The Ontario Line and its
proposed extension are drawn from [OpenStreetMap](https://www.openstreetmap.org/copyright),
© OpenStreetMap contributors, under the Open Database License.
