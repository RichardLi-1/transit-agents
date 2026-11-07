# What the eval set looks like

The eval set is what turns a demo into a research result. It lives in
[evals/](../evals), and the layers are described in [benchmark.md](benchmark.md).

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

An agent answers with its text, its behaviour, and any value, decision, test
results and citations. [score.ts](../evals/score.ts) compares them with the case.

## Fields

| Field | Means |
|---|---|
| `capability` | Which skill from [queries.md](queries.md) it tests |
| `split` | `dev` to build against, `test` kept aside, `future` for answers nobody knows yet |
| `context` or `inputs` | Full documents, or a prepared copy with the outcome removed |
| `perturbed` | The numbers were changed, so the published answer is wrong |
| `expect.behaviour` | `answer`, `flag`, `abstain` or `refuse` |
| `expect.value`, `tolerance` | The number, and how close it must be |
| `expect.citations` | Pages that must be cited |
| `expect.decision`, `checks` | Recommendation and each test result |
| `expect.judgement` | The rules alone don't decide this case |
| `expect.mentions`, `forbids` | Required and banned wording |
| `scorer: "rubric"` | Needs planners or judged scoring |

## The current set

45 cases from the 2026 plan.

| Capability | Cases | Scored by |
|---|---|---|
| Find | 11 | Script |
| Check, including trial reviews and changed numbers | 12 | Script |
| Calculate | 6 | Script |
| Stop and hand over | 7 | Script |
| Reconcile, consultation, trace | 5 | Script |
| Monitor | 2 | Script and rubric |
| Draft | 2 | Rubric |

## What gets reported

| Measure | Why |
|---|---|
| Pass rate by capability | Shows what it can and can't do |
| Decisions matched, against the rules-only control | Shows whether the agent adds anything. The control applies the answer key's own test results, so it is an upper bound for rules alone, and it can never answer "defer" or "amend". |
| Hand-overs on judgement cases | Counted as correct, and reported apart, so honest hand-overs are never beaten by lucky guesses |
| Accuracy on changed numbers, against the originals | A large gap means it is remembering, not reading |
| Citation recall and precision | Whether sources are real and relevant |
| Figures rejected by the service | A live measure of invented sources |
| Correct refusals | The safety result. Scored from the answer today; should be scored from the service's log, where an agent's actual calls are recorded. |
| Agreement across repeated runs | One lucky run proves nothing, so run each case at least 3 times |
| Tokens, cost and time per case | Whether it is worth running |
| Share of output planners corrected | The result planners care about, and the only one that needs real use |

## Rules for a fair result

1. **Agents don't get the web during evals.** The published plans are online, so the answers are too.
2. **`test` cases are not for tuning.** Use `dev`, and move a case to `dev` if you look at its answer.
3. **Report the control beside the score.** A pass rate alone means little.
4. **Report counts, not only percentages.** With 8 real decisions, one case moves the result by 12 points.
5. **Prefer the script.** Use judged scoring only for drafts, and check judges against planners.
6. **Keep the judge separate from the agent.** A model shouldn't grade its own vendor alone.

## What this can and can't claim

The current set can show that the system works and that the method is sound. It
can't yet support a claim about agent quality. Eight decisions is too few: five
perfect answers still give a 95% lower bound of 48%. A planner wrote none of the
cases, and 17 of the 45 reuse the Lawrence proposal. The claim gets stronger in
this order:

1. About 105 records from the 2024–2026 plans.
2. A sealed prediction on the 2027 plan.
3. Rubrics written by planners, and planners scoring a sample.
4. The Lawrence trial's real result at its review.
