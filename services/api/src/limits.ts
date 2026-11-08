// How often visitors may write. Passes are free, so without a limit one script
// could fill the disk the log and the collector share. Each visitor gets a few
// writes a minute and a day, and all visitors together a few thousand a day. The
// counts live in memory, in fixed windows, and start again when the service does.
import { RATE_LIMITED } from "@transit-agents/contracts";
import { ApiError } from "./service.ts";

export type LimitOptions = { perMinute?: number; perDay?: number; allPerDay?: number; clock?: () => Date };

// Days start at midnight in Toronto, as the visitors' budget's do.
const torontoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" });

export class VisitorLimits {
  private readonly perMinute: number;
  private readonly perDay: number;
  private readonly allPerDay: number;
  private readonly clock: () => Date;
  private day = "";
  private all = 0;
  // Each visitor who wrote today: their minute, their writes in it, and today's.
  private readonly counts = new Map<string, { minute: number; inMinute: number; today: number }>();

  constructor({ perMinute = 10, perDay = 200, allPerDay = 10_000, clock = () => new Date() }: LimitOptions = {}) {
    this.perMinute = perMinute;
    this.perDay = perDay;
    this.allPerDay = allPerDay;
    this.clock = clock;
  }

  // Counts one write, or refuses it. A refused write isn't counted.
  take(audience: string): void {
    const now = this.clock();
    const day = torontoDay.format(now);
    if (day !== this.day) {
      // Yesterday's counts are no use, so memory holds at most a day of visitors.
      this.day = day;
      this.all = 0;
      this.counts.clear();
    }
    const minute = Math.floor(now.getTime() / 60_000);
    const count = this.counts.get(audience) ?? { minute, inMinute: 0, today: 0 };
    if (count.minute !== minute) {
      count.minute = minute;
      count.inMinute = 0;
    }
    if (count.inMinute >= this.perMinute || count.today >= this.perDay || this.all >= this.allPerDay) {
      throw new ApiError(429, "rate_limited", RATE_LIMITED);
    }
    count.inMinute += 1;
    count.today += 1;
    this.all += 1;
    this.counts.set(audience, count);
  }
}
