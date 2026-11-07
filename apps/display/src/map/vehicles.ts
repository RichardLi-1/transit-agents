// Places scheduled vehicles along a study's line for any moment in time.
import type { Point } from "./engine.ts";

export type Trip = [pattern: number, start: number, end: number];

export type StudyLine = {
  lines: Point[][];
  schedule: Record<"weekday" | "saturday" | "sunday", Trip[]>;
};

const DAY_KEYS = ["weekday", "saturday", "sunday"] as const;
const DAY_SECONDS = 86_400;

type Measured = { points: Point[]; cumulative: number[]; total: number };

export class ScheduledVehicles {
  private readonly study: StudyLine;
  private readonly measured: Measured[];

  constructor(study: StudyLine) {
    this.study = study;
    this.measured = study.lines.map((points) => {
      const cumulative = [0];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1] as Point;
        const b = points[i] as Point;
        cumulative.push((cumulative[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      return { points, cumulative, total: cumulative.at(-1) ?? 0 };
    });
  }

  private pointAt(pattern: number, fraction: number): Point {
    const line = this.measured[pattern] as Measured;
    const target = fraction * line.total;
    let low = 0;
    let high = line.cumulative.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if ((line.cumulative[middle] as number) <= target) low = middle;
      else high = middle;
    }
    const a = line.points[low] as Point;
    const b = line.points[high] as Point;
    const span = (line.cumulative[high] as number) - (line.cumulative[low] as number) || 1;
    const t = (target - (line.cumulative[low] as number)) / span;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // Each vehicle is x, y, kind. Kind 0 draws as a ring, meaning scheduled.
  at(dayType: number, seconds: number): Float32Array {
    const trips = this.study.schedule[DAY_KEYS[dayType] as (typeof DAY_KEYS)[number]];
    const out: number[] = [];
    for (const [pattern, start, end] of trips) {
      // Trips after midnight are scheduled past 24:00 on the day they began.
      for (const clock of [seconds, seconds + DAY_SECONDS]) {
        if (clock >= start && clock <= end) {
          const [x, y] = this.pointAt(pattern, (clock - start) / (end - start));
          out.push(x, y, 0);
        }
      }
    }
    return new Float32Array(out);
  }
}
