// The agents panel: while a run works on the open study, the lead and each
// specialist it asked, with its skill, its question, what it is doing now and for
// how long, and what the run has spent. It folds to a pill once the run is done.
// It never takes focus, and says only that a run started and finished.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Context } from "@transit-agents/contracts";
import { spentUsd } from "../money.ts";
import { elapsed, runState, said, specialistState, type Run, type State } from "../runs.ts";
import { CheckIcon, StaleIcon } from "./icons.tsx";

const number = new Intl.NumberFormat("en-CA");
const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const WORDS: Record<State, string> = { working: "Working", done: "Done", stopped: "Stopped", stale: "Stale" };

type Props = {
  run: Run | null;
  contexts: Context[];
  study: string;
};

// The time now, each second while something is working, for the elapsed times.
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

// The state's icon. Its word is said with it, unless the text beside it says it.
function Mark({ state, said = false }: { state: State; said?: boolean }) {
  return (
    <span class="mark" data-state={state}>
      {state === "done" ? <CheckIcon /> : state === "working" ? null : <StaleIcon />}
      {!said && <span class="sr-only">{WORDS[state]}: </span>}
    </span>
  );
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

export function Agents({ run, contexts, study }: Props) {
  const now = useNow(Boolean(run && !run.finishedAt));
  const state = run ? runState(run, now) : null;
  // An older run shows only while it still works. One the display saw shows until the next.
  const shown = run && (run.live || state === "working") ? run : null;
  const [open, setOpen] = useState(true);
  const announcement = useAnnouncement(run, study);
  // Where focus goes once the panel folds or opens, if it was in what went away.
  const pill = useRef<HTMLButtonElement>(null);
  const fold = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);

  // Open for each new run, and folded once it's done.
  const key = shown ? `${shown.studyId}:${shown.seq}` : "";
  const done = Boolean(shown?.finishedAt);
  useEffect(() => {
    moveFocus.current = Boolean(document.activeElement?.closest(".agents"));
    setOpen(!done);
  }, [key, done]);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (open ? fold : pill).current?.focus();
  }, [open]);
  const toggle = (next: boolean) => {
    moveFocus.current = true;
    setOpen(next);
  };

  const live = (
    <p class="sr-only" role="status">
      {announcement}
    </p>
  );
  if (!shown || !state) return live;

  const time = elapsed(shown.startedAt, shown.finishedAt ?? now);
  const spent = spentUsd({ inputTokens: 0, outputTokens: 0, computeSeconds: 0, calls: shown.calls, costUsd: shown.costUsd, unpricedCalls: shown.unpricedCalls });
  const count = shown.specialists.length;
  const lead = said(shown.doing, contexts);

  if (!open) {
    return (
      <>
        {live}
        <button type="button" class="agents pill" data-state={state} aria-expanded="false" ref={pill} onClick={() => toggle(true)}>
          <Mark state={state} said />
          <span>{`Lead agent · ${WORDS[state]}`}</span>
          <span class="elapsed">{`· ${count} ${count === 1 ? "specialist" : "specialists"} · ${time}`}</span>
        </button>
      </>
    );
  }

  return (
    <>
      {live}
      <section id="agents-panel" class="agents panel" data-state={state} aria-labelledby="agents-heading">
        <header class="lead">
          <Mark state={state} />
          <div class="words">
            <h2 id="agents-heading">Lead agent</h2>
            <p class="doing">{lead ?? (state === "working" ? (count ? `Asked ${count} ${count === 1 ? "specialist" : "specialists"}` : "Planning") : WORDS[state])}</p>
          </div>
          <span class="elapsed">{time}</span>
          <button type="button" class="fold" aria-expanded="true" aria-controls="agents-panel" aria-label="Fold agents panel" ref={fold} onClick={() => toggle(false)}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M6 9.500l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </header>
        {count > 0 && (
          <ul class="specialists" aria-label="Specialists">
            {shown.specialists.map((specialist) => {
              const mine = specialistState(specialist, shown, now);
              const doing = mine === "working" ? said(specialist.doing, contexts) ?? "Starting" : WORDS[mine];
              return (
                <li key={specialist.id} data-state={mine}>
                  <Mark state={mine} />
                  <div class="words">
                    <p class="question" title={specialist.question}>
                      {specialist.question}
                    </p>
                    <p class="doing">
                      {specialist.skill && (
                        <span class="skill">
                          <span class="sr-only">Skill </span>
                          {specialist.skill}
                        </span>
                      )}
                      {doing}
                    </p>
                  </div>
                  <span class="elapsed">
                    {elapsed(specialist.startedAt, specialist.finishedAt ?? now)}
                    {specialist.tokens > 0 && <span class="tokens">{`${number.format(specialist.tokens)} tokens`}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {shown.calls > 0 && <p class="spent">{`${number.format(shown.tokens)} tokens${spent !== null ? ` · ${money.format(spent)}` : ""}`}</p>}
      </section>
    </>
  );
}
