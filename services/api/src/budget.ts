// What visitors' agents have spent on Gemini today, and what is left. It adds up
// the usage the agents already report for each model call made for a visitor, by
// the day in Toronto. The shared record's usage, and so planners', never counts.
//
// New visitor work stops a margin short of the cap, so work already running ends
// under it, and no one visitor gets more than a share of the day.
import { BUDGET_SPENT, type VisitorBudget as BudgetView } from "@transit-agents/contracts";
import type { Entry } from "./log.ts";
import { ApiError } from "./service.ts";

// What a call reported without a cost counts as, above any Gemini model's price.
const UNPRICED_USD_PER_TOKEN = 20 / 1_000_000;

const torontoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" });
const dayOf = (date: Date) => torontoDay.format(date);

export type BudgetOptions = { capUsd?: number; marginUsd?: number; shareUsd?: number; clock?: () => Date };

type Spent = { total: number; byAudience: Map<string, number> };

export class VisitorBudget {
  readonly capUsd: number;
  readonly marginUsd: number;
  readonly shareUsd: number;
  private readonly clock: () => Date;
  // By Toronto day. Days before today are dropped.
  private readonly days = new Map<string, Spent>();

  constructor({ capUsd = 10, marginUsd = 2, shareUsd = 1, clock = () => new Date() }: BudgetOptions = {}) {
    this.capUsd = capUsd;
    this.marginUsd = marginUsd;
    this.shareUsd = shareUsd;
    this.clock = clock;
  }

  // Counts a model call an agent reported for a visitor. Anything else is ignored.
  observe(entry: Pick<Entry, "type" | "actor" | "at" | "data" | "audience">) {
    const data = (entry.data ?? {}) as { kind?: string; inputTokens?: number; outputTokens?: number; costUsd?: number };
    if (entry.type !== "activity" || data.kind !== "usage" || !entry.audience || !entry.actor.startsWith("agent:")) return;
    const cost = data.costUsd ?? ((data.inputTokens ?? 0) + (data.outputTokens ?? 0)) * UNPRICED_USD_PER_TOKEN;
    const day = dayOf(new Date(entry.at));
    if (day < this.today()) return;
    const spent = this.days.get(day) ?? { total: 0, byAudience: new Map() };
    spent.total += cost;
    spent.byAudience.set(entry.audience, (spent.byAudience.get(entry.audience) ?? 0) + cost);
    this.days.set(day, spent);
  }

  // What this visitor may still spend today. Below zero once it is overspent.
  left(audience: string): number {
    const spent = this.days.get(this.today());
    return Math.min(
      this.capUsd - this.marginUsd - (spent?.total ?? 0),
      this.shareUsd - (spent?.byAudience.get(audience) ?? 0),
    );
  }

  // Refuses new work that would cost more than is left.
  require(audience: string, usd: number) {
    if (this.left(audience) < usd) throw new ApiError(429, "budget_spent", BUDGET_SPENT);
  }

  view(audience: string | null): BudgetView {
    if (audience === null) return { capped: false };
    return { capped: true, capUsd: this.capUsd, leftUsd: Math.max(0, this.left(audience)) };
  }

  private today(): string {
    const today = dayOf(this.clock());
    for (const day of this.days.keys()) if (day < today) this.days.delete(day);
    return today;
  }
}
