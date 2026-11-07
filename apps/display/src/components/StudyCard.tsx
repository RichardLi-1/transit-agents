import { useEffect, useRef, useState } from "preact/hooks";
import type { CheckView, FindingView, StudyView, Timeline } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { CheckIcon, CrossIcon, StaleIcon } from "./icons.tsx";

const SYMBOL = { ">=": "≥", ">": ">", "<=": "≤", "<": "<" } as const;
const STATUS_TEXT = { pass: "Passes", fail: "Fails", stale: "Out of date", unverified: "Awaiting a planner" } as const;
const OUTCOME = { adopt: "Adopted", reject: "Not adopted", defer: "Deferred", amend: "Amended" } as const;
const ANALYSIS = { pass: "Passes", fail: "Fails", mixed: "Needs judgement", incomplete: "Incomplete" } as const;

const number = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 1 });
// A true minus sign, so a saving reads as negative at a glance.
const signed = (n: number) => (n < 0 ? `\u2212${number.format(-n)}` : number.format(n));

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
function Results({ timeline }: { timeline: Timeline | null }) {
  if (!timeline) return null;
  const days = timeline.measured.days;
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

type Props = {
  study: StudyView;
  studies: StudyView[];
  timeline: Timeline | null;
  onSelect: (id: string) => void;
  onPreview: (view: StudyView | null) => void;
  onFigure: (id: string, element: Element) => void;
  onCitation: (item: CheckView | FindingView, element: Element) => void;
};

export function StudyCard({ study, studies, timeline, onSelect, onPreview, onFigure, onCitation }: Props) {
  const { decision } = study;

  return (
    <section class="card" aria-labelledby="study-heading">
      <h2 id="study-heading" class="sr-only">
        Study
      </h2>
      {studies.length > 1 ? (
        <select class="title" aria-label="Study" value={study.id} onChange={(event) => onSelect(event.currentTarget.value)}>
          {studies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      ) : (
        <p class="title">{study.title}</p>
      )}

      <ul class="checks">
        {study.checks.map((check) => (
          <li key={check.id}>
            <Status status={check.status} />
            <button type="button" class="figure" onClick={(event) => onFigure(check.figure, event.currentTarget)}>
              {signed(check.actual)}
              <span class="sr-only">, show source</span>
            </button>
            <span class="label">{check.label}</span>
            <span class="rule">
              <span aria-hidden="true">{SYMBOL[check.op]}</span>
              <span class="sr-only">{check.op.startsWith(">") ? "at least" : "under"}</span> {number.format(check.threshold)}
            </span>
          </li>
        ))}
      </ul>

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

      <Results timeline={timeline} />
      <Sliders study={study} onPreview={onPreview} />
    </section>
  );
}
