// The service core. Every method validates against current state, appends one
// entry, and applies it. HTTP lives in app.ts; this file knows nothing about it.
import { createHash } from "node:crypto";
import {
  evaluate,
  variables,
  type Activity,
  type Analysis,
  type Assumption,
  type Basis,
  type Citation,
  type CheckView,
  type Context,
  type Decision,
  type Figure,
  type FindingView,
  type StudyView,
  type Usage,
} from "@transit-agents/contracts";
import type { z } from "zod";
import type {
  NewAssumption as NewAssumptionSchema,
  NewCheck as NewCheckSchema,
  NewContext as NewContextSchema,
  NewDecision as NewDecisionSchema,
  NewFigure as NewFigureSchema,
  NewFinding as NewFindingSchema,
  NewStudy as NewStudySchema,
} from "@transit-agents/contracts";
import { findQuote, valueInQuote } from "./citations.ts";
import { Log, type Entry, type NewEntry } from "./log.ts";
import {
  analysisOf,
  apply,
  assumptionValues,
  checksFor,
  emptyState,
  isOverride,
  resolveFigures,
  viewFigures,
  type State,
  type Study,
} from "./state.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = (what: string, id: string) => new ApiError(404, "not_found", `No ${what} "${id}"`);

type Change = { id: string; from: number; to: number };
type CheckChange = { id: string; from: string; to: string };

export type Effects = {
  studyId: string;
  figures: Change[];
  checks: CheckChange[];
  analysis: { from: Analysis; to: Analysis };
};

export type Preview = { assumptions?: Record<string, number>; figures?: Record<string, number> };

export type TraceNode = {
  id: string;
  label: string;
  value: number;
  unit: string;
  basis: Basis;
  entry?: { seq: number; hash: string; at: string; actor: string };
  inputs: (TraceNode | { assumption: Assumption })[];
};

export type Comparison = {
  from: number;
  to: number;
  figures: {
    id: string;
    label: string;
    from: number;
    to: number;
    causes: { seq: number; at: string; actor: string; reason: string; change: number; share: number }[];
  }[];
  checks: CheckChange[];
};

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "context";

export class Service {
  readonly log: Log;
  readonly state: State = emptyState();

  constructor(database: string, clock?: () => Date) {
    this.log = new Log(database, clock);
    this.log.db.exec(`
      CREATE TABLE IF NOT EXISTS context_pages (
        context_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (context_id, page)
      );
    `);
    for (const entry of this.allEntries()) apply(this.state, entry);
  }

  private *allEntries(): Generator<Entry> {
    let seq = 0;
    for (;;) {
      const batch = this.log.since(seq, 1000);
      if (!batch.length) return;
      yield* batch;
      seq = (batch.at(-1) as Entry).seq;
    }
  }

  private commit(entry: NewEntry): Entry {
    const written = this.log.append(entry);
    apply(this.state, written);
    return written;
  }

  private study(id: string): Study {
    const study = this.state.studies.get(id);
    if (!study) throw notFound("study", id);
    return study;
  }

  // --- Context -------------------------------------------------------------

  addContext(actor: string, input: z.output<typeof NewContextSchema>): Context {
    const pages = input.pages ?? (input.text !== undefined ? [{ page: 1, text: input.text }] : []);
    const sha256 = createHash("sha256")
      .update(JSON.stringify(pages.length ? pages : input.url ?? input.title))
      .digest("hex");
    const id = input.id ?? `${slugify(input.title)}-${sha256.slice(0, 8)}`;

    const existing = this.state.contexts.get(id);
    if (existing) {
      if (existing.sha256 === sha256) return existing;
      throw new ApiError(409, "context_conflict", `Context "${id}" already exists with different content`);
    }

    const insert = this.log.db.prepare("INSERT INTO context_pages (context_id, page, text) VALUES (?, ?, ?)");
    for (const { page, text } of pages) insert.run(id, page, text);

    const data = {
      id,
      title: input.title,
      folder: input.folder,
      source: input.source,
      url: input.url,
      publishedOn: input.publishedOn,
      sha256,
      pageCount: pages.length,
    };
    this.commit({ actor, type: "context.added", data });
    return this.state.contexts.get(id) as Context;
  }

  contextPage(id: string, page: number): string {
    if (!this.state.contexts.has(id)) throw notFound("context", id);
    const row = this.log.db.prepare("SELECT text FROM context_pages WHERE context_id = ? AND page = ?").get(id, page) as
      | { text: string }
      | undefined;
    if (!row) throw new ApiError(404, "not_found", `Context "${id}" has no page ${page}`);
    return row.text;
  }

  private verifyCitation(citation: Citation): "exact" | "scattered" {
    const context = this.state.contexts.get(citation.contextId);
    if (!context) throw new ApiError(422, "unknown_source", `No context "${citation.contextId}"`);
    if (!context.pageCount) throw new ApiError(422, "unreadable_source", `Context "${context.id}" has no readable text`);
    let page: string;
    try {
      page = this.contextPage(citation.contextId, citation.page);
    } catch {
      throw new ApiError(422, "page_not_found", `Context "${context.id}" has no page ${citation.page}`);
    }
    const match = findQuote(page, citation.quote);
    if (match === "none") {
      throw new ApiError(422, "quote_not_found", `Quote not found on page ${citation.page} of "${context.id}"`);
    }
    return match;
  }

  // --- Studies -------------------------------------------------------------

  openStudy(actor: string, input: z.output<typeof NewStudySchema>): StudyView {
    if (this.state.studies.has(input.id)) throw new ApiError(409, "study_exists", `Study "${input.id}" already exists`);
    this.commit({ actor, type: "study.opened", studyId: input.id, data: input });
    return this.viewStudy(input.id);
  }

  addFigure(actor: string, studyId: string, input: z.output<typeof NewFigureSchema>): Figure {
    const study = this.study(studyId);
    try {
      const { value, match } = this.resolveNewFigure(study, input);
      this.commit({
        actor,
        type: "figure.recorded",
        studyId,
        data: { id: input.id, label: input.label, unit: input.unit, value, basis: input.basis, match },
      });
      return study.figures.get(input.id) as Figure;
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        this.commit({
          actor,
          type: "figure.rejected",
          studyId,
          data: { id: input.id, code: error.code, reason: error.message },
        });
      }
      throw error;
    }
  }

  private resolveNewFigure(study: Study, input: z.output<typeof NewFigureSchema>): { value: number; match?: string } {
    const { basis } = input;

    if (basis.kind === "cited") {
      if (input.value === undefined) throw new ApiError(422, "missing_value", "A cited figure needs a value");
      const match = this.verifyCitation(basis.citation);
      if (!valueInQuote(input.value, basis.citation.quote)) {
        throw new ApiError(422, "value_not_in_quote", `${input.value} does not appear in the quote`);
      }
      return { value: input.value, match };
    }

    if (basis.kind === "computed") {
      if (input.value === undefined) throw new ApiError(422, "missing_value", "A computed figure needs a value");
      for (const dependency of basis.inputs) this.requireInput(study, dependency);
      return { value: input.value };
    }

    let names: string[];
    try {
      names = variables(basis.formula);
    } catch (error) {
      throw new ApiError(422, "bad_formula", (error as Error).message);
    }
    const scope: Record<string, number> = {};
    const assumptions = assumptionValues(this.state);
    const values = resolveFigures(study, assumptions);
    for (const name of names) {
      const dependency = basis.inputs[name];
      if (!dependency) throw new ApiError(422, "unbound_name", `"${name}" has no input`);
      this.requireInput(study, dependency);
      if ("figure" in dependency && dependency.figure === input.id) {
        throw new ApiError(422, "circular", `Figure "${input.id}" depends on itself`);
      }
      scope[name] = ("figure" in dependency ? values.get(dependency.figure) : assumptions.get(dependency.assumption)) as number;
    }
    let computed: number;
    try {
      computed = evaluate(basis.formula, scope);
    } catch (error) {
      throw new ApiError(422, "bad_formula", (error as Error).message);
    }
    if (input.value !== undefined && Math.abs(input.value - computed) > Math.abs(computed) * 1e-6 + 1e-9) {
      throw new ApiError(422, "value_mismatch", `Formula gives ${computed}, not ${input.value}`);
    }
    return { value: computed };
  }

  private requireInput(study: Study, dependency: { figure: string } | { assumption: string }) {
    if ("figure" in dependency) {
      if (!study.figures.has(dependency.figure)) {
        throw new ApiError(422, "unknown_input", `No figure "${dependency.figure}" in this study`);
      }
    } else if (!this.state.assumptions.has(dependency.assumption)) {
      throw new ApiError(422, "unknown_input", `No assumption "${dependency.assumption}"`);
    }
  }

  addCheck(actor: string, studyId: string, input: z.output<typeof NewCheckSchema>): CheckView {
    const study = this.study(studyId);
    if (!study.figures.has(input.figure)) throw new ApiError(422, "unknown_input", `No figure "${input.figure}"`);
    if ("assumption" in input.threshold) this.requireInput(study, input.threshold);
    if (input.rule) this.verifyCitation(input.rule);
    this.commit({ actor, type: "check.recorded", studyId, data: input });
    return this.viewStudy(studyId).checks.find((c) => c.id === input.id) as CheckView;
  }

  addFinding(actor: string, studyId: string, input: z.output<typeof NewFindingSchema>): FindingView {
    this.study(studyId);
    this.verifyCitation(input.citation);
    this.commit({ actor, type: "finding.recorded", studyId, data: input });
    return input;
  }

  // --- Assumptions ---------------------------------------------------------

  setAssumption(actor: string, key: string, input: z.output<typeof NewAssumptionSchema>): { assumption: Assumption; effects: Effects[] } {
    if (input.citation) this.verifyCitation(input.citation);
    const before = this.snapshot();
    const previous = this.state.assumptions.get(key);
    const scope = assumptionValues(this.state).set(key, input.value);
    const effects = this.effectsOf(before, this.snapshot(scope));
    this.commit({
      actor,
      type: "assumption.set",
      data: { ...input, key, label: input.label ?? previous?.label ?? key, from: previous?.value ?? null, effects },
    });
    return { assumption: this.state.assumptions.get(key) as Assumption, effects };
  }

  private snapshot(assumptions = assumptionValues(this.state)) {
    return new Map(
      [...this.state.studies.values()].map((study) => {
        const values = resolveFigures(study, assumptions);
        const checks = checksFor(study, values, assumptions);
        return [study.id, { values, checks, analysis: analysisOf(checks) }] as const;
      }),
    );
  }

  private effectsOf(before: ReturnType<Service["snapshot"]>, after: ReturnType<Service["snapshot"]>): Effects[] {
    const effects: Effects[] = [];
    for (const [studyId, next] of after) {
      const previous = before.get(studyId);
      if (!previous) continue;
      const figures: Change[] = [];
      for (const [id, to] of next.values) {
        const from = previous.values.get(id) as number;
        if (from !== to) figures.push({ id, from, to });
      }
      const checks: CheckChange[] = [];
      next.checks.forEach((check, i) => {
        const from = previous.checks[i]?.status as string;
        if (from !== check.status) checks.push({ id: check.id, from, to: check.status });
      });
      if (figures.length || checks.length) {
        effects.push({ studyId, figures, checks, analysis: { from: previous.analysis, to: next.analysis } });
      }
    }
    return effects;
  }

  // --- Decisions -----------------------------------------------------------

  recordDecision(actor: string, studyId: string, input: z.output<typeof NewDecisionSchema>): Decision {
    const view = this.viewStudy(studyId);
    if (input.citation) this.verifyCitation(input.citation);
    const data = {
      outcome: input.outcome,
      reason: input.reason,
      decidedBy: input.decidedBy,
      analysis: view.analysis,
      override: isOverride(view.analysis, input.outcome),
      ...(input.citation ? { citation: input.citation } : {}),
    };
    this.commit({ actor, type: "decision.recorded", studyId, data });
    return this.study(studyId).decisions.at(-1) as Decision;
  }

  // --- Activity ------------------------------------------------------------

  recordActivity(actor: string, studyId: string, activity: Activity): Entry {
    this.study(studyId);
    if (activity.kind === "reading" && !this.state.contexts.has(activity.contextId)) {
      throw new ApiError(422, "unknown_source", `No context "${activity.contextId}"`);
    }
    return this.commit({ actor, type: "activity", studyId, data: activity });
  }

  // --- Reads ---------------------------------------------------------------

  viewStudy(id: string, preview: Preview = {}): StudyView {
    const study = this.study(id);
    const assumptions = assumptionValues(this.state);
    for (const [key, value] of Object.entries(preview.assumptions ?? {})) {
      if (!assumptions.has(key)) throw new ApiError(422, "unknown_input", `No assumption "${key}"`);
      assumptions.set(key, value);
    }
    const overrides = new Map(Object.entries(preview.figures ?? {}));
    for (const key of overrides.keys()) {
      if (!study.figures.has(key)) throw new ApiError(422, "unknown_input", `No figure "${key}"`);
    }
    let values: Map<string, number>;
    try {
      values = resolveFigures(study, assumptions, overrides);
    } catch (error) {
      throw new ApiError(422, "bad_preview", (error as Error).message);
    }
    const checks = checksFor(study, values, assumptions);
    const decision = study.decisions.at(-1);
    return {
      id: study.id,
      title: study.title,
      brief: study.brief,
      routes: study.routes,
      ...(study.line ? { line: study.line } : {}),
      ...(study.trial ? { trial: study.trial } : {}),
      figures: viewFigures(study, values),
      checks,
      findings: [...study.findings.values()],
      analysis: analysisOf(checks),
      ...(decision ? { decision } : {}),
    };
  }

  studies(): StudyView[] {
    return [...this.state.studies.keys()].map((id) => this.viewStudy(id));
  }

  usage(): { total: Usage; byStudy: Record<string, Usage> } {
    return { total: this.state.usage, byStudy: Object.fromEntries(this.state.usageByStudy) };
  }

  private entryFor(studyId: string, figureId: string): Entry | undefined {
    let found: Entry | undefined;
    for (const entry of this.allEntries()) {
      if (entry.type === "figure.recorded" && entry.studyId === studyId && (entry.data as { id: string }).id === figureId) {
        found = entry;
      }
    }
    return found;
  }

  trace(studyId: string, figureId: string): TraceNode {
    const study = this.study(studyId);
    const values = resolveFigures(study, assumptionValues(this.state));
    const build = (id: string): TraceNode => {
      const figure = study.figures.get(id);
      if (!figure) throw notFound("figure", id);
      const dependencies =
        figure.basis.kind === "derived"
          ? Object.values(figure.basis.inputs)
          : figure.basis.kind === "computed"
            ? figure.basis.inputs
            : [];
      const entry = this.entryFor(studyId, id);
      return {
        id,
        label: figure.label,
        value: values.get(id) as number,
        unit: figure.unit,
        basis: figure.basis,
        ...(entry ? { entry: { seq: entry.seq, hash: entry.hash, at: entry.at, actor: entry.actor } } : {}),
        inputs: dependencies.map((d) =>
          "figure" in d ? build(d.figure) : { assumption: this.state.assumptions.get(d.assumption) as Assumption },
        ),
      };
    };
    return build(figureId);
  }

  // What changed between two points in the log, and how much of each change came
  // from each entry. Walking the log entry by entry makes the shares add up.
  compare(studyId: string, from: number, to: number): Comparison {
    this.study(studyId);
    const replay = emptyState();
    const measure = () => {
      const study = replay.studies.get(studyId);
      if (!study) return undefined;
      const assumptions = assumptionValues(replay);
      const values = resolveFigures(study, assumptions);
      return { values, checks: checksFor(study, values, assumptions), labels: study.figures };
    };

    type Cause = Comparison["figures"][number]["causes"][number];
    let start: ReturnType<typeof measure>;
    const causes = new Map<string, Cause[]>();
    let previous: ReturnType<typeof measure>;
    for (const entry of this.allEntries()) {
      if (entry.seq > to) break;
      apply(replay, entry);
      if (entry.seq <= from) {
        previous = measure();
        start = previous;
        continue;
      }
      const current = measure();
      if (previous && current) {
        for (const [id, value] of current.values) {
          const before = previous.values.get(id);
          if (before === undefined || before === value) continue;
          const reason = (entry.data as { reason?: string }).reason ?? entry.type;
          const list = causes.get(id) ?? [];
          list.push({ seq: entry.seq, at: entry.at, actor: entry.actor, reason, change: value - before, share: 0 });
          causes.set(id, list);
        }
      }
      previous = current;
    }

    const end = previous;
    const figures: Comparison["figures"] = [];
    for (const [id, list] of causes) {
      const first = start?.values.get(id);
      const last = end?.values.get(id);
      if (first === undefined || last === undefined || first === last) continue;
      const total = last - first;
      figures.push({
        id,
        label: end?.labels.get(id)?.label ?? id,
        from: first,
        to: last,
        causes: list.map((cause) => ({ ...cause, share: cause.change / total })),
      });
    }
    const checks: CheckChange[] = [];
    end?.checks.forEach((check) => {
      const before = start?.checks.find((c) => c.id === check.id);
      if (before && before.status !== check.status) checks.push({ id: check.id, from: before.status, to: check.status });
    });
    return { from, to, figures, checks };
  }

  close() {
    this.log.close();
  }
}
