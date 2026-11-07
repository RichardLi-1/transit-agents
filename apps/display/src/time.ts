// The display's clock. It is a view parameter only: moving it writes nothing, and
// it never reaches the log.

export const TIME_ZONE = "America/Toronto";

export const DAY_MS = 86_400_000;

// Simulated seconds per real second.
export const SPEEDS = [
  { label: "1×", rate: 1 },
  { label: "1 min/s", rate: 60 },
  { label: "1 h/s", rate: 3600 },
  { label: "1 d/s", rate: 86_400 },
  { label: "1 wk/s", rate: 604_800 },
] as const;

const parts = (ms: number) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

export type Clock = { dayType: 0 | 1 | 2; hour: number; seconds: number };

// Which timetable applies at a moment: weekday, Saturday or Sunday.
export function clockAt(ms: number): Clock {
  const p = parts(ms);
  const seconds = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  const dayType = p.weekday === "Sat" ? 1 : p.weekday === "Sun" ? 2 : 0;
  return { dayType, hour: seconds / 3600, seconds };
}

const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
const spokenFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, dateStyle: "full" });

export const formatDate = (ms: number) => dateFormat.format(ms);
export const formatTime = (ms: number) => timeFormat.format(ms);
export const spokenDate = (ms: number) => spokenFormat.format(ms);

// Noon on a date in Toronto, which is safely the right day in any time zone.
export const dateToMs = (date: string) => Date.parse(`${date}T17:00:00Z`);
