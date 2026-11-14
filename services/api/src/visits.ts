// Who visits, from where, and what they look at: each page view and quick bounce the
// display reports (public/track.js), and each AI assistant that fetches a page itself,
// as a message in a Discord channel. Ported from hi-sg's tracker (VISITOR_TRACKING.md
// there). The webhook stays on the server: the browser only posts to /v1/track.
//
// The server writes every message from what the page reports, so a request can't put
// words of its own in the channel, and no message can @-mention anyone.

type Headers = { get(name: string): string | null };

// ─── What the page reports ──────────────────────────────────────────────────

// Raw facts the browser reports about the visitor; scoreVisit judges them.
export type HumanSignals = {
  userAgent: string;
  webdriver: boolean;
  languagesCount: number;
  screenWidth: number;
  screenHeight: number;
  outerWidth: number;
  outerHeight: number;
  pluginsCount: number;
  isMobile: boolean;
  timeZone: string;
  pointerMoves: number;
  touches: number;
  scrolls: number;
  keyPresses: number;
  wasVisible: boolean;
  interactedEarlier: boolean;
  msObserved: number;
};

export type Visit = {
  kind: "visit" | "bounce";
  path: string;
  trail: string[];
  referral?: string; // LinkedIn, Resume, ChatGPT…
  ai?: string; // the AI assistant they came from, with how we know
  referrer?: string;
  params?: string;
  device?: string;
  seconds?: number; // on the page, for a bounce
  bot?: boolean;
  signals?: Partial<HumanSignals>;
};

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, max) : undefined);
const whole = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined);

// What the page sent, as a Visit, or null when it isn't one. Strings are cut short
// and stripped of control characters; anything else is dropped.
export function readVisit(body: unknown): Visit | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.kind !== "visit" && b.kind !== "bounce") return null;
  const path = text(b.path, 200);
  if (!path?.startsWith("/")) return null;
  const trail = Array.isArray(b.trail) ? b.trail.slice(-12).map((step) => text(step, 120)).filter((step): step is string => Boolean(step)) : [];
  const signals = b.signals && typeof b.signals === "object" ? (b.signals as Record<string, unknown>) : undefined;
  return {
    kind: b.kind,
    path,
    trail,
    referral: text(b.referral, 40),
    ai: text(b.ai, 80),
    referrer: text(b.referrer, 300),
    params: text(b.params, 300),
    device: text(b.device, 60),
    seconds: whole(b.seconds),
    bot: b.bot === true,
    signals: signals && {
      userAgent: text(signals.userAgent, 300) ?? "",
      webdriver: signals.webdriver === true,
      languagesCount: whole(signals.languagesCount),
      screenWidth: whole(signals.screenWidth),
      screenHeight: whole(signals.screenHeight),
      outerWidth: whole(signals.outerWidth),
      outerHeight: whole(signals.outerHeight),
      pluginsCount: whole(signals.pluginsCount),
      isMobile: signals.isMobile === true,
      timeZone: text(signals.timeZone, 60) ?? "",
      pointerMoves: whole(signals.pointerMoves),
      touches: whole(signals.touches),
      scrolls: whole(signals.scrolls),
      keyPresses: whole(signals.keyPresses),
      wasVisible: signals.wasVisible !== false,
      interactedEarlier: signals.interactedEarlier === true,
      msObserved: whole(signals.msObserved),
    },
  };
}

// ─── How likely a person ────────────────────────────────────────────────────
// From 50, points for signs of a person and against signs of automation, each kept
// as a reason so the message shows why. Hand-picked weights, as in hi-sg.

export type HumanScore = { score: number; label: string; reasons: string[] };

function tally() {
  let points = 0;
  const reasons: string[] = [];
  const add = (delta: number, why: string) => {
    points += delta;
    reasons.push(`${delta > 0 ? "+" : ""}${delta} ${why}`);
  };
  return { add, points: () => points, reasons };
}

export function scoreClientSignals(s: Partial<HumanSignals>) {
  const { add, points, reasons } = tally();
  const ua = s.userAgent ?? "";
  if (/bot|crawler|spider/i.test(ua)) add(-60, "bot user-agent");
  if (/HeadlessChrome|PhantomJS|Lighthouse/i.test(ua)) add(-50, "headless browser user-agent");
  if (s.webdriver) add(-50, "webdriver flag (automated browser)");
  if (s.languagesCount === 0) add(-15, "no browser languages");
  if (s.screenWidth === 0 || s.screenHeight === 0) add(-20, "0px screen");
  if (s.outerWidth === 0 && s.outerHeight === 0) add(-15, "no window frame");
  if (!s.isMobile && s.pluginsCount === 0) add(-10, "no plugins on desktop");
  const moves = s.pointerMoves ?? 0;
  if (moves >= 5) add(25, "mouse moved");
  else if (moves > 0) add(10, "slight mouse movement");
  if ((s.touches ?? 0) > 0) add(25, "touched screen");
  if ((s.scrolls ?? 0) > 0) add(15, "scrolled");
  if ((s.keyPresses ?? 0) > 0) add(10, "pressed keys");
  if (s.interactedEarlier) add(20, "interacted on an earlier page");
  const didAnything = moves > 0 || (s.touches ?? 0) > 0 || (s.scrolls ?? 0) > 0 || (s.keyPresses ?? 0) > 0;
  if (!didAnything && !s.interactedEarlier && (s.msObserved ?? 0) >= 5_000) add(-10, `no input in ${Math.round((s.msObserved ?? 0) / 1000)}s`);
  if (s.wasVisible === false) add(-10, "tab never visible");
  return { points: points(), reasons };
}

// The /v1/track request's own headers: real browsers send these on their own.
export function scoreRequestHeaders(headers: Headers) {
  const { add, points, reasons } = tally();
  const ua = headers.get("user-agent") ?? "";
  const secChUa = headers.get("sec-ch-ua");
  if (!headers.get("accept-language")) add(-20, "no Accept-Language header");
  if (/HeadlessChrome/i.test(secChUa ?? "")) add(-50, "headless Chrome in sec-ch-ua");
  else if (/Chrome\/\d/.test(ua) && !secChUa) add(-15, "claims Chrome but no sec-ch-ua");
  if (!headers.get("sec-fetch-site")) add(-10, "no Sec-Fetch headers");
  return { points: points(), reasons };
}

export function scoreVisit(signals: Partial<HumanSignals>, headers: Headers): HumanScore {
  const client = scoreClientSignals(signals);
  const server = scoreRequestHeaders(headers);
  const score = Math.max(0, Math.min(100, 50 + client.points + server.points));
  return {
    score,
    label: score >= 70 ? "likely human" : score >= 40 ? "unsure" : "likely bot",
    reasons: [...client.reasons, ...server.reasons],
  };
}

// ─── Where from ─────────────────────────────────────────────────────────────
// Fly gives the visitor's address and the region of the edge that took the request,
// near the visitor. No lookup elsewhere: the address goes to Discord and nowhere else.

const REGIONS: Record<string, string> = {
  yyz: "Toronto",
  yul: "Montreal",
  iad: "Ashburn, Virginia",
  ewr: "Secaucus, New Jersey",
  bos: "Boston",
  ord: "Chicago",
  atl: "Atlanta",
  mia: "Miami",
  dfw: "Dallas",
  den: "Denver",
  sea: "Seattle",
  sjc: "San Jose",
  lax: "Los Angeles",
  lhr: "London",
  ams: "Amsterdam",
  fra: "Frankfurt",
  cdg: "Paris",
  arn: "Stockholm",
  waw: "Warsaw",
  mad: "Madrid",
  nrt: "Tokyo",
  sin: "Singapore",
  hkg: "Hong Kong",
  bom: "Mumbai",
  syd: "Sydney",
  gru: "São Paulo",
  jnb: "Johannesburg",
};

export function edgeRegion(code: string | null): string | undefined {
  if (!code) return undefined;
  const name = REGIONS[code.toLowerCase()];
  return name ? `${name} (${code})` : code;
}

// ─── The message ────────────────────────────────────────────────────────────

const PLACE = "transit-agents";

export function visitMessage(visit: Visit, headers: Headers, now: Date = new Date()): string {
  const human = visit.signals ? scoreVisit(visit.signals, headers) : null;
  const page = visit.path;
  const from = visit.ai ? `**${visit.ai.split(" (")[0]}** (AI assistant)` : visit.referral ? `**${visit.referral}**` : null;
  const title =
    visit.kind === "bounce"
      ? `👋 Quick bounce${from ? ` from ${from}` : ""} on ${page}`
      : visit.bot
        ? `🤖 Bot/crawler on ${page}`
        : from
          ? `👀 New visitor from ${from} on ${page}`
          : visit.params
            ? `👀 New visitor — CUSTOM REFERRAL on ${page}`
            : `👀 New visitor on ${page}`;
  const ip = headers.get("fly-client-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const lines: [string, string | undefined][] = [
    [human?.label === "likely bot" ? "🤖 Human likelihood" : "🧍 Human likelihood", human ? `**${human.score}/100** (${human.label})` : undefined],
    ["🧾 Why", human ? human.reasons.join(", ") || "no signals either way" : undefined],
    ["🖥️ Device", visit.device],
    ["🛤️ Path", visit.trail.length ? visit.trail.join(" → ") : undefined],
    ["⏱️ Time on page", visit.seconds !== undefined && visit.kind === "bounce" ? `${visit.seconds}s` : undefined],
    ["🔗 Params", visit.params ? `?${visit.params.replace(/^\?/, "")}` : undefined],
    ["↩️ Referrer", visit.referrer],
    ["🤖 AI assistant", visit.ai],
    ["🔍 UA", visit.bot ? visit.signals?.userAgent : undefined],
    ["🌐 IP", ip],
    ["📍 Near", edgeRegion(headers.get("fly-region"))],
    ["🕒 Time", now.toISOString()],
  ];
  return [`🔔 [${PLACE}] ${title}`, ...lines.filter(([key, value]) => key && value).map(([key, value]) => `${key}: ${value}`)].join("\n");
}

// ─── AI assistants fetching pages themselves ────────────────────────────────
// They run no JavaScript, so only the service sees them, by User-Agent. "user": a
// person asked the assistant just now and it opened this page, worth a message;
// "search" and "training": indexing and crawling, a log line only.

export type AiFetcher = { token: string; vendor: string; kind: "user" | "search" | "training" };

const AI_FETCHERS: AiFetcher[] = [
  { token: "ChatGPT-User", vendor: "OpenAI", kind: "user" },
  { token: "OAI-SearchBot", vendor: "OpenAI", kind: "search" },
  { token: "GPTBot", vendor: "OpenAI", kind: "training" },
  { token: "Claude-User", vendor: "Anthropic", kind: "user" },
  { token: "Claude-SearchBot", vendor: "Anthropic", kind: "search" },
  { token: "ClaudeBot", vendor: "Anthropic", kind: "training" },
  { token: "Perplexity-User", vendor: "Perplexity", kind: "user" },
  { token: "PerplexityBot", vendor: "Perplexity", kind: "search" },
];

export function matchAiFetcher(userAgent: string | null | undefined): AiFetcher | null {
  if (!userAgent) return null;
  return AI_FETCHERS.find((fetcher) => userAgent.includes(fetcher.token)) ?? null;
}

export function aiFetchMessage(fetcher: AiFetcher, page: string, now: Date = new Date()): string {
  return [
    `🔔 [${PLACE}] 🔎 **${fetcher.token}** read ${page.split("?")[0]} for someone`,
    `🤖 Assistant: ${fetcher.vendor}`,
    `📄 Page: ${page}`,
    `🕒 Time: ${now.toISOString()}`,
  ].join("\n");
}

// ─── Sending ────────────────────────────────────────────────────────────────

const MINUTE = 60_000;

// Posts to the Discord channel, at most `perMinute` messages a minute in all and
// `perAddress` an hour from one address, so a script can't flood it. Best effort:
// a message that fails is logged, never retried, and never slows a response.
export class Visits {
  private sent: number[] = [];
  private byAddress = new Map<string, number[]>();
  private readonly webhook: string;
  private readonly options: { perMinute?: number; perAddress?: number; clock?: () => number; post?: typeof fetch };

  constructor(webhook: string, options: { perMinute?: number; perAddress?: number; clock?: () => number; post?: typeof fetch } = {}) {
    this.webhook = webhook;
    this.options = options;
  }

  // Whether a message from this address may go now; counts it if so.
  take(address: string | undefined): boolean {
    const now = (this.options.clock ?? Date.now)();
    this.sent = this.sent.filter((at) => now - at < MINUTE);
    if (this.sent.length >= (this.options.perMinute ?? 20)) return false;
    if (address) {
      const recent = (this.byAddress.get(address) ?? []).filter((at) => now - at < 60 * MINUTE);
      if (recent.length >= (this.options.perAddress ?? 30)) return false;
      recent.push(now);
      this.byAddress.set(address, recent);
      if (this.byAddress.size > 5_000) this.byAddress.clear();
    }
    this.sent.push(now);
    return true;
  }

  send(content: string): Promise<void> {
    const post = this.options.post ?? fetch;
    // No @-mentions, and no link previews: a link in a referrer stays a line of text.
    return post(this.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 }),
    })
      .then((response) => {
        if (!response.ok) console.error(`Discord didn't take a visit: ${response.status}`);
      })
      .catch((error: unknown) => console.error("Discord didn't take a visit:", error instanceof Error ? error.message : error));
  }
}

// A Discord webhook's address, or undefined for anything else, so a mistyped setting
// sends nothing anywhere.
export function discordUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" && /^(?:ptb\.|canary\.)?discord(?:app)?\.com$/.test(url.hostname) && url.pathname.startsWith("/api/webhooks/")
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
