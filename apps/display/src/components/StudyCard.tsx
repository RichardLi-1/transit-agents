import { useEffect, useRef, useState } from "preact/hooks";
import type { Assumption, CheckView, FigureView, FindingView, StudyView, Timeline } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { recordedBy } from "../actors.ts";
import { amount, citesAPage, otherFigures, trialDays, unitAfter } from "../figures.ts";
import { CheckIcon, CrossIcon, StaleIcon } from "./icons.tsx";

const SYMBOL = { ">=": "≥", ">": ">", "<=": "≤", "<": "<" } as const;
const STATUS_TEXT = { pass: "Passes", fail: "Fails", stale: "Out of date", unverified: "Awaiting a planner" } as const;
const OUTCOME = { adopt: "Adopted", reject: "Not adopted", defer: "Deferred", amend: "Amended" } as const;
const ANALYSIS = { pass: "Passes", fail: "Fails", mixed: "Needs judgement", incomplete: "Incomplete" } as const;

const number = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 1 });
// A true minus sign, so a saving reads as negative at a glance.
const signed = (n: number) => (n < 0 ? `\u2212${number.format(-n)}` : number.format(n));

// The figures a study leads with, as MapView keeps each study's view. Each traces
// to a source page. The Ontario extension's riders aren't among them: until a
// model run there is no forecast, only a precedent, so the card leads with what
// riders do today where the line would run.
const HEADLINES: Record<string, string[]> = {
  "ontario-line-don-mills": ["ext-capital-cost-ob", "ext-run-time", "line4-boardings", "don-mills-usage"],
};
// What the solid and dashed parts of a study's line stand for, where it has both.
const KEYS: Record<string, [solid: string, dashed: string]> = {
  "ontario-line-don-mills": ["Under construction", "Proposed"],
};

// Below this many departures, a percentage says more about chance than service.
const MIN_SAMPLE = 20;
const whole = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 });

function Status({ status }: { status: CheckView["status"] }) {
  return (
    <span class={`status ${status}`}>
      {status === "pass" ? <CheckIcon /> : status === "fail" ? <CrossIcon /> : <StaleIcon />}
      <span class="sr-only">{STATUS_TEXT[status]}</span>
    </span>
  );
}

// Scenario sliders. Moving one previews through the API and records nothing.
function Sliders({ study, onPreview }: { study: StudyView; onPreview: (view: StudyView | null) => void }) {
  const realised = study.figures.flatMap((figure) => {
    if (figure.basis.kind !== "derived") return [];
    return Object.values(figure.basis.inputs).flatMap((input) => ("assumption" in input && input.assumption.endsWith("-realised") ? [input.assumption] : []));
  });
  const keys = [...new Set(realised)];
  const [values, setValues] = useState<Record<string, number>>({});
  const request = useRef(0);

  useEffect(() => {
    setValues({});
    onPreview(null);
  }, [study.id]);

  if (!keys.length) return null;

  const change = async (key: string, value: number) => {
    const next = { ...values, [key]: value };
    setValues(next);
    const id = ++request.current;
    const response = await api(`/v1/studies/${study.id}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assumptions: next }),
    });
    if (response.ok && id === request.current) onPreview((await response.json()) as StudyView);
  };

  return (
    <div class="sliders">
      {keys.map((key) => {
        const value = values[key] ?? 1;
        const name = key.includes("riders") ? "Riders" : "Hours";
        return (
          <label key={key}>
            <span>{name}</span>
            <input
              type="range"
              min="0.1"
              max="1.5"
              step="0.05"
              value={value}
              aria-valuetext={`${Math.round(value * 100)}% of forecast`}
              onInput={(event) => void change(key, Number(event.currentTarget.value))}
            />
            <output>{Math.round(value * 100)}%</output>
          </label>
        );
      })}
    </div>
  );
}

// Measured results to date, and the published forecast as a flat weekly rate. A
// forecast is a claim, not a result, so it is never added up over time or drawn
// like a measurement.
function Results({ timeline, trialStart }: { timeline: Timeline | null; trialStart?: string }) {
  if (!timeline) return null;
  const days = trialDays(timeline.measured.days, trialStart);
  const departures = days.reduce((sum, d) => sum + d.departures, 0);
  const onTime = days.reduce((sum, d) => sum + d.onTimeStandard, 0);
  const scheduled = days.reduce((sum, d) => sum + d.scheduled, 0);
  const riders = timeline.forecast.find((f) => f.figure === "riders");

  return (
    <dl class="results">
      {departures > 0 && (
        <div class="measured">
          <dt>On time, measured</dt>
          <dd>
            {departures >= MIN_SAMPLE ? `${Math.round((onTime / departures) * 100)}%` : "Too few"}
            <span class="note">
              {" "}
              {whole.format(departures)} {departures === 1 ? "trip" : "trips"}
              {scheduled >= departures ? ` of ${whole.format(scheduled)}` : ""}
            </span>
          </dd>
        </div>
      )}
      {riders && (
        <div class="forecast">
          <dt>Riders gained, forecast</dt>
          <dd>
            {whole.format(riders.perWeek)}
            <span class="note"> a week</span>
          </dd>
        </div>
      )}
    </dl>
  );
}

// Whether a scrolling element has more below what shows, so the card can fade
// its bottom edge as a sign that it scrolls.
function useMoreBelow(ref: { current: HTMLElement | null }): boolean {
  const [below, setBelow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => setBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 2);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    const mutations = new MutationObserver(check);
    mutations.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    element.addEventListener("scroll", check, { passive: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
      element.removeEventListener("scroll", check);
    };
  }, [ref]);
  return below;
}

type Props = {
  study: StudyView;
  studies: StudyView[];
  assumptions: Assumption[];
  // The log position the display opened at: figures recorded after it are new.
  since: number | null;
  timeline: Timeline | null;
  onSelect: (id: string) => void;
  onPreview: (view: StudyView | null) => void;
  onFigure: (id: string, element: Element) => void;
  onCitation: (item: CheckView | FindingView, element: Element) => void;
};

export function StudyCard({ study, studies, assumptions, since, timeline, onSelect, onPreview, onFigure, onCitation }: Props) {
  // What a figure's button opens: its pages, or, with none, how it's worked out.
  const opens = (id: string) => (citesAPage(id, study.figures, assumptions) ? ", show source" : ", show working");
  const { decision } = study;
  // Beside any tests, so a test an agent adds never takes the headlines away.
  const headlines = (HEADLINES[study.id] ?? []).flatMap((id) => study.figures.find((f) => f.id === id) ?? []);
  const key = KEYS[study.id];
  const card = useRef<HTMLElement>(null);
  const below = useMoreBelow(card);
  // Every other figure, so all an agent records can be opened here.
  const others = otherFigures(study.figures, [...study.checks.map((check) => check.figure), ...headlines.map((figure) => figure.id)]);
  const count = others.reduce((sum, group) => sum + group.figures.length, 0);
  const fresh = since === null ? 0 : others.reduce((sum, group) => sum + group.figures.filter((figure) => figure.seq > since).length, 0);

  return (
    <section ref={card} class={below ? "card below" : "card"} aria-labelledby="study-heading">
      <h2 id="study-heading" class="sr-only">
        Study
      </h2>
      {studies.length > 1 ? (
        // A select can't wrap, so the title shows as text and the select lies over it.
        <div class="title picker">
          <span aria-hidden="true">{study.title}</span>
          <select aria-label="Study" value={study.id} onChange={(event) => onSelect(event.currentTarget.value)}>
            {studies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p class="title">{study.title}</p>
      )}

      {key && (
        <p class="key">
          <span>
            <span class="swatch" aria-hidden="true" />
            <span class="sr-only">Solid line: </span>
            {key[0]}
          </span>
          <span>
            <span class="swatch dashed" aria-hidden="true" />
            <span class="sr-only">Dashed line: </span>
            {key[1]}
          </span>
        </p>
      )}

      <ul class="checks">
        {study.checks.map((check) => (
          <li key={check.id}>
            <Status status={check.status} />
            <button type="button" class="figure" onClick={(event) => onFigure(check.figure, event.currentTarget)}>
              {signed(check.actual)}
              <span class="sr-only">{opens(check.figure)}</span>
            </button>
            <span class="label">{check.label}</span>
            <span class="rule">
              <span aria-hidden="true">{SYMBOL[check.op]}</span>
              <span class="sr-only">{check.op.startsWith(">") ? "at least" : "under"}</span> {number.format(check.threshold)}
            </span>
          </li>
        ))}
      </ul>

      {headlines.length > 0 && (
        <ul class="headlines">
          {headlines.map((figure) => (
            <li key={figure.id}>
              <button type="button" class="figure" onClick={(event) => onFigure(figure.id, event.currentTarget)}>
                {amount(figure)}
                <span class="sr-only">{opens(figure.id)}</span>
              </button>
              <span class="label">{figure.label}</span>
            </li>
          ))}
        </ul>
      )}

      {/* The hollow rings' meaning, for sighted people. Each finding says it to a screen reader. */}
      {study.findings.some((finding) => finding.tone === "unrated") && (
        <p class="awaiting" aria-hidden="true">
          <span class="dot" />
          Awaiting a planner
        </p>
      )}
      {study.findings.length > 0 && (
        <ul class="findings">
          {study.findings.map((finding) => (
            <li key={finding.id}>
              <button type="button" class={`finding ${finding.tone}`} onClick={(event) => onCitation(finding, event.currentTarget)}>
                <span class="dot" aria-hidden="true" />
                <span class="sr-only">{finding.tone === "unrated" ? "Not yet rated by a planner" : finding.tone}, </span>
                <span>{finding.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {decision && (
        <p class="decision">
          <span>{ANALYSIS[decision.analysis]}</span>
          <span aria-hidden="true">→</span>
          <span class="sr-only">, decision: </span>
          <strong>{OUTCOME[decision.outcome]}</strong>
          {decision.override && <span class="override">Override</span>}
        </p>
      )}

      <Results timeline={timeline} trialStart={study.trial?.startedOn} />
      <Sliders study={study} onPreview={onPreview} />

      {count > 0 && (
        <details class="more">
          <summary>
            {count} more {count === 1 ? "figure" : "figures"}
            {fresh > 0 && <span class="fresh"> · {fresh} new</span>}
          </summary>
          {others.map((group) => (
            <div key={group.by}>
              {others.length > 1 && <p class="by">{recordedBy(group.by)}</p>}
              <ul>
                {group.figures.map((figure) => (
                  <li key={figure.id} class={since !== null && figure.seq > since ? "new" : undefined}>
                    <button type="button" class="figure" onClick={(event) => onFigure(figure.id, event.currentTarget)}>
                      {amount(figure)}
                      <span class="sr-only">{opens(figure.id)}</span>
                    </button>
                    <span class="label">
                      {figure.label}
                      {unitAfter(figure.unit) && <span class="unit">, {unitAfter(figure.unit)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
