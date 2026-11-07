# Our version of PNNL

The plan, with sources, for a Canadian transit planning benchmark modelled on PNNL's
PermitAI, which made environmental review measurable for AI. PNNL scores
documents; we also score real decisions and what happened after them, which TTC
plans publish enough to do.

## What PNNL built

- [NEPATEC](https://huggingface.co/datasets/PNNL/NEPATEC3.0): environmental review documents as standard records (project, process, document, file, page). 120,000+ documents in 2.0, about 60,000 projects; 188,330 files in 3.0, preliminary.
- [NEPAQuAD](https://arxiv.org/abs/2407.07321): question and answer benchmark, 1,590 items from 9 reviews.
- [DraftNEPABench](https://github.com/pnnl/PermitAI/tree/master/DraftNEPABench): draft one section of a real review, scored against rubrics. 102 tasks from 22 reviews, written by 19 experts.
- [Tools](https://www.pnnl.gov/projects/permitai/ai-applications): SearchNEPA, CommentNEPA and others. Federal beta; SearchNEPA has 600+ users.

Corrections to the report's PNNL claims, on what the 19 counts and the order PNNL
built in: [report-corrections.md](report-corrections.md).

## What we build

- Corpus, **TRANSITEC**: what was proposed, what was decided, and why?
- Lookup, **TransitQuAD**: can it find the right rule and number?
- Decision, **DecisionBench**: with the outcome hidden, can it apply the rules and spot when judgement is needed?
- Drafting, **DraftTransitBench**: can it write a section a planner would keep?
- Reality, **TrialBench**: did the forecast come true?
- Tools: the skills in [skills.md](skills.md), built per agency on the shared layers.

## TRANSITEC

One record per proposal, not per document. Fields, with examples:

- Agency and process: TTC, Annual Network Plan.
- Stage: technical assessment.
- Proposal and routes: Lawrence–Sunnybrook, routes 11, 52 and 124.
- Inputs: service hours, ridership forecast.
- Metrics: boardings per hour, riders per $100, customer time.
- Consultation: survey and event results, kept apart.
- Outcome and reason: adopted, or dropped after public feedback.
- Later result: post-implementation review.
- Pages: source document and page for every field.

A benchmark record needs inputs, metrics, a decision and a reason. Few sources have
all four.

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

Counts are from sampling; the TTC and Metrolinx rows were counted by hand. The
2024–2026 TTC plans alone give about 105 records, the seed.

Limits to state in the paper:

- Only the 2026 plan has the full metric block for every record.
- Most records' answer is a staff recommendation. Join Board decisions where they exist.
- Metrolinx's Project Evaluation Advisory Panel publishes no outputs.
- Canadian public documents can't be assumed free to redistribute; PNNL's corpus is CC0. Publish records, page references and links until permission is confirmed.

## DecisionBench

The agent gets the rules and a proposal copied without its recommendation or any
pass or fail statement. It returns each test result, a recommendation, and whether
a person needs to weigh in. Three controls:

- **Rules only.** A script that applies the tests and nothing else matches 3 of the 8 real decisions in the 2026 plan. An agent has to beat that.
- **Changed numbers.** Copies with altered figures and anonymous routes have a different correct answer, so remembering the plan gets them wrong.
- **Sealed future.** Run on the 2027 plan before it is published, logging the prediction first, so no model can have seen the answer.

## DraftTransitBench

Copies DraftNEPABench's method:

- From a task file, the reference documents and shared instructions, the agent drafts one section: a technical assessment, a business case part, or an environmental project report section.
- The published section is the withheld answer.
- A planner writes each case's rubric, grouped into accuracy, clarity, structure, reference, and our fifth group, provenance.
- Each criterion scores 1 to 5 on PNNL's published scale.
- Three models from different vendors judge, several runs each.
- Planners score a sample, and we report the judges' mean absolute difference from them.

Environmental project reports mirror the structure of the reviews PNNL used, so
they suit drafting best. PNNL's agents had open web access while the reviews were
online; ours don't ([evals.md](evals.md#rules-for-a-fair-result)).

## TrialBench

The TTC tests its forecasts after a 12-month trial. Lawrence–Sunnybrook began on
November 1, 2026, with its forecast already published. Public feeds measure
reliability from the first week; ridership has to come from the TTC at the review.

Past reviews show why this matters: the 200 Toronto Zoo went from 9 to 12 to 8
riders per $100 over three summers, and the 503 Kingston Rd from 19 to 14.

## Order of work

PNNL's first corpus came out in 2024 and its drafting benchmark in 2026. We can
move faster: the seed is small and the structure is already published.

1. Seed from the 2026 plan: 45 cases, answer key, scorer, rules-only control. **Done.**
2. Add the 2024 and 2025 plans, to reach about 105 records. **Next.**
3. Seal predictions for the 2027 plan before it is published. **Time-critical.**
4. Planners write rubrics for the first 10 drafting tasks. **Needs planners.**
5. Add Metrolinx cases and environmental project reports. **Later.**
6. Publish records and the benchmark, once licensing is clear. **Later.**
