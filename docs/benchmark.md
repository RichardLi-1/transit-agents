# Our version of PNNL

PNNL's PermitAI turned environmental review into something AI could be measured
on. This does the same for Canadian transit planning, and adds what PNNL leaves
out: real decisions, and what happened after them.

## What PNNL built

| Layer | What it is | Size |
|---|---|---|
| [NEPATEC](https://huggingface.co/datasets/PNNL/NEPATEC3.0) | Environmental review documents as standard records: project, process, document, file, page | 120,000+ documents in 2.0, about 60,000 projects. 188,330 files in 3.0, preliminary. |
| [NEPAQuAD](https://arxiv.org/abs/2407.07321) | Question and answer benchmark | 1,590 items from 9 reviews |
| [DraftNEPABench](https://github.com/pnnl/PermitAI/tree/master/DraftNEPABench) | Draft one section of a real review, scored against rubrics | 102 tasks from 22 reviews, written by 19 experts |
| [Tools](https://www.pnnl.gov/projects/permitai/ai-applications) | SearchNEPA, CommentNEPA and others | Federal beta. SearchNEPA has 600+ users. |

The 19 is the number of lead agencies whose reviews supplied benchmark cases, not
the number of agencies using tools. Tools and benchmarks were built side by side:
SearchNEPA came before DraftNEPABench.

## What we build

| Layer | Ours | Answers |
|---|---|---|
| Corpus | **TRANSITEC** | What was proposed, what was decided, and why? |
| Lookup | **TransitQuAD** | Can it find the right rule and number? |
| Decision | **DecisionBench** | Given a proposal with its outcome hidden, can it apply the rules and spot when judgement is needed? |
| Drafting | **DraftTransitBench** | Can it write a section a planner would keep? |
| Reality | **TrialBench** | Did the forecast come true? |
| Tools | The skills in [skills.md](skills.md) | Built per agency, on the shared layers |

Decision and Reality are ours. PNNL scores documents. We also score the decision
and what followed, and TTC plans publish enough to do it.

## TRANSITEC

One record per proposal, not per document:

| Field | Example |
|---|---|
| Agency and process | TTC, Annual Network Plan |
| Stage | Technical assessment |
| Proposal and routes | Lawrence–Sunnybrook: 11, 52, 124 |
| Inputs | Service hours, ridership forecast |
| Metrics | Boardings per hour, riders per $100, customer time |
| Consultation | Survey and event results, kept apart |
| Outcome and reason | Adopted, or dropped after public feedback |
| Later result | Post-implementation review |
| Pages | Source document and page for every field |

A benchmark record needs four things: inputs, metrics, a decision and a reason.
Few sources have all four.

| Source | Size | Inputs | Metrics | Decision | Reason |
|---|---|---|---|---|---|
| [TTC 2026 technical assessment](https://www.ttc.ca/about-the-ttc/projects-and-plans/2026-Annual-Network-Plan) | About 12 records | Yes | Yes | Yes | Yes |
| [TTC 2024](https://transittoronto.ca/archives/reports/ttc-2024-annual-service-plan-2023-11-22.pdf) and [2025](https://www.ttc.ca/about-the-ttc/projects-and-plans/2025-Annual-Service-Plan) assessments | About 66 and 27 | Yes | Partly | Yes | Yes |
| [TTC Service Improvements, 2000–2008](https://transittoronto.ca/spare/0059.shtml) | About 200 entries in 4 parsed reports | Yes | Partly | Yes | Yes |
| [Metrolinx business cases](https://www.metrolinx.com/en/about-us/doing-business-with-metrolinx/business-cases) | 35 links | Yes | Yes | Partly | Partly |
| [Calgary RouteAhead](https://transit-dev.calgary.ca/content/dam/transit/plans---projects/2013-0118strategyaheadweb2.pdf) | 20 scored projects | Yes | Yes | Partly | Partly |
| [TransLink network reviews](https://www.translink.ca/plans-and-projects/strategies-plans-and-guidelines/managing-the-transit-network) | 15 reviews, with data | Yes | Yes | No | No |
| [Environmental project reports](https://www.ontario.ca/document/guide-ontarios-transit-and-rail-project-assessment-process) | 14 found, likely 60–100 | Yes | Partly | No | Partly |
| [Ontario Auditor General audits](https://www.auditor.on.ca/en/content/reporttopics/transportation.html) | 7 audits, 11 follow-ups, 1 special report | No | Partly | Yes | Yes |
| TTC board reports | Estimated 5,000–9,000 PDFs | Varies | Varies | Varies | Varies |

Counts are from sampling, and the TTC and Metrolinx rows were counted by hand.
The 2024–2026 TTC plans alone give about 105 records, which is the seed.

**Limits to state in the paper:**

- Only the 2026 plan has the full metric block for every record.
- The answer in most records is a staff recommendation. Join Board decisions where they exist.
- Metrolinx's Project Evaluation Advisory Panel publishes no outputs.
- Canadian public documents can't be assumed free to redistribute. PNNL's corpus is CC0. Publish records, page references and links until permission is confirmed.

## DecisionBench

Each proposal's text is copied with its recommendation and every pass or fail
statement removed. The agent gets the rules and the proposal, and returns a result
for each test, a recommendation, and whether a person needs to weigh in.

Three controls make the result mean something:

- **Rules only.** A script applies the tests and nothing else. It matches 3 of the 8 real decisions in the 2026 plan. An agent has to beat that to be worth anything.
- **Changed numbers.** Copies with altered figures and anonymous routes have a different correct answer, so remembering the plan gets them wrong.
- **Sealed future.** Run on the 2027 plan before it is published, and log the prediction first. No model can have seen the answer.

## DraftTransitBench

Follows DraftNEPABench, which is the method to copy.

| Part | Approach |
|---|---|
| Task | Draft one section: a technical assessment, a business case part, or an environmental project report section |
| Inputs | A task file, the reference documents, and shared instructions |
| Answer | The published section, withheld from the agent |
| Rubric | Written by a planner for each case, grouped into accuracy, clarity, structure, reference, and our fifth group: provenance |
| Score | 1 to 5 for each criterion, on PNNL's published scale |
| Judges | Three models from different vendors, several runs each |
| Validation | Planners score a sample, and we report mean absolute difference against the judges |

Environmental project reports mirror the structure of the reviews PNNL used, so
they suit drafting best.

**One change from PNNL:** their agents had open web access while the published
reviews were online. Ours run without it, so the answer can't simply be found.

## TrialBench

A forecast is a claim about the future, and the TTC tests its claims after a
12-month trial. Lawrence–Sunnybrook began on November 1, 2026, with its forecast
already published. Public feeds measure reliability from the first week. Ridership
has to come from the TTC at the review.

Past reviews already show why this matters. The 200 Toronto Zoo went from 9 to 12
to 8 riders per $100 over three summers. The 503 Kingston Rd went from 19 to 14.

## Order of work

PNNL's first corpus came out in 2024 and its drafting benchmark in 2026. We can
move faster, because the seed is small and the structure is already published.

| Step | Work | Status |
|---|---|---|
| 1 | Seed from the 2026 plan: 45 cases, answer key, scorer, rules-only control | Done |
| 2 | Add the 2024 and 2025 plans to reach about 105 records | Next |
| 3 | Seal predictions for the 2027 plan before it is published | Time-critical |
| 4 | Planners write rubrics for the first 10 drafting tasks | Needs planners |
| 5 | Add Metrolinx cases and environmental project reports | Later |
| 6 | Publish records and the benchmark, once licensing is clear | Later |
