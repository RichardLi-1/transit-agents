// Delivers log entries to subscribers. This is how Slack, Teams and any other
// system hear about decisions without being replaced or changed.
//
// Delivery is at least once. Each subscriber has a cursor, so a receiver that
// was down catches up from where it stopped. Every payload carries the log head,
// so each subscriber also acts as an outside witness to the log's history.
import { createHmac, randomUUID } from "node:crypto";
import type { Decision } from "@transit-agents/contracts";
import type { Entry } from "./log.ts";
import type { Service } from "./service.ts";

export type Format = "json" | "slack" | "teams";

type Subscription = { id: string; url: string; types: string[]; format: Format; secret: string | null; cursor: number };

type Row = { id: string; url: string; types: string; format: Format; secret: string | null; cursor: number };

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 5 * 60 * 1000;

// Messages carry a study title and an outcome, never document contents, so chat
// tools don't become a second copy of the record.
export function describe(entry: Entry, service: Service): string {
  const title = (entry.studyId && service.state.studies.get(entry.studyId)?.title) || entry.studyId || "";
  if (entry.type === "decision.recorded") {
    const decision = entry.data as Decision;
    const override = decision.override ? " Override of the analysis." : "";
    return `${title}: ${decision.outcome}, decided by ${decision.decidedBy}.${override}`;
  }
  if (entry.type === "assumption.set") {
    const { key, value, reason } = entry.data as { key: string; value: number; reason: string };
    return `Assumption ${key} set to ${value}: ${reason}`;
  }
  if (entry.type === "context.added") return `Context added: ${(entry.data as { title: string }).title}`;
  if (entry.type === "figure.rejected") return `${title}: figure rejected. ${(entry.data as { reason: string }).reason}`;
  return `${title}: ${entry.type}`;
}

export function format(entry: Entry, service: Service, kind: Format, link?: string): unknown {
  const text = describe(entry, service);
  if (kind === "slack") return { text: link ? `${text} <${link}|Open>` : text };
  if (kind === "teams") {
    return {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
            body: [{ type: "TextBlock", text, wrap: true }],
            ...(link ? { actions: [{ type: "Action.OpenUrl", title: "Open", url: link }] } : {}),
          },
        },
      ],
    };
  }
  return { entry, head: service.log.head() };
}

export const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export class Webhooks {
  private readonly service: Service;
  private readonly publicUrl: string | undefined;
  private readonly post: typeof fetch;
  private readonly running = new Set<string>();
  private readonly failures = new Map<string, number>();
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor(service: Service, publicUrl?: string, post: typeof fetch = fetch) {
    this.service = service;
    this.publicUrl = publicUrl;
    this.post = post;
    service.log.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        types TEXT NOT NULL,
        format TEXT NOT NULL,
        secret TEXT,
        cursor INTEGER NOT NULL
      );
    `);
    this.unsubscribe = service.log.subscribe(() => this.pump());
    this.pump();
  }

  private all(): Subscription[] {
    const rows = this.service.log.db.prepare("SELECT * FROM subscriptions").all() as Row[];
    return rows.map((r) => ({ ...r, types: JSON.parse(r.types) as string[] }));
  }

  add(actor: string, input: { url: string; types: string[]; format: Format; secret?: string | undefined }) {
    const id = randomUUID();
    const cursor = this.service.log.head().seq;
    this.service.log.db
      .prepare("INSERT INTO subscriptions (id, url, types, format, secret, cursor) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.url, JSON.stringify(input.types), input.format, input.secret ?? null, cursor);
    // Only the host is recorded. A Slack or Teams address is itself a secret, and
    // anyone who can read the log could post with it. The signing secret never is.
    const host = new URL(input.url).host;
    this.service.log.append({ actor, type: "subscription.added", data: { id, host, types: input.types, format: input.format } });
    return { id, url: input.url, types: input.types, format: input.format };
  }

  private pump() {
    if (this.stopped) return;
    for (const subscription of this.all()) void this.deliver(subscription);
  }

  private link(entry: Entry) {
    return this.publicUrl && entry.studyId ? `${this.publicUrl}/#${entry.studyId}` : undefined;
  }

  private async deliver(subscription: Subscription) {
    if (this.running.has(subscription.id)) return;
    this.running.add(subscription.id);
    let cursor = subscription.cursor;
    try {
      for (;;) {
        const pending = this.service.log.since(cursor, 200);
        if (!pending.length) break;
        for (const entry of pending) {
          if (subscription.types.includes(entry.type) || subscription.types.includes("*")) {
            await this.send(subscription, entry);
          }
          cursor = entry.seq;
          this.service.log.db.prepare("UPDATE subscriptions SET cursor = ? WHERE id = ?").run(cursor, subscription.id);
        }
      }
      this.failures.delete(subscription.id);
    } catch {
      const failures = (this.failures.get(subscription.id) ?? 0) + 1;
      this.failures.set(subscription.id, failures);
      const wait = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      setTimeout(() => this.pump(), wait).unref();
    } finally {
      this.running.delete(subscription.id);
    }
  }

  private async send(subscription: Subscription, entry: Entry) {
    const body = JSON.stringify(format(entry, this.service, subscription.format, this.link(entry)));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (subscription.secret) headers["x-transit-signature"] = sign(subscription.secret, body);
    const response = await this.post(subscription.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Receiver returned ${response.status}`);
  }

  stop() {
    this.stopped = true;
    this.unsubscribe();
  }
}
