// Scores one agent answer against one eval case. Everything here is
// deterministic. Cases marked `scorer: "rubric"` need human or judged review.

export type Behaviour = "answer" | "flag" | "abstain" | "refuse";
export type Decision = "adopt" | "reject" | "defer" | "amend";
export type CheckResult = "pass" | "fail" | "not_assessed";

export type Citation = { source: string; page?: number; quote?: string };

export type Expectation = {
  behaviour: Behaviour;
  value?: number;
  tolerance?: number;
  mentions?: string[];
  forbids?: string[];
  citations?: Citation[];
  decision?: Decision;
  judgement?: boolean;
  checks?: Record<string, CheckResult>;
};

export type EvalCase = {
  id: string;
  capability: string;
  // The skill in agents/skills the case mainly tests, so a run with skills and one
  // without show what each adds.
  skill: string;
  split: "dev" | "test" | "future";
  query: string;
  context?: string[];
  inputs?: string[];
  // The study the case runs in, as a planner would have opened it.
  study?: { brief?: string; routes?: string[]; line?: string; trial?: { startedOn: string; reviewOn: string }; watch?: string[] };
  // What the live feed measured for it: evals/inputs/<name>.json.
  measured?: string;
  perturbed?: boolean;
  scorer?: "rubric";
  // For a rubric case: what a planner checks the answer for.
  rubric?: string[];
  // A planner still has to check the gold answer before the case counts.
  review?: "planner";
  // How the gold answer was worked out, when not read off a page.
  goldFrom?: string;
  expect: Expectation;
};

export type Answer = {
  text: string;
  behaviour: Behaviour;
  value?: number;
  decision?: Decision;
  checks?: Record<string, CheckResult>;
  citations?: Citation[];
};

export type Score = {
  id: string;
  passed: boolean;
  failures: string[];
  citationRecall: number | null;
  citationPrecision: number | null;
  // On a case that needs judgement, flagging it for a planner without deciding
  // is as good as deciding correctly. Reported apart, so neither hides the other.
  handedOver: boolean;
};

const samePage = (a: Citation, b: Citation) => a.source === b.source && a.page === b.page;

export function scoreCase(c: EvalCase, a: Answer): Score {
  const e = c.expect;
  const failures: string[] = [];
  const text = a.text.toLowerCase();

  if (a.behaviour !== e.behaviour) failures.push(`behaviour: wanted ${e.behaviour}, got ${a.behaviour}`);

  if (e.value !== undefined) {
    const tolerance = e.tolerance ?? 0;
    if (a.value === undefined || Math.abs(a.value - e.value) > tolerance) {
      failures.push(`value: wanted ${e.value}, got ${a.value ?? "nothing"}`);
    }
  }

  for (const term of e.mentions ?? []) {
    if (!text.includes(term.toLowerCase())) failures.push(`missing: ${term}`);
  }

  for (const term of e.forbids ?? []) {
    if (text.includes(term.toLowerCase())) failures.push(`forbidden: ${term}`);
  }

  const handedOver = Boolean(e.judgement) && a.behaviour === "flag" && a.decision === undefined;
  if (e.decision && !handedOver && a.decision !== e.decision) {
    failures.push(`decision: wanted ${e.decision}, got ${a.decision ?? "nothing"}`);
  }

  for (const [name, wanted] of Object.entries(e.checks ?? {})) {
    const got = a.checks?.[name];
    if (got !== wanted) failures.push(`check ${name}: wanted ${wanted}, got ${got ?? "nothing"}`);
  }

  let citationRecall: number | null = null;
  let citationPrecision: number | null = null;
  if (e.citations?.length) {
    const given = a.citations ?? [];
    const found = e.citations.filter((want) => given.some((got) => samePage(got, want)));
    const relevant = given.filter((got) => e.citations?.some((want) => samePage(got, want)));
    citationRecall = found.length / e.citations.length;
    citationPrecision = given.length ? relevant.length / given.length : 0;
    if (citationRecall < 1) failures.push("citations: expected page not cited");
  }

  return { id: c.id, passed: failures.length === 0, failures, citationRecall, citationPrecision, handedOver };
}

// The control: apply the published tests perfectly, using the answer key's test
// results, and nothing else. It is an upper bound for rules alone, not a model of
// any real tool, and it can never answer "defer" or "amend".
export function rulesOnlyDecision(checks: Record<string, CheckResult>): Decision {
  return Object.values(checks).includes("fail") ? "reject" : "adopt";
}

export type Summary = {
  total: number;
  passed: number;
  byCapability: Record<string, { total: number; passed: number }>;
  // Set beside a run without skills, this shows what each skill adds.
  bySkill: Record<string, { total: number; passed: number }>;
};

export function summarize(cases: EvalCase[], scores: Score[]): Summary {
  const byCapability: Summary["byCapability"] = {};
  const bySkill: Summary["bySkill"] = {};
  const byId = new Map(cases.map((c) => [c.id, c]));
  const add = (rows: Summary["byCapability"], name: string, passed: boolean) => {
    const row = (rows[name] ??= { total: 0, passed: 0 });
    row.total += 1;
    if (passed) row.passed += 1;
  };
  for (const s of scores) {
    const c = byId.get(s.id);
    add(byCapability, c?.capability ?? "unknown", s.passed);
    add(bySkill, c?.skill ?? "unknown", s.passed);
  }
  return { total: scores.length, passed: scores.filter((s) => s.passed).length, byCapability, bySkill };
}

export type SkillCount = { skill: string; dev: number; test: number; future: number; handOver: number; toReview: number };

// Each skill's cases by split, with how many it should refuse or hand over, and how
// many still wait for a planner to check their gold answer: what the agent
// catalogue's scorecard counts (docs/agents.md).
export function countBySkill(cases: EvalCase[]): SkillCount[] {
  const rows = new Map<string, SkillCount>();
  for (const c of cases) {
    const name = c.skill ?? "unknown";
    const row = rows.get(name) ?? { skill: name, dev: 0, test: 0, future: 0, handOver: 0, toReview: 0 };
    row[c.split] += 1;
    if (c.expect.behaviour === "refuse" || c.expect.behaviour === "flag") row.handOver += 1;
    if (c.review === "planner") row.toReview += 1;
    rows.set(name, row);
  }
  return [...rows.values()].sort((a, b) => a.skill.localeCompare(b.skill));
}
