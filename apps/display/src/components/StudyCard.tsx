import { useEffect, useRef, useState } from "preact/hooks";
import type { Assumption, CheckView, FigureView, FindingView, Outcome, StudyView, Timeline } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { recordedBy } from "../actors.ts";
import { amount, citesAPage, otherFigures, trialDays, unitAfter } from "../figures.ts";
import { gap } from "../gap.ts";
import { refusal, setNotice } from "../notice.ts";
import { canDecide, signIn, type Session } from "../session.ts";
import { CheckIcon, CrossIcon, StaleIcon } from "./icons.tsx";
import { studyColor } from "../map/views.ts";

const SYMBOL = { ">=": "≥", ">": ">", "<=": "≤", "<": "<" } as const;
const STATUS_TEXT = { pass: "Passes", fail: "Fails", stale: "Out of date", unverified: "Awaiting a planner" } as const;
const OUTCOME = { adopt: "Adopted", reject: "Not adopted", defer: "Deferred", amend: "Amended" } as const;
const DECIDE: Record<Outcome, string> = { adopt: "Adopt", reject: "Reject", defer: "Defer", amend: "Amend" };
const ANALYSIS = { pass: "Passes", fail: "Fails", mixed: "Needs judgement", incomplete: "Incomplete" } as const;

const number = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 1 });
// A true minus sign, so a saving reads as negative at a glance.
const signed = (n: number) => (n < 0 ? `\u2212${number.format(-n)}` : number.format(n));

// The figures a study leads with, as MapView keeps each study's view. Each traces
// to a source page. The Ontario extension's riders aren't among them: until a
// model run there is no forecast, only a precedent, so the card leads with what
// riders do today where the line would run. Each has a caption in plain words:
// its full label is in its source view, and in its button's name.
const HEADLINES: Record<string, { figure: string; caption: string }[]> = {
  "ontario-line-don-mills": [
    { figure: "ext-capital-cost-ob", caption: "Cost to build (2019 dollars)" },
    { figure: "ext-run-time", caption: "Ride time on the extension" },
    { figure: "line4-boardings", caption: "Line 4 riders a weekday" },
    { figure: "don-mills-usage", caption: "Don Mills Station riders a weekday" },
  ],
};
// What the solid and dashed parts of a study's line stand for, where it has both.
const KEYS: Record<string, [solid: string, dashed: string]> = {
  "ontario-line-don-mills": ["Under construction", "Proposed"],
};

// Below this many departures, a percentage says more about chance than service.
const MIN_SAMPLE = 20;
const whole = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 });

// A test awaiting a planner is a hollow ring, as a note awaiting one is.
function Status({ status }: { status: CheckView["status"] }) {
  return (
    <span class={`status ${status}`}>
      {status === "pass" ? <CheckIcon /> : status === "fail" ? <CrossIcon /> : status === "stale" ? <StaleIcon /> : null}
      <span class="sr-only">{STATUS_TEXT[status]}</span>
    </span>
  );
}

// No break between them: a label and its first word, or a word and the dot after it.
const NBSP = "\u00a0";

// A note, which opens its page. A gap shows what's missing, then the next step
// and who to contact on a smaller line, which wraps at the dot between them. A
// screen reader hears each as a sentence, without the dot.
function Note({ finding, onCitation }: { finding: FindingView; onCitation: (item: FindingView, element: Element) => void }) {
  const parts = gap(finding.text);
  return (
    <li>
      <button type="button" class={`finding ${finding.tone}`} data-finding={finding.id} onClick={(event) => onCitation(finding, event.currentTarget)}>
        <span class="dot" aria-hidden="true" />
        <span class="sr-only">{finding.tone === "unrated" ? "Not yet rated by a planner" : finding.tone}, </span>
        {parts ? (
          <>
            <span class="gap">{parts.missing}</span>{" "}
            <span class="next">
              {`Next:${NBSP}${parts.next}`}
              <span class="sr-only">.</span>
              <span aria-hidden="true">{`${NBSP}·`}</span> {`Contact:${NBSP}${parts.contact}`}
            </span>
          </>
        ) : (
          <span>{finding.text}</span>
        )}
      </button>
    </li>
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

// The decision shows once the log has it, in place of the form.
function DecisionForm({ studyId, decidedBy }: { studyId: string; decidedBy: string }) {
  const [outcome, setOutcome] = useState<Outcome>("adopt");
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);

  const record = async (event: Event) => {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    const response = await api(`/v1/studies/${studyId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome, reason: reason.trim(), decidedBy }),
    }).catch(() => undefined);
    setSending(false);
    setNotice(response?.ok ? null : await refusal(response));
  };

  return (
    <form class="decide" onSubmit={record}>
      <select aria-label="Decision" value={outcome} onChange={(event) => setOutcome(event.currentTarget.value as Outcome)}>
        {Object.entries(DECIDE).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <input
        type="text"
        aria-label="Reason"
        placeholder="Reason"
        autocomplete="off"
        required
        minLength={3}
        maxLength={1000}
        value={reason}
        onInput={(event) => setReason(event.currentTarget.value)}
      />
      <button type="submit" aria-disabled={sending}>
        Record
      </button>
    </form>
  );
}

// Only a planner decides. Anyone else not signed in is offered the way to.
function Decide({ studyId, session }: { studyId: string; session: Session | null }) {
  const me = session?.me ?? null;
  if (me && canDecide(me)) return <DecisionForm key={studyId} studyId={studyId} decidedBy={me.name} />;
  const tenant = session?.anonymous ? session.config?.signIn : null;
  if (!tenant) return null;
  return (
    <button type="button" class="sign-in" onClick={() => void signIn(tenant)}>
      Sign in to decide
    </button>
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
  session: Session | null;
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

// How many figures the card leads with. Everything else is under Details.
const LEADS = 2;

// A test: its figure, which opens its working, against its rule.
function Check({ check, opens, onFigure }: { check: CheckView; opens: string; onFigure: Props["onFigure"] }) {
  return (
    <li>
      <Status status={check.status} />
      <button type="button" class="figure" data-figure={check.figure} onClick={(event) => onFigure(check.figure, event.currentTarget)}>
        {signed(check.actual)}
        <span class="sr-only">{opens}</span>
      </button>
      <span class="label">{check.label}</span>
      <span class="rule">
        <span aria-hidden="true">{SYMBOL[check.op]}</span>
        <span class="sr-only">{check.op.startsWith(">") ? "at least" : "under"}</span> {number.format(check.threshold)}
      </span>
    </li>
  );
}

// One of the study's other figures, under Details.
function Other({ figure, fresh, opens, onFigure }: { figure: FigureView; fresh: boolean; opens: string; onFigure: Props["onFigure"] }) {
  return (
    <li class={fresh ? "new" : undefined}>
      <button type="button" class="figure" data-figure={figure.id} onClick={(event) => onFigure(figure.id, event.currentTarget)}>
        {amount(figure)}
        <span class="sr-only">{opens}</span>
      </button>
      <span class="label">
        {figure.label}
        {unitAfter(figure.unit) && <span class="unit">, {unitAfter(figure.unit)}</span>}
      </span>
    </li>
  );
}

export function StudyCard({ study, session, studies, assumptions, since, timeline, onSelect, onPreview, onFigure, onCitation }: Props) {
  // What a figure's button opens: its pages, or, with none, how it's worked out.
  const opens = (id: string) => (citesAPage(id, study.figures, assumptions) ? ", show source" : ", show working");
  const { decision } = study;
  const all = (HEADLINES[study.id] ?? []).flatMap(({ figure: id, caption }) => {
    const figure = study.figures.find((f) => f.id === id);
    return figure ? [{ figure, caption }] : [];
  });
  // The card leads with two figures: a study's chosen headlines, or else its first tests.
  const headlines = all.slice(0, LEADS);
  const checks = headlines.length ? [] : study.checks.slice(0, LEADS);
  const foldedChecks = study.checks.filter((check) => !checks.includes(check));
  const key = KEYS[study.id];
  const card = useRef<HTMLElement>(null);
  const below = useMoreBelow(card);
  // Every other figure, so all an agent records can be opened here.
  const others = otherFigures(study.figures, [...study.checks.map((check) => check.figure), ...headlines.map(({ figure }) => figure.id)]);
  const awaiting = study.findings.some((finding) => finding.tone === "unrated") || study.checks.some((check) => check.status === "unverified");
  const passed = study.checks.filter((check) => check.status === "pass").length;
  const status = awaiting ? "Awaiting a planner" : study.checks.length ? `${passed} of ${study.checks.length} tests pass` : null;
  const isFresh = (figure: FigureView) => since !== null && figure.seq > since;
  const fresh = others.reduce((sum, group) => sum + group.figures.filter(isFresh).length, 0);
  const details = foldedChecks.length + study.findings.length + others.length + (key ? 1 : 0);

  return (
    <section ref={card} class={below ? "card below" : "card"} data-study={study.id} aria-labelledby="study-heading">
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

      {checks.length > 0 && (
        <ul class="checks">
          {checks.map((check) => (
            <Check key={check.id} check={check} opens={opens(check.figure)} onFigure={onFigure} />
          ))}
        </ul>
      )}

      {headlines.length > 0 && (
        <ul class="headlines">
          {headlines.map(({ figure, caption }) => (
            <li key={figure.id}>
              <button type="button" class="figure" data-figure={figure.id} onClick={(event) => onFigure(figure.id, event.currentTarget)}>
                {amount(figure)}
                <span class="sr-only">{`, ${figure.label}${opens(figure.id)}`}</span>
              </button>
              {/* The button's name says the full label, so the caption isn't read twice. */}
              <span class="label" aria-hidden="true">
                {caption}
              </span>
            </li>
          ))}
        </ul>
      )}

      {decision ? (
        <p class="decision">
          <span>{ANALYSIS[decision.analysis]}</span>
          <span aria-hidden="true">→</span>
          <span class="sr-only">, decision: </span>
          <strong>{OUTCOME[decision.outcome]}</strong>
          {decision.override && <span class="override">Override</span>}
        </p>
      ) : (
        <>
          {status && (
            <p class={awaiting ? "awaiting" : "awaiting passed"}>
              <span class="dot" aria-hidden="true" />
              {status}
            </p>
          )}
          <Decide studyId={study.id} session={session} />
        </>
      )}

      <Results timeline={timeline} trialStart={study.trial?.startedOn} />

      {details > 0 && (
        <details class="details">
          <summary>
            Details
            {fresh > 0 && <span class="fresh"> · {fresh} new</span>}
          </summary>
          <div class="details-body">
            {key && (
              <p class="key" style={{ "--line": `#${studyColor(study.line)}` }}>
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
            {foldedChecks.length > 0 && (
              <ul class="checks">
                {foldedChecks.map((check) => (
                  <Check key={check.id} check={check} opens={opens(check.figure)} onFigure={onFigure} />
                ))}
              </ul>
            )}
            {study.findings.length > 0 && (
              <ul class="findings">
                {study.findings.map((finding) => (
                  <Note key={finding.id} finding={finding} onCitation={onCitation} />
                ))}
              </ul>
            )}
            {others.length > 0 && (
              <div class="more">
                {others.map((group) => (
                  <div key={group.by}>
                    {others.length > 1 && <p class="by">{recordedBy(group.by)}</p>}
                    <ul>
                      {group.figures.map((figure) => (
                        <Other key={figure.id} figure={figure} fresh={isFresh(figure)} opens={opens(figure.id)} onFigure={onFigure} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <Sliders study={study} onPreview={onPreview} />
          </div>
        </details>
      )}
    </section>
  );
}
