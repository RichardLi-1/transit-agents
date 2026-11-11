# What the eval set looks like

Case format, current set, reporting and limits for the eval set, which turns the
demo into a research result. Cases and scorer: [evals/](../evals). Benchmark plan:
[benchmark.md](benchmark.md). Reasons for these rules: [decisions.md](decisions.md).

## One case

```json
{
  "id": "perturbed-001",
  "capability": "check",
  "split": "test",
  "perturbed": true,
  "query": "Assess this proposal against the rules. Give each test result and a recommendation.",
  "inputs": ["rules", "perturbed-low-ridership"],
  "expect": {
    "behaviour": "answer",
    "decision": "reject",
    "checks": { "customer_time": "pass", "productivity": "fail", "ridership_per_dollar": "fail" }
  }
}
```

An answer gives its text, behaviour, and any value, decision, test results and
citations. [score.ts](../evals/score.ts) compares it with the case.

## Fields

- `capability`: the capability in [queries.md](queries.md) it tests.
- `skill`: the skill in `agents/skills/` it mainly tests. A run's scores are given by
  skill too, so a run with skills set beside one with `--no-skills` shows what each
  adds. `npm run agent:cases` prints each skill's cases by split.
- `split`: `dev` to build against, `test` kept aside, `future` for answers nobody knows yet.
- `context` or `inputs`: full documents, or a prepared copy with the outcome removed.
- `study`: what the case's study holds when it opens, as a planner would have set it:
  `brief`, `routes`, `line` (a line the map draws, for engagement needs), `trial` dates
  and the service patterns to `watch`.
- `measured`: departures the live feed measured, `evals/inputs/<name>.json`, each day's
  by pattern and by how they left. The runner adds them where the collector would, so
  `get_timeline` serves them. The ones here are synthetic, and say so.
- `perturbed`: the numbers were changed, so the published answer is wrong.
- `expect.behaviour`: `answer`, `flag`, `abstain` or `refuse`.
- `expect.value`, `tolerance`: the number, and how close it must be.
- `expect.citations`: pages that must be cited.
- `expect.decision`, `checks`: the recommendation and each test result.
- `expect.judgement`: the rules alone don't decide this case.
- `expect.mentions`, `forbids`: required and banned wording.
- `scorer: "rubric"`: needs planners or judged scoring. `rubric`: what a planner checks the answer for.
- `review: "planner"`: a planner hasn't yet checked the gold answer, so the case
  doesn't count in the paper.
- `goldFrom`: how the gold answer was worked out, when it isn't read off a page, such
  as with a skill's own script.

## The current set

205 cases, every one named by the skill it mainly tests, and each skill with at least
8 of its own, split between `dev` and `test`, with at least one it should refuse or
hand over. `npm run agent:cases` prints the counts:

| Skill | dev | test | future | Refuse or flag | To review |
|---|---|---|---|---|---|
| ttc-standards | 13 | 19 | | 6 | |
| ttc-service-change | 5 | 5 | | 4 | 9 |
| gtfs-analyst | 4 | 5 | | 2 | 9 |
| trial-monitor | 5 | 4 | 1 | 3 | 6 |
| consultation | 5 | 5 | | 4 | 7 |
| metrolinx-business-case | 5 | 4 | | 2 | 7 |
| metrolinx-bca | 5 | 4 | | 2 | 8 |
| business-case-template | 5 | 4 | | 3 | 8 |
| transit-cost-benchmark | 7 | 5 | | 5 | 11 |
| planning-glossary | 5 | 4 | | 1 | 5 |
| handover | 5 | 4 | | 9 | 5 |
| engagement-needs | 4 | 5 | | 4 | 9 |
| tpap-brief | 4 | 4 | | 2 | 8 |
| gis-analyst | 8 | 5 | | 3 | |
| safety-audit | 5 | 5 | | 3 | 10 |
| active-transportation | 5 | 5 | | 2 | 10 |
| equity-analysis | 5 | 4 | | 2 | 9 |
| economic-development | 5 | 4 | | 1 | 9 |
| stop-accessibility | 5 | 4 | | 1 | 9 |

- Behaviours: 130 answer, 35 flag, 20 refuse, 20 abstain.
- Spatial cases' gold comes from the service's own GIS tools on the committed datasets ([spatial-gold.ts](../evals/spatial-gold.ts)), and the safety and active cases' from its safety and active transportation tools ([safety-gold.ts](../evals/safety-gold.ts)). A test fails if a rebuilt dataset moves one. They cite datasets, which have no pages, so they score values and wording, not pages. Bike share counts are on one day's station list, so a rebuild moves them. The equity-analysis, economic-development and stop-accessibility cases' gold comes the same way ([gis-skills-gold.ts](../evals/gis-skills-gold.ts)), and their two cases on what Metrolinx's Manual and the AODA regulation say cite pages.
- Scored by script: all but 6. By rubric: draft-001, draft-002, monitor-001, bct-008,
  tpap-005 and tpap-006, each new one with its rubric written out.
- Changed numbers, so remembering the published answer gives the wrong one: the four
  perturbed-* cases, svc-007, bca-002 and tcb-007.
- Sources: the 2026 plan and the Service Standards; the Ontario Line's business cases
  and Metrolinx's Business Case Manual; the City's Vision Zero plans and FHWA's Proven
  Safety Countermeasures (safety-audit); the AODA's Integrated Accessibility Standards,
  O. Reg. 191/11 (stop-accessibility); the TTC timetable in the repo
  (gtfs-analyst); and inputs written for a case in `evals/inputs/`: proposals with the
  outcome removed, changed copies, planted instructions, a project's appraisal inputs
  for metrolinx-bca, and synthetic measured departures for trial-monitor.
- `find-009`, `find-010` and `reconcile-002` name sources the eval service doesn't seed
  yet, so they are skipped, and trial-monitor runs 8 of its 9.

**The 139 new cases await a planner's review** (`"review": "planner"`): every case
except the 53 first ones and the 13 spatial ones. Their gold answers were read off the page the service
serves, in read_page's numbering, or worked out with the skill's own script, which
`goldFrom` names, but no planner has checked them, so they don't count in the paper
until one has. A test case's answer is in no skill; the dev cases whose answers a skill
spells out are listed in [test_skills.py](../agents/tests/test_skills.py), and for the three skills
above, in each one's own test.

## What gets reported

- Pass rate by capability, and by skill: set beside a run without skills, what each skill adds.
- Decisions matched, against the rules-only control. The control uses the answer key's own test results, so it is an upper bound for rules alone, and it can never answer "defer" or "amend".
- Hand-overs on judgement cases: counted as correct, and reported apart.
- Accuracy on changed numbers against the originals. A large gap means remembering, not reading.
- Citation recall and precision.
- Figures the service rejected: a live measure of invented sources.
- Correct refusals, the safety result: scored from the answer today, but it should be scored from the service's log of the agent's actual calls.
- Agreement across at least 3 runs of each case.
- Tokens, cost and time per case.
- Share of output planners corrected: what planners care about, and the only measure that needs real use.

## Running it

`npm run agent:eval` runs the first 3 `dev` cases through the lead agent. Pick
others with `-- --case ID` (repeat it), `--split` and `--limit N`. Real runs cost
money, so the limit stays at 3 unless you raise it. Run the same cases again with
`--no-skills` and report both, so the score shows what the skills add.

- Each case runs on a throwaway service of its own, on a free port from 4175 to 4179 (set `EVAL_PORTS`, such as `4326-4330`, to use others), with the public sources and the inputs it needs, so no case can read what an earlier one found. Each is deleted once its case is done.
- Cases run one at a time, each in its own study. The agent never sees a case's id or its inputs' file names, which could give the answer away: the study is `study-<n>`, and the inputs are `rules` and `document-<n>`. A case that names a source the service lacks is skipped: `ttc-standards-deck-2025` and `ttc-standards-note-2025` aren't seeded yet.
- A case's `study` opens its study with a line, a trial or watched patterns, and its `measured` departures go into its service's measurements, so engagement-needs can pin to a line and trial-monitor has a trial to measure.
- The seed is the demo's (`clients/seed.ts`). From commit 53ec37b it holds the Ontario Line's business cases, Metrolinx's Business Case Manual and the TTC's 2024-25 subway ridership, Metrolinx's rules, and the Ontario study's planner-set values (a 6 km extension, 3 stations). So runs before and after it aren't comparable, above all on `stop-003`, `stop-006` and `draft-002`: an agent can now find the Ontario Line's own benefit-cost ratio (1.05) and Don Mills station's real weekday count, and must still not pass either off as the extension's. Their expected behaviours stand: no ratio exists for the extension, and a made-up number is still made up.
- Once the lead answers, one model call without tools fills in the behaviour, value, decision and test results. `READER_MODEL` picks its model, `qwen3.5:4b` on this machine by default, apart from the agents' default (`qwen3.5:9b`), and each answer records it: keep it apart from `LEAD_MODEL`, as rule 6 asks. It's still a model, and a small one, so check its fields by hand on a sample of answers. An answer with the skills' hand-over line, "For a planner to decide:", counts as a flag whatever the reader says, unless it abstains or refuses. A script reads the citations.
- Answers go to `evals/runs/<UTC time>.jsonl` with their tokens, cost and time, and each case's log to `evals/runs/<UTC time>/<id>.log.jsonl`: its subagents, readings, figures and each model call's usage. If Gemini's quota runs out, the run stops and keeps them. Costs come from the prices in [agents/prices.py](../agents/prices.py).
- [score-run.ts](../evals/score-run.ts) then prints the pass rate by capability and by skill, decisions against the control, hand-overs, citation recall and precision, and tokens and time per case. `npm run agent:score` scores a run again.

## Rules for a fair result

1. No web for agents during evals. The plans are online, so the answers are too.
2. Don't tune on `test` cases. Use `dev`, and move a case to `dev` once you look at its answer.
3. Report the control beside the score. A pass rate alone means little.
4. Report counts, not only percentages. With 8 real decisions, one case moves the result by 12 points.
5. Prefer the script. Use judged scoring only for drafts, and check judges against planners.
6. Keep the judge separate from the agent. A model shouldn't grade its own vendor alone.

## What this can and can't claim

The current set can show that the system works and the method is sound, but not
yet agent quality. Eight decisions is too few: five perfect answers still give a
95% lower bound of 48%. A planner wrote none of the cases, 17 of the first 53 reuse the
Lawrence proposal, and 112 of the 178 wait for a planner's review. With 4 or 5 test cases a skill, one case moves a skill's test
score by 20 to 25 points, so report each skill's counts with its rate, over at least
3 runs.

The claim gets stronger in this order ([order of work](benchmark.md#order-of-work)):

1. About 105 records from the 2024–2026 plans.
2. A sealed prediction on the 2027 plan.
3. Rubrics written by planners, and planners scoring a sample.
4. The Lawrence trial's real result at its review.
