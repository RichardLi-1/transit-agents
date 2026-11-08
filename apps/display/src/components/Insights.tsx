// Findings pinned to the map beside the engagement needs: an agent's draft alignment
// options, for planners to choose between, and what isn't known yet where it
// applies. Each opens the pages it rests on. Planners decide.
import { useState } from "preact/hooks";
import type { AlignmentOption, FindingView, StudyView } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { gap } from "../gap.ts";
import { refusal, setNotice } from "../notice.ts";
import type { Opened as Details } from "./QuickLook.tsx";

type Option = FindingView & { option: AlignmentOption };

export const isOption = (finding: FindingView): finding is Option => Boolean(finding.option);

// The findings pinned to the map: options, then gaps with a place.
export const pinnedOf = (study: StudyView | null): FindingView[] => {
  const findings = (study?.findings ?? []).filter((finding) => finding.at || finding.option);
  return [...findings.filter(isOption), ...findings.filter((finding) => !isOption(finding))];
};

const placeOf = (finding: FindingView) => finding.at ?? (finding.option ? { lon: finding.option.station.lon, lat: finding.option.station.lat } : undefined);

const billions = (millions: number) => `about $${(millions / 1000).toFixed(1)} B`;
// The first street it follows, shortened as a street sign would, and where it ends.
const streetOf = (option: AlignmentOption) =>
  (option.follows.split(", ")[0] ?? option.follows).replace(/ Road$/, " Rd").replace(/ Street$/, " St").replace(/ Avenue( East)?$/, " Ave");
const routeOf = (option: AlignmentOption) => `${streetOf(option)} to ${option.station.name}`;
const summaryOf = (option: AlignmentOption) => `${routeOf(option)} · ${option.lengthKm.toFixed(1)} km · ${billions(option.costM)} (draft)`;

const sourcesOf = (finding: FindingView) =>
  [finding.citation, ...(finding.option?.costCitations ?? [])]
    .filter((c, i, all) => all.findIndex((o) => o.contextId === c.contextId && o.page === c.page && o.quote === c.quote) === i)
    .map((citation) => ({ label: `p. ${citation.page}`, ...citation }));

type OptionProps = {
  study: StudyView;
  finding: Option;
  canAct: boolean;
  onDetails: (details: Details, from: Element) => void;
};

function OptionPin({ study, finding, canAct, onDetails }: OptionProps) {
  const [open, setOpen] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { option } = finding;
  const panel = `option-${finding.id}-actions`;
  const reviewed = study.findings.some((f) => f.id === `${finding.id}-review`);
  const rendered = study.needs.some((need) => need.id === `${finding.id}-station`);
  const options = study.findings.filter(isOption);

  const post = async (action: "review" | "renders") => {
    if (busy) return;
    setBusy(true);
    const response = await api(`/v1/studies/${study.id}/findings/${finding.id}/${action}`, { method: "POST" }).catch(() => undefined);
    setBusy(false);
    if (response?.status === 429) setNotice(await refusal(response));
    else if (response?.ok) setNotice(null);
  };

  const sources = (event: MouseEvent) =>
    onDetails(
      { title: `${finding.label}, ${option.follows}`, sources: sourcesOf(finding), steps: [], note: finding.text },
      event.currentTarget as Element,
    );

  const { lon, lat } = placeOf(finding) as { lon: number; lat: number };
  return (
    <li class="pin" data-lat={lat} data-lon={lon}>
      <article class="need option" aria-label={`${finding.label}, ${option.follows} to ${option.station.name}`}>
        <div class="body">
          <button type="button" class="words" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
            <span class="title">{finding.label}</span>
            <span class="place">{summaryOf(option)}</span>
            <span class="state">Draft options for planners</span>
          </button>
          {open && (
            <div id={panel} class="actions">
              {canAct && (
                <button type="button" class="action" aria-disabled={busy || reviewed} onClick={() => !reviewed && void post("review")}>
                  {reviewed ? "Consultancy review asked" : "Needs consultancy review"}
                </button>
              )}
              {canAct && (
                <button type="button" class="action" aria-disabled={busy || rendered} onClick={() => !rendered && void post("renders")}>
                  {rendered ? "Renders proposed" : "Generate renders"}
                </button>
              )}
              <button type="button" class="action" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>
                Compare
              </button>
              <button type="button" class="action" aria-haspopup="dialog" onClick={sources}>
                Sources
              </button>
              {comparing && (
                <table class="compare">
                  <caption class="sr-only">Draft alignment options side by side</caption>
                  <thead>
                    <tr>
                      <td />
                      {options.map((o) => (
                        <th key={o.id} scope="col">
                          {o.option.letter} · {o.option.station.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Length</th>
                      {options.map((o) => (
                        <td key={o.id}>{o.option.lengthKm.toFixed(1)} km</td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">Stations</th>
                      {options.map((o) => (
                        <td key={o.id}>{o.option.stations}</td>
                      ))}
                    </tr>
                    <tr>
                      <th scope="row">Cost</th>
                      {options.map((o) => (
                        <td key={o.id}>{billions(o.option.costM)}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </article>
      <span class="dot" aria-hidden="true" />
    </li>
  );
}

function GapPin({ finding, onDetails }: { finding: FindingView; onDetails: OptionProps["onDetails"] }) {
  const parts = gap(finding.text);
  const { lon, lat } = placeOf(finding) as { lon: number; lat: number };
  const open = (event: MouseEvent) =>
    onDetails(
      { title: `Not known yet: ${finding.label}`, sources: sourcesOf(finding), steps: [], note: finding.text },
      event.currentTarget as Element,
    );
  return (
    <li class="pin" data-lat={lat} data-lon={lon}>
      <article class="need gap" aria-label={`Not known yet: ${finding.label}`}>
        <button type="button" class="words" aria-haspopup="dialog" onClick={open}>
          <span class="state">Not known yet</span>
          <span class="title">{finding.label}</span>
          {parts && (
            <span class="place">
              Next: {parts.next} · Contact: {parts.contact}
            </span>
          )}
        </button>
      </article>
      <span class="dot" aria-hidden="true" />
    </li>
  );
}

export function Insight({ study, finding, canAct, onDetails }: Omit<OptionProps, "finding"> & { finding: FindingView }) {
  return isOption(finding) ? (
    <OptionPin study={study} finding={finding} canAct={canAct} onDetails={onDetails} />
  ) : (
    <GapPin finding={finding} onDetails={onDetails} />
  );
}
