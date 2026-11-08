import { useEffect, useMemo, useState } from "preact/hooks";
import type { Timeline } from "@transit-agents/contracts";
import type { Simulator } from "../simulator.ts";
import { dateToMs, DAY_MS, formatDate, formatTime, spokenDate } from "../time.ts";
import { NowIcon, PauseIcon, PlayIcon } from "./icons.tsx";

const STEPS = 1000;
const WEEK_MS = 7 * DAY_MS;

// Trial weeks count from the day a change began, so the axis reads in weeks of
// the trial, and only dates from today on are ever shown.
const weekOf = (ms: number, start: number | null) => (start === null ? null : Math.floor((ms - start) / WEEK_MS) + 1);

// One mark per trial week that has measurements, sized by the on-time share.
// Weeks that haven't happened stay empty.
function Measured({ timeline, first, last, start }: { timeline: Timeline | null; first: number; last: number; start: number | null }) {
  const marks = useMemo(() => {
    if (!timeline || start === null) return [];
    const weeks = new Map<number, { departures: number; onTime: number }>();
    for (const day of timeline.measured.days) {
      const week = weekOf(dateToMs(day.date), start) as number;
      const total = weeks.get(week) ?? { departures: 0, onTime: 0 };
      total.departures += day.departures;
      total.onTime += day.onTimeStandard;
      weeks.set(week, total);
    }
    return [...weeks].flatMap(([week, { departures, onTime }]) => {
      const x = (Math.max(start + (week - 1) * WEEK_MS, first) - first) / (last - first);
      return departures && x <= 1 ? [{ week, x, height: onTime / departures }] : [];
    });
  }, [timeline, first, last, start]);

  return (
    <svg class="marks" viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true">
      {marks.map((mark) => (
        <rect key={mark.week} x={mark.x * 1000} y={24 - mark.height * 24} width="8" height={mark.height * 24} rx="1" />
      ))}
    </svg>
  );
}

type Props = { simulator: Simulator; timeline: Timeline | null; trialStart: string | null };

// Shown only for a study with a trial. Unmounting it also drops the Space shortcut.
export function TimeBar({ simulator, timeline, trialStart }: Props) {
  const [, setTick] = useState(0);
  const [ms, setMs] = useState(simulator.now);

  useEffect(() => simulator.subscribeState(() => setTick((n) => n + 1)), [simulator]);

  useEffect(() => {
    let frame = 0;
    return simulator.subscribe((now) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setMs(now);
      });
    });
  }, [simulator]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        simulator.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [simulator]);

  const { first, last, playing, speed, live } = simulator;
  const span = last - first || 1;
  const position = Math.round(((ms - first) / span) * STEPS);
  const start = trialStart ? dateToMs(trialStart) - DAY_MS / 2 : null;
  const week = weekOf(ms, start);
  const atReview = ms >= last && trialStart !== null;
  const spoken = `${spokenDate(ms)}${week ? `, trial week ${week}` : ""}`;

  return (
    <section class="time" aria-label="Time">
      <button type="button" class="round" aria-label={playing ? "Pause" : "Play"} onClick={() => simulator.toggle()}>
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button type="button" class="speed" aria-label={`Speed ${speed.label}, change`} onClick={() => simulator.cycleSpeed()}>
        {speed.label}
      </button>
      <button type="button" class="round" aria-label="Back to now" disabled={live} onClick={() => simulator.backToNow()}>
        <NowIcon />
      </button>
      <div class="track">
        <Measured timeline={timeline} first={first} last={last} start={start} />
        <input
          type="range"
          min="0"
          max={STEPS}
          value={position}
          aria-label="Date"
          aria-valuetext={spoken}
          onInput={(event) => {
            simulator.pause();
            simulator.seek(first + (Number(event.currentTarget.value) / STEPS) * span);
          }}
        />
        <p class="legend" aria-hidden="true">
          <span class="dot live" />
          Live
          <span class="dot scheduled" />
          Scheduled
        </p>
      </div>
      <p class="when">
        <span>{atReview ? "Review" : week ? `Week ${week}` : formatDate(ms)}</span>
        <span class="clock">{week || atReview ? formatDate(ms) : ""}</span>
        <span class="clock">{live ? "Live" : formatTime(ms)}</span>
      </p>
    </section>
  );
}
