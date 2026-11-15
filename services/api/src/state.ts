// All state is a fold of the log. Nothing here is written to directly: an entry
// is appended first, then applied.
import {
  evaluate,
  MEDIA_LABEL,
  type Analysis,
  type Assumption,
  type Basis,
  type CheckView,
  type Context,
  type Decision,
  type Figure,
  type FigureView,
  type Layer,
  type FindingView,
  type DocumentKind,
  type MediaType,
  type MediaView,
  type NeedStatus,
  type NeedView,
  type NewCheck,
  type Usage,
} from "@transit-agents/contracts";
import type { Entry } from "./log.ts";

type Check = NewCheck & { threshold: { assumption: string } };

export type Need = Omit<NeedView, "status" | "requestedBy" | "requestedAt" | "claimedBy" | "claimedAt" | "failure" | "failedBy" | "failedAt"> & {
  // A planner's latest request to make it.
  requested?: { by: string; at: string };
  // The agent making it for that request, and the hash of its claim.
  claimed?: { by: string; at: string; hash: string };
  // Set when an agent made nothing for the latest request. A new request clears it.
  failed?: { by: string; at: string; reason: string };
};

// A layer as the service keeps it: what the display sees, the hash of its features,
// kept outside the log, and any totals the operation worked out, which figures cite.
export type StoredLayer = Layer & {
  sha256: string;
  totals?: Record<string, { value: number; unit: string; label: string }>;
  warnings?: string[];
};

export type Study = {
  id: string;
  title: string;
  brief: string;
  routes: string[];
  line?: string;
  trial?: { startedOn: string; reviewOn: string };
  watch: string[];
  project: string[];
  figures: Map<string, Figure>;
  checks: Map<string, Check>;
  findings: Map<string, FindingView & { seq: number }>;
  decisions: Decision[];
  stale: Set<string>;
  needs: Map<string, Need>;
  // Map layers, in the order they were saved.
  layers: Map<string, StoredLayer>;
  // Questions agents handed to a planner, by id.
  questions: Map<string, { kind: string; question: string; askedBy: string; seq: number }>;
};

export type State = {
  contexts: Map<string, Context>;
  studies: Map<string, Study>;
  assumptions: Map<string, Assumption>;
  // Each skill's one current approved version, its content hash. A new approval
  // replaces it; a revocation removes it.
  skills: Map<string, string>;
  usage: Usage;
  usageByStudy: Map<string, Usage>;
  // Every file a log entry names, by its sha256, and a need that names it. Only these
  // are served.
  media: Map<string, { type: MediaType; size: number; need: string }>;
  // Every document a log entry names, by its PDF's sha256. Only these are served.
  documents: Map<string, { size: number; title: string; kind: DocumentKind }>;
};

const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, computeSeconds: 0, calls: 0, unpricedCalls: 0 });

export const emptyState = (): State => ({
  contexts: new Map(),
  studies: new Map(),
  assumptions: new Map(),
  skills: new Map(),
  usage: noUsage(),
  usageByStudy: new Map(),
  media: new Map(),
  documents: new Map(),
});

export const mediaUrl = (sha256: string) => `/v1/media/${sha256}`;

// Whether a planner's request waits on an agent: asked for, and not failed since.
export const isOpen = (need: Need) => Boolean(need.requested && !need.failed);

// The kinds a need asks for that no file has yet.
export const missingKinds = (need: Need) => need.kinds.filter((kind) => !need.media.some((media) => media.kind === kind));

// Ready once every kind it asks for is made. Until then: needed until a planner
// asks, creating while the request is open, and failed when an agent couldn't
// make what it still lacks. A half-made need keeps the files it has.
export const statusOf = (need: Need): NeedStatus => {
  if (!missingKinds(need).length) return "ready";
  if (need.failed) return "failed";
  return need.requested ? "creating" : "needed";
};

export function viewNeed(need: Need): NeedView {
  return {
    id: need.id,
    title: need.title,
    place: need.place,
    lon: need.lon,
    lat: need.lat,
    kinds: need.kinds,
    reason: need.reason,
    citations: need.citations,
    ...(need.subject ? { subject: need.subject } : {}),
    status: statusOf(need),
    addedBy: need.addedBy,
    addedAt: need.addedAt,
    ...(need.requested ? { requestedBy: need.requested.by, requestedAt: need.requested.at } : {}),
    ...(need.claimed ? { claimedBy: need.claimed.by, claimedAt: need.claimed.at } : {}),
    ...(need.failed ? { failure: need.failed.reason, failedBy: need.failed.by, failedAt: need.failed.at } : {}),
    media: [...need.media],
  };
}

// Stops serving a file once no need names it. While another need does, it's served
// under that need's name.
function unname(state: State, sha256: string) {
  for (const study of state.studies.values()) {
    for (const need of study.needs.values()) {
      if (!need.media.some((media) => media.id === sha256)) continue;
      const known = state.media.get(sha256);
      if (known) known.need = need.id;
      return;
    }
  }
  state.media.delete(sha256);
}

type Scope = Map<string, number>;

export const inputsOf = (basis: Basis): ({ figure: string } | { assumption: string })[] => {
  if (basis.kind === "derived") return Object.values(basis.inputs);
  if (basis.kind === "computed") return basis.inputs;
  return [];
};

// What each figure in a study is worth, given assumption values. A cycle or a
// missing input throws, and the API rejects such figures before they are stored.
export function resolveFigures(study: Pick<Study, "figures">, assumptions: Scope, overrides: Scope = new Map()): Scope {
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

// Figures that rest on a skill result no planner has accepted yet.
export function unverified(study: Study): Set<string> {
  const out = new Set([...study.figures.values()].filter((f) => !f.accepted).map((f) => f.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const figure of study.figures.values()) {
      if (out.has(figure.id)) continue;
      if (inputsOf(figure.basis).some((input) => "figure" in input && out.has(input.figure))) {
        out.add(figure.id);
        grew = true;
      }
    }
  }
  return out;
}

export function checksFor(study: Study, values: Scope, assumptions: Scope): CheckView[] {
  const pending = unverified(study);
  return [...study.checks.values()].map((check) => {
    const threshold = assumptionValue(assumptions, check.threshold.assumption);
    const actual = values.get(check.figure) as number;
    const status = study.stale.has(check.figure)
      ? "stale"
      : pending.has(check.figure)
        ? "unverified"
        : passes(actual, check.op, threshold)
          ? "pass"
          : "fail";
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

// Tests and consultation together. When they disagree, the analysis says so and a
// person decides; the service never resolves it. Consultation is one of the TTC's
// tests, so a study is incomplete until a planner has rated some.
export function analysisOf(checks: CheckView[], findings: Pick<FindingView, "tone">[] = []): Analysis {
  if (!checks.length || checks.some((c) => c.status === "stale" || c.status === "unverified")) return "incomplete";
  const tones = new Set(findings.map((f) => f.tone));
  if (tones.has("unrated")) return "incomplete";
  const consulted = tones.has("positive") || tones.has("negative") || tones.has("mixed");
  if (!consulted) return "incomplete";
  const failed = checks.filter((c) => c.status === "fail").length;
  const doubts = tones.has("negative") || tones.has("mixed");
  if (failed === 0) return doubts ? "mixed" : "pass";
  if (failed === checks.length) return tones.has("positive") ? "mixed" : "fail";
  return "mixed";
}

// A decision is an override when it goes against a clear analysis.
export function isOverride(analysis: Analysis, outcome: Decision["outcome"]): boolean {
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
  if (data.costUsd === undefined) total.unpricedCalls = (total.unpricedCalls ?? 0) + 1;
}

// What model calls cost, in all and by study.
export type Spend = Pick<State, "usage" | "usageByStudy">;

export const noSpend = (): Spend => ({ usage: noUsage(), usageByStudy: new Map() });

// Adds a model call an agent reported. Any other entry, or one whose content was
// removed, adds nothing.
export function countUsage(spend: Spend, entry: Pick<Entry, "type" | "studyId" | "data">) {
  const data = entry.data as { kind?: string; redacted?: true };
  if (entry.type !== "activity" || data.kind !== "usage" || data.redacted) return;
  const usage = data as unknown as Parameters<typeof addUsage>[1];
  addUsage(spend.usage, usage);
  if (entry.studyId) {
    const byStudy = spend.usageByStudy.get(entry.studyId) ?? noUsage();
    addUsage(byStudy, usage);
    spend.usageByStudy.set(entry.studyId, byStudy);
  }
}

// Two totals added together, as a third.
export function addSpend(a: Spend, b: Spend): Spend {
  const sum = noSpend();
  for (const spend of [a, b]) {
    mergeUsage(sum.usage, spend.usage);
    for (const [id, usage] of spend.usageByStudy) {
      const byStudy = sum.usageByStudy.get(id) ?? noUsage();
      mergeUsage(byStudy, usage);
      sum.usageByStudy.set(id, byStudy);
    }
  }
  return sum;
}

function mergeUsage(total: Usage, more: Usage) {
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.costUsd += more.costUsd;
  total.computeSeconds += more.computeSeconds;
  total.calls += more.calls;
  total.unpricedCalls = (total.unpricedCalls ?? 0) + (more.unpricedCalls ?? 0);
}

const get = <T>(map: Map<string, T>, key: string | null): T => {
  const value = map.get(key as string);
  if (value === undefined) throw new Error(`Log refers to unknown id "${key}"`);
  return value;
};

export function apply(state: State, entry: Entry): void {
  const data = entry.data as { id: string; kind?: string; redacted?: true };
  // Removed content stays in the chain as a placeholder and changes nothing.
  if (data.redacted) return;

  switch (entry.type) {
    case "context.added":
      state.contexts.set(data.id, { ...(data as unknown as Context), addedAt: entry.at, addedBy: entry.actor });
      return;

    case "study.opened": {
      const opened = data as unknown as Pick<Study, "id" | "title" | "brief" | "routes" | "line" | "trial" | "watch" | "project">;
      state.studies.set(opened.id, {
        ...opened,
        watch: opened.watch ?? [],
        project: opened.project ?? [],
        figures: new Map(),
        checks: new Map(),
        findings: new Map(),
        decisions: [],
        stale: new Set(),
        needs: new Map(),
        layers: new Map(),
        questions: new Map(),
      });
      return;
    }

    // An agent handed a question to a planner. It changes no figure, check or finding.
    case "question.asked": {
      const { id, kind, question } = data as unknown as { id: string; kind: string; question: string };
      get(state.studies, entry.studyId).questions.set(id, { kind, question, askedBy: entry.actor, seq: entry.seq });
      return;
    }

    case "figure.recorded": {
      const study = get(state.studies, entry.studyId);
      const figure = data as unknown as Omit<Figure, "studyId" | "recordedBy" | "recordedAt" | "seq" | "hash">;
      const replacing = study.figures.has(figure.id);
      study.figures.set(figure.id, {
        ...figure,
        studyId: study.id,
        recordedBy: entry.actor,
        recordedAt: entry.at,
        seq: entry.seq,
        hash: entry.hash,
        accepted: figure.basis.kind !== "computed" || entry.actor.startsWith("planner:"),
      });
      study.stale.delete(figure.id);
      if (replacing) for (const id of staleAfter(study, { figure: figure.id })) study.stale.add(id);
      return;
    }

    case "check.recorded":
      get(state.studies, entry.studyId).checks.set(data.id, data as unknown as Check);
      return;

    case "finding.recorded": {
      const finding = data as unknown as FindingView & { tone: FindingView["proposedTone"] };
      const rated = entry.actor.startsWith("planner:");
      get(state.studies, entry.studyId).findings.set(data.id, {
        ...finding,
        tone: rated ? (finding.tone as FindingView["tone"]) : "unrated",
        ...(rated ? {} : { proposedTone: finding.tone }),
        seq: entry.seq,
      });
      return;
    }

    case "finding.rated": {
      const { finding, tone } = data as unknown as { finding: string; tone: FindingView["tone"] };
      const existing = get(state.studies, entry.studyId).findings.get(finding);
      if (existing) existing.tone = tone;
      return;
    }

    case "figure.accepted": {
      const { figure, seq } = data as unknown as { figure: string; seq: number };
      const existing = get(state.studies, entry.studyId).figures.get(figure);
      if (existing && existing.seq === seq) existing.accepted = true;
      return;
    }

    case "content.removed": {
      const { seq } = data as unknown as { seq: number };
      for (const study of state.studies.values()) {
        for (const [id, finding] of study.findings) if (finding.seq === seq) study.findings.delete(id);
      }
      return;
    }

    // The latest approval is the skill's current version. A log from before there was
    // one current version, with several approvals of a skill, folds to its latest.
    case "skill.registered": {
      const { name, version } = data as unknown as { name: string; version: string };
      state.skills.set(name, version);
      return;
    }

    case "skill.revoked": {
      const { name, version } = data as unknown as { name: string; version: string };
      if (state.skills.get(name) === version) state.skills.delete(name);
      return;
    }

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

    case "need.added": {
      const need = data as unknown as Omit<Need, "addedBy" | "addedAt" | "media">;
      get(state.studies, entry.studyId).needs.set(need.id, {
        id: need.id,
        title: need.title,
        place: need.place,
        lon: need.lon,
        lat: need.lat,
        kinds: need.kinds,
        reason: need.reason,
        citations: need.citations ?? [],
        ...(need.subject ? { subject: need.subject } : {}),
        addedBy: entry.actor,
        addedAt: entry.at,
        media: [],
      });
      return;
    }

    // Asking while a request is open changes nothing. Asking after a failure is a
    // new request.
    case "need.create.requested": {
      const { need: id } = data as unknown as { need: string };
      const need = get(get(state.studies, entry.studyId).needs, id);
      if (isOpen(need)) return;
      need.requested = { by: entry.actor, at: entry.at };
      delete need.failed;
      delete need.claimed;
      return;
    }

    // A later claim takes over one that has lapsed.
    case "need.create.claimed": {
      const { need: id, claim } = data as unknown as { need: string; claim: string };
      get(get(state.studies, entry.studyId).needs, id).claimed = { by: entry.actor, at: entry.at, hash: claim };
      return;
    }

    case "need.create.failed": {
      const { need: id, reason } = data as unknown as { need: string; reason: string };
      get(get(state.studies, entry.studyId).needs, id).failed = { by: entry.actor, at: entry.at, reason };
      return;
    }

    // A planner dropped a need nobody has to make any more. Its files go with it.
    case "need.dismissed": {
      const { need: id } = data as unknown as { need: string };
      const study = get(state.studies, entry.studyId);
      const need = get(study.needs, id);
      study.needs.delete(id);
      for (const media of need.media) unname(state, media.id);
      return;
    }

    // A planner took a file down. The need is needed again, until a planner asks.
    case "media.withdrawn": {
      const { need: id, sha256 } = data as unknown as { need: string; sha256: string };
      const need = get(get(state.studies, entry.studyId).needs, id);
      need.media = need.media.filter((media) => media.id !== sha256);
      delete need.requested;
      delete need.claimed;
      delete need.failed;
      unname(state, sha256);
      return;
    }

    // The file itself is kept outside the log, by its hash.
    case "media.added": {
      const media = data as unknown as Omit<MediaView, "id" | "url" | "addedBy" | "addedAt"> & { need: string; sha256: string };
      const need = get(get(state.studies, entry.studyId).needs, media.need);
      need.media.push({
        id: media.sha256,
        url: mediaUrl(media.sha256),
        kind: media.kind,
        type: media.type,
        size: media.size,
        model: media.model,
        prompt: media.prompt,
        inputs: media.inputs,
        ...(media.alt ? { alt: media.alt } : {}),
        label: MEDIA_LABEL,
        addedBy: entry.actor,
        addedAt: entry.at,
      });
      state.media.set(media.sha256, { type: media.type, size: media.size, need: media.need });
      return;
    }

    // A study's PDF, kept outside the log by its hash, like media.
    case "document.created": {
      const document = data as unknown as { sha256: string; size: number; title: string; kind: DocumentKind };
      state.documents.set(document.sha256, { size: document.size, title: document.title, kind: document.kind });
      return;
    }

    // A map layer. Its features are kept outside the log, by their hash.
    case "layer.saved": {
      const layer = data as unknown as Omit<StoredLayer, "createdBy" | "at">;
      get(state.studies, entry.studyId).layers.set(layer.id, { ...layer, createdBy: entry.actor, at: entry.at });
      return;
    }

    case "activity":
      countUsage(state, entry);
      return;

    default:
      // Unknown entry types are history, not errors: older servers ignore newer events.
      return;
  }
}
