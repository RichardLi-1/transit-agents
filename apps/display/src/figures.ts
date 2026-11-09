import type { Assumption, DayResult, FigureView } from "@transit-agents/contracts";

// Whether a figure traces to at least one source page: it's cited, or one of its
// inputs is, or rests on a rule with a page. A figure worked out only from values
// planners set has no page to show, only its working.
export function citesAPage(id: string, figures: FigureView[], assumptions: Assumption[], seen = new Set<string>()): boolean {
  const figure = figures.find((f) => f.id === id);
  if (!figure || seen.has(id)) return false;
  seen.add(id);
  const { basis } = figure;
  if (basis.kind === "cited") return true;
  // A total from a map layer cites its dataset, which has no pages.
  if (basis.kind === "spatial") return false;
  const inputs = basis.kind === "derived" ? Object.values(basis.inputs) : basis.inputs;
  return inputs.some((input) =>
    "figure" in input ? citesAPage(input.figure, figures, assumptions, seen) : Boolean(assumptions.find((a) => a.key === input.assumption)?.citation),
  );
}

const UNITS: Record<string, string> = { minutes: " min", km: " km", "%": "%" };

// Rounded as a planner would quote it, with a true minus sign, and with its unit
// where the unit reads as part of the number: $4,640 M, 11.5 min, 30%.
export function amount({ value, unit }: { value: number; unit: string }): string {
  const n = new Intl.NumberFormat("en-CA", { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 1 }).format(Math.abs(value));
  const sign = value < 0 ? "\u2212" : "";
  return unit === "$M" ? `${sign}$${n} M` : `${sign}${n}${UNITS[unit] ?? ""}`;
}

// The unit to write after amount(), when amount() doesn't show it already.
export const unitAfter = (unit: string) => (unit === "$M" || unit in UNITS ? "" : unit);

// amount() with any unit it leaves out: 143,846 trips/day.
export const quantity = (value: number, unit: string) => `${amount({ value, unit })} ${unitAfter(unit)}`.trim();

// The figures a card doesn't show already, in tests or headlines, so every figure
// an agent records can be opened on the display. Grouped by who recorded them,
// in the order they were recorded.
export function otherFigures(figures: FigureView[], shown: Iterable<string>): { by: string; figures: FigureView[] }[] {
  const skip = new Set(shown);
  const groups = new Map<string, FigureView[]>();
  for (const figure of [...figures].sort((a, b) => a.seq - b.seq)) {
    if (skip.has(figure.id)) continue;
    groups.set(figure.recordedBy, [...(groups.get(figure.recordedBy) ?? []), figure]);
  }
  return [...groups].map(([by, list]) => ({ by, figures: list }));
}

// A study's measured days that count: on a trial, only the trial's, as the
// trial-monitor skill counts them, so the card and the agent agree.
export const trialDays = (days: DayResult[], startedOn: string | undefined) => (startedOn ? days.filter((day) => day.date >= startedOn) : days);
