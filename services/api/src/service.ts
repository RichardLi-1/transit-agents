// The service core. Every method validates against current state, appends one
// entry, and applies it. HTTP lives in app.ts; this file knows nothing about it.
import { createHash } from "node:crypto";
import {
  evaluate,
  MEDIA_LABEL,
  MEDIA_MAX_BYTES,
  MEDIA_TYPES,
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
  type MediaKind,
  type MediaType,
  type MediaView,
  type NeedView,
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
  NeedClaim as NeedClaimSchema,
  NeedFailure as NeedFailureSchema,
  NeedWithdrawal as NeedWithdrawalSchema,
  NewMedia as NewMediaSchema,
  NewNeed as NewNeedSchema,
  NewStudy as NewStudySchema,
} from "@transit-agents/contracts";
import { checkValue, findQuote } from "./citations.ts";
import type { Page } from "./extract.ts";
import { Log, REDACTED, type Entry, type NewEntry } from "./log.ts";
import { isSha256, isWhole, MediaStore, sniff } from "./media.ts";
import { SearchIndex } from "./search.ts";
import {
  analysisOf,
  apply,
  assumptionValues,
  checksFor,
  emptyState,
  isOpen,
  isOverride,
  missingKinds,
  resolveFigures,
  viewFigures,
  viewNeed,
  type Need,
  type State,
  type Study,
} from "./state.ts";

// Entry types whose content may be removed, such as a member of the public's
// words. Figures, decisions and rules stay: removing them would change results.
const REMOVABLE = new Set(["activity", "finding.recorded"]);

// Only sources added by people or agency systems can back a figure, so an agent
// can't upload a document and then cite it.
const CITABLE_ROLES = ["planner:", "integration:"];
const citable = (context: Context) => CITABLE_ROLES.some((role) => context.addedBy.startsWith(role));

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

export type SearchResult = { contextId: string; title: string; page: number; snippet: string; citable: boolean };

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "context";

const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");

// How long a claim holds without a file. Longer than the slowest video takes, so
// an agent that stops mid-way frees the request for another.
export const CLAIM_MS = 20 * 60 * 1000;

export type ServiceOptions = {
  clock?: () => Date;
  // Where generated media is kept. Without it, media can't be attached.
  mediaDir?: string;
};

export type MediaFile = { id: string; path: string; type: MediaType; size: number };

export class Service {
  readonly log: Log;
  readonly state: State = emptyState();
  readonly media: MediaStore | undefined;
  // Derived from the contexts in state and their pages, like state is from the
  // log, and never written to the log.
  private readonly index = new SearchIndex();
  private closed = false;

  private readonly clock: () => Date;

  constructor(database: string, { clock = () => new Date(), mediaDir }: ServiceOptions = {}) {
    this.clock = clock;
    this.log = new Log(database, clock);
    this.media = mediaDir ? new MediaStore(mediaDir) : undefined;
    this.log.db.exec(`
      CREATE TABLE IF NOT EXISTS context_pages (
        context_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (context_id, page)
      );
    `);
    for (const entry of this.allEntries()) apply(this.state, entry);
    const pages = this.log.db.prepare("SELECT page, text FROM context_pages WHERE context_id = ? ORDER BY page");
    for (const context of this.state.contexts.values()) this.index.add(context.id, pages.all(context.id) as Page[], citable(context));
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

  // `fileHash` is the hash of an uploaded file's bytes, so a changed file with no
  // readable text still counts as new.
  addContext(actor: string, input: z.output<typeof NewContextSchema>, fileHash?: string): Context {
    const pages = input.pages ?? (input.text !== undefined ? [{ page: 1, text: input.text }] : []);
    const sha256 =
      fileHash ??
      createHash("sha256")
        .update(JSON.stringify(pages.length ? pages : input.url ?? input.title))
        .digest("hex");
    const id = input.id ?? `${slugify(input.title)}-${sha256.slice(0, 8)}`;

    const existing = this.state.contexts.get(id);
    if (existing) {
      if (existing.sha256 === sha256) return existing;
      throw new ApiError(409, "context_conflict", `Context "${id}" already exists with different content`);
    }

    // All the pages or none. The log entry comes after them, so first clear any
    // pages an attempt that never reached the log left under this id.
    const insert = this.log.db.prepare("INSERT INTO context_pages (context_id, page, text) VALUES (?, ?, ?)");
    this.log.db.exec("BEGIN");
    try {
      this.log.db.prepare("DELETE FROM context_pages WHERE context_id = ?").run(id);
      for (const { page, text } of pages) insert.run(id, page, text);
      this.log.db.exec("COMMIT");
    } catch (error) {
      this.log.db.exec("ROLLBACK");
      throw error;
    }

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
    const context = this.state.contexts.get(id) as Context;
    this.index.add(id, pages, citable(context));
    return context;
  }

  contextPage(id: string, page: number): string {
    if (!this.state.contexts.has(id)) throw notFound("context", id);
    const row = this.log.db.prepare("SELECT text FROM context_pages WHERE context_id = ? AND page = ?").get(id, page) as
      | { text: string }
      | undefined;
    if (!row) throw new ApiError(404, "not_found", `Context "${id}" has no page ${page}`);
    return row.text;
  }

  // Pages that mention any of the query's words, those that can be cited first,
  // then best match first. `citable` is verifyCitation's rule: only a source a
  // planner or an agency system added can back a figure.
  search(query: string, limit: number): SearchResult[] {
    return this.index.find(query, limit).map(({ contextId, page, snippet }) => {
      const context = this.state.contexts.get(contextId) as Context;
      return { contextId, title: context.title, page, snippet, citable: citable(context) };
    });
  }

  private verifyCitation(citation: Citation): "exact" | "table" {
    const context = this.state.contexts.get(citation.contextId);
    if (!context) throw new ApiError(422, "unknown_source", `No context "${citation.contextId}"`);
    if (!citable(context)) {
      throw new ApiError(422, "uncitable_source", `"${context.id}" was added by ${context.addedBy}, so it can't back a figure`);
    }
    if (!context.pageCount) throw new ApiError(422, "unreadable_source", `Context "${context.id}" has no readable text`);
    let page: string;
    try {
      page = this.contextPage(citation.contextId, citation.page);
    } catch {
      throw new ApiError(422, "page_not_found", `Context "${context.id}" has no page ${citation.page}`);
    }
    let next = "";
    try {
      next = this.contextPage(citation.contextId, citation.page + 1);
    } catch {
      // The last page has no next page.
    }
    const match = findQuote(page, citation.quote, next);
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
      const check = checkValue(input.value, basis.citation.quote, match);
      if (!check.ok) throw new ApiError(422, "value_not_in_quote", check.reason);
      return { value: input.value, match };
    }

    if (basis.kind === "computed") {
      if (input.value === undefined) throw new ApiError(422, "missing_value", "A computed figure needs a value");
      if (!this.state.skills.get(basis.skill)?.has(basis.version)) {
        throw new ApiError(422, "unregistered_skill", `Skill "${basis.skill}" version ${basis.version} has not been approved`);
      }
      for (const dependency of basis.inputs) this.requireInput(study, dependency);
      this.rejectCycles(study, input.id, basis);
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
    this.rejectCycles(study, input.id, basis);
    return { value: computed };
  }

  // Replacing a figure can close a loop through others, so try the study with the
  // new figure in place before accepting it.
  private rejectCycles(study: Study, id: string, basis: Basis) {
    const figures = new Map(study.figures);
    const placeholder = figures.get(id) ?? study.figures.values().next().value;
    figures.set(id, { ...(placeholder as Figure), id, basis, value: 0 });
    try {
      resolveFigures({ figures }, assumptionValues(this.state));
    } catch (error) {
      if (/depends on itself/.test((error as Error).message)) throw new ApiError(422, "circular", (error as Error).message);
    }
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
    const study = this.study(studyId);
    this.verifyCitation(input.citation);
    this.commit({ actor, type: "finding.recorded", studyId, data: input });
    const { seq: _seq, ...finding } = study.findings.get(input.id) as FindingView & { seq: number };
    return finding;
  }

  // How consultation reads is a judgement, so only a planner sets it.
  rateFinding(actor: string, studyId: string, findingId: string, tone: Exclude<FindingView["tone"], "unrated">): FindingView {
    const study = this.study(studyId);
    if (!study.findings.has(findingId)) throw notFound("finding", findingId);
    this.commit({ actor, type: "finding.rated", studyId, data: { finding: findingId, tone } });
    const { seq: _seq, ...finding } = study.findings.get(findingId) as FindingView & { seq: number };
    return finding;
  }

  // A planner accepts one specific version of a skill's result. If the skill
  // resubmits, the new value needs accepting again.
  acceptFigure(actor: string, studyId: string, figureId: string): Figure {
    const study = this.study(studyId);
    const figure = study.figures.get(figureId);
    if (!figure) throw notFound("figure", figureId);
    if (figure.accepted) return figure;
    this.commit({ actor, type: "figure.accepted", studyId, data: { figure: figureId, seq: figure.seq } });
    return study.figures.get(figureId) as Figure;
  }

  // --- Assumptions ---------------------------------------------------------

  setAssumption(actor: string, key: string, input: z.output<typeof NewAssumptionSchema>): { assumption: Assumption; effects: Effects[] } {
    if (input.citation) this.verifyCitation(input.citation);
    const before = this.snapshot();
    const previous = this.state.assumptions.get(key);
    if (previous && previous.value === input.value && previous.reason === input.reason) {
      return { assumption: previous, effects: [] };
    }
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
        return [study.id, { values, checks, analysis: analysisOf(checks, [...study.findings.values()]) }] as const;
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

  // --- Skills and removal ---------------------------------------------------

  registerSkill(actor: string, name: string, input: { version: string; description: string }) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new ApiError(400, "invalid_name", "Use lowercase letters, numbers and dashes");
    this.commit({ actor, type: "skill.registered", data: { name, ...input } });
    return { name, versions: [...(this.state.skills.get(name) ?? [])] };
  }

  removeContent(actor: string, seq: number, reason: string) {
    const entry = this.log.get(seq);
    if (!entry) throw notFound("log entry", String(seq));
    if (!REMOVABLE.has(entry.type)) {
      throw new ApiError(422, "not_removable", `${entry.type} entries can't be removed, because results depend on them`);
    }
    if (entry.data === REDACTED || (entry.data as { redacted?: boolean }).redacted) {
      throw new ApiError(409, "already_removed", `Entry ${seq} has no content`);
    }
    this.log.removePayload(seq);
    return this.commit({ actor, type: "content.removed", studyId: entry.studyId, data: { seq, reason } });
  }

  // --- Engagement ------------------------------------------------------------

  private need(study: Study, id: string): Need {
    const need = study.needs.get(id);
    if (!need) throw notFound("need", id);
    return need;
  }

  // Something to make for public engagement in one place. Its citations must hold,
  // as a figure's must, since the media made for it is drawn from them.
  addNeed(actor: string, studyId: string, input: z.output<typeof NewNeedSchema>): NeedView {
    const study = this.study(studyId);
    if (study.needs.has(input.id)) throw new ApiError(409, "need_exists", `Need "${input.id}" already exists`);
    for (const citation of input.citations) this.verifyCitation(citation);
    this.commit({ actor, type: "need.added", studyId, data: input });
    return viewNeed(this.need(study, input.id));
  }

  // Only a planner asks for media to be made, and it is made once: asking again
  // while a request is open changes nothing. After an agent fails, a planner can
  // ask again.
  requestCreation(actor: string, studyId: string, needId: string): NeedView {
    const study = this.study(studyId);
    const need = this.need(study, needId);
    if (!isOpen(need)) this.commit({ actor, type: "need.create.requested", studyId, data: { need: needId } });
    return viewNeed(need);
  }

  // An agent takes on an open request before it spends anything. Only one agent
  // holds it at a time, until it lapses; claiming again with the same claim
  // changes nothing.
  claimCreation(actor: string, studyId: string, needId: string, input: z.output<typeof NeedClaimSchema>): NeedView {
    const study = this.study(studyId);
    const need = this.need(study, needId);
    if (!isOpen(need) || !missingKinds(need).length) throw new ApiError(409, "not_requested", `No request to make "${needId}" is open`);
    const hash = sha256Of(input.claim);
    if (need.claimed?.by === actor && need.claimed.hash === hash) return viewNeed(need);
    if (need.claimed && this.clock().getTime() - Date.parse(need.claimed.at) < CLAIM_MS) {
      throw new ApiError(409, "claimed", `Another agent is making "${needId}"`);
    }
    this.commit({ actor, type: "need.create.claimed", studyId, data: { need: needId, claim: hash } });
    return viewNeed(need);
  }

  // Only the agent holding the request's claim attaches files or says it failed.
  private holds(need: Need, actor: string, claim: string) {
    if (need.claimed?.by !== actor || need.claimed.hash !== sha256Of(claim)) {
      throw new ApiError(409, "not_claimed", `Claim "${need.id}" before making it`);
    }
  }

  // An agent couldn't make what a planner asked for, and says why. The request
  // closes, so nothing more is made, or paid for, until a planner asks again.
  failCreation(actor: string, studyId: string, needId: string, input: z.output<typeof NeedFailureSchema>): NeedView {
    const study = this.study(studyId);
    const need = this.need(study, needId);
    if (!isOpen(need)) throw new ApiError(409, "not_requested", `No request to make "${needId}" is open`);
    this.holds(need, actor, input.claim);
    this.commit({ actor, type: "need.create.failed", studyId, data: { need: needId, reason: input.reason } });
    return viewNeed(need);
  }

  // What an agent may upload for a need, checked before the upload is read: the
  // kinds it still lacks, for an open request this agent has claimed.
  uploadable(actor: string, studyId: string, needId: string): MediaKind[] {
    const need = this.need(this.study(studyId), needId);
    if (!isOpen(need)) throw new ApiError(409, "not_requested", `No planner has asked for "${need.id}" to be created`);
    if (need.claimed?.by !== actor) throw new ApiError(409, "not_claimed", `Claim "${need.id}" before making it`);
    const kinds = missingKinds(need);
    if (!kinds.length) throw new ApiError(409, "already_made", `"${need.id}" has every kind it asks for`);
    return kinds;
  }

  // A generated image or video for a need. What the file is comes from its bytes,
  // not from what the upload says. The bytes are kept by their hash, outside the
  // log, and the log records the hash, what made the file, and its label.
  addMedia(actor: string, studyId: string, input: z.output<typeof NewMediaSchema>, file: { bytes: Uint8Array; type?: string }): MediaView {
    const study = this.study(studyId);
    const need = study.needs.get(input.needId);
    if (!need) throw new ApiError(422, "unknown_need", `No need "${input.needId}" in this study`);
    // An agent makes media only while a planner's request is open.
    if (!isOpen(need)) throw new ApiError(409, "not_requested", `No planner has asked for "${need.id}" to be created`);
    this.holds(need, actor, input.claim);
    if (!need.kinds.includes(input.kind)) {
      throw new ApiError(422, "kind_not_needed", `"${need.id}" needs ${need.kinds.join(" and ")}, not ${input.kind}`);
    }
    const type = sniff(file.bytes);
    if (!type) throw new ApiError(415, "unsupported_media", "Send a PNG, JPEG or WebP image, or an MP4 video");
    if (file.type && Object.hasOwn(MEDIA_TYPES, file.type) && file.type !== type) {
      throw new ApiError(415, "type_mismatch", `The upload says ${file.type}, but the file is ${type}`);
    }
    const kind = input.kind === "image" ? "an image" : "a video";
    if (MEDIA_TYPES[type] !== input.kind) throw new ApiError(422, "kind_mismatch", `The file is ${type}, not ${kind}`);
    const cap = MEDIA_MAX_BYTES[input.kind];
    if (file.bytes.length > cap) throw new ApiError(413, "too_large", `The file is over ${megabytes(cap)}, the most for ${kind}`);
    // Nothing may ride along after the file, to be served from this site.
    if (!isWhole(file.bytes, type)) throw new ApiError(422, "malformed_media", `The file isn't one whole ${type}`);
    for (const source of input.inputs) {
      if ("citation" in source) this.verifyCitation(source.citation);
      else if (!study.figures.has(source.figure)) throw new ApiError(422, "unknown_input", `No figure "${source.figure}" in this study`);
    }
    if (!this.media) throw new ApiError(503, "no_media_store", "This service has nowhere to keep media");

    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    // The same file again, such as a retried upload, is already attached.
    const attached = need.media.find((media) => media.id === sha256);
    if (attached) return attached;
    // One file of each kind, so no agent can fill the disk the log shares.
    if (need.media.some((media) => media.kind === input.kind)) throw new ApiError(409, "already_made", `"${need.id}" already has ${kind}`);
    this.media.put(sha256, file.bytes);
    this.commit({
      actor,
      type: "media.added",
      studyId,
      data: {
        need: need.id,
        sha256,
        kind: input.kind,
        type,
        size: file.bytes.length,
        model: input.model,
        prompt: input.prompt,
        inputs: input.inputs,
        ...(input.alt ? { alt: input.alt } : {}),
        label: MEDIA_LABEL,
      },
    });
    return need.media.at(-1) as MediaView;
  }

  // A planner drops a need nobody has to make any more, such as one for a change
  // that won't go ahead. Its files stop being served, and leave the disk.
  dismissNeed(actor: string, studyId: string, needId: string, input: z.output<typeof NeedWithdrawalSchema>): { dismissed: string } {
    const need = this.need(this.study(studyId), needId);
    this.commit({ actor, type: "need.dismissed", studyId, data: { need: needId, reason: input.reason } });
    this.forget(need.media.map((media) => media.id));
    return { dismissed: needId };
  }

  // A planner takes down a file that shouldn't be shown. The need is needed again,
  // so nothing new is made until a planner asks.
  withdrawMedia(actor: string, studyId: string, needId: string, sha256: string, input: z.output<typeof NeedWithdrawalSchema>): NeedView {
    const need = this.need(this.study(studyId), needId);
    if (!need.media.some((media) => media.id === sha256)) throw notFound("media", sha256);
    this.commit({ actor, type: "media.withdrawn", studyId, data: { need: needId, sha256, reason: input.reason } });
    this.forget([sha256]);
    return viewNeed(need);
  }

  // Deletes the files no need names any more.
  private forget(ids: string[]) {
    for (const id of ids) if (!this.state.media.has(id)) this.media?.remove(id);
  }

  // A file the log names, and only such a file.
  mediaFile(id: string): MediaFile {
    const known = isSha256(id) ? this.state.media.get(id) : undefined;
    const path = known && this.media?.path(id);
    if (!known || !path) throw notFound("media", id);
    return { id, path, type: known.type, size: known.size };
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
    const findings = [...study.findings.values()].map(({ seq: _seq, ...finding }) => finding);
    const decision = study.decisions.at(-1);
    return {
      id: study.id,
      title: study.title,
      brief: study.brief,
      routes: study.routes,
      ...(study.line ? { line: study.line } : {}),
      ...(study.trial ? { trial: study.trial } : {}),
      watch: study.watch,
      project: study.project,
      figures: viewFigures(study, values),
      checks,
      findings,
      analysis: analysisOf(checks, findings),
      ...(decision ? { decision } : {}),
      needs: [...study.needs.values()].map(viewNeed),
    };
  }

  studies(): StudyView[] {
    return [...this.state.studies.keys()].map((id) => this.viewStudy(id));
  }

  usage(): { total: Usage; byStudy: Record<string, Usage> } {
    return { total: this.state.usage, byStudy: Object.fromEntries(this.state.usageByStudy) };
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
      return {
        id,
        label: figure.label,
        value: values.get(id) as number,
        unit: figure.unit,
        basis: figure.basis,
        entry: { seq: figure.seq, hash: figure.hash, at: figure.recordedAt, actor: figure.recordedBy },
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

  // Safe to call twice: a second call does nothing.
  close() {
    if (this.closed) return;
    this.closed = true;
    this.index.close();
    this.log.close();
  }
}
