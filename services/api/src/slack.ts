// Posts short notices to one Slack incoming webhook, set by SLACK_WEBHOOK_URL:
// a hand-over that needs a planner's call, an answer, a decision, a change to the
// brief, and illustrative media. Each names the study and links to it.
//
// Only the shared record is posted. A visitor's sandbox entry, and anyone's own
// words, never are: a notice says what happened, not what was said.
//
// The webhook's address is itself the secret, so it never appears in a log line or
// an error. Posting never blocks the service: each notice waits its turn in a short
// queue, times out quickly, is tried twice at most, and is dropped after that.
import { HANDOVER, NO_ANSWER, type Activity, type Decision, type Outcome } from "@transit-agents/contracts";
import type { Entry } from "./log.ts";
import type { Service } from "./service.ts";

// The studies a notice is about: one, but for a change to the brief, which names
// every study whose figures it changes.
export type Notice = { headline: string; detail?: string; studies: string[] };

export type SlackMessage = {
  text: string;
  blocks: { type: "section"; text: { type: "mrkdwn"; text: string } }[];
};

const OUTCOME: Record<Outcome, string> = { adopt: "Adopted", reject: "Not adopted", defer: "Deferred", amend: "Amended" };

// A person's own words and work, never an agent's.
const PERSON = /^(planner|guest):/;

const TIMEOUT_MS = 3000;
const RETRY_MS = 1000;
// Notices waiting while Slack is slow or down. Past this, new ones are dropped.
const QUEUE = 20;

// An incoming webhook's address, or a local one for tests and demos. Anything else
// turns Slack off, so a mistyped address can't send the record somewhere else.
export function slackUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "https:" && url.hostname === "hooks.slack.com" && url.pathname.startsWith("/services/")) return url;
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url;
  return null;
}

// Slack's mrkdwn treats these three as control characters.
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function message(notice: Pick<Notice, "headline" | "detail">, study: string, link?: string): SlackMessage {
  const what = notice.detail ? `${notice.headline}: ${notice.detail}` : notice.headline;
  const open = link ? ` <${link}|Open>` : "";
  const text = `${escape(what)}. ${escape(study)}.${open}`;
  const section = `*${escape(what)}*\n${escape(study)}${link ? ` · <${link}|Open the study>` : ""}`;
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: section } }] };
}

// Where the display opens on a study.
export const studyLink = (publicUrl: string | undefined, studyId: string) =>
  publicUrl ? `${publicUrl.replace(/\/+$/, "")}/#${encodeURIComponent(studyId)}` : undefined;

const text = (data: unknown, key: string) => {
  const value = (data as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : undefined;
};

// What one shared entry is worth telling Slack, if anything. said holds each
// study's last agent message, until anything but reading follows it, and is
// updated here.
export function notice(entry: Entry, said: Map<string, string>, service: Service): Notice | null {
  const studyId = entry.studyId;
  if (entry.audience) return null;
  let raised: Notice | null = null;

  if (entry.type === "activity" && studyId) {
    const activity = entry.data as Activity;
    if (activity.kind === "message") {
      if (PERSON.test(entry.actor)) said.delete(studyId);
      else said.set(studyId, activity.text);
      return null;
    }
    if (activity.kind === "run.finished") {
      const last = said.get(studyId);
      if (last && HANDOVER.test(last)) raised = { headline: "Needs your call", studies: [studyId] };
      else if (last && !NO_ANSWER.test(last)) raised = { headline: "Answer ready", studies: [studyId] };
    }
    // A run's answer is its last word: anything it does after a message, but read,
    // means the message wasn't the end.
    if (activity.kind !== "reading" && activity.kind !== "usage") said.delete(studyId);
    return raised;
  }
  if (studyId) said.delete(studyId);

  switch (entry.type) {
    case "decision.recorded": {
      const decision = entry.data as Decision;
      if (!studyId) return null;
      const what = OUTCOME[decision.outcome] ?? decision.outcome;
      return { headline: "Decided", detail: decision.decidedBy ? `${what}, by ${decision.decidedBy}` : what, studies: [studyId] };
    }
    case "assumption.set": {
      const { key, value, unit, label, effects } = entry.data as { key: string; value: number; unit?: string; label?: string; effects?: { studyId: string }[] };
      const name = label ?? service.state.assumptions.get(key)?.label ?? key;
      // The brief is shared by every study, so a change names the ones it moves.
      return { headline: "Brief changed", detail: `${name} set to ${value}${unit ? ` ${unit}` : ""}`, studies: (effects ?? []).map((e) => e.studyId) };
    }
    case "media.added": {
      const need = text(entry.data, "need");
      if (!studyId || !need) return null;
      const kind = text(entry.data, "kind") === "video" ? "video" : "image";
      const found = service.state.studies.get(studyId)?.needs.get(need);
      const where = found ? [found.title, found.place].filter(Boolean).join(", ") : need;
      return { headline: `Illustrative ${kind} ready`, detail: where, studies: [studyId] };
    }
  }
  return null;
}

type Post = typeof fetch;

export class Slack {
  private readonly service: Service;
  private readonly url: URL;
  private readonly publicUrl: string | undefined;
  private readonly post: Post;
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly warn: (line: string) => void;
  private readonly said = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private queue: Promise<void> = Promise.resolve();
  private waiting = 0;
  private stopped = false;

  constructor(
    service: Service,
    url: URL,
    options: { publicUrl?: string | undefined; post?: Post; timeoutMs?: number; retryMs?: number; warn?: (line: string) => void } = {},
  ) {
    this.service = service;
    this.url = url;
    this.publicUrl = options.publicUrl;
    this.post = options.post ?? fetch;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.warn = options.warn ?? ((line) => console.warn(line));
    // The log tells listeners before the service applies the entry, so the notice is
    // made once the state has it.
    this.unsubscribe = service.log.subscribe((entry) => queueMicrotask(() => this.hear(entry)));
  }

  private hear(entry: Entry) {
    if (this.stopped || entry.audience) return;
    let raised: Notice | null;
    try {
      raised = notice(entry, this.said, this.service);
    } catch {
      return;
    }
    if (!raised) return;
    const titles = raised.studies.map((id) => this.service.state.studies.get(id)?.title ?? id);
    const [only] = raised.studies;
    const link = raised.studies.length === 1 && only ? studyLink(this.publicUrl, only) : this.publicUrl;
    this.send(message(raised, titles.join(", ") || "No study's figures change", link));
  }

  // Waits its turn, so notices arrive in order.
  send(body: SlackMessage) {
    if (this.waiting >= QUEUE) {
      this.warn("Slack: too many notices waiting; dropped one");
      return;
    }
    this.waiting += 1;
    this.queue = this.queue
      .then(() => this.deliver(JSON.stringify(body)))
      .finally(() => {
        this.waiting -= 1;
      });
  }

  // Resolves once every notice sent so far has been posted or dropped.
  settled(): Promise<void> {
    return this.queue;
  }

  private async deliver(body: string) {
    let reason = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (this.stopped) return;
      try {
        const response = await this.post(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        await response.body?.cancel();
        if (response.ok) return;
        reason = `Slack returned ${response.status}`;
      } catch (error) {
        // Only the error's kind: a message could quote the address.
        const e = error as { name?: string; cause?: { code?: string } };
        reason = e.name === "TimeoutError" ? `no answer in ${this.timeoutMs} ms` : (e.cause?.code ?? e.name ?? "error");
      }
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, this.retryMs).unref());
    }
    this.warn(`Slack: a notice was not posted (${reason})`);
  }

  stop() {
    this.stopped = true;
    this.unsubscribe();
  }
}
