// All state is a fold of the log. Nothing here is written to directly: an entry
// is appended first, then applied.
import {
  evaluate,
  type Assumption,
  type Basis,
  type CheckView,
  type Context,
  type Decision,
  type Figure,
  type FigureView,
  type FindingView,
  type NewCheck,
  type Usage,
} from "@transit-agents/contracts";
import type { Entry } from "./log.ts";

type Check = Omit<NewCheck, "threshold"> & { threshold: { assumption: string } | { value: number } };

export type Study = {
  id: string;
  title: string;
  brief: string;
  routes: string[];
  line?: string;
  trial?: { startedOn: string; reviewOn: string };
  figures: Map<string, Figure>;
  checks: Map<string, Check>;
  findings: Map<string, FindingView>;
  decisions: Decision[];
  stale: Set<string>;
};

export type State = {
  contexts: Map<string, Context>;
  studies: Map<string, Study>;
  assumptions: Map<string, Assumption>;
  usage: Usage;
  usageByStudy: Map<string, Usage>;
};

const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, computeSeconds: 0, calls: 0 });

export const emptyState = (): State => ({
  contexts: new Map(),
  studies: new Map(),
  assumptions: new Map(),
  usage: noUsage(),
  usageByStudy: new Map(),
});

type Scope = Map<string, number>;

const inputsOf = (basis: Basis): ({ figure: string } | { assumption: string })[] => {
  if (basis.kind === "derived") return Object.values(basis.inputs);
  if (basis.kind === "computed") return basis.inputs;
  return [];
};

// What each figure in a study is worth, given assumption values. A cycle or a
// missing input throws, and the API rejects such figures before they are stored.
export function resolveFigures(study: Study, assumptions: Scope, overrides: Scope = new Map()): Scope {
  const values: Scope = new Map();
  const visiting = new Set<string>();

  const valueOf = (id: string): number => {
    const known = values.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error(`Figure "${id}" depends on itself`);
    const figure = study.figures.get(id);
    if (!figure) throw new Error(`Unknown figure "${id}"`);
    visiting.add(id);
    let value = overrides.get(id) ?? figure.value;
    if (figure.basis.kind === "derived" && !overrides.has(id)) {
      const scope: Record<string, number> = {};
      for (const [name, input] of Object.entries(figure.basis.inputs)) {
        scope[name] = "figure" in input ? valueOf(input.figure) : assumptionValue(assumptions, input.assumption);
      }
      value = evaluate(figure.basis.formula, scope);
    }
    visiting.delete(id);
    values.set(id, value);
    return value;
  };

  for (const id of study.figures.keys()) valueOf(id);
  return values;
}

function assumptionValue(assumptions: Scope, key: string): number {
  const value = assumptions.get(key);
  if (value === undefined) throw new Error(`Unknown assumption "${key}"`);
  return value;
}

export const assumptionValues = (state: State): Scope =>
  new Map([...state.assumptions].map(([key, a]) => [key, a.value]));

const passes = (actual: number, op: Check["op"], threshold: number) => {
  if (op === ">=") return actual >= threshold;
  if (op === ">") return actual > threshold;
  if (op === "<=") return actual <= threshold;
  return actual < threshold;
};

export function checksFor(study: Study, values: Scope, assumptions: Scope): CheckView[] {
  return [...study.checks.values()].map((check) => {
    const threshold =
      "value" in check.threshold ? check.threshold.value : assumptionValue(assumptions, check.threshold.assumption);
    const actual = values.get(check.figure) as number;
    const status = study.stale.has(check.figure) ? "stale" : passes(actual, check.op, threshold) ? "pass" : "fail";
    return {
      id: check.id,
      label: check.label,
      figure: check.figure,
      op: check.op,
      threshold,
      actual,
      status,
      ...(check.rule ? { rule: check.rule } : {}),
    } as CheckView;
  });
}

export function analysisOf(checks: CheckView[]): "pass" | "fail" | "mixed" | "incomplete" {
  if (!checks.length || checks.some((c) => c.status === "stale")) return "incomplete";
  const failed = checks.filter((c) => c.status === "fail").length;
  if (failed === 0) return "pass";
  return failed === checks.length ? "fail" : "mixed";
}

// A decision is an override when it goes against a clear analysis.
export function isOverride(analysis: Decision["analysis"], outcome: Decision["outcome"]): boolean {
  if (analysis === "pass") return outcome !== "adopt";
  if (analysis === "fail") return outcome === "adopt";
  return false;
}

// Figures a skill produced can't be recomputed here. When something they depend
// on changes, they are marked stale until a skill resubmits them.
export function staleAfter(study: Study, changed: { figure: string } | { assumption: string }): Set<string> {
  const stale = new Set<string>();
  const dependsOn = (id: string, seen: Set<string>): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const figure = study.figures.get(id);
    if (!figure) return false;
    return inputsOf(figure.basis).some((input) => {
      if ("assumption" in input) return "assumption" in changed && input.assumption === changed.assumption;
      if ("figure" in changed && input.figure === changed.figure) return true;
      return dependsOn(input.figure, seen);
    });
  };
  for (const figure of study.figures.values()) {
    if (figure.basis.kind === "computed" && dependsOn(figure.id, new Set())) stale.add(figure.id);
  }
  // Anything built on a stale figure is stale too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const figure of study.figures.values()) {
      if (stale.has(figure.id)) continue;
      if (inputsOf(figure.basis).some((input) => "figure" in input && stale.has(input.figure))) {
        stale.add(figure.id);
        grew = true;
      }
    }
  }
  return stale;
}

export function viewFigures(study: Study, values: Scope): FigureView[] {
  return [...study.figures.values()].map((figure) => ({
    ...figure,
    value: values.get(figure.id) as number,
    stale: study.stale.has(figure.id),
  }));
}

function addUsage(total: Usage, data: { inputTokens: number; outputTokens: number; costUsd?: number; computeSeconds?: number }) {
  total.inputTokens += data.inputTokens;
  total.outputTokens += data.outputTokens;
  total.costUsd += data.costUsd ?? 0;
  total.computeSeconds += data.computeSeconds ?? 0;
  total.calls += 1;
}

const get = <T>(map: Map<string, T>, key: string | null): T => {
  const value = map.get(key as string);
  if (value === undefined) throw new Error(`Log refers to unknown id "${key}"`);
  return value;
};

export function apply(state: State, entry: Entry): void {
  const data = entry.data as { id: string; kind?: string };
  switch (entry.type) {
    case "context.added":
      state.contexts.set(data.id, { ...(data as unknown as Context), addedAt: entry.at, addedBy: entry.actor });
      return;

    case "study.opened": {
      const opened = data as unknown as Pick<Study, "id" | "title" | "brief" | "routes" | "line" | "trial">;
      state.studies.set(opened.id, {
        ...opened,
        figures: new Map(),
        checks: new Map(),
        findings: new Map(),
        decisions: [],
        stale: new Set(),
      });
      return;
    }

    case "figure.recorded": {
      const study = get(state.studies, entry.studyId);
      const figure = data as unknown as Omit<Figure, "studyId" | "recordedBy" | "recordedAt">;
      const replacing = study.figures.has(figure.id);
      study.figures.set(figure.id, { ...figure, studyId: study.id, recordedBy: entry.actor, recordedAt: entry.at });
      study.stale.delete(figure.id);
      if (replacing) for (const id of staleAfter(study, { figure: figure.id })) study.stale.add(id);
      return;
    }

    case "check.recorded":
      get(state.studies, entry.studyId).checks.set(data.id, data as unknown as Check);
      return;

    case "finding.recorded":
      get(state.studies, entry.studyId).findings.set(data.id, data as unknown as FindingView);
      return;

    case "assumption.set": {
      const { key, value, unit, label, reason, citation } = data as unknown as Assumption;
      const previous = state.assumptions.get(key);
      state.assumptions.set(key, {
        key,
        value,
        unit,
        label: label ?? previous?.label ?? key,
        reason,
        owner: entry.actor,
        setAt: entry.at,
        ...(citation ? { citation } : {}),
        history: previous
          ? [...previous.history, { value: previous.value, owner: previous.owner, setAt: previous.setAt, reason: previous.reason }]
          : [],
      });
      for (const study of state.studies.values()) {
        for (const id of staleAfter(study, { assumption: key })) study.stale.add(id);
      }
      return;
    }

    case "decision.recorded":
      get(state.studies, entry.studyId).decisions.push({
        ...(data as unknown as Decision),
        recordedBy: entry.actor,
        recordedAt: entry.at,
      });
      return;

    case "activity": {
      if (data.kind !== "usage") return;
      const usage = data as unknown as Parameters<typeof addUsage>[1];
      addUsage(state.usage, usage);
      if (entry.studyId) {
        const byStudy = state.usageByStudy.get(entry.studyId) ?? noUsage();
        addUsage(byStudy, usage);
        state.usageByStudy.set(entry.studyId, byStudy);
      }
      return;
    }

    default:
      // Unknown entry types are history, not errors: older servers ignore newer events.
      return;
  }
}
