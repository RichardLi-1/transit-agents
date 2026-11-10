// The study, as a page of its own: the figures it leads with and the decision,
// then the first of what isn't known yet, and its tests, notes and every figure
// with where it comes from folded away, each a click from open. Each number and
// note opens its source.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Assumption, CheckView, Context, FigureView, FindingView, Outcome, StudyView, Timeline } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { recordedBy } from "../actors.ts";
import { amount, citesAPage, otherFigures, trialDays, unitAfter } from "../figures.ts";
import { gap } from "../gap.ts";
import { refusal, setNotice } from "../notice.ts";
import type { Layer } from "../map/layers.ts";
import { shortName } from "../runs.ts";
import { spatialLayer } from "../spatial.ts";
import { canDecide, signIn, type Session } from "../session.ts";
import { CheckIcon, CrossIcon, StaleIcon } from "./icons.tsx";

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

type Props = {
  study: StudyView;
  session: Session | null;
  assumptions: Assumption[];
  contexts: Context[];
  // The log position the display opened at: figures recorded after it are new.
  since: number | null;
  timeline: Timeline | null;
  onPreview: (view: StudyView | null) => void;
  onFigure: (id: string, element: Element) => void;
  onCitation: (item: CheckView | FindingView, element: Element) => void;
  // Opens the map on a layer.
  onLayer: (id: string) => void;
};

// A test: its status, its figure, which opens its working, against its rule, and the rule's page.
function Check({ check, opens, onFigure, onCitation }: { check: CheckView; opens: string; onFigure: Props["onFigure"]; onCitation: Props["onCitation"] }) {
  return (
    <tr>
      <td>
        <Status status={check.status} />
      </td>
      <th scope="row">{check.label}</th>
      <td class="num">
        <button type="button" class="figure" data-figure={check.figure} onClick={(event) => onFigure(check.figure, event.currentTarget)}>
          {signed(check.actual)}
          <span class="sr-only">{opens}</span>
        </button>
      </td>
      <td class="num rule">
        <span aria-hidden="true">{SYMBOL[check.op]}</span>
        <span class="sr-only">{check.op.startsWith(">") ? "at least" : "under"}</span> {number.format(check.threshold)}
      </td>
      <td>
        {check.rule && (
          <button type="button" class="cite-page" onClick={(event) => onCitation(check, event.currentTarget)}>
            p. {check.rule.page}
            <span class="sr-only">, the rule's page</span>
          </button>
        )}
      </td>
    </tr>
  );
}

type Summary = Pick<Layer, "id" | "title" | "dataset">;

// Each layer's summary, for the figures measured on it, so they cite its dataset.
function useLayerSummaries(studyId: string, ids: string[]): Record<string, Summary> {
  const [found, setFound] = useState<Record<string, Summary>>({});
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    void Promise.all(
      key.split(",").map(async (id) => {
        const response = await api(`/v1/studies/${encodeURIComponent(studyId)}/layers/${encodeURIComponent(id)}`).catch(() => undefined);
        const body = response?.ok ? ((await response.json().catch(() => null)) as (Summary & { layer?: Summary }) | null) : null;
        const layer = body?.layer ?? body;
        return [id, layer && typeof layer.title === "string" ? layer : { id, title: id }] as const;
      }),
    ).then((pairs) => live && setFound(Object.fromEntries(pairs)));
    return () => {
      live = false;
    };
  }, [studyId, key]);
  return found;
}

const retrievedOn = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

// A figure measured on a map layer cites the layer's data: who published it, under
// what licence, where, and when it was retrieved. Its name opens the layer on the map.
function SpatialSource({ figure, layer, onLayer }: { figure: FigureView; layer: Summary | undefined; onLayer: (id: string) => void }) {
  const id = spatialLayer(figure) as string;
  const dataset = layer?.dataset;
  const retrieved = dataset?.retrieved && !Number.isNaN(Date.parse(dataset.retrieved)) ? retrievedOn.format(Date.parse(dataset.retrieved)) : dataset?.retrieved;
  return (
    <span class="spatial">
      <button type="button" class="cite-page" data-figure={figure.id} onClick={() => onLayer(id)}>
        {layer?.title ?? id}
        <span class="sr-only">{`, ${figure.label}, show on the map`}</span>
      </button>
      {dataset && (
        <span class="dataset">
          {[dataset.publisher, dataset.licence, retrieved && `retrieved ${retrieved}`].filter(Boolean).join(" · ")}{" "}
          {dataset.url && (
            <a href={dataset.url} target="_blank" rel="noopener noreferrer">
              Data<span class="sr-only">: {dataset.title}</span>
            </a>
          )}
        </span>
      )}
    </span>
  );
}

// Where a figure comes from, in a few words: a source and its page, or its working.
function basisOf(figure: FigureView, contexts: Context[]): string {
  const { basis } = figure;
  if (basis.kind === "cited") return `${shortName(basis.citation.contextId, contexts)} p. ${basis.citation.page}`;
  return basis.kind === "derived" ? "Worked out" : "Computed";
}

// A part of the page, under its heading.
function Part({ id, title, children, kind }: { id: string; title: string; children: ComponentChildren; kind?: string }) {
  return (
    <section class={kind ? `part ${kind}` : "part"} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

// A part folded away under its heading and how many it holds, opened at a click.
function Fold({ id, title, count, extra, children }: { id: string; title: string; count: number; extra?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="part fold" aria-labelledby={id}>
      <details>
        <summary>
          <h2 id={id}>
            {title} <span class="n">({count})</span>
            {extra}
          </h2>
        </summary>
        <div class="fold-body">{children}</div>
      </details>
    </section>
  );
}

// What isn't known yet shows its first few; the rest are a click away.
const FIRST_GAPS = 2;

function Gaps({ gaps, onCitation }: { gaps: FindingView[]; onCitation: Props["onCitation"] }) {
  const [all, setAll] = useState(false);
  const rest = gaps.slice(FIRST_GAPS);
  return (
    <>
      <ul class="findings">
        {gaps.slice(0, FIRST_GAPS).map((finding) => (
          <Note key={finding.id} finding={finding} onCitation={onCitation} />
        ))}
      </ul>
      {rest.length > 0 && (
        <>
          <ul id="gaps-more" class="findings" data-more hidden={!all}>
            {rest.map((finding) => (
              <Note key={finding.id} finding={finding} onCitation={onCitation} />
            ))}
          </ul>
          <button type="button" class="show-all" aria-expanded={all} aria-controls="gaps-more" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all (${gaps.length})`}
          </button>
        </>
      )}
    </>
  );
}

const day = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric" });
// Who recorded a figure, in a word or two: "lead", "scripted replay", "planner ana".
const by = (actor: string) => recordedBy(actor).replace(/^(Recorded|Set) by (the )?/, "");

export function StudyPage({ study, session, assumptions, contexts, since, timeline, onPreview, onFigure, onCitation, onLayer }: Props) {
  const { decision } = study;
  const headlines = (HEADLINES[study.id] ?? []).flatMap(({ figure: id, caption }) => {
    const figure = study.figures.find((f) => f.id === id);
    return figure ? [{ figure, caption }] : [];
  });
  const gaps = study.findings.filter((finding) => gap(finding.text));
  const notes = study.findings.filter((finding) => !gap(finding.text));
  const awaiting = study.findings.some((finding) => finding.tone === "unrated") || study.checks.some((check) => check.status === "unverified");
  const passed = study.checks.filter((check) => check.status === "pass").length;
  const status = awaiting ? "Awaiting a planner" : study.checks.length ? `${passed} of ${study.checks.length} tests pass` : null;
  const isFresh = (figure: FigureView) => since !== null && figure.seq > since;
  const figures = otherFigures(study.figures, []).flatMap((group) => group.figures);
  const fresh = figures.filter(isFresh).length;
  const layers = useLayerSummaries(study.id, figures.flatMap((figure) => spatialLayer(figure) ?? []));
  // What a figure's button opens: its pages, or, with none, how it's worked out. A
  // figure measured on a map layer, or worked out from one, cites the layer instead.
  const opens = (id: string) => {
    try {
      return citesAPage(id, study.figures, assumptions) ? ", show source" : ", show working";
    } catch {
      return ", show working";
    }
  };

  return (
    <article class="study-page" data-study={study.id} aria-labelledby="study-title">
      {study.brief && <p class="brief">{study.brief}</p>}

      {headlines.length > 0 && (
        <ul class="headlines" aria-label="Headline figures">
          {headlines.map(({ figure, caption }) => (
            <li key={figure.id}>
              {/* The button's name says the full label, so the caption isn't read twice. */}
              <span class="label" aria-hidden="true">
                {caption}
              </span>
              <button type="button" class="figure" data-figure={figure.id} onClick={(event) => onFigure(figure.id, event.currentTarget)}>
                {amount(figure)}
                <span class="sr-only">{`, ${figure.label}${opens(figure.id)}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Part id="decision-title" title="Decision" kind="decision-part">
        <div class="decision-row">
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
        </div>
        <Results timeline={timeline} trialStart={study.trial?.startedOn} />
        <Sliders study={study} onPreview={onPreview} />
      </Part>

      {gaps.length > 0 && (
        <Part id="gaps-title" title="Not known yet">
          <Gaps gaps={gaps} onCitation={onCitation} />
        </Part>
      )}

      {study.checks.length > 0 && (
        <Fold id="checks-title" title="Checks" count={study.checks.length}>
          <table class="checks">
            <thead>
              <tr>
                <th scope="col">
                  <span class="sr-only">Status</span>
                </th>
                <th scope="col">Test</th>
                <th scope="col" class="num">
                  Value
                </th>
                <th scope="col" class="num">
                  Rule
                </th>
                <th scope="col">
                  <span class="sr-only">Rule's page</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {study.checks.map((check) => (
                <Check key={check.id} check={check} opens={opens(check.figure)} onFigure={onFigure} onCitation={onCitation} />
              ))}
            </tbody>
          </table>
        </Fold>
      )}

      {notes.length > 0 && (
        <Fold id="notes-title" title="Findings" count={notes.length}>
          <ul class="findings">
            {notes.map((finding) => (
              <Note key={finding.id} finding={finding} onCitation={onCitation} />
            ))}
          </ul>
        </Fold>
      )}

      {figures.length > 0 && (
        <Fold id="figures-title" title="Figures" count={figures.length} extra={fresh > 0 && <span class="fresh">{` · ${fresh} new`}</span>}>
          <div class="table-scroll" tabIndex={0} role="region" aria-label="Figures table">
            <table class="figures">
              <thead>
                <tr>
                  <th scope="col">Figure</th>
                  <th scope="col" class="num">
                    Value
                  </th>
                  <th scope="col">Source</th>
                  <th scope="col">By</th>
                  <th scope="col">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {figures.map((figure) => (
                  <tr key={figure.id} class={isFresh(figure) ? "new" : undefined}>
                    <th scope="row">
                      {figure.label}
                      {unitAfter(figure.unit) && <span class="unit">, {unitAfter(figure.unit)}</span>}
                    </th>
                    <td class="num">{amount(figure)}</td>
                    <td>
                      {spatialLayer(figure) ? (
                        <SpatialSource figure={figure} layer={layers[spatialLayer(figure) as string]} onLayer={onLayer} />
                      ) : (
                        <button type="button" class="cite-page" data-figure={figure.id} onClick={(event) => onFigure(figure.id, event.currentTarget)}>
                          {basisOf(figure, contexts)}
                          <span class="sr-only">{`, ${figure.label}${opens(figure.id)}`}</span>
                        </button>
                      )}
                    </td>
                    <td class="by">{by(figure.recordedBy)}</td>
                    <td class="by">{day.format(Date.parse(figure.recordedAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Fold>
      )}
    </article>
  );
}

