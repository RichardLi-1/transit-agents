// The service core. Every method validates against current state, appends one
// entry, and applies it. HTTP lives in app.ts; this file knows nothing about it.
//
// The root service holds the shared record. A visitor works in a view of it: the
// shared record plus that visitor's own entries, which only that view applies.
import { createHash } from "node:crypto";
import {
  evaluate,
  GATE_RUNS,
  MEDIA_LABEL,
  MEDIA_MAX_BYTES,
  MEDIA_TYPES,
  variables,
  type Activity,
  type Escalation,
  type Analysis,
  type Assumption,
  type Basis,
  type Citation,
  type CheckView,
  type Context,
  type Decision,
  type DocumentKind,
  type DocumentView,
  type DatasetInfo,
  type Figure,
  type FindingView,
  type Layer,
  type LayerAdded,
  type MediaKind,
  type MediaType,
  type MediaView,
  type NeedView,
  type StudyView,
  type Usage,
} from "@transit-agents/contracts";
import type { Feature } from "geojson";
import type { z } from "zod";
import type {
  NewAssumption as NewAssumptionSchema,
  NewCheck as NewCheckSchema,
  NewContext as NewContextSchema,
  NewDecision as NewDecisionSchema,
  NewFigure as NewFigureSchema,
  NewAlignment as NewAlignmentSchema,
  NewFinding as NewFindingSchema,
  NewQuestion as NewQuestionSchema,
  NeedClaim as NeedClaimSchema,
  NeedFailure as NeedFailureSchema,
  NeedWithdrawal as NeedWithdrawalSchema,
  NewDocument as NewDocumentSchema,
  NewMedia as NewMediaSchema,
  NewNeed as NewNeedSchema,
  NewStudy as NewStudySchema,
  SkillCandidate as SkillCandidateSchema,
  SkillScores as SkillScoresSchema,
  AreaRequest as AreaRequestSchema,
  BufferRequest as BufferRequestSchema,
  OverlayRequest as OverlayRequestSchema,
  PointsWithinRequest as PointsWithinRequestSchema,
  RouteLayerRequest as RouteLayerRequestSchema,
  StudyLineRequest as StudyLineRequestSchema,
} from "@transit-agents/contracts";
import { type Alignment, ALIGNMENT_COST, AlignmentError, along, cachedNetwork, slugOf, snapAlignment } from "./alignment.ts";
import { checkValue, findQuote } from "./citations.ts";
import { renderDocument, type RenderedSection, type Source } from "./document.ts";
import type { Page } from "./extract.ts";
import type { VisitorBudget } from "./budget.ts";
import { estimate } from "./footprint.ts";
import { boundsOf, buffer, Gis, GisError, measure, METHOD, shortName as datasetShort, studyLine, type Made, type Total } from "./gis.ts";
import { EVERYONE, Log, REDACTED, type Entry, type NewEntry, type Scope } from "./log.ts";
import { isSha256, isWhole, MediaStore, sniff } from "./media.ts";
import { SearchIndex } from "./search.ts";
import {
  addSpend,
  analysisOf,
  apply,
  assumptionValues,
  checksFor,
  countUsage,
  emptyState,
  isOpen,
  isOverride,
  mediaUrl,
  missingKinds,
  noSpend,
  resolveFigures,
  viewFigures,
  viewNeed,
  type Need,
  type Spend,
  type State,
  type StoredLayer,
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

const sharedOnly = (what: string) => new ApiError(403, "shared_only", `${what} only in the shared record, not in a visitor's sandbox`);

// A skill's name is its folder's: lowercase letters, numbers and dashes.
function checkSkillName(name: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new ApiError(400, "invalid_name", "Use lowercase letters, numbers and dashes");
}

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
  // For a total from a map layer: the layer, with its dataset and the operation that made it.
  layer?: Layer;
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

// A layer as the display sees it, without what the service keeps for itself.
const viewLayer = ({ sha256: _sha256, totals: _totals, warnings: _warnings, ...layer }: StoredLayer): Layer => layer;

// How long a claim holds without a file. Longer than the slowest video takes, so
// an agent that stops mid-way frees the request for another.
export const CLAIM_MS = 20 * 60 * 1000;

export type ServiceOptions = {
  clock?: () => Date;
  // Where generated media is kept. Without it, media can't be attached.
  mediaDir?: string;
  // Counts what agents spend for visitors, from every entry, visitors' included.
  budget?: VisitorBudget;
  // The open datasets the GIS tools work on. Without it, those in services/api/assets/gis.
  gis?: Gis;
};

// private is true for a file made in a visitor's sandbox, and filename is what a
// saved copy is called: for a need's file, the need it's for.
export type MediaFile = { id: string; path: string; type: MediaType | "application/pdf"; size: number; private: boolean; filename: string };

// A page cite written into a document's words, as agents cite in their answers:
// (source-id p. N).
const TEXT_CITE = /\(([a-z0-9][a-z0-9._-]*) p\. (\d+)\)/g;

// A document's sources by a short name: a title cut at a word.
const shortName = (title: string) => (title.length <= 70 ? title : `${title.slice(0, 70).replace(/\s+\S*$/, "")}…`);

export class Service {
  readonly log: Log;
  // The visitor this view acts for, or null for the shared record.
  readonly audience: string | null = null;
  readonly state: State = emptyState();
  readonly media: MediaStore | undefined;
  // Derived from the contexts in state and their pages, like state is from the
  // log, and never written to the log.
  private readonly index = new SearchIndex();
  private readonly budget: VisitorBudget | undefined;
  readonly gis: Gis;
  // The files agents made in visitors' sandboxes, by sha256, with the need each is
  // for. The shared state names the shared record's files.
  private readonly visitorMedia = new Map<string, { type: MediaType; size: number; studyId: string | null; need: string }>();
  // The documents made in visitors' sandboxes, by sha256.
  private readonly visitorDocuments = new Map<string, { size: number; title: string }>();
  // What agents spent for visitors, every sandbox's together: numbers only.
  private readonly visitorSpend: Spend = noSpend();
  private closed = false;

  private readonly clock: () => Date;

  constructor(database: string, { clock = () => new Date(), mediaDir, budget, gis = new Gis() }: ServiceOptions = {}) {
    this.clock = clock;
    this.log = new Log(database, clock);
    this.media = mediaDir ? new MediaStore(mediaDir) : undefined;
    this.budget = budget;
    this.gis = gis;
    // A layer's features, by their hash, as a context's pages are kept: outside the
    // log, which names the hash.
    this.log.db.exec(`
      CREATE TABLE IF NOT EXISTS context_pages (
        context_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (context_id, page)
      );
      CREATE TABLE IF NOT EXISTS layer_features (
        sha256 TEXT PRIMARY KEY,
        geojson TEXT NOT NULL
      );
    `);
    for (const entry of this.allEntries(EVERYONE)) {
      this.observe(entry);
      if (!entry.audience) apply(this.state, entry);
    }
    const pages = this.log.db.prepare("SELECT page, text FROM context_pages WHERE context_id = ? ORDER BY page");
    for (const context of this.state.contexts.values()) this.index.add(context.id, pages.all(context.id) as Page[], citable(context));
  }

  // The shared record, plus this view's visitor's own entries.
  private *allEntries(scope: Scope = this.audience): Generator<Entry> {
    let seq = 0;
    for (;;) {
      const batch = this.log.since(seq, 1000, scope);
      if (!batch.length) return;
      yield* batch;
      seq = (batch.at(-1) as Entry).seq;
    }
  }

  private commit(entry: NewEntry): Entry {
    const written = this.log.append({ ...entry, audience: this.audience });
    apply(this.state, written);
    this.observe(written);
    return written;
  }

  // What every entry adds beyond state: spend for visitors, and the files made in
  // their sandboxes. A need the shared record drops takes visitors' files for it.
  private observe(entry: Entry) {
    this.budget?.observe(entry);
    if (entry.audience) countUsage(this.visitorSpend, entry);
    const data = entry.data as { need?: string; sha256?: string; type?: MediaType; size?: number; title?: string };
    if (entry.type === "document.created" && entry.audience && data.sha256 && data.size !== undefined) {
      this.visitorDocuments.set(data.sha256, { size: data.size, title: data.title ?? "document" });
    } else if (entry.type === "media.added" && entry.audience && data.sha256 && data.need && data.type && data.size !== undefined) {
      this.visitorMedia.set(data.sha256, { type: data.type, size: data.size, studyId: entry.studyId, need: data.need });
    } else if (entry.type === "need.dismissed" && !entry.audience) {
      for (const [id, file] of this.visitorMedia) if (file.studyId === entry.studyId && file.need === data.need) this.visitorMedia.delete(id);
    }
  }

  // The shared record plus one visitor's own entries, built for each request from
  // a copy of the shared state, so nothing done through it changes the shared
  // record. An entry the shared record no longer allows is skipped.
  viewFor(audience: string | null): Service {
    const root = this.audience === null ? this : (Object.getPrototypeOf(this) as Service);
    if (audience === null) return root;
    const state = structuredClone(root.state);
    for (const entry of this.log.own(audience)) {
      try {
        apply(state, entry);
      } catch {
        // Skipped, as above.
      }
    }
    return Object.assign(Object.create(root) as Service, { audience, state });
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
    if (this.audience) throw sharedOnly("Sources are added");
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
    if (this.audience) throw sharedOnly("Studies are opened");
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

    if (basis.kind === "spatial") {
      const layer = study.layers.get(basis.layer);
      if (!layer) throw new ApiError(422, "unknown_layer", `No layer "${basis.layer}" in this study`);
      const total = layer.totals?.[basis.total];
      if (!total) {
        const names = Object.keys(layer.totals ?? {});
        throw new ApiError(422, "unknown_total", `Layer "${layer.id}" has no total "${basis.total}"${names.length ? `. It has: ${names.join(", ")}` : ""}`);
      }
      if (input.value !== undefined && Math.abs(input.value - total.value) > Math.abs(total.value) * 1e-6 + 1e-9) {
        throw new ApiError(422, "value_mismatch", `Layer "${layer.id}" gives ${total.value} for ${basis.total}, not ${input.value}`);
      }
      return { value: total.value };
    }

    if (basis.kind === "computed") {
      if (input.value === undefined) throw new ApiError(422, "missing_value", "A computed figure needs a value");
      // The version is the skill's content hash, which the agent's loader computed
      // from the files it ran. Only the skill's current approved version counts.
      if (this.state.skills.get(basis.skill) !== basis.version) {
        throw new ApiError(
          422,
          "unregistered_skill",
          `Skill "${basis.skill}" version ${basis.version} has not been approved: it isn't the skill's current version. A planner approves a skill's content hash with PUT /v1/skills/${basis.skill}`,
        );
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
    for (const citation of input.option?.costCitations ?? []) this.verifyCitation(citation);
    this.commit({ actor, type: "finding.recorded", studyId, data: input });
    const { seq: _seq, ...finding } = study.findings.get(input.id) as FindingView & { seq: number };
    return finding;
  }

  // An agent hands a question to a planner, as its own entry: the typed hand-over
  // the evals score a flag by. It decides nothing, and records no result. Asking the
  // same question again, by its id, changes nothing.
  askPlanner(actor: string, studyId: string, input: z.output<typeof NewQuestionSchema>) {
    const study = this.study(studyId);
    const asked = study.questions.get(input.id);
    if (asked) return { id: input.id, kind: asked.kind, question: asked.question, seq: asked.seq };
    if (input.citation) this.verifyCitation(input.citation);
    const entry = this.commit({ actor, type: "question.asked", studyId, data: input });
    return { id: input.id, kind: input.kind, question: input.question, seq: entry.seq };
  }

  // A draft alignment option, as a finding that carries one.
  private option(studyId: string, findingId: string) {
    const finding = this.study(studyId).findings.get(findingId);
    if (!finding) throw notFound("finding", findingId);
    if (!finding.option) throw new ApiError(422, "not_an_option", `Finding "${findingId}" is not an alignment option`);
    return { finding, option: finding.option };
  }

  // Proposes a draft alignment, built only along route shapes the service holds,
  // from Don Valley station to a real station or interchange. Its length feeds the
  // study's cost per km, optimism bias and contingency, so its cost traces to them,
  // and its stations follow the planner-set spacing. Proposing one to the same
  // terminus again replaces it.
  proposeAlignment(actor: string, studyId: string, input: z.output<typeof NewAlignmentSchema>): FindingView {
    this.study(studyId);
    let alignment: Alignment;
    try {
      alignment = snapAlignment(cachedNetwork(), input.corridor, input.terminus);
    } catch (error) {
      if (error instanceof AlignmentError) throw new ApiError(422, "cannot_snap", error.message);
      throw error;
    }
    const view = this.viewStudy(studyId);
    const figure = (id: string) => view.figures.find((f) => f.id === id);
    const perKm = figure(ALIGNMENT_COST.perKm);
    const contingency = figure(ALIGNMENT_COST.contingency);
    const bias = this.state.assumptions.get(ALIGNMENT_COST.optimismBias);
    const length = this.state.assumptions.get(ALIGNMENT_COST.length);
    const stations = this.state.assumptions.get(ALIGNMENT_COST.stations);
    if (!perKm || !contingency || !bias?.citation || perKm.basis.kind !== "cited") {
      throw new ApiError(422, "no_cost_basis", "The study needs a cited cost per km, contingency and optimism bias to cost an alignment");
    }
    const km = alignment.lengthKm;
    const costM = Math.round((perKm.value * km * (1 + bias.value / 100)) / (1 + contingency.value / 100));
    const spacing = length && stations?.value ? length.value / stations.value : 2;
    const id = `option-${slugOf(alignment.terminus.name)}`.slice(0, 63);
    const others = view.findings.filter((f) => f.option && f.id !== id);
    const existing = view.findings.find((f) => f.id === id)?.option;
    const letter = existing?.letter ?? String.fromCharCode(65 + Math.min(25, others.length));
    const street = alignment.follows.split(", ")[0] as string;
    const short = street.replace(/ Road$/, " Rd").replace(/ Street$/, " St").replace(/ Avenue( East)?$/, " Ave");
    const [lon, lat] = along(alignment.line, 0.6);
    const text = `Alignment option ${letter} · ${short} to ${alignment.terminus.name} · ${km.toFixed(1)} km · about $${(costM / 1000).toFixed(1)} B (draft). Draft options for planners. ${input.note}`;
    return this.addFinding(actor, studyId, {
      id,
      label: input.label ?? `Alignment option ${letter}`,
      text: text.slice(0, 400),
      tone: "neutral",
      citation: perKm.basis.citation,
      at: { lon, lat },
      option: {
        letter,
        follows: alignment.follows,
        line: alignment.line,
        lengthKm: km,
        stations: Math.max(1, Math.round(km / spacing)),
        costM,
        costCitations: [perKm.basis.citation, bias.citation],
        station: { name: alignment.terminus.name, lon: alignment.terminus.at[0], lat: alignment.terminus.at[1] },
      },
    });
  }

  // Hands an option over for a consultant's review: a gap that asks a planner to
  // request one from an engineering consultancy. Asking again changes nothing.
  requestReview(actor: string, studyId: string, findingId: string): FindingView {
    const { finding, option } = this.option(studyId, findingId);
    const id = `${findingId}-review`;
    const study = this.study(studyId);
    const existing = study.findings.get(id);
    if (existing) {
      const { seq: _seq, ...review } = existing as FindingView & { seq: number };
      return review;
    }
    return this.addFinding(actor, studyId, {
      id,
      label: `Option ${option.letter} review`,
      text: `Option ${option.letter}, along ${option.follows}, needs a consultant's review. Next: a planner requests an engineering review of the alignment. Contact: an engineering consultancy.`,
      tone: "neutral",
      citation: finding.citation,
    });
  }

  // Proposes renders of an option's main station, an image and a video, for the
  // usual Create flow. Asking again changes nothing.
  proposeRenders(actor: string, studyId: string, findingId: string): NeedView {
    const { finding, option } = this.option(studyId, findingId);
    const id = `${findingId}-station`;
    const study = this.study(studyId);
    if (study.needs.has(id)) return viewNeed(this.need(study, id));
    return this.addNeed(actor, studyId, {
      id,
      title: "Station rendering missing",
      place: `${option.station.name}, option ${option.letter}`,
      lon: option.station.lon,
      lat: option.station.lat,
      kinds: ["image", "video"],
      subject: "station-entrance",
      reason: `Option ${option.letter}'s main station, along ${option.follows}. People here need to see what its entrance could look like. A draft option for planners.`,
      citations: [finding.citation],
    });
  }

  // How consultation reads is a judgement, so a planner sets it, or a visitor in
  // their sandbox.
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

  // Each skill's current approved content hash. Agents load a skill only while its
  // folder hashes to it.
  approvedSkills(): { current: Record<string, string> } {
    return { current: Object.fromEntries(this.state.skills) };
  }

  // A planner approves a version: it becomes the skill's current one, replacing the
  // one before, which no agent loads any more. Rolling back is approving the parent's
  // hash again.
  // When the version is a candidate an agent put forward, the approval's entry names
  // the proposal and carries the evaluator's scores for it, or null if none were posted,
  // so the log shows what the planner approved it on.
  registerSkill(actor: string, name: string, input: { version: string; description: string }) {
    if (this.audience) throw sharedOnly("Skills are approved");
    checkSkillName(name);
    const previous = this.state.skills.get(name) ?? null;
    const candidate = this.state.candidates.get(name)?.get(input.version);
    const review = candidate
      ? {
          proposal: { seq: candidate.seq, parent: candidate.parent },
          evaluation: candidate.evaluation ? { seq: candidate.evaluation.seq, by: candidate.evaluation.by, ...candidate.evaluation.scores } : null,
        }
      : {};
    this.commit({ actor, type: "skill.registered", data: { name, ...input, previous, ...review } });
    return { name, version: input.version, previous, ...review };
  }

  // The evaluator, the process holding the test split, posts a candidate's scores and
  // its gate's verdict. Only a candidate put forward can be scored, against the parent
  // it was put forward with, and the verdict must follow from the numbers: each mean is
  // its runs' mean, over GATE_RUNS runs or more on each side, and the gate passes only
  // if the candidate's dev mean is no lower than its parent's and it lost no safety case.
  scoreSkill(actor: string, name: string, version: string, input: z.output<typeof SkillScoresSchema>) {
    if (this.audience) throw sharedOnly("Skills are scored");
    checkSkillName(name);
    const candidate = this.state.candidates.get(name)?.get(version);
    if (!candidate) throw new ApiError(404, "not_found", `No candidate ${version} of skill "${name}" was put forward`);
    if (input.parent !== candidate.parent) {
      throw new ApiError(422, "wrong_parent", `Candidate ${version} was put forward with parent ${candidate.parent}, not ${input.parent}`);
    }
    const sides = [input.dev.candidate, input.dev.parent, ...(input.test ? [input.test.candidate, input.test.parent] : [])];
    for (const side of sides) {
      const mean = side.runs.reduce((sum, run) => sum + run, 0) / side.runs.length;
      if (Math.abs(mean - side.mean) > 1e-9) throw new ApiError(422, "bad_mean", `A mean of ${side.mean} isn't its runs' mean, ${mean}`);
    }
    const runs = Math.min(input.dev.candidate.runs.length, input.dev.parent.runs.length);
    const passes = runs >= GATE_RUNS && input.dev.candidate.mean >= input.dev.parent.mean && input.safety.lost.length === 0;
    if (input.gate.passed !== passes) {
      throw new ApiError(422, "bad_verdict", `The gate ${passes ? "passes" : "fails"} on these numbers: ${GATE_RUNS} runs or more a side, a dev mean no lower than the parent's, and no safety case lost`);
    }
    if (input.test && !passes) throw new ApiError(422, "test_before_gate", "Test cases are scored only once the gate passes");
    const entry = this.commit({ actor, type: "skill.evaluated", data: { name, version, ...input } });
    return { name, version, seq: entry.seq, gate: input.gate };
  }

  // A planner withdraws a skill's current version. No agent loads the skill, and no
  // computed figure may name it, until a planner approves a version again.
  revokeSkill(actor: string, name: string, input: { reason: string; version?: string }) {
    if (this.audience) throw sharedOnly("Skills are revoked");
    checkSkillName(name);
    const current = this.state.skills.get(name);
    if (!current) throw new ApiError(404, "not_found", `Skill "${name}" has no approved version to revoke`);
    if (input.version && input.version !== current) {
      throw new ApiError(409, "not_current", `Skill "${name}"'s current version is ${current}, not ${input.version}`);
    }
    const entry = this.commit({ actor, type: "skill.revoked", data: { name, version: current, reason: input.reason } });
    return { name, revoked: current, seq: entry.seq };
  }

  // An agent puts a skill version forward, once it has passed its gate. It approves
  // nothing: only a planner's registerSkill does, so the version waits for one.
  proposeSkill(actor: string, name: string, input: z.output<typeof SkillCandidateSchema>) {
    if (this.audience) throw sharedOnly("Skills are proposed");
    checkSkillName(name);
    if (input.version === input.parent) throw new ApiError(422, "same_version", "A candidate must differ from its parent");
    const entry = this.commit({ actor, type: "skill.proposed", data: { name, ...input } });
    return { name, ...input, seq: entry.seq, approved: this.state.skills.get(name) === input.version };
  }

  // Content is removed from the shared record or, given their audience, from one
  // visitor's sandbox, where only they see the removal. A visitor's entry named
  // without its audience, or with another, is not found, as a position nobody has
  // written isn't, so the answer shows nothing of anyone's sandbox.
  removeContent(actor: string, seq: number, reason: string, audience: string | null = null) {
    if (this.audience) throw sharedOnly("Content is removed");
    const entry = this.log.get(seq, audience);
    if (!entry || entry.audience !== audience) throw notFound("log entry", String(seq));
    if (!REMOVABLE.has(entry.type)) {
      throw new ApiError(422, "not_removable", `${entry.type} entries can't be removed, because results depend on them`);
    }
    if (entry.data === REDACTED || (entry.data as { redacted?: boolean }).redacted) {
      throw new ApiError(409, "already_removed", `Entry ${seq} has no content`);
    }
    this.log.removePayload(seq);
    return this.viewFor(audience).commit({ actor, type: "content.removed", studyId: entry.studyId, data: { seq, reason } });
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

  // A planner asks for media to be made, or a visitor in their sandbox, and it is
  // made once: asking again while a request is open changes nothing. After an
  // agent fails, they can ask again.
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

  // An agent couldn't make what was asked for, and says why. The request closes,
  // so nothing more is made, or paid for, until someone asks again.
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
    // An agent makes media only while a request is open, and only the one holding its claim.
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
      // A site photo is the agent's own, and is credited as it says.
      if ("citation" in source) this.verifyCitation(source.citation);
      else if ("figure" in source && !study.figures.has(source.figure)) throw new ApiError(422, "unknown_input", `No figure "${source.figure}" in this study`);
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
  // that won't go ahead. Its files stop being served, and leave the disk, with the
  // ones agents made for it in visitors' sandboxes.
  dismissNeed(actor: string, studyId: string, needId: string, input: z.output<typeof NeedWithdrawalSchema>): { dismissed: string } {
    if (this.audience) throw sharedOnly("Needs are dropped");
    const need = this.need(this.study(studyId), needId);
    const visitors = [...this.visitorMedia].filter(([, file]) => file.studyId === studyId && file.need === needId).map(([id]) => id);
    this.commit({ actor, type: "need.dismissed", studyId, data: { need: needId, reason: input.reason } });
    this.forget([...need.media.map((media) => media.id), ...visitors]);
    return { dismissed: needId };
  }

  // A planner takes down a file that shouldn't be shown. The need is needed again,
  // so nothing new is made until a planner asks.
  withdrawMedia(actor: string, studyId: string, needId: string, sha256: string, input: z.output<typeof NeedWithdrawalSchema>): NeedView {
    if (this.audience) throw sharedOnly("Files are taken down");
    const need = this.need(this.study(studyId), needId);
    if (!need.media.some((media) => media.id === sha256)) throw notFound("media", sha256);
    this.commit({ actor, type: "media.withdrawn", studyId, data: { need: needId, sha256, reason: input.reason } });
    this.forget([sha256]);
    return viewNeed(need);
  }

  // Deletes the files nothing names any more: no need in the shared record, and no
  // visitor's sandbox.
  private forget(ids: string[]) {
    for (const id of ids) if (!this.state.media.has(id) && !this.visitorMedia.has(id)) this.media?.remove(id);
  }

  // A file a need names, and only such a file: the shared record's, for anyone, or
  // one made in a visitor's sandbox, served privately to whoever has its hash, which
  // only their sandbox shows.
  mediaFile(id: string): MediaFile {
    if (!isSha256(id)) throw notFound("media", id);
    const document = this.state.documents.get(id) ?? this.visitorDocuments.get(id);
    if (document) {
      const path = this.media?.path(id);
      if (!path) throw notFound("media", id);
      const name = slugify(document.title).slice(0, 60) || "document";
      return { id, path, type: "application/pdf", size: document.size, private: !this.state.documents.has(id), filename: `${name}-draft.pdf` };
    }
    const shared = this.state.media.get(id);
    const known = shared ?? this.visitorMedia.get(id);
    const path = known && this.media?.path(id);
    if (!known || !path) throw notFound("media", id);
    const extension = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4" }[known.type];
    // Saved or shared, its name says it's illustrative, and for which need: never a
    // name an upload chose. A need's id is a slug, safe in a header.
    return { id, path, type: known.type, size: known.size, private: !shared, filename: `${known.need}-illustrative${extension}` };
  }

  // --- Documents -------------------------------------------------------------

  // A study's document as a PDF, from points an agent or a planner gives. A point's
  // citation is checked as a finding's is, and a page it names in its words must
  // exist, so nothing in it cites a page that doesn't say so. The PDF is kept in the
  // media store, and the log names its hash. `base` is the service's address, for
  // the whole link.
  async createDocument(actor: string, studyId: string, input: z.output<typeof NewDocumentSchema>, base: string): Promise<DocumentView> {
    const study = this.study(studyId);
    if (!this.media) throw new ApiError(503, "no_media_store", "This service has nowhere to keep documents");
    const sources = new Map<string, Source>();
    const cite = (contextId: string, page: number) => {
      const context = this.state.contexts.get(contextId) as Context;
      const source = sources.get(contextId) ?? { n: sources.size + 1, name: shortName(context.title), pages: [] };
      sources.set(contextId, source);
      if (!source.pages.includes(page)) source.pages.push(page);
      return { n: source.n, page };
    };
    const sections: RenderedSection[] = input.sections.map((section) => ({
      heading: section.heading,
      points: section.points.map((point, i) => {
        const where = `Section "${section.heading}", point ${i + 1}`;
        const text = typeof point === "string" ? point : point.text;
        for (const [, contextId, page] of text.matchAll(TEXT_CITE)) {
          const context = this.state.contexts.get(contextId as string);
          if (!context) throw new ApiError(422, "unknown_source", `${where}: no source "${contextId}". Cite a source from list_sources, or drop the cite`);
          if (Number(page) < 1 || Number(page) > context.pageCount) {
            throw new ApiError(422, "page_not_found", `${where}: "${contextId}" has no page ${page}. Cite a page it has, or drop the cite`);
          }
        }
        if (typeof point === "string") return { text };
        try {
          this.verifyCitation(point.citation);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          throw new ApiError(
            error.status,
            error.code,
            `${where}: ${error.message}. Quote the page word for word, as a finding in get_study does, or give the point as plain words without a citation`,
          );
        }
        return { text, cite: cite(point.citation.contextId, point.citation.page) };
      }),
    }));
    for (const source of sources.values()) source.pages.sort((a, b) => a - b);

    const created = this.clock();
    const date = new Intl.DateTimeFormat("en-CA", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Toronto" }).format(created);
    const { bytes, pages } = await renderDocument({ kind: input.kind, title: input.title, study: study.title, date, sections, sources: [...sources.values()] }, created);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.media.put(sha256, bytes);
    const url = mediaUrl(sha256);
    const cites = [...sources.entries()].map(([contextId, source]) => ({ contextId, pages: source.pages }));
    this.commit({
      actor,
      type: "document.created",
      studyId,
      data: { sha256, url, kind: input.kind, title: input.title, size: bytes.length, pages, sections: input.sections.length, cites },
    });
    return { id: sha256, url, link: new URL(url, base).href, kind: input.kind, title: input.title, pages, size: bytes.length };
  }

  // --- Maps and GIS ----------------------------------------------------------

  datasets(): DatasetInfo[] {
    return this.gis.datasets();
  }

  // A study's layers, as the display sees them, newest last.
  layers(studyId: string): Layer[] {
    return [...this.study(studyId).layers.values()].map(viewLayer);
  }

  private layer(study: Study, id: string): StoredLayer {
    const layer = study.layers.get(id);
    if (!layer) {
      const names = [...study.layers.keys()];
      throw new ApiError(404, "not_found", `No layer "${id}" in this study${names.length ? `. Layers: ${names.join(", ")}` : ""}`);
    }
    return layer;
  }

  private features(layer: StoredLayer): Feature[] {
    const row = this.log.db.prepare("SELECT geojson FROM layer_features WHERE sha256 = ?").get(layer.sha256) as { geojson: string } | undefined;
    if (!row) throw new ApiError(404, "not_found", `Layer "${layer.id}" has no features stored`);
    return (JSON.parse(row.geojson) as { features: Feature[] }).features;
  }

  // A study's layer and its features, for the skills' GIS modules (gis-skills.ts),
  // which save what they make with saveLayer.
  studyLayer(studyId: string, layerId: string): { layer: Layer; features: Feature[] } {
    const layer = this.layer(this.study(studyId), layerId);
    return { layer: viewLayer(layer), features: this.features(layer) };
  }

  // A layer's features, in WGS84.
  layerGeojson(studyId: string, layerId: string): { type: "FeatureCollection"; features: Feature[] } {
    return { type: "FeatureCollection", features: this.features(this.layer(this.study(studyId), layerId)) };
  }

  // What an agent needs of a layer without its features: what it is, its size, its
  // totals and the figures that record them, and its first rows, largest share first.
  summariseLayer(studyId: string, layerId: string) {
    const study = this.study(studyId);
    const layer = this.layer(study, layerId);
    const features = this.features(layer);
    const rows = features
      .map((f) => f.properties ?? {})
      .sort((a, b) => Number(b.share ?? 0) - Number(a.share ?? 0))
      .slice(0, 10);
    return {
      layer: viewLayer(layer),
      ...measure(layer.kind, features),
      ...(layer.totals ? { totals: this.withFigures(study, layer) } : {}),
      ...(layer.operation?.name === "overlay" ? { method: METHOD } : {}),
      ...(layer.warnings?.length ? { warnings: layer.warnings } : {}),
      rows,
    };
  }

  // Each total, with the id of the figure that records it, if one does.
  private withFigures(study: Study, layer: StoredLayer): Record<string, Total & { figure?: string }> {
    const recorded = new Map(
      [...study.figures.values()].flatMap((f) => (f.basis.kind === "spatial" && f.basis.layer === layer.id ? [[f.basis.total, f.id] as const] : [])),
    );
    return Object.fromEntries(Object.entries(layer.totals ?? {}).map(([name, total]) => [name, { ...total, ...(recorded.has(name) ? { figure: recorded.get(name) } : {}) }]));
  }

  gisCall<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof GisError) throw new ApiError(422, error.code, error.message);
      throw error;
    }
  }

  // A TTC route's stops, or its main shapes, from the GTFS.
  routeLayer(actor: string, studyId: string, what: "stops" | "shape", input: z.output<typeof RouteLayerRequestSchema>) {
    this.study(studyId);
    const route = this.gisCall(() => this.gis.route(input.route));
    const made = this.gisCall(() => (what === "stops" ? this.gis.routeStops(route.name) : this.gis.routeShape(route.name)));
    const name = `${route.name} ${route.long}`;
    return this.saveLayer(actor, studyId, made, {
      id: input.id ?? `ttc-${route.name.toLowerCase()}-${what}`,
      title: input.title ?? `${name} ${what === "stops" ? "stops" : "route"}`,
      color: route.color,
      operation: { name: what === "stops" ? "route_stops" : "route_shape", params: { route: route.name } },
    });
  }

  // The study's line, as the display draws it: built and proposed parts.
  studyLineLayer(actor: string, studyId: string, input: z.output<typeof StudyLineRequestSchema>) {
    const study = this.study(studyId);
    const made = this.gisCall(() => studyLine(study.line));
    return this.saveLayer(actor, studyId, made, {
      id: input.id ?? `line-${study.line}`.slice(0, 63),
      title: input.title ?? `${study.title} line`,
      color: "#1f2937",
      operation: { name: "study_line", params: { line: study.line } },
    });
  }

  // One named area of a dataset, such as a neighbourhood, as a layer to work within.
  namedAreaLayer(actor: string, studyId: string, input: z.output<typeof AreaRequestSchema>) {
    this.study(studyId);
    const made = this.gisCall(() => this.gis.namedArea(input.dataset, input.name));
    const slug = slugify(made.name);
    return this.saveLayer(actor, studyId, made, {
      id: input.id ?? `${datasetShort(input.dataset)}-${slug}`.slice(0, 63),
      title: input.title ?? made.name,
      color: "#0d9488",
      operation: { name: "named_area", params: { dataset: input.dataset, name: made.name } },
    });
  }

  bufferLayer(actor: string, studyId: string, input: z.output<typeof BufferRequestSchema>) {
    const study = this.study(studyId);
    const source = this.layer(study, input.layer);
    const made = this.gisCall(() => buffer(this.features(source), input.metres));
    return this.saveLayer(actor, studyId, { ...made, ...(source.dataset ? { dataset: source.dataset } : {}) }, {
      id: input.id ?? `${source.id}-${input.metres}m`,
      title: input.title ?? `${input.metres} m around ${source.title}`,
      color: "#2563eb",
      derivedFrom: [source.id],
      operation: { name: "buffer", params: { layer: source.id, metres: input.metres } },
    });
  }

  // Areas of a dataset against a polygon layer, with area-weighted totals. The census
  // variables asked for are recorded as figures; without any, its population and
  // households. Other area datasets record how many areas the layer touches and the
  // share of it they cover.
  overlayLayer(actor: string, studyId: string, input: z.output<typeof OverlayRequestSchema>) {
    const study = this.study(studyId);
    const source = this.layer(study, input.layer);
    const counts = Object.keys(this.gisCall(() => this.gis.variables(input.dataset)));
    const variables = counts.length && !input.variables.length ? ["population", "households"] : input.variables;
    const made = this.gisCall(() => this.gis.overlay(this.features(source), input.dataset, variables));
    const label = { "census-da-2021": "Census areas", "toronto-nia": "NIAs", "toronto-neighbourhoods": "Neighbourhoods", "toronto-parks-corridor": "Parks" }[input.dataset] ?? input.dataset;
    const saved = this.saveLayer(
      actor,
      studyId,
      made,
      {
        id: input.id ?? `${source.id}-${datasetShort(input.dataset)}`,
        title: input.title ?? `${label} in ${source.title}`,
        color: { "census-da-2021": "#7c3aed", "toronto-nia": "#ea580c", "toronto-neighbourhoods": "#0d9488", "toronto-parks-corridor": "#16a34a" }[input.dataset],
        derivedFrom: [source.id],
        operation: { name: "overlay", params: { layer: source.id, dataset: input.dataset, variables, weighting: "area" } },
      },
      counts.length ? variables : ["areas", "layerShare"],
      source.title,
    );
    return { ...saved, method: METHOD };
  }

  pointsWithinLayer(actor: string, studyId: string, input: z.output<typeof PointsWithinRequestSchema>) {
    const study = this.study(studyId);
    const source = this.layer(study, input.layer);
    const filter = {
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.fatal !== undefined ? { fatal: input.fatal } : {}),
      ...(input.involving !== undefined ? { involving: input.involving } : {}),
    };
    const made = this.gisCall(() => this.gis.pointsWithin(this.features(source), input.dataset, filter));
    const suffix = [
      filter.from !== undefined || filter.to !== undefined ? `${filter.from ?? "start"}-${filter.to ?? "end"}` : "",
      filter.fatal ? "fatal" : "",
      filter.involving ?? "",
    ].filter(Boolean);
    const recorded = Object.keys(made.totals ?? {}).filter((name) => ["collisions", "fatal", "stops", "properties"].includes(name));
    const label = { "toronto-ksi": "KSI collisions", "toronto-heritage-corridor": "Heritage properties", "ttc-gtfs": "TTC stops" }[input.dataset] ?? input.dataset;
    const years = filter.from !== undefined || filter.to !== undefined ? ` ${filter.from ?? ""}–${filter.to ?? ""}` : "";
    return this.saveLayer(
      actor,
      studyId,
      made,
      {
        id: input.id ?? [`${source.id}-${datasetShort(input.dataset)}`, ...suffix].join("-"),
        title: input.title ?? `${label}${years} in ${source.title}`,
        color: { "toronto-ksi": "#dc2626", "toronto-heritage-corridor": "#a16207", "ttc-gtfs": "#da251d" }[input.dataset],
        derivedFrom: [source.id],
        operation: { name: "points_within", params: { layer: source.id, dataset: input.dataset, ...filter } },
      },
      filter.fatal ? recorded.filter((name) => name !== "fatal") : recorded,
      source.title,
    );
  }

  // Saves what an operation made as a layer, logs that it was added, and records the
  // totals named as figures. The same operation again gives back the layer it made.
  // The road safety and active transportation tools (gis-safety.ts, gis-active.ts) save theirs here too.
  saveLayer(
    actor: string,
    studyId: string,
    made: Made,
    meta: { id: string; title: string; color?: string | undefined; derivedFrom?: string[]; operation: { name: string; params: Record<string, unknown> } },
    record: string[] = [],
    within?: string,
  ) {
    const study = this.study(studyId);
    const id = meta.id.toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(id)) {
      throw new ApiError(422, "bad_layer_id", `"${id}" can't be a layer's id: give an id of lowercase letters, numbers, dots and dashes, at most 63`);
    }
    const existing = study.layers.get(id);
    if (existing) {
      if (JSON.stringify(existing.operation) !== JSON.stringify(meta.operation)) {
        throw new ApiError(409, "layer_exists", `Layer "${id}" exists, made another way. Give this one another id`);
      }
      return { layer: viewLayer(existing), ...(existing.totals ? { totals: this.withFigures(study, existing) } : {}), ...(existing.warnings?.length ? { warnings: existing.warnings } : {}), repeated: true };
    }
    const title = meta.title.length > 80 ? `${meta.title.slice(0, 79).trimEnd()}…` : meta.title;
    const geojson = JSON.stringify({ type: "FeatureCollection", features: made.features });
    const sha256 = sha256Of(geojson);
    this.log.db.prepare("INSERT OR IGNORE INTO layer_features (sha256, geojson) VALUES (?, ?)").run(sha256, geojson);
    const data = {
      id,
      title,
      kind: made.kind,
      ...(meta.color ? { color: meta.color } : {}),
      featureCount: made.features.length,
      bbox: boundsOf(made.features),
      ...(made.dataset ? { dataset: made.dataset } : {}),
      ...(meta.derivedFrom ? { derivedFrom: meta.derivedFrom } : {}),
      operation: meta.operation,
      sha256,
      ...(made.totals ? { totals: made.totals } : {}),
      ...(made.warnings?.length ? { warnings: made.warnings } : {}),
    };
    this.commit({ actor, type: "layer.saved", studyId, data });
    this.commit({ actor, type: "activity", studyId, data: { kind: "layer.added", layerId: id, title } satisfies LayerAdded });
    const layer = study.layers.get(id) as StoredLayer;
    for (const name of record) {
      const total = made.totals?.[name];
      if (!total) continue;
      const suffix = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const figure = `${id.slice(0, 62 - suffix.length).replace(/[.-]+$/, "")}.${suffix}`;
      const label = within ? `${total.label}, ${within}` : total.label;
      this.addFigure(actor, studyId, {
        id: figure,
        label: label.length > 120 ? `${label.slice(0, 119).trimEnd()}…` : label,
        unit: total.unit,
        value: total.value,
        basis: { kind: "spatial", layer: id, total: name },
      });
    }
    return { layer: viewLayer(layer), ...(layer.totals ? { totals: this.withFigures(study, layer) } : {}), ...(layer.warnings?.length ? { warnings: layer.warnings } : {}) };
  }

  // --- Activity ------------------------------------------------------------

  // An Escalation comes only from a planner's ping, never from POST .../activity.
  recordActivity(actor: string, studyId: string, activity: Activity | Escalation): Entry {
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

  // Everything spent, the same for everyone: in total, the shared record's model
  // calls and every visitor's, added up, so no one visitor's work shows. By study,
  // the shared record's alone, which would otherwise show where visitors work.
  // Each total comes with an estimate of the energy, emissions and water its model
  // calls used: a floor.
  usage(): { total: Usage; byStudy: Record<string, Usage> } {
    const root = this.audience === null ? this : (Object.getPrototypeOf(this) as Service);
    const spent = addSpend(root.state, this.visitorSpend);
    const estimated = (usage: Usage): Usage => ({ ...usage, estimate: estimate(usage.calls) });
    return {
      total: estimated(spent.usage),
      byStudy: Object.fromEntries([...root.state.usageByStudy].map(([id, usage]) => [id, estimated(usage)])),
    };
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
        ...(figure.basis.kind === "spatial" && study.layers.has(figure.basis.layer) ? { layer: viewLayer(study.layers.get(figure.basis.layer) as StoredLayer) } : {}),
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
