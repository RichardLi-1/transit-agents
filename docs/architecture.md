# Architecture: agents at the centre

Planners give the system context and make the decisions. Agents do everything
in between: they decide what work the context calls for, run the agency's
existing tools, record every figure with its source, and improve their own
skills. The paper on it, for CASPT & TransitData 2027: [paper/main.tex](../paper/main.tex).

## Designed for the models of five years from now

Models get better faster than agencies can buy and connect software. So:

1. **What gets better with the model is left to the model.** Planning the
   work, picking tools and writing procedures are text the model reads
   (skills), not code paths. A stronger model does them better with no redesign.
2. **What must not depend on the model is fixed in the service.** Evidence
   (the citation check), authority (roles), the log and evaluation. The more
   capable and persuasive models get, the more these matter.
3. **General interfaces.** Documents in; APIs, files and screens out. A
   stronger model uses them better with no new integration.
4. **The model is replaceable.** The eval set, not the model, is what lasts:
   it decides whether a new model is good enough.

## Parts

| Part | Job |
|---|---|
| Context intake | Planners drop in documents, transcripts, messages, exports and feeds: API, watched folder or Slack. Each one becomes an event in the log. |
| Orchestrator | The lead agent. Triages each event: which studies it touches, what it changes, which open questions it reopens. Starts work without being asked. |
| Specialists and skills | One specialist per question, with one skill. The skill is what gets versioned, tested and improved. |
| Adapters | How agents run existing systems: APIs and MCP where they exist, scheduled exports where they don't, computer use for desktop tools with neither. Each is a tool inside a skill. |
| Record | The append-only log, the citation check, roles and budgets. Also which skill versions are approved. |
| Evolver | An agent that proposes new skill versions. It is itself a skill. It runs no evaluation and posts no scores. |
| Evaluator | Not an agent: a process of its own that holds the test split. It runs a candidate's gate, then the test split, and alone may post the scores. |

## How it improves itself

Three levels:

1. **In a run.** A rejected citation or a failed check goes back to the agent,
   which fixes its work.
2. **Across runs.** The evolver reads typed signals from the log: failed dev
   cases, rejection codes and planner overrides. Never free text, which a
   planted document could steer. It writes new instructions (SKILL.md) beside
   the live skill, with its parent's hash, the change and the signals it used.
   Scripts change only by code review: planners rely on what they compute. It
   puts the candidate forward with its content hash, the diff and the signals,
   and no scores (`POST /v1/skills/{name}/candidates`, agents only). The
   evaluator then runs the gate, Equation 1 in the paper, and the candidate goes
   live only if:
   - its mean score on the dev cases, over 3 runs or more, is no lower than its
     parent's;
   - it passes every refuse, flag and abstain case its parent passed, at least as
     often, judged from the log of what the agent did, not from its wording;
   - a planner approves the diff, with the evaluator's scores beside the proposal
     in the log (`PUT /v1/skills/{name}`, planners only).

   Only once the gate passes does the evaluator run the test split, and it posts
   the scores and the gate's verdict with its own token
   (`POST /v1/skills/{name}/candidates/{hash}/scores`, the evaluator only). The
   service checks the verdict follows from the numbers. A set used to pick
   between changes stops measuring anything.
3. **The model.** Fine-tuning the local model on runs planners accepted goes
   through the same gate, for every skill.

A skill's version is the SHA-256 of its folder: every file's path and bytes.
Each skill has one current version, the content hash a planner approved last
(`npm run approve-skill -- <name>`), and agents load only that. Approving a new
hash replaces the old one, and a planner can revoke it. A candidate carries the
hash its folder will have once its SKILL.md is copied in, so approving it approves
exactly that content. Rolling back is restoring the parent's files and approving
the parent's hash again. The evolver is a skill too, but the gate can judge it only once it has
cases of its own, scored by how its candidates do on the test split. Until then
its instructions, like the lead's, change by hand.

## Rules, and whether they're enforced yet

| Rule | Today |
|---|---|
| Only planners decide, set rules and approve versions | Enforced by service roles |
| A cited figure's quote must be on the cited page | Enforced by the service |
| A computed figure names an approved skill version | Enforced: the agent names the hash it loaded, and the service checks it is the skill's current one |
| Agents load only approved content hashes | Enforced by the loader: only each skill's current hash, so a replaced or revoked one no longer loads |
| Skill scripts run sandboxed, with no keys, tokens or session | Enforced: on macOS by sandbox-exec; elsewhere only the environment is scrubbed |
| Evolution edits instructions only | Enforced by the evolver (in development) |
| Only the evaluator scores a candidate | Enforced by service roles: an agent's token, the evolver's among them, and a planner's are refused, and the service refuses a verdict the numbers don't give |
| Test cases stay off agent machines | Not yet: the test split is public |
| Safety cases are scored from the log of actions | Partly: the scorer reads each case's log, so a refusal or abstention passes only if nothing was recorded or tried, and a flag only if an agent handed a question to a planner (ask_planner). Whether an answer refused rather than answered in words is still read by a small model |
| Writes to agency systems need a planner decision | Not yet: computer use isn't logged |

Found by a red-team review on 2026-11-15. The "not yet" rows are the next work.

## Built and not yet built

- **Built:** the lead and specialists, 19 skills, the log and citation check,
  roles, the watched folder, Slack, computer use on two sample apps, budgets,
  planner approval of skill versions, and 205 eval cases.
- **Being built:** the evolver and its gate, and the lead starting on new
  context without being asked. Both are on the branch
  `worktree-agent-aa381b7846cc4fab0`, with unit tests (30 pass) but no
  evaluation, and not merged. Today the lead starts when a planner asks in
  chat, Slack or the command line.
- **Next:** a planner reviews the 139 cases waiting for review; evolved skills
  are compared with hand-written ones on the test split; then a read-only
  pilot with an agency.
