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
- `split`: `dev` to build against, `test` kept aside, `future` for answers nobody knows yet.
- `context` or `inputs`: full documents, or a prepared copy with the outcome removed.
- `perturbed`: the numbers were changed, so the published answer is wrong.
- `expect.behaviour`: `answer`, `flag`, `abstain` or `refuse`.
- `expect.value`, `tolerance`: the number, and how close it must be.
- `expect.citations`: pages that must be cited.
- `expect.decision`, `checks`: the recommendation and each test result.
- `expect.judgement`: the rules alone don't decide this case.
- `expect.mentions`, `forbids`: required and banned wording.
- `scorer: "rubric"`: needs planners or judged scoring.

## The current set

45 cases from the 2026 plan:

- Scored by script: Find 11; Check 12, including trial reviews and changed numbers; Calculate 6; Stop and hand over 7; Reconcile, consultation and trace 5.
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
95% lower bound of 48%. A planner wrote none of the cases, and 17 of the 45 reuse
the Lawrence proposal.

The claim gets stronger in this order ([order of work](benchmark.md#order-of-work)):

1. About 105 records from the 2024–2026 plans.
2. A sealed prediction on the 2027 plan.
3. Rubrics written by planners, and planners scoring a sample.
4. The Lawrence trial's real result at its review.
