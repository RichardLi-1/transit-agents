# Results, 2026-11-16: repeat runs

The first night's runs gave one run per case ([results-2026-11-16.md](results-2026-11-16.md)).
This second night repeats them, so the numbers can be checked against run-to-run noise. It
adds a run without skills and a bigger model. Every run used the same 25 runnable,
planner-reviewed test cases, 24 of them scored by script.

Headline, in passed of 24 scored test cases:

- **4B with skills: 5, 10 and 6** in three runs (mean 7.0). The same model and settings
  passed 5 cases in one run and 10 in another, so a single run moves by up to 5 cases
  (about 20 points) from sampling alone.
- **4B without skills: 5, 4 and 7** (mean 5.3).
- **9B with skills, on Ollama: 3, 7 and 5** (mean 5.0).
- **4B with the LoRA adapter (run B, one run): 8.** That falls within the range of the base
  model's own runs (5 to 10), so last night's +3 for the adapter is what noise alone gives.
- **No difference here is significant.** Skills against no skills (4B): 8 against 5 cases
  passed by majority of runs, 4 cases against 1 (exact McNemar p = 0.38). 9B against 4B,
  with skills: 4 against 8, 0 cases against 4 (p = 0.13).
- **One clear pattern, by skill:** without skills, the 4B failed all 5 spatial cases in
  all 3 runs (0 of 15), each time by saying it couldn't answer. With skills, it passed 10 of 15.
  On the 16 ttc-standards cases, it did no better with skills (10 of 48) than without (16 of 48).
  This is a finding from the data, not a test chosen in advance.

## Setup

Run exactly as in [results-2026-11-16.md](results-2026-11-16.md), with the same code
(branch `eval/overnight`), prompts, skills, scorer and cases. Prompts, skills and the scorer
didn't change.

- **4B runs (A, C):** `mlx-community/Qwen3.5-4B-4bit` on mlx-lm 0.32.2 (MLX 0.32.4), port 8090,
  started with `--temp 0.7 --top-p 0.8 --top-k 20 --chat-template-args '{"enable_thinking":false}'
  --prompt-cache-size 4 --prompt-cache-bytes 1GB`. The model is named `default_model`, for the
  lead, the specialists and the reader. `MODEL_EXTRA={"max_tokens": 4096}`, `EVAL_MODEL_LOGS=1`,
  `EVAL_PORTS=4326-4330`, no Gemini key. Runs C added `--no-skills`.
- **9B runs (D):** `qwen3.5:9b` in Ollama 0.30.10 (`ollama serve`), at `MODEL_BASE_URL=http://127.0.0.1:11434/v1`,
  for the lead, the specialists and the reader. Ollama takes sampling and thinking settings
  per request, not when the server starts, so the 4B server's settings went in each request:
  `MODEL_EXTRA={"max_tokens": 4096, "temperature": 0.7, "top_p": 0.8, "presence_penalty": 0, "reasoning_effort": "none"}`.
  Without them, Ollama would use the model's own defaults: temperature 1, top-p 0.95 and
  presence penalty 1.5. Top-k is 20 by the model's default, as on the 4B server. A test call
  before D1 showed thinking was off (4 tokens out, no reasoning). The server ran with
  `OLLAMA_CONTEXT_LENGTH=65536`, so the longest prompt of the 4B runs (47,276 tokens) and a
  4,096-token reply would fit, plus `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1` and
  `OLLAMA_KEEP_ALIVE=2h`. The 9B's longest prompt was 13,651 tokens, and none was truncated.
- **Same everything else:** `python agents/main.py eval --limit 100 --case <the 25 ids>`, run
  A's case order, other settings at the repo's defaults (30 model calls an agent, 60 a run).
- **One model process at a time.** The MLX server was stopped before Ollama started, and
  Ollama (model and server) before MLX started again.
- **Order:** A2, C1, D1, A3, C2, D2, C3, D3, from 00:51 to 06:57 EST, one at a time. Run 1
  of 4B with skills is last night's run A (`20261115T235557Z`).

## Passed per run and condition

Passed of 24 scored test cases. The rubric case `draft-001` ran each time but isn't scored.

| Condition | Run 1 | Run 2 | Run 3 | Mean | Min–max | All runs |
|---|---|---|---|---|---|---|
| 4B, skills | 5 | 10 | 6 | 7.0 | 5–10 | 21/72 |
| 4B, no skills | 5 | 4 | 7 | 5.3 | 4–7 | 16/72 |
| 4B, LoRA adapter (run B) | 8 | – | – | 8.0 | 8 (one run) | 8/24 |
| 9B, skills (Ollama) | 3 | 7 | 5 | 5.0 | 3–7 | 15/72 |

By skill and by expected behaviour, over all runs of each condition:

| | 4B, skills | 4B, no skills | 4B, adapter | 9B, skills |
|---|---|---|---|---|
| gis-analyst (spatial, 5 cases) | 10/15 | **0/15** | 2/5 | 5/15 |
| ttc-standards (16 cases) | 10/48 | 16/48 | 5/16 | 9/48 |
| consultation (3 cases) | 1/9 | 0/9 | 1/3 | 1/9 |
| answer expected (20 cases) | 21/60 | 13/60 | 7/20 | 15/60 |
| flag expected (4 cases) | 0/12 | 3/12 | 1/4 | 0/12 |

Without skills, all 15 spatial attempts ended with the model saying it couldn't answer.

## Per case

How many runs passed each case.

| Case | 4B, skills | 4B, no skills | 9B, skills | 4B, adapter |
|---|---|---|---|---|
| calc-002 | 0/3 | 0/3 | 0/3 | 0/1 |
| calc-003 | 0/3 | 0/3 | 1/3 | 0/1 |
| calc-004 | 3/3 | 2/3 | 3/3 | 1/1 |
| calc-005 | 0/3 | 0/3 | 0/3 | 1/1 |
| calc-006 | 2/3 | 3/3 | 0/3 | 1/1 |
| check-002 | 0/3 | 0/3 | 1/3 | 0/1 |
| check-004 | 2/3 | 2/3 | 0/3 | 0/1 |
| consult-001 | 0/3 | 0/3 | 1/3 | 0/1 |
| consult-002 | 1/3 | 0/3 | 0/3 | 1/1 |
| find-003 | 0/3 | 1/3 | 0/3 | 0/1 |
| find-011 | 2/3 | 3/3 | 3/3 | 1/1 |
| perturbed-001 | 1/3 | 1/3 | 1/3 | 0/1 |
| perturbed-002 | 0/3 | 1/3 | 0/3 | 0/1 |
| perturbed-003 | 0/3 | 0/3 | 0/3 | 0/1 |
| perturbed-004 | 0/3 | 0/3 | 0/3 | 0/1 |
| review-001 | 0/3 | 1/3 | 0/3 | 1/1 |
| review-002 | 0/3 | 0/3 | 0/3 | 0/1 |
| review-003 | 0/3 | 2/3 | 0/3 | 0/1 |
| spatial-004 | 2/3 | 0/3 | 0/3 | 0/1 |
| spatial-006 | 0/3 | 0/3 | 0/3 | 0/1 |
| spatial-007 | 2/3 | 0/3 | 2/3 | 1/1 |
| spatial-009 | 3/3 | 0/3 | 2/3 | 1/1 |
| spatial-010 | 3/3 | 0/3 | 1/3 | 0/1 |
| stop-005 | 0/3 | 0/3 | 0/3 | 0/1 |

7 cases failed in all 9 runs of the three conditions: `calc-002`, `calc-005`, `perturbed-003`,
`perturbed-004`, `review-002`, `spatial-006` and `stop-005`.

### Run-to-run agreement

Cases with the same result in all 3 runs of a condition:

| Condition | Same in all 3 | Always pass | Always fail | Differ | Pairs of runs agreeing |
|---|---|---|---|---|---|
| 4B, skills | 17/24 | 3 | 14 | 7 | 19, 19, 20 of 24 |
| 4B, no skills | 17/24 | 2 | 15 | 7 | 19, 20, 19 of 24 |
| 9B, skills | 17/24 | 2 | 15 | 7 | 20, 20, 18 of 24 |

In each condition, 7 of 24 cases changed result between runs. Most of the agreement is cases
that always fail: only 2 or 3 cases a condition always pass.

## Paired comparisons, same cases

Each case's result is its majority over 3 runs (passed in at least 2). Exact two-sided
McNemar test on the cases where the two conditions differ. Run 1 against run 1 is also shown.

| Comparison | Basis | Passed | Both | Only first | Only second | p |
|---|---|---|---|---|---|---|
| 4B skills vs no skills | majority of 3 | 8 vs 5 | 4 | 4 | 1 | 0.38 |
| 4B skills vs no skills | run 1 vs run 1 | 5 vs 5 | 1 | 4 | 4 | 1.00 |
| 9B vs 4B, with skills | majority of 3 | 4 vs 8 | 4 | 0 | 4 | 0.13 |
| 9B vs 4B, with skills | run 1 vs run 1 | 3 vs 5 | 2 | 1 | 3 | 0.63 |
| Adapter vs 4B, with skills | adapter's one run vs 4B majority | 8 vs 8 | 5 | 3 | 3 | 1.00 |
| Adapter vs 4B, with skills | run 1 vs run 1 (last night's) | 8 vs 5 | 2 | 6 | 3 | 0.51 |

- **Skills vs no skills:** the 4 cases only skills passed are all spatial (`spatial-004`, `-007`,
  `-009`, `-010`), and the 1 case only no-skills passed is `review-003`, a flag case. With 5
  discordant cases, even 5 against 0 couldn't reach p < 0.05 (p = 0.06). On run 1 alone, the
  two conditions tie, 5 and 5, with 4 swaps each way.
- **9B vs 4B:** the 4 cases only the 4B passed are `calc-006`, `check-004`, `spatial-004` and
  `spatial-010`. None went the other way. That is no evidence that the 9B is worse, and
  it has the confounds below.
- **Adapter:** against the base model's majority, the adapter's run ties, 8 and 8, with 3 swaps
  each way. Last night's comparison (8 against 5, p = 0.51) set it against the base model's
  lowest run.

## Hand-overs claimed in the text, not in the log

The scorer notes each answer whose wording hands over to a planner while the log has no question
for a planner (no `ask_planner` question recorded). It doesn't score this: a hand-over is
scored from the log. Counts are of the 24 scored test cases a run:

| Condition | Run 1 | Run 2 | Run 3 | All runs | `ask_planner` calls (questions recorded) |
|---|---|---|---|---|---|
| 4B, skills | 7 | 3 | 9 | 19/72 | 3 (1), 0 (0), 0 (0) |
| 4B, no skills | 4 | 5 | 3 | 12/72 | 9 (4), 5 (1), 3 (2) |
| 4B, adapter | 6 | – | – | 6/24 | 22 (1) |
| 9B, skills | 8 | 4 | 4 | 16/72 | 2 (0), 0 (0), 0 (0) |

The finding holds in every run of every condition: between 3 and 9 answers in 24 claim a
hand-over that never happened. (Last night's figure, 16 of 60, counted run A's test and dev
cases together; its test half is run 1 here, 7 of 24.) With skills, neither model recorded a
single question for a planner in tonight's runs. Without skills, the 4B asked 17 times and 7
questions were recorded, and it passed 3 of 12 flag-case runs, against 0 of 12 with skills.
Whether the answer's wording hands over is read by the reader, which is the agents' own model.
So the counts depend on that reader too, and the 9B runs had a different reader.

## Time and tokens per case

Over all case runs of each condition (25 cases a run). Tokens are the agents', not the reader's.

| Condition | Case runs | Median time | Mean time | Longest | Model calls | Tokens in | Tokens out | Wall clock a run |
|---|---|---|---|---|---|---|---|---|
| 4B, skills | 75 | 81 s | 133 s | 649 s | 10.5 | 130,721 | 2,039 | 52, 62, 59 min |
| 4B, no skills | 75 | 71 s | 98 s | 799 s | 9.1 | 109,020 | 1,528 | 48, 39, 37 min |
| 4B, adapter | 25 | 100 s | 217 s | 1,550 s | 13.9 | 201,443 | 3,045 | 91 min |
| 9B, skills | 75 | 73 s | 95 s | 264 s | 4.2 | 30,600 | 511 | 44, 41, 36 min |

The 9B made 4.2 model calls a case against the 4B's 10.5, and read about a quarter of the
tokens. It was slower per call (about 2 times on the first case, 54 s against 30 s for 3 calls)
but stopped sooner. It gave shorter answers: a median of 62 to 94 words a run, against 118 to
157 for the 4B with skills. Calls on this machine cost nothing.

## Errors

- **9B, `calc-003`, in D1 and D2:** Ollama's tool-call parser for qwen3.5 rejected the model's
  reply ("expected element type <function> but have <parameter>"), and Ollama answered HTTP 500.
  It failed the same way on each retry (8 in D1), so the case has no answer and is scored as a
  failure. The runner's message names Gemini, as it does for any model error, but no Gemini
  model was called. In D3 the case passed.
- **4B with skills, `draft-001`, run 3:** the reader echoed the JSON schema in place of an answer.
  It's the rubric case, so no score changed.

## What didn't run, and why

- **Nothing in the plan was dropped.** All 8 planned runs finished, the last (D3) at 06:57,
  well before the 09:30 cut-off. The plan listed A3, C2, D2, C3 and D3 for the time left, giving
  3 runs of each condition. No further runs were added after D3.
- **The adapter (run B) has one run.** It wasn't in tonight's plan, so its comparisons use its
  one run.
- **Dev cases weren't repeated.** Only the 25 test cases ran.
- **Rubric cases weren't scored**, as last night (`draft-001`).

## Departures from the plan

- **The 9B's request settings.** `MODEL_EXTRA` for the D runs added temperature, top-p,
  presence penalty and `reasoning_effort: none`. This was to match the 4B server's
  sampling and thinking settings, which Ollama only takes per request (see Setup). The
  4B runs used the same `MODEL_EXTRA` as last night.
- **A watchdog** checked memory pressure and free disk every 15 seconds. It would have stopped
  every model process if pressure were critical for a minute, or free disk fell under 12 GB.
  It never fired. Pressure reached the warning level, never critical. Free disk fell to
  22 GB at its lowest, during D1, as swap grew to about 22 GB while the 9B was loaded. It came
  back to about 35 GB once Ollama stopped.
- The MLX server was started as `mlx_lm.server` (the same module as `mlx_lm server`), with
  `HF_HUB_OFFLINE=1`.

## Limitations

- **The 9B differs in more than size.** It ran on a different server (Ollama 0.30.10 and its
  llama.cpp runner, not mlx-lm), at a different quantisation (GGUF Q4_K_M, 5.02 bits a weight,
  against MLX's 4-bit). Its chat template and tool-call parser are Ollama's own, and its
  reader was the 9B itself. Any of these could explain its fewer calls, shorter answers or
  lower score, as could its size. The parser failure on `calc-003` is one such difference.
- **Three runs a condition is still few.** A condition's runs spanned up to 5 cases (5 to 10).
  The majority of 3 runs smooths this a little, but 7 of 24 cases still changed between runs in
  every condition.
- **24 test cases.** One case is about 4 points. At this size, a paired test needs about 6
  discordant cases all going one way to reach p < 0.05. None of the comparisons here comes close.
- **The skill finding is post hoc.** The spatial gap (10 of 15 against 0 of 15) was noticed in
  the results, not tested as planned, and it covers 5 cases. The ttc-standards cases went the
  other way (10 of 48 with skills, 16 of 48 without). Both deserve a planned test on more cases.
- **The reader is the agents' own model**, against rule 6, and it decides the hand-over wording
  count as well as the answer fields.
- **The committed test split is public**, so these are scores on public cases.

## Run files

In `evals/runs/` (not committed), each with a folder of case logs and model calls. The progress
log of the night is `evals/runs/progress.log`.

| Run | File |
|---|---|
| 4B, skills, run 1 (last night's A) | `20261115T235557Z` |
| 4B, skills, run 2 (A2) | `20261116T055151Z` |
| 4B, skills, run 3 (A3) | `20261116T082541Z` |
| 4B, no skills, run 1 (C1) | `20261116T065325Z` |
| 4B, no skills, run 2 (C2) | `20261116T092445Z` |
| 4B, no skills, run 3 (C3) | `20261116T104427Z` |
| 4B, adapter (last night's B) | `20261116T040228Z` |
| 9B, skills, run 1 (D1) | `20261116T074158Z` |
| 9B, skills, run 2 (D2) | `20261116T100319Z` |
| 9B, skills, run 3 (D3) | `20261116T112131Z` |

Scores: `node evals/score-run.ts [--json] evals/runs/<file>.jsonl`.
