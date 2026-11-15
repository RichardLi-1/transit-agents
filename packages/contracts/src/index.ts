// The shapes every client of the service shares: agents, integrations and the
// display. Anything that crosses the API is defined here once.
import { z } from "zod";

export * from "./safety.ts";

export { evaluate, FormulaError, variables } from "./formula.ts";

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/, "Use lowercase letters, numbers, dots and dashes");

// A skill version: the SHA-256 of the skill's folder, every file's path and bytes
// (agents/skills.py, clients/skill-hash.ts). It names exactly one content, so
// approving it approves that content, and nothing else.
export const SkillHash = z.string().regex(/^[0-9a-f]{64}$/, "Give the skill folder's SHA-256: 64 lowercase hex digits");

// A guest is a visitor with a guest pass, or someone signed in who isn't a planner.
// It can do what a planner does, in its own sandbox, except decide.
export const Role = z.enum(["viewer", "integration", "agent", "planner", "guest"]);
export type Role = z.infer<typeof Role>;

// What a request without a token may do. "token" refuses it. "demo", for a public
// demo, lets it read as a viewer. "open" lets it act as a planner.
export const AccessMode = z.enum(["token", "open", "demo"]);
export type AccessMode = z.infer<typeof AccessMode>;

// How people sign in. Nothing here is secret.
export type SignIn = { provider: "auth0"; domain: string; clientId: string; audience: string };

// GET /v1/config, which needs no token. signIn is null when people can't sign in.
// guests is true when the service gives out guest passes. executive is the name of
// the person a planner can ping on Slack about an executive decision, and null when
// Slack isn't set up. Older services send none.
export type ServiceConfig = { auth: AccessMode; signIn: SignIn | null; guests: boolean; executive?: string | null; models?: ModelChoices };

// The models a chat message may ask the agents to answer on, from MODEL_CHOICES, the
// first the default. The display's Settings offers them.
export type ModelChoices = { choices: string[]; default: string };
// A model's name as the agents take it, such as gemini-3.6-flash or qwen3.5:9b.
export const modelName = z.string().regex(/^[a-z0-9][a-z0-9.:-]{0,59}$/);

// GET /v1/me: who the caller is.
export type Me = { role: Role; name: string };

// --- Visitors --------------------------------------------------------------

// A visitor's audience, which tags the log entries only that visitor sees: guest:<id>
// for a guest pass, user:<id> for someone signed in who isn't a planner.
export const AUDIENCE = /^(guest|user):[A-Za-z0-9_-]{22}$/;

// The header the service's own agents send to act for one visitor (an audience),
// or, only to read the log, for everyone ("*").
export const ON_BEHALF_OF = "x-on-behalf-of";

// POST /v1/guests, which needs no token.
export type GuestPass = { token: string; expiresAt: string };

// GET /v1/budget: what is left of today's Gemini budget for visitors.
export type VisitorBudget = { capped: false } | { capped: true; capUsd: number; leftUsd: number };

// The service's words for 403 sign_in_required on a decision, 429 budget_spent and
// 429 rate_limited. agents/core.py keeps a copy of BUDGET_SPENT.
export const SIGN_IN_TO_DECIDE = "Only planners decide. Sign in to decide.";
export const BUDGET_SPENT = "Visitors have used today's agent budget. Sign in, or come back tomorrow.";
export const RATE_LIMITED = "Too many changes at once. Try again in a minute.";

// --- Context ---------------------------------------------------------------

export const NewContext = z.object({
  id: slug.optional(),
  title: z.string().min(1).max(200),
  folder: z.string().min(1).max(60).default("Inbox"),
  source: z.string().max(200).optional(),
  // A web address only: the display links to it.
  url: z.url({ protocol: /^https?$/ }).optional(),
  publishedOn: z.iso.date().optional(),
  pages: z
    .array(z.object({ page: z.number().int().positive(), text: z.string() }))
    .refine((pages) => new Set(pages.map(({ page }) => page)).size === pages.length, "Give each page number once")
    .optional(),
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

// A result from a skill's script the service can't repeat. It is kept with what
// produced it, and is marked stale when one of its inputs changes. version is the
// skill's content hash, which a planner must have approved for that skill.
const Computed = z.object({
  kind: z.literal("computed"),
  skill: z.string().min(1).max(100),
  version: SkillHash,
  inputs: z.array(z.object({ figure: slug }).or(z.object({ assumption: slug }))).default([]),
  run: z.string().max(200).optional(),
});

// A total the service worked out itself, with its GIS tools, from an open dataset:
// one of a map layer's totals. The layer names its dataset, whose publisher, licence
// and retrieval date stand in for a page, and the operation that made it, which can
// be run again.
const Spatial = z.object({
  kind: z.literal("spatial"),
  layer: slug,
  total: z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/, "A total's name, such as population"),
});

export const Basis = z.discriminatedUnion("kind", [Cited, Derived, Computed, Spatial]);
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
  // "table" when the quote matched a table row with gaps. Shown, never hidden.
  match?: "exact" | "table";
  // A skill's result counts only once a planner accepts it.
  accepted: boolean;
  recordedBy: string;
  recordedAt: string;
  seq: number;
  hash: string;
};

// --- Checks ----------------------------------------------------------------

export const CheckOp = z.enum([">=", ">", "<=", "<"]);

// A check compares a figure with a rule. Thresholds always come from a rule a
// planner has set, so an agent can't decide what passing means.
export const NewCheck = z.object({
  id: slug,
  label: z.string().min(1).max(120),
  figure: slug,
  op: CheckOp,
  threshold: z.object({ assumption: slug }),
  rule: Citation.optional(),
});
export type NewCheck = z.input<typeof NewCheck>;

// Something the service can't compute, such as public feedback. Consultation is
// one of the TTC's own tests, so a negative or mixed finding counts in the analysis.
// A neutral finding, such as a noted risk, does not.
const Lon = z.number().min(-180).max(180);
const Lat = z.number().min(-90).max(90);
export const MapPlace = z.object({ lon: Lon, lat: Lat });
// A point as [longitude, latitude]. A plain two-number array, not a tuple: a tuple's
// JSON schema says `items: false`, which google-genai's MCP tools can't read, so
// every agent given record_finding would fail. The type stays a pair.
const Point = z
  .array(z.number())
  .length(2)
  .refine(([lon, lat]) => Lon.safeParse(lon).success && Lat.safeParse(lat).success, "A point is [longitude, latitude].") as unknown as z.ZodType<
  [number, number]
>;

// A draft route for a line, which an agent proposes and planners choose between:
// the street it follows, its line on the map as longitude and latitude, its length
// measured along that line, its new stations, and its main station, where it meets
// the network. Its cost is the study's own formula over its length, citing the
// pages the formula's inputs come from.
export const AlignmentOption = z.object({
  letter: z.string().regex(/^[A-Z]$/),
  follows: z.string().min(1).max(60),
  line: z.array(Point).min(2).max(200),
  lengthKm: z.number().positive().max(100),
  stations: z.number().int().nonnegative().max(50),
  costM: z.number().nonnegative(),
  costCitations: z.array(Citation).max(3).default([]),
  station: MapPlace.extend({ name: z.string().min(1).max(60) }),
});
export type AlignmentOption = z.infer<typeof AlignmentOption>;

// What an agent asks for when it proposes an alignment: a terminus, the streets to
// follow there in order, and one line on why. The service builds the line itself,
// only along route shapes it holds, and refuses one it can't snap.
export const NewAlignment = z.object({
  label: z.string().min(1).max(60).optional(),
  terminus: z.string().min(1).max(80),
  corridor: z.array(z.string().min(1).max(60)).min(1).max(4),
  note: z.string().min(3).max(200),
});
export type NewAlignment = z.input<typeof NewAlignment>;

export const NewFinding = z.object({
  id: slug,
  label: z.string().min(1).max(120),
  text: z.string().min(1).max(400),
  tone: z.enum(["positive", "mixed", "negative", "neutral"]),
  citation: Citation,
  // Where on the map it applies, if anywhere: the display pins it there.
  at: MapPlace.optional(),
  // A draft alignment for planners to choose between.
  option: AlignmentOption.optional(),
});
export type NewFinding = z.input<typeof NewFinding>;

export const Tone = z.enum(["positive", "mixed", "negative", "neutral"]);
export const FindingRating = z.object({ tone: Tone });

// "stale" means an input changed since a skill computed it. "unverified" means a
// skill's result is waiting for a planner to accept it.
export const CheckStatus = z.enum(["pass", "fail", "stale", "unverified"]);
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

// --- Engagement ------------------------------------------------------------

// Something to make so people in one place hear about a change, such as a poster
// near a hospital. Agents and planners propose it; only a planner asks for it to
// be made, and only then is any image or video generated.
export const MediaKind = z.enum(["image", "video"]);
export type MediaKind = z.infer<typeof MediaKind>;

// The only files the service keeps, told apart by their first bytes, never by what
// the upload says they are. SVG is never one: it can carry script.
export const MEDIA_TYPES = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "video/mp4": "video",
} as const satisfies Record<string, MediaKind>;
export type MediaType = keyof typeof MEDIA_TYPES;

export const MEDIA_MAX_BYTES: Record<MediaKind, number> = { image: 10 * 1024 * 1024, video: 40 * 1024 * 1024 };

// Generated media shows what a change could look like. It is never evidence, so it
// always carries this label.
export const MEDIA_LABEL = "Illustrative";

// What a need's render shows: transit infrastructure, never a street of people
// walking. A station entrance building, the elevated guideway with a train on it,
// a platform or concourse, the line seen from its street, or, for a bus route, the
// stop, bay or terminal with its bus.
export const NeedSubject = z.enum(["station-entrance", "guideway", "platform", "street", "bus-stop"]);
export type NeedSubject = z.infer<typeof NeedSubject>;

export const NewNeed = z.object({
  id: slug,
  title: z.string().min(1).max(60),
  place: z.string().min(1).max(60),
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  kinds: z
    .array(MediaKind)
    .min(1)
    .max(2)
    .refine((kinds) => new Set(kinds).size === kinds.length, "List each kind once"),
  reason: z.string().min(3).max(300),
  citations: z.array(Citation).max(5).default([]),
  // Needs from before subjects have none, and the media agent picks one by the study.
  subject: NeedSubject.optional(),
});
export type NewNeed = z.input<typeof NewNeed>;

// An openly licensed photo of a render's site, which the image model was given for its
// terrain, roads and buildings, with the credit its licence asks for and its page.
export const SitePhoto = z.object({
  file: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, "A file name: lowercase letters, numbers, dots, dashes and underscores"),
  credit: z.string().min(3).max(300),
  licence: z.string().min(1).max(40),
  source: z.url({ protocol: /^https$/, hostname: z.regexes.domain }).max(500),
});
export type SitePhoto = z.infer<typeof SitePhoto>;

// What a file drew on: a figure in the same study, a cited page, or a photo of its
// site, credited wherever the file is shown.
export const MediaInput = z.union([z.object({ figure: slug }), z.object({ citation: Citation }), z.object({ photo: SitePhoto })]);
export type MediaInput = z.infer<typeof MediaInput>;

// The fields that come with a file to POST /v1/studies/{id}/needs/{need}/media,
// which takes multipart/form-data, with the need in the path. In the form,
// `inputs` is a JSON array.
// An agent takes on a planner's request before it spends anything, so two agents
// never both pay to make one need. The claim is a secret the agent makes up and
// sends again with each file and with any failure. The log keeps only its hash.
export const Claim = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "A claim is 16 to 128 letters, digits, - or _");
export const NeedClaim = z.object({ claim: Claim });
export type NeedClaim = z.input<typeof NeedClaim>;

export const NewMedia = z.object({
  needId: slug,
  claim: Claim,
  kind: MediaKind,
  model: z.string().min(1).max(100),
  prompt: z.string().min(1).max(8000),
  inputs: z.array(MediaInput).max(20).default([]),
  // What the file shows, in words, for people who can't see it: any words drawn
  // into it, and the scene.
  alt: z.string().min(3).max(400).optional(),
});
export type NewMedia = z.input<typeof NewMedia>;

// Why a planner drops a need, or takes a file down.
export const NeedWithdrawal = z.object({ reason: z.string().min(3).max(300) });
export type NeedWithdrawal = z.input<typeof NeedWithdrawal>;

// What an agent says when it couldn't make what a planner asked for.
export const NeedFailure = z.object({ reason: z.string().min(3).max(300), claim: Claim });
export type NeedFailure = z.input<typeof NeedFailure>;

// "creating" once a planner has asked for it, and "ready" once every kind it asks
// for is attached. "failed" when an agent couldn't make a kind it still lacks:
// nothing more is made until a planner asks again, and what was made is kept.
export type NeedStatus = "needed" | "creating" | "ready" | "failed";

export type MediaView = {
  // The file's sha256.
  id: string;
  // Where to read it. Needs no token.
  url: string;
  kind: MediaKind;
  type: MediaType;
  size: number;
  model: string;
  prompt: string;
  inputs: MediaInput[];
  // What it shows, in words. Older files have none.
  alt?: string;
  label: typeof MEDIA_LABEL;
  addedBy: string;
  addedAt: string;
};

// --- Documents ---------------------------------------------------------------

// A PDF an agent or a planner builds from a study's cited findings: a report, or
// slides. A point is plain words, or words with the page they come from, cited as a
// finding is: the quote must be on that page.
export const DocumentKind = z.enum(["report", "slides"]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const DocumentPoint = z.union([
  z.string().min(1).max(500),
  z.object({ text: z.string().min(1).max(500), citation: Citation }),
]);
export type DocumentPoint = z.infer<typeof DocumentPoint>;

export const NewDocument = z.object({
  kind: DocumentKind,
  title: z.string().min(1).max(120),
  sections: z
    .array(z.object({ heading: z.string().min(1).max(100), points: z.array(DocumentPoint).min(1).max(15) }))
    .min(1)
    .max(15),
});
export type NewDocument = z.input<typeof NewDocument>;

// Every document is a first pass, and says so on its first page.
export const DOCUMENT_LABEL = "Draft first pass for planners, not a final answer";

export type DocumentView = {
  // The PDF's sha256.
  id: string;
  // Where to read it, from this service. Needs no token.
  url: string;
  // The same, as a whole address, to give people.
  link: string;
  kind: DocumentKind;
  title: string;
  pages: number;
  size: number;
};

// --- Maps and GIS ------------------------------------------------------------

// An open dataset the service's GIS tools work on: where it came from, under what
// licence, and the day it was fetched. A figure from a layer cites it.
export const Dataset = z.object({
  id: slug,
  title: z.string().min(1).max(200),
  publisher: z.string().min(1).max(200),
  licence: z.string().min(1).max(100),
  url: z.url({ protocol: /^https$/ }),
  retrieved: z.iso.date(),
});
export type Dataset = z.infer<typeof Dataset>;

// GET /v1/datasets: each dataset with what it covers, what to know before using it,
// and, for an area dataset with counts, the variables overlay can total.
export type DatasetInfo = Dataset & {
  licenceUrl: string;
  kind: LayerKind;
  coverage: string;
  notes: string;
  // Only where it covers part of the city: west, south, east, north.
  bbox?: [number, number, number, number];
  variables?: Record<string, { label: string; unit: string }>;
};

export const LayerKind = z.enum(["points", "lines", "polygons"]);
export type LayerKind = z.infer<typeof LayerKind>;

// A map layer saved on a study, newest last in GET /v1/studies/:id/layers. Its
// features are at GET /v1/studies/:id/layers/:layer/geojson, in WGS84. A layer made
// from others names them and the operation, with its parameters, so it can be made
// again.
export const Layer = z.object({
  id: slug,
  title: z.string().min(1).max(80),
  kind: LayerKind,
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .optional(),
  featureCount: z.number().int().nonnegative(),
  // west, south, east, north. A plain array, as for Point.
  bbox: z.array(z.number()).length(4) as unknown as z.ZodType<[number, number, number, number]>,
  dataset: Dataset.optional(),
  derivedFrom: z.array(slug).optional(),
  operation: z.object({ name: z.string().min(1).max(40), params: z.record(z.string(), z.unknown()) }).optional(),
  createdBy: z.string(),
  at: z.string(),
});
export type Layer = z.infer<typeof Layer>;

// The service logs one when a layer is saved, so the display can open its map. Only
// the service: it isn't an Activity an agent can post.
export const LayerAdded = z.object({ kind: z.literal("layer.added"), layerId: slug, title: z.string().min(1).max(80) });
export type LayerAdded = z.infer<typeof LayerAdded>;

// What the GIS tools take. id and title name the new layer; without them the
// service makes them from the operation, so the same request gives the same layer.
const LayerName = { id: slug.optional(), title: z.string().min(1).max(80).optional() };
const Route = z.string().regex(/^[0-9A-Za-z]{1,6}$/, "A TTC route number, such as 52 or 510");

export const RouteLayerRequest = z.object({ route: Route, ...LayerName });
export type RouteLayerRequest = z.input<typeof RouteLayerRequest>;

export const StudyLineRequest = z.object({ ...LayerName });
export type StudyLineRequest = z.input<typeof StudyLineRequest>;

// One named area of an area dataset, such as a neighbourhood: its name or id.
export const AreaRequest = z.object({ dataset: slug, name: z.string().min(1).max(80), ...LayerName });
export type AreaRequest = z.input<typeof AreaRequest>;

export const BufferRequest = z.object({
  layer: slug,
  metres: z.number().min(10).max(3000),
  ...LayerName,
});
export type BufferRequest = z.input<typeof BufferRequest>;

export const OverlayRequest = z.object({
  layer: slug,
  dataset: slug,
  // Census totals to record as figures, from the dataset's variables or their shares.
  variables: z.array(z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/)).max(8).default([]),
  ...LayerName,
});
export type OverlayRequest = z.input<typeof OverlayRequest>;

export const PointsWithinRequest = z.object({
  layer: slug,
  dataset: slug,
  // Collision years, both included.
  from: z.number().int().min(1900).max(2100).optional(),
  to: z.number().int().min(1900).max(2100).optional(),
  // Only collisions where someone was killed.
  fatal: z.boolean().optional(),
  // Only collisions involving these road users.
  involving: z.enum(["pedestrian", "cyclist", "motorcyclist"]).optional(),
  ...LayerName,
});
export type PointsWithinRequest = z.input<typeof PointsWithinRequest>;

export type NeedView = {
  id: string;
  title: string;
  place: string;
  lon: number;
  lat: number;
  kinds: MediaKind[];
  reason: string;
  citations: Citation[];
  subject?: NeedSubject;
  status: NeedStatus;
  addedBy: string;
  addedAt: string;
  // The latest request.
  requestedBy?: string;
  requestedAt?: string;
  // The agent making it for that request. Until one claims it, nobody is.
  claimedBy?: string;
  claimedAt?: string;
  // Why the latest request failed, when it did. Media made for it is kept.
  failure?: string;
  failedBy?: string;
  failedAt?: string;
  // Oldest first.
  media: MediaView[];
};

// --- Studies ---------------------------------------------------------------

export const NewStudy = z.object({
  id: slug,
  title: z.string().min(1).max(120),
  brief: z.string().max(2000).default(""),
  routes: z.array(z.string()).default([]),
  line: z.string().optional(),
  trial: z.object({ startedOn: z.iso.date(), reviewOn: z.iso.date() }).optional(),
  // Service patterns to measure, such as 52F, and weekly figures to project.
  watch: z.array(z.string()).default([]),
  project: z.array(slug).default([]),
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

// "mixed" means the tests disagree, so a person has to weigh them.
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

// An agent can only propose a tone. Until a planner rates the finding it reads
// "unrated", and the study's analysis stays incomplete.
export type FindingView = Omit<z.infer<typeof NewFinding>, "tone"> & {
  tone: z.infer<typeof Tone> | "unrated";
  proposedTone?: z.infer<typeof Tone>;
};

export type DayResult = { date: string; departures: number; onTimeStandard: number; onTimeReported: number; scheduled: number };

// Measured and forecast are kept apart on purpose. `measured` is what the live feed
// recorded. `forecast` is a published weekly figure at current assumptions: a claim,
// not a result, and it stays flat because no one has published how it will change.
export type Timeline = {
  today: string;
  reviewOn: string | null;
  measured: { patterns: string[]; days: DayResult[] };
  network: { days: DayResult[] };
  forecast: { figure: string; label: string; unit: string; perWeek: number }[];
};

export type StudyView = {
  id: string;
  title: string;
  brief: string;
  routes: string[];
  line?: string;
  trial?: { startedOn: string; reviewOn: string };
  watch: string[];
  project: string[];
  figures: FigureView[];
  checks: CheckView[];
  findings: FindingView[];
  analysis: Analysis;
  decision?: Decision;
  // Oldest first.
  needs: NeedView[];
};

// --- Activity --------------------------------------------------------------

export const Activity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.started") }),
  z.object({ kind: z.literal("run.finished") }),
  // model: what a person's message asks the agents to answer on, one of MODEL_CHOICES.
  z.object({ kind: z.literal("message"), text: z.string().min(1).max(4000), model: modelName.optional() }),
  // subagentId names the specialist whose reading or usage it is. The lead's has none.
  z.object({ kind: z.literal("reading"), contextId: slug, page: z.number().int().positive().optional(), subagentId: slug.optional() }),
  // skill is the skill the lead gave it, if any.
  z.object({ kind: z.literal("subagent.started"), id: slug, question: z.string().min(1).max(300), skill: slug.optional() }),
  // ok is false when it stopped before answering, as on an error or a cancel.
  z.object({ kind: z.literal("subagent.finished"), id: slug, summary: z.string().min(1).max(1000), ok: z.boolean().optional() }),
  z.object({
    kind: z.literal("usage"),
    model: z.string().min(1).max(100),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    computeSeconds: z.number().nonnegative().optional(),
    subagentId: slug.optional(),
  }),
  // One tool call an agent makes: the call, then how it went. id pairs the two.
  // summary is a short line, such as the arguments or a count of results: never a
  // whole page, and never a secret.
  z.object({ kind: z.literal("tool.called"), id: slug, name: z.string().min(1).max(100), subagentId: slug.optional(), summary: z.string().max(300).optional() }),
  z.object({ kind: z.literal("tool.finished"), id: slug, ok: z.boolean(), ms: z.number().int().nonnegative().optional(), summary: z.string().max(300).optional() }),
]);
export type Activity = z.infer<typeof Activity>;

// How an agent's last message before run.finished reads. The line the skills end a
// hand-over with, and the replay's hand-over, ask for a planner's call. What the
// agent posts when a run stops without an answer, BUDGET_SPENT's words included,
// is no answer. The display's notices and the Slack integration both read these.
export const HANDOVER = /\bfor a planner to decide:|\bready for planners\b/i;
// The line the lead ends an answer with when it turns on a decision above a
// planner's authority, such as which option to fund: "Executive decision required:
// <the decision>." The display offers to ping the executive about it.
export const EXECUTIVE = /\bexecutive decision required\b/i;
export const NO_ANSWER = /^(That failed\.|That took more than|Stopped before answering\.|The lead gave no answer\.|Visitors have used today's agent budget\.)/;

// The decision an answer's executive line names, or null without one: the text after
// "Executive decision required:" on its last such line, capitalised. A line without a decision
// after it names none.
export function executiveDecision(text: string): string | null {
  const lines = text.split("\n").filter((line) => EXECUTIVE.test(line));
  const decision = lines.at(-1)?.replace(/^[\s\-•*]*/, "").replace(/^.*?\bexecutive decision required\b\s*[:.\-–—]?\s*/i, "").trim();
  // As a line of its own, so it starts with a capital.
  return decision ? decision.charAt(0).toUpperCase() + decision.slice(1) : null;
}

// A planner pinged the executive on Slack about a decision: the decision, who it
// went to, and the log position of the answer that asked for it. Only POST
// /v1/studies/:id/escalate logs one, as an activity, so agents can't post it.
export const Escalation = z.object({
  kind: z.literal("escalation.sent"),
  text: z.string().min(1).max(300),
  to: z.string().min(1).max(100),
  message: z.number().int().positive().optional(),
});
export type Escalation = z.infer<typeof Escalation>;
// What an activity entry in the log holds: what agents and people post, a ping, or
// a layer the service saved.
export type LoggedActivity = Activity | Escalation | LayerAdded;

// POST /v1/studies/:id/escalate: the decision, or the answer's executive line, and
// the answer's log position, which makes a second ping for it a repeat.
export const NewEscalation = z.object({
  text: z.string().trim().min(1).max(300),
  message: z.number().int().positive().optional(),
});
export type NewEscalation = z.input<typeof NewEscalation>;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  computeSeconds: number;
  calls: number;
  // Calls reported without a cost, which costUsd leaves out. The service counts
  // them; a display that adds up usage from the log itself may not.
  unpricedCalls?: number;
  // GET /v1/usage adds it. Older services send none.
  estimate?: UsageEstimate;
};

// The energy, emissions and water behind the model calls: each call times a
// published figure for one median prompt. Our calls are often much longer than
// a median prompt, so it is a floor, never an exact figure.
export type UsageEstimate = {
  atLeast: true;
  energyWh: number;
  co2eGrams: number;
  waterMl: number;
  basis: EstimateBasis;
};

export type EstimateBasis = {
  perCallWh: number;
  perCallCo2eGrams: number;
  perCallWaterMl: number;
  // Market-based emissions count the clean energy the operator buys, so they
  // are lower than the local grid's.
  co2e: "market-based";
  // date is the day it was published.
  source: { title: string; url: string; date: string; quote: string };
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
  // null for the shared record. Otherwise the one visitor who may see it.
  audience: string | null;
};

// A skill version a planner approves: its content hash. It becomes the skill's one
// current version, replacing the one before. Agents load only the current hash, and
// computed figures must name it. Rolling back is approving the parent's hash again.
export const NewSkill = z.object({
  version: SkillHash,
  description: z.string().max(400).default(""),
});
export type NewSkill = z.input<typeof NewSkill>;

// A planner withdraws a skill's current version, so no agent loads it and no computed
// figure may name it, until a planner approves one again. With a version, only if it
// is still the current one.
export const SkillRevocation = z.object({
  reason: z.string().trim().min(3).max(400),
  version: SkillHash.optional(),
});
export type SkillRevocation = z.input<typeof SkillRevocation>;

// Cases a skill passed, of those scored, on one split.
const Tally = z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() });

// A skill version an agent puts forward once it has passed its gate (agents/evolve.py):
// on the skill's dev cases, as good as its parent and losing no refusal or hand-over.
// version and parent are content hashes of the skill's folder, with the candidate's
// SKILL.md and with the live one. test is reported, never used to choose. Only a
// planner approves a version, with NewSkill.
export const SkillCandidate = z.object({
  version: SkillHash,
  parent: SkillHash,
  summary: z.string().max(400).default(""),
  dev: z.object({ candidate: Tally, parent: Tally }),
  test: z.object({ candidate: Tally, parent: Tally }).optional(),
});
export type SkillCandidate = z.input<typeof SkillCandidate>;

// With an audience, the entry is in that visitor's sandbox.
export const ContentRemoval = z.object({ reason: z.string().min(3).max(400), audience: z.string().regex(AUDIENCE).optional() });

export const NewSubscription = z.object({
  url: z.url(),
  types: z.array(z.string()).default(["decision.recorded"]),
  format: z.enum(["json", "slack", "teams"]).default("json"),
  secret: z.string().min(16).optional(),
});
export type NewSubscription = z.input<typeof NewSubscription>;

// A need's title as people should read it. A need is named for what's missing, such
// as "Viaduct rendering missing"; once it has its image or video, "missing" is
// wrong, so the made thing goes by its own name: "Viaduct rendering".
export function needTitle(need: { title: string; media?: readonly unknown[] | null }, made = Boolean(need.media?.length)): string {
  return made ? need.title.replace(/\s+missing$/i, "") : need.title;
}
