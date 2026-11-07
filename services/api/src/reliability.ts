// Measures on-time departures from live vehicle positions, with no agency data.
//
// A departure is seen when a vehicle on a trip moves off its first stop between
// two readings. Vehicles often report their next trip early, so a single reading
// proves nothing: only an in-order move from the first stop counts.

export type Observation = {
  vehicle: string;
  trip: string;
  route: string;
  sequence: number;
  at: number;
};

export type ScheduledTrip = {
  route: string;
  pattern: string;
  firstSequence: number;
  departure: number;
  // 1 weekday, 2 Saturday, 4 Sunday.
  days: number;
};

export type Departure = {
  trip: string;
  route: string;
  pattern: string;
  date: string;
  scheduled: number;
  actual: number;
  deviation: number;
};

// Readings further apart than this can't place a departure accurately.
const MAX_GAP_SECONDS = 90;

// A larger gap means the trip was reassigned, not that it ran hours late.
const MAX_DEVIATION_SECONDS = 2 * 3600;

const DAY = 86400;

export type Window = { early: number; late: number };

export const WINDOWS = {
  // TTC Service Standards, May 2024: one minute early to five minutes late.
  standard: { early: -60, late: 300 } satisfies Window,
  // TTC KPI reporting since February 2025: on time to five minutes late.
  reported: { early: 0, late: 300 } satisfies Window,
};

export const isOnTime = (deviation: number, window: Window) => deviation >= window.early && deviation <= window.late;

// Toronto's date and seconds past midnight for a moment in time.
export function localClock(epochSeconds: number): { date: string; seconds: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    seconds: Number(get("hour")) * 3600 + Number(get("minute")) * 60 + Number(get("second")),
  };
}

// GTFS times run past 24:00 for trips after midnight, so the same scheduled time
// could belong to today or yesterday. The closer one is the real one.
export function deviationFrom(scheduled: number, clockSeconds: number): number {
  const options = [clockSeconds - scheduled, clockSeconds + DAY - scheduled];
  return options.reduce((best, next) => (Math.abs(next) < Math.abs(best) ? next : best));
}

export class DepartureTracker {
  private readonly schedule: (trip: string) => ScheduledTrip | undefined;
  private readonly last = new Map<string, Observation>();
  private readonly counted = new Set<string>();

  constructor(schedule: (trip: string) => ScheduledTrip | undefined) {
    this.schedule = schedule;
  }

  observe(observation: Observation): Departure | undefined {
    const previous = this.last.get(observation.vehicle);
    if (previous && observation.at < previous.at) return undefined;
    this.last.set(observation.vehicle, observation);
    if (!previous || previous.trip !== observation.trip) return undefined;

    const trip = this.schedule(observation.trip);
    if (!trip) return undefined;
    if (previous.sequence !== trip.firstSequence || observation.sequence <= trip.firstSequence) return undefined;

    const gap = observation.at - previous.at;
    if (gap <= 0 || gap > MAX_GAP_SECONDS) return undefined;

    const actual = Math.round((previous.at + observation.at) / 2);
    const { date, seconds } = localClock(actual);
    const key = `${observation.trip}|${date}`;
    if (this.counted.has(key)) return undefined;

    const deviation = deviationFrom(trip.departure, seconds);
    if (Math.abs(deviation) > MAX_DEVIATION_SECONDS) return undefined;

    this.counted.add(key);
    return {
      trip: observation.trip,
      route: trip.route,
      pattern: trip.pattern,
      date,
      scheduled: trip.departure,
      actual,
      deviation,
    };
  }
}

export type DaySummary = {
  date: string;
  departures: number;
  onTimeStandard: number;
  onTimeReported: number;
  // Trips the timetable planned. Departures below this include cancellations and
  // trips the feed missed, which on-time rates alone would hide.
  scheduled: number;
};

const dayMask = (date: string) => {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 4 : day === 6 ? 2 : 1;
};

// How many trips of these patterns were due to leave by a time on a date.
export function scheduledCount(trips: Iterable<ScheduledTrip>, patterns: Set<string> | null, date: string, until = Infinity): number {
  const mask = dayMask(date);
  let count = 0;
  for (const trip of trips) {
    if ((trip.days & mask) && trip.departure <= until && (!patterns || patterns.has(trip.pattern))) count++;
  }
  return count;
}

export function summarize(
  departures: Pick<Departure, "date" | "deviation">[],
  scheduled: (date: string) => number = () => 0,
): DaySummary[] {
  const days = new Map<string, DaySummary>();
  for (const { date, deviation } of departures) {
    const day = days.get(date) ?? { date, departures: 0, onTimeStandard: 0, onTimeReported: 0, scheduled: scheduled(date) };
    day.departures += 1;
    if (isOnTime(deviation, WINDOWS.standard)) day.onTimeStandard += 1;
    if (isOnTime(deviation, WINDOWS.reported)) day.onTimeReported += 1;
    days.set(date, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
