// The open study's agent run, in the chat's header: whether the lead is at work or
// done, for how long, and how many specialists it asked. A screen reader hears only
// that a run started and that it finished, never what's in between.
import { useEffect, useRef, useState } from "preact/hooks";
import { elapsed, runState, type Run, type State } from "../runs.ts";

const WORDS: Record<State, string> = { working: "Working", done: "Done", stopped: "Stopped", stale: "Stale" };

// The time now, each second while something is working, for the elapsed times.
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

// What a screen reader hears: that a run started, and that it finished. Nothing in between.
function useAnnouncement(run: Run | null, study: string): string {
  const [said, setSaid] = useState("");
  const seen = useRef<{ key: string; done: boolean } | null>(null);
  useEffect(() => {
    if (!run) return;
    const key = `${run.studyId}:${run.seq}`;
    const done = Boolean(run.finishedAt);
    const before = seen.current;
    seen.current = { key, done };
    if (!run.live) return;
    if (before?.key !== key) {
      // A new run on this study, or one that has only just started where the focus went.
      const fresh = before?.key.startsWith(`${run.studyId}:`) || run.specialists.length === 0;
      if (!done && fresh) setSaid(`Lead agent started on ${study}.`);
    } else if (done && !before.done) {
      const count = run.specialists.length;
      setSaid(`Lead agent finished on ${study}, with ${count} ${count === 1 ? "specialist" : "specialists"}, in ${elapsed(run.startedAt, run.finishedAt as string)}.`);
    }
  }, [run, study]);
  return said;
}

export function RunLine({ run, study }: { run: Run | null; study: string }) {
  const now = useNow(Boolean(run && !run.finishedAt));
  const announcement = useAnnouncement(run, study);
  const state = run ? runState(run, now) : null;
  // An older run shows only while it still works. One the display saw shows until the next.
  const shown = run && state && (run.live || state === "working") ? run : null;
  const count = shown?.specialists.length ?? 0;
  return (
    <>
      <p class="sr-only" role="status">
        {announcement}
      </p>
      {shown && state && (
        <p class="run-line" data-state={state}>
          <span class="mark" aria-hidden="true" />
          {`${WORDS[state]} · ${elapsed(shown.startedAt, shown.finishedAt ?? now)}${count ? ` · ${count} ${count === 1 ? "specialist" : "specialists"}` : ""}`}
        </p>
      )}
    </>
  );
}
