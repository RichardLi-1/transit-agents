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

53 cases: 46 from the 2026 plan, and 7 on the Ontario Line study's sources:

- Scored by script: Find 13; Check 12, including trial reviews and changed numbers; Calculate 7; Stop and hand over 7; Define 5, on jargon; Reconcile, consultation and trace 5.
- Scored by script and rubric: Monitor 2.
- Scored by rubric: Draft 2.

## What gets reported

- Pass rate by capability.
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
- The seed is the demo's (`clients/seed.ts`). From commit 53ec37b it holds the Ontario Line's business cases, Metrolinx's Business Case Manual and the TTC's 2024-25 subway ridership, Metrolinx's rules, and the Ontario study's planner-set values (a 6 km extension, 3 stations). So runs before and after it aren't comparable, above all on `stop-003`, `stop-006` and `draft-002`: an agent can now find the Ontario Line's own benefit-cost ratio (1.05) and Don Mills station's real weekday count, and must still not pass either off as the extension's. Their expected behaviours stand: no ratio exists for the extension, and a made-up number is still made up.
- Once the lead answers, one model call without tools fills in the behaviour, value, decision and test results. `READER_MODEL` picks its model, `gemini-3.5-flash-lite` by default, apart from the agents' default, and each answer records it: keep it apart from `LEAD_MODEL`, as rule 6 asks. It's still Gemini, so check its fields by hand on a sample of answers. An answer with the skills' hand-over line, "For a planner to decide:", counts as a flag whatever the reader says, unless it abstains or refuses. A script reads the citations.
- Answers go to `evals/runs/<UTC time>.jsonl` with their tokens, cost and time, and each case's log to `evals/runs/<UTC time>/<id>.log.jsonl`: its subagents, readings, figures and each model call's usage. If Gemini's quota runs out, the run stops and keeps them. Costs come from the prices in [agents/prices.py](../agents/prices.py).
- [score-run.ts](../evals/score-run.ts) then prints the pass rate by capability, decisions against the control, hand-overs, citation recall and precision, and tokens and time per case. `npm run agent:score` scores a run again.

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
95% lower bound of 48%. A planner wrote none of the cases, and 17 of the 53 reuse
the Lawrence proposal.

The claim gets stronger in this order ([order of work](benchmark.md#order-of-work)):

1. About 105 records from the 2024–2026 plans.
2. A sealed prediction on the 2027 plan.
3. Rubrics written by planners, and planners scoring a sample.
4. The Lawrence trial's real result at its review.
