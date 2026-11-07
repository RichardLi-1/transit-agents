// The shapes every client of the service shares: agents, integrations and the
// display. Anything that crosses the API is defined here once.
import { z } from "zod";

export { evaluate, FormulaError, variables } from "./formula.ts";

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/, "Use lowercase letters, numbers, dots and dashes");

export const Role = z.enum(["viewer", "integration", "agent", "planner"]);
export type Role = z.infer<typeof Role>;

// --- Context ---------------------------------------------------------------

export const NewContext = z.object({
  id: slug.optional(),
  title: z.string().min(1).max(200),
  folder: z.string().min(1).max(60).default("Inbox"),
  source: z.string().max(200).optional(),
  url: z.url().optional(),
  publishedOn: z.iso.date().optional(),
  pages: z.array(z.object({ page: z.number().int().positive(), text: z.string() })).optional(),
  text: z.string().optional(),
});
export type NewContext = z.input<typeof NewContext>;

export const Context = z.object({
  id: slug,
  title: z.string(),
  folder: z.string(),
  source: z.string().optional(),
  url: z.string().optional(),
  publishedOn: z.string().optional(),
  sha256: z.string(),
  pageCount: z.number().int(),
  addedAt: z.string(),
  addedBy: z.string(),
});
export type Context = z.infer<typeof Context>;

// --- Figures ---------------------------------------------------------------

export const Citation = z.object({
  contextId: slug,
  page: z.number().int().positive(),
  quote: z.string().min(3).max(800),
});
export type Citation = z.infer<typeof Citation>;

const Cited = z.object({ kind: z.literal("cited"), citation: Citation });

// A calculation the service can repeat. `inputs` maps each name in the formula
// to a figure in the same study, or to an assumption.
const Derived = z.object({
  kind: z.literal("derived"),
  formula: z.string().min(1).max(500),
  inputs: z.record(z.string(), z.object({ figure: slug }).or(z.object({ assumption: slug }))),
});

// A result from a skill or model the service can't repeat. It is kept with what
// produced it, and is marked stale when one of its inputs changes.
const Computed = z.object({
  kind: z.literal("computed"),
  skill: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  inputs: z.array(z.object({ figure: slug }).or(z.object({ assumption: slug }))).default([]),
  run: z.string().max(200).optional(),
});

export const Basis = z.discriminatedUnion("kind", [Cited, Derived, Computed]);
export type Basis = z.infer<typeof Basis>;

export const NewFigure = z.object({
  id: slug,
  label: z.string().min(1).max(120),
  unit: z.string().max(40).default(""),
  value: z.number().optional(),
  basis: Basis,
});
export type NewFigure = z.input<typeof NewFigure>;

export type Figure = {
  id: string;
  studyId: string;
  label: string;
  unit: string;
  value: number;
  basis: Basis;
  recordedBy: string;
  recordedAt: string;
};

// --- Checks ----------------------------------------------------------------

export const CheckOp = z.enum([">=", ">", "<=", "<"]);

export const NewCheck = z.object({
  id: slug,
  label: z.string().min(1).max(120),
  figure: slug,
  op: CheckOp,
  threshold: z.object({ assumption: slug }).or(z.object({ value: z.number() })),
  rule: Citation.optional(),
});
export type NewCheck = z.input<typeof NewCheck>;

// A test the service can't compute, such as whether public feedback was positive.
export const NewFinding = z.object({
  id: slug,
  label: z.string().min(1).max(120),
  text: z.string().min(1).max(400),
  tone: z.enum(["positive", "mixed", "negative", "neutral"]),
  citation: Citation,
});
export type NewFinding = z.input<typeof NewFinding>;

export const CheckStatus = z.enum(["pass", "fail", "stale"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

// --- Assumptions -----------------------------------------------------------

export const NewAssumption = z.object({
  value: z.number(),
  unit: z.string().max(40).default(""),
  label: z.string().min(1).max(120).optional(),
  reason: z.string().min(3).max(400),
  citation: Citation.optional(),
});
export type NewAssumption = z.input<typeof NewAssumption>;

export type Assumption = {
  key: string;
  label: string;
  value: number;
  unit: string;
  reason: string;
  owner: string;
  setAt: string;
  citation?: Citation;
  history: { value: number; owner: string; setAt: string; reason: string }[];
};

// --- Studies ---------------------------------------------------------------

export const NewStudy = z.object({
  id: slug,
  title: z.string().min(1).max(120),
  brief: z.string().max(2000).default(""),
  routes: z.array(z.string()).default([]),
  line: z.string().optional(),
  trial: z.object({ startedOn: z.iso.date(), reviewOn: z.iso.date() }).optional(),
});
export type NewStudy = z.input<typeof NewStudy>;

export const Outcome = z.enum(["adopt", "reject", "defer", "amend"]);
export type Outcome = z.infer<typeof Outcome>;

export const NewDecision = z.object({
  outcome: Outcome,
  reason: z.string().min(3).max(1000),
  decidedBy: z.string().min(1).max(120),
  citation: Citation.optional(),
});
export type NewDecision = z.input<typeof NewDecision>;

export type Analysis = "pass" | "fail" | "mixed" | "incomplete";

export type Decision = {
  outcome: Outcome;
  reason: string;
  decidedBy: string;
  recordedBy: string;
  recordedAt: string;
  analysis: Analysis;
  override: boolean;
  citation?: Citation;
};

export type FigureView = Figure & { stale: boolean };

export type CheckView = {
  id: string;
  label: string;
  figure: string;
  op: z.infer<typeof CheckOp>;
  threshold: number;
  actual: number;
  status: CheckStatus;
  rule?: Citation;
};

export type FindingView = z.infer<typeof NewFinding>;

export type StudyView = {
  id: string;
  title: string;
  brief: string;
  routes: string[];
  line?: string;
  trial?: { startedOn: string; reviewOn: string };
  figures: FigureView[];
  checks: CheckView[];
  findings: FindingView[];
  analysis: Analysis;
  decision?: Decision;
};

// --- Activity --------------------------------------------------------------

export const Activity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.started") }),
  z.object({ kind: z.literal("run.finished") }),
  z.object({ kind: z.literal("message"), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal("reading"), contextId: slug, page: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("subagent.started"), id: slug, question: z.string().min(1).max(300) }),
  z.object({ kind: z.literal("subagent.finished"), id: slug, summary: z.string().min(1).max(1000) }),
  z.object({
    kind: z.literal("usage"),
    model: z.string().min(1).max(100),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    computeSeconds: z.number().nonnegative().optional(),
  }),
]);
export type Activity = z.infer<typeof Activity>;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  computeSeconds: number;
  calls: number;
};

// --- Log and subscriptions -------------------------------------------------

export type LogEntry = {
  seq: number;
  at: string;
  actor: string;
  type: string;
  studyId: string | null;
  data: unknown;
  prevHash: string;
  hash: string;
};

export const NewSubscription = z.object({
  url: z.url(),
  types: z.array(z.string()).default(["decision.recorded"]),
  format: z.enum(["json", "slack", "teams"]).default("json"),
  secret: z.string().min(16).optional(),
});
export type NewSubscription = z.input<typeof NewSubscription>;
