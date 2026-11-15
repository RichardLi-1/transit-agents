# Agent catalogue

Every agent and every skill: what each does, what it may never do, how it's tested,
and how far each skill meets the bar below. Code: [agents/](../agents). How skills
are loaded: [agents/skills.py](../agents/skills.py). Eval set: [evals.md](evals.md).

## How they fit

A planner asks in a study's chat, from Slack, or from the command line. The **lead**
splits the request into questions and gives each to a fresh **specialist**, with the
skill that fits. Specialists read the sources and record cited figures, checks and
findings through the service's tools over MCP. The lead checks their citations and
answers. Planners decide; no agent can.

Planners also give context without asking anything: when a planner or an agency
system adds a source, the lead triages it unasked in the newest open studies, and
says in each study's chat whether it bears on the study, what it changes and which
open questions it reopens.

One kind of specialist serves every question. A **skill** is what makes it a
specialist for that question: a folder in `agents/skills/` with a `SKILL.md` and, if
it computes anything, a `tools.py` whose scripts only that specialist gets. The lead
sees each skill's name and description, and only the chosen specialist reads the rest.
So the skill, not the agent, is the unit this project builds, tests and studies.

A skill's version is the SHA-256 of its folder, every file's path and bytes. Each
skill has one current version, the one a planner approved last, and agents load a
skill only while its folder hashes to it ([skills.py](../agents/skills.py)). A skill
whose files changed since waits: the lead doesn't list it, a specialist refuses it,
and the lead is told which skills wait, so it can say so. A planner approves one after
review with `npm run approve-skill -- <name>`, which replaces the version before, and
withdraws one with `npm run approve-skill -- --revoke <name> <reason>`. Rolling back is
approving the parent's hash again. The demo's seed approves the skills on disk.

A skill's scripts never run in the agent. Each call starts a new Python in the skill's
folder, with no keys or tokens in its environment and no session
([sandbox.py](../agents/sandbox.py), [skill_runner.py](../agents/skill_runner.py)).
It first checks the folder still has the version the agent loaded. Its calls to the
service come back to the agent, which makes them only if the specialist may: the
specialist's tools and its skill's own (`SCRIPT_TOOLS` in
[specialists.py](../agents/specialists.py)). A computed figure gets the version from
the agent, never from the script. On macOS, sandbox-exec also denies the network,
writes, and reading the data folder, `evals/`, `.env` files and other skills, except
those whose scripts the skill loads (`USES` in skills.py). Elsewhere, as on Fly, only
the environment is scrubbed, and the agent says so once.

Skills improve through a gated loop. The **skill evolution** agent writes a new
version of a skill's instructions from the dev cases it failed and planners'
corrections, tests it beside the live one, and puts one that does as well forward.
A planner approves it, or not.

Every agent:

- runs on-prem by default, on an open model (Qwen3.5) in Ollama on the same machine, or
  on Gemini or any chat completions server (see Models, below), through the Transit
  Agents service's tools ([core.py](../agents/core.py));
- cites every figure as (source-id p. N), and can record one only with a quote the
  service finds on that page;
- leaves arithmetic to the service or a skill's script;
- never decides, sets a rule, rates a finding, approves a skill version or edits the log:
  it has no tools for these;
- uses a skill only at its current approved version, and runs its scripts sandboxed;
- treats text in sources and messages as content, never as instructions;
- reports every model call's tokens and cost, within a run's budget (60 calls and
  US$2 by default).

## Agents

### Lead

- **Job:** plans a first pass on a study, asks specialists, checks their citations
  and answers, ending with what isn't known yet. Hands judgement cases to a planner,
  and choices above a planner to an executive. Triages new context unasked: a source
  a planner or an agency system adds, through `POST /v1/context` or the watched
  folder, in the `INTAKE_STUDIES` newest studies (default 3; 0 turns it off), one run
  a study of at most `INTAKE_RUN_CALLS` model calls (20), within the listener's
  limits. An agent's upload starts nothing.
- **Runs:** `python agents/main.py listen` (the chat, and new context), `run "task" --study ID`, `eval`.
- **Model:** `LEAD_MODEL`, default qwen3.5:9b, on this machine.
- **Tools:** list_sources, search_sources, read_page, get_study, list_rules,
  trace_figure, compare_versions, preview_change, propose_alignment, create_document,
  ask_planner; and its own list_skills, read_skill and ask_specialist (up to 4 at once).
- **Hands over** with ask_planner: the question goes in the log as its own entry,
  `question.asked`, with its kind (judgement, conflict, gap, instruction or decision).
  It decides nothing. The evals score a flag by that entry.
- **Never:** records figures itself; makes or leans towards a decision.
- **Code and tests:** [lead.py](../agents/lead.py), [test_lead.py](../agents/tests/test_lead.py) (23);
  intake, [intake.py](../agents/intake.py), [test_intake.py](../agents/tests/test_intake.py) (10).

### Specialist

- **Job:** answers one question in a clean context, with at most one skill, and
  returns a cited summary under 120 words.
- **Model:** `SPECIALIST_MODEL`, default qwen3.5:9b, on this machine.
- **Tools:** list_sources, search_sources, read_page, get_study, list_rules,
  trace_figure, compare_versions, record_figure, record_check, record_finding,
  ask_planner, preview_change, get_timeline, live_vehicles; plus its skill's scripts,
  sandboxed.
- **Never:** asks specialists of its own; adds an engagement need except through
  the engagement-needs skill, which pins it to the line and needs a citation; runs
  the service's GIS tools except through the gis-analyst, safety-audit,
  active-transportation, equity-analysis, economic-development and
  stop-accessibility skills.
- **Code and tests:** [specialists.py](../agents/specialists.py), [test_specialists.py](../agents/tests/test_specialists.py) (14);
  the sandbox, [sandbox.py](../agents/sandbox.py), [test_sandbox.py](../agents/tests/test_sandbox.py) (9).

### Media

- **Job:** makes the renders that planners and visitors ask for on an engagement
  need: a still of the infrastructure at its real site, grounded in openly licensed
  photos of the site, and a short camera move animated from it. The service labels
  every file Illustrative.
- **Runs:** `python agents/media.py listen` or `once`.
- **Models:** gemini-3.6-flash writes the prompts from the need's cited pages;
  gemini-3.1-flash-image makes the still; gemini-omni-1.2-flash the video.
- **Never:** makes anything nobody asked for; presents a render as evidence.
- **Code and tests:** [media.py](../agents/media.py), [test_media.py](../agents/tests/test_media.py) (61).

### Computer use

- **Job:** works a legacy desktop tool by sight, as a planner would, for tools with
  no API. Two mocks with sample data: a trip scheduler and a signal-timing
  microsimulator.
- **Runs:** `python agents/computer_use.py [--app microsim]`; from the chat,
  `python agents/computer_listen.py`.
- **Model:** gemini-3.8-flash with Gemini's computer-use tool.
- **Never:** touches anything outside the mock app's window.
- **Status:** a demonstration on mocks. No real agency tool, and no eval cases.
- **Code and tests:** [computer_use.py](../agents/computer_use.py) (20 tests), [computer_listen.py](../agents/computer_listen.py) (4).

### Slack bridge

- **Job:** passes a Slack mention or message to a study's chat, and the lead's
  answer back to the thread. Can ping an executive.
- **Never:** records a decision: only a signed-in planner can.
- **Code and tests:** [slack_bridge.py](../agents/slack_bridge.py), [test_slack_bridge.py](../agents/tests/test_slack_bridge.py) (28).

### Skill evolution

- **Job:** proposes a better version of one skill's instructions, from its dev cases
  that failed in the newest eval runs and planners' corrections in the log: figures
  the service refused from it, and, in studies that used it, findings rated otherwise
  and overrides. Writes it to `agents/skill-candidates/<skill>/<version>/`, with the
  parent's version, the diff and the signals (`lineage.json`, `changes.diff`). A
  candidate's version is the hash the live folder will have with its SKILL.md.
- **Gate:** the skill's dev cases run with the live skill, then with the candidate
  (`eval --skill-dir`). It passes only if it passes as many, and every case the live
  skill passed by refusing, flagging or abstaining. Only then do the test cases run,
  for the record. A candidate that passes is put forward with
  `POST /v1/skills/{name}/candidates`.
- **Runs:** `python agents/main.py evolve <skill> [--dry-run]`. A dry run writes
  nothing to the service. The gate runs every dev case twice, through the lead, so
  it takes as long as that.
- **Model:** `EVOLVE_MODEL`, default qwen3.5:9b, on this machine, one call with no
  tools. The gate's runs use the eval runner's models.
- **Never:** sees a test case or its answer; writes over a live skill or changes its
  scripts; approves a version. Only a planner does: they copy the SKILL.md into
  `agents/skills/`, then approve exactly that content with
  `npm run approve-skill -- <skill> <hash>`, which uses `PUT /v1/skills/{name}` with a
  planner's token. The service refuses an agent's. An eval run approves a candidate
  only in its own throwaway service, so its agents can load it.
- **Code and tests:** [evolve.py](../agents/evolve.py), [test_evolve.py](../agents/tests/test_evolve.py) (20).

### Eval reader

- **Job:** in an eval run only, one call without tools reads the lead's answer into
  the fields the scorer compares. `READER_MODEL` should differ from the agent's.
- **Code and tests:** [evals.py](../agents/evals.py), [test_evals.py](../agents/tests/test_evals.py) (37).

## Models

On-prem by default: the lead and specialists run on qwen3.5:9b in Ollama on this machine,
and the eval reader on qwen3.5:4b, a different model, so evals cost nothing and no document
leaves the machine. `npm run dev` starts Ollama if it isn't running. Specialists work one
at a time, as one machine answers one request at a time.

Any model the settings name works. Names starting "gemini" go to Gemini (with
`GEMINI_API_KEY`); the rest go to `MODEL_BASE_URL`, any server that speaks OpenAI's chat
completions API: Ollama (the default, http://127.0.0.1:11434/v1), vLLM or a hosted
fine-tuning service ([openai_compat.py](../agents/openai_compat.py)). `MODEL_BASE_URL=off`
sends every model to Gemini. Calls to a server on the same machine are priced at zero.

```sh
ollama pull qwen3.5:9b && ollama pull qwen3.5:4b
npm run agent:eval -- --split dev                         # on-prem
LEAD_MODEL=gemini-3.6-flash SPECIALIST_MODEL=gemini-3.6-flash npm run agent:eval -- --split dev
```

Media and computer use stay on Gemini: they need its image, video and computer-use models.

## What makes a skill good

Seven tests. The first four are about the skill itself, the last three about the evidence for it.

1. **Picked right.** Its description says when to use it, and when another skill fits better.
2. **Cited.** Every rule and value it states has its source and page, and the tests check that each page exists.
3. **Scripts compute.** Any arithmetic, counting or lookup is done by its script or by the service, never by the model.
4. **Honest about gaps.** It says what's missing and hands judgement to a planner, rather than guessing.
5. **Unit tested.** Its scripts, and its quotes, have tests.
6. **Evaluated.** At least 8 eval cases of its own, split between dev and test, including at least one it should refuse or hand over.
7. **Shown to help.** Its cases score better with the skill than without it (`python agents/main.py eval --no-skills`), over at least 3 runs.

## Skills

Eval cases are each case's `skill`, the one it mainly tests, counted over `dev` and
`test` as dev/test; `npm run agent:cases` prints them. ◐ in column 6: enough cases,
but most still wait for a planner to check their gold answers. ✓ meets the test, ◐
partly, ✗ not yet.

| Skill | 1 Picked | 2 Cited | 3 Scripts | 4 Gaps | 5 Tests | 6 Cases | 7 Helps |
|---|---|---|---|---|---|---|---|
| ttc-standards | ◐ | ✓ | ✓ service | ✓ | ◐ | ✓ 13/19 | ✗ |
| ttc-service-change | ◐ | ✓ | ✓ | ✓ | ✓ 19 | ◐ 5/5 | ✗ |
| gtfs-analyst | ◐ | ✓ | ✓ | ✓ | ✓ 17 | ◐ 4/5 | ✗ |
| trial-monitor | ◐ | ✓ | ✓ | ✓ | ✓ 13 | ◐ 5/4 | ✗ |
| consultation | ◐ | ✓ | n/a | ✓ | ✗ | ◐ 5/5 | ✗ |
| metrolinx-business-case | ◐ | ✓ | ✓ service | ✓ | ✗ | ◐ 5/4 | ✗ |
| metrolinx-bca | ◐ | ✓ | ✓ | ✓ | ✓ 26 | ◐ 5/4 | ✗ |
| business-case-template | ◐ | ✓ | n/a | ✓ | ✓ 4 | ◐ 5/4 | ✗ |
| transit-cost-benchmark | ◐ | ✓ | ✓ service | ✓ | ◐ 3 | ◐ 7/5 | ✗ |
| planning-glossary | ◐ | ✓ | n/a | ✓ | ✓ | ◐ 5/4 | ✗ |
| handover | ◐ | ✓ | n/a | ✓ | ◐ | ◐ 5/4 | ✗ |
| engagement-needs | ◐ | ✓ | ✓ | ✓ | ✓ 9 | ◐ 4/5 | ✗ |
| tpap-brief | ◐ | ✓ | ✓ service | ✓ | ✗ | ◐ 4/4 | ✗ |
| gis-analyst | ✓ | ✓ | ✓ service | ✓ | ✓ 8 + 19 service | ✓ 8/5 | ✗ |
| safety-audit | ✓ | ✓ | ✓ service | ✓ | ✓ 6 + 13 service | ◐ 5/5 | ✗ |
| active-transportation | ✓ | ✓ | ✓ service | ✓ | ✓ 5 + 8 service | ◐ 5/5 | ✗ |
| equity-analysis | ✓ | ✓ | ✓ service | ✓ | ✓ 7 + 18 service | ◐ 5/4 | ✗ |
| economic-development | ✓ | ✓ | ✓ service | ✓ | ✓ 7 + 18 service | ◐ 5/4 | ✗ |
| stop-accessibility | ✓ | ✓ | ✓ service | ✓ | ✓ 7 + 18 service | ◐ 5/4 | ✗ |

What the table shows:

- The instructions are strong: every skill cites its rules, and every one says what it
  can't do. Shared tests check that each cited page exists, that each quote is on its
  page, and that no skill gives away a held-out case's answer ([test_skills.py](../agents/tests/test_skills.py)).
- Descriptions say what a skill does, not when to pick another. Three overlap:
  metrolinx-business-case, business-case-template and metrolinx-bca are one method.
- The evidence is still missing. Every skill now has at least 8 cases of its own,
  half kept for `test`, but the 139 new ones wait for a planner to check their gold,
  and no skill has been run with and without. The eval set has been run once, on one
  case (2026-11-08).

### ttc-standards

Tests a proposed TTC service change against the 2026 plan's tests and the May 2024
Service Standards: customer time, boardings per service hour, riders per $100, and
the trial. Thresholds come only from list_rules; the service computes derived figures
from their formulas. Flags the conflicting ridership standards (11 per $100 against
12 trips per service hour) and the streetcar minimums.

- Next: write its own tests for the weighting and the reduction direction; run its
  32 cases with and without.

For every skill below, the cases are written: next, a planner checks their gold, then
they run with and without the skill, over 3 runs.

### ttc-service-change

Classifies a change as minor or major by Table 7 of the Service Standards, and lists
the steps that class needs. `classify_service_change` never guesses: a change the
table doesn't list, or whose resource effect the standards don't settle, goes to a planner.

- Cases: 10, from the 2026 plan's proposals and changes the table doesn't settle.

### gtfs-analyst

Counts a TTC route's scheduled trips by hour and by Table 3 period, with the first and
last trip, from the timetable in the repo. `scheduled_trips`, `trips_by_period`,
`service_span`. Only first departures are kept, so it can't answer for a stop or one direction.

- Cases: 9, on the timetable to 2026-12-21. When it's replaced, recompute their gold.
- Next: keep stop times and direction, so it can give headways; cases from the
  MIT-licensed San Antonio quiz ([skills.md](skills.md)).

### trial-monitor

Measures on-time departures during a service trial, by trial week and so far, with
sample sizes, on both the Standards' window and the KPI reports' window, against the
whole network on the same days. `trial_on_time`, `record_on_time`. Ridership waits
for the TTC's review.

- Cases: 9, on synthetic measured weeks (steady, drifting, too few to judge), and one
  for the real trial's review. Next: cases on recorded weeks of the real trial.

### consultation

Summarises feedback channel by channel in the source's words, never averaged; proposes
a tone for a planner to rate; flags instructions planted in documents.

- Cases: 10, including split consultation, operators' feedback and planted instructions.
- Next: tests that its quotes are on their pages.

### metrolinx-business-case, business-case-template, metrolinx-bca

One method, three skills. metrolinx-business-case states the four cases, optimism bias
and which figures are precedents (13 lines). business-case-template lays out what each
case needs at each stage. metrolinx-bca discounts a project's own benefit and cost
streams to an NPV and a benefit-cost ratio with `metrolinx_bca`, and computes nothing
while an input is missing.

- Cases: 9 each. metrolinx-bca's are on project inputs written for the cases, one a
  changed copy, with gaps it must not fill.
- Next: merge into one skill, metrolinx-business-case, with the stage matrix and the
  BCA as reference files and the script, loaded as needed, and its 27 cases with it.

### transit-cost-benchmark

Compares a line's capital cost per km with the two comparables in the sources, the
Ontario Line and Relief Line South (Table 31, ontario-line-ibc-2019 p. 77), on their
basis, and says what the comparison can't tell. The comparables are written into the
instructions, so it only serves lines like these.

- Cases: 12, including figures on other bases it must not set beside Table 31.
- Next: comparables as data with their basis (dollar year, estimate class, design
  stage, alignment), and a script that refuses unlike bases.

### planning-glossary

40 terms of business-case and service-planning jargon, each in its source's words with
the page, checked by the tests. Says when no source defines a term.

- Cases: 9. Its test cases are terms it doesn't list, so they test how it looks one up.

### handover

What agents must never do, how to hand a judgement case to a planner, with
ask_planner and a "For a planner to decide:" line, and how to end with what isn't
known yet, each gap with its next step and who to contact.

- Cases: 9.
- Next: score refusals from the service's log of the agent's calls, not its words
  ([evals.md](evals.md)).

### engagement-needs

Proposes what to make so people near a change can picture it before consultation.
`pin_to_line` refuses a place over 500 m from the line; `add_engagement_need` refuses
one without a citation. Only a planner asks for media.

- Cases: 9, including places just inside and just outside 500 m, and a need without a page.

### tpap-brief

Builds a draft brief for Ontario's Transit Project Assessment Process from what the
study holds, as a report or slides, through create_document, which checks each point's
citation. The regulation itself, O. Reg. 231/08, isn't in the sources, so TPAP's steps
go under "To confirm".

- Cases: 8, two of them briefs scored by rubric. An eval study holds a brief and a
  line but no findings, so the briefs test what it does with an empty study.
- Next: add the regulation as a source; tests on a sample study, and cases on one.

### gis-analyst

Answers where-questions in Toronto from open data, as Waypoint does: a route's stops
or shape, the study's line or a named neighbourhood, buffered and overlaid with 2021
census areas, Neighbourhood Improvement Areas and police-reported KSI collisions.
Its tools call the service's GIS tools, which no other specialist gets. The service
does the geometry with Turf.js, saves each step as a map layer on the study, logs
`layer.added` for the display's map, and records totals as figures that cite the
dataset ([decisions.md](decisions.md#13-gis-figures-cite-a-dataset-not-a-page)).
Census totals are area-weighted estimates; the census counts people in low income,
not households; collisions are police-reported; heritage and green spaces cover the
Don Mills corridor only, and the tools refuse beyond it. A catchment's population
is never ridership.

- Data: [services/api/assets/gis](../services/api/assets/gis/CREDITS.md), from
  `scripts/build-gis-data.ts`.
- Cases: 13 in `spatial`, 8 dev and 5 test: two it must not answer, one to flag; their gold
  comes from the same tools ([spatial-gold.ts](../evals/spatial-gold.ts)), checked by a test.
- Next: run its cases with and without the skill; a walkshed along streets, not
  only straight-line buffers.

### safety-audit

A Vision Zero audit of a route, line or area, as Waypoint does. `ksi_profile` counts
police-reported KSI collisions by year, road user, severity, intersection or
mid-block, dark and time of day, and the people killed and seriously injured by road
user. `ksi_hotspots` ranks the places with the most, collisions within 30 m counting
as one place. `ksi_trend` compares collisions a year before and after a split year,
against the city's change, with an exact test of whether chance alone could give it.
The service counts ([gis-safety.ts](../services/api/src/gis-safety.ts)); each result
is a layer, its main counts figures citing toronto-ksi-detail. Countermeasures come
only from the City's Vision Zero Road Safety Plan, its 2.0 update and FHWA's Proven
Safety Countermeasures, with pages, as what they list, never as what a measure would
prevent here. It never says why a collision happened, and says the data is
police-reported and has no traffic counts.

- Data: `ksi-detail.json.gz`, from `scripts/build-safety-data.ts`
  ([CREDITS.md](../services/api/assets/gis/CREDITS.md)).
- Cases: 10, 5 dev and 5 test, gold from [safety-gold.ts](../evals/safety-gold.ts):
  a cause, a forecast and a rate per vehicle-km it must not give.
- Next: a planner checks the gold; run with and without; hot spots on the City's own
  intersections and segments, not clusters.

### active-transportation

Walking, cycling and bike share near transit. `cycling_within` gives km of cycle
tracks, bike lanes, trails and shared roads in an area; `sidewalks_within`, street km
by sidewalks on both sides, one, partial or none; `bike_share_within`, stations and
docks; `first_last_mile`, for each stop, the nearest bike share station and the
bikeway within reach, and the stops with neither. The service measures
([gis-active.ts](../services/api/src/gis-active.ts)), each total a figure citing its
dataset. The sidewalk inventory dates from 2017; bike share is one day's station
list; none of it is ridership.

- Data: `cycling.json.gz`, `sidewalks.json.gz`, `bikeshare.json.gz`, from
  `scripts/build-safety-data.ts`, under the Open Government Licence – Toronto.
- Cases: 10, 5 dev and 5 test, gold from [safety-gold.ts](../evals/safety-gold.ts):
  a ridership forecast it must not give, and sidewalk priorities it hands to a planner.
- Next: a planner checks the gold; distances along streets; whether the network
  connects, not only how much of it is near.
### equity-analysis

Says who a route, its stops or a line serves, as Waypoint's equity analysis does:
people within reach in low income (LIM-AT), commuting by transit, 65 and over and 0 to
14, each beside the City's share from the same 2021 census, with the gap; the
Neighbourhood Improvement Areas it reaches and the people in them; and the stops
within 400 m of an NIA, which the TTC weights at 125% (ttc-anp-2026 p. 114). The
service's `equity_profile` works it all out ([gis-equity.ts](../services/api/src/gis-equity.ts)).
Area-weighted estimates of people in areas: it never infers anyone's traits, never
counts boardings, and leaves whether a change is fair to a planner. It counts stops
near the NIAs' whole areas, so the TTC's own count, near their residential parts, can
only be fewer.

- Data: children by census area, added to the census by `scripts/build-gis-skills-data.ts`.
- Cases: 9, 5 dev and 4 test, gold from the service's tools ([gis-skills-gold.ts](../evals/gis-skills-gold.ts)).

### economic-development

Counts the work and land near stations, as they were in 2021, never as they will be:
people with a usual place of work within reach, from the census by census tract of
work, beside the people who live there (`jobs_within`); and the land zoned
residential, mixed use, employment and so on, on the Don Mills corridor only
(`zoning_within`) ([gis-economy.ts](../services/api/src/gis-economy.ts)). Says what
Metrolinx's Business Case Manual asks of wider economic impacts, with its pages, and
that they need a model run. The census ran during COVID-19, and tracts are coarse
beside a walk to a station; it says both.

- Cases: 9, 5 dev and 4 test, including a forecast it hands over and zoning beyond the corridor.
- Next: the City's whole Zoning By-law layer; employment at a finer grain, such as the
  Toronto Employment Survey by location, if the City publishes it openly.

### stop-accessibility

An asset inventory of a route's or line's stops: which the TTC's GTFS marks wheelchair
accessible or not, the stations with a platform marked not accessible
(`stop_accessibility`), and the City transit shelter nearest each stop
(`stop_shelters`) ([gis-access.ts](../services/api/src/gis-access.ts)). Quotes what
the AODA's Integrated Accessibility Standards ask of transit stops, O. Reg. 191/11,
now a source with its pages. An inventory and its gaps, never a finding of compliance:
a planner confirms. No open data says which stations have elevators.

- Cases: 9, 5 dev and 4 test, including a request to confirm compliance, which it refuses.
- Next: station elevator and entrance data, if the TTC publishes it openly.
