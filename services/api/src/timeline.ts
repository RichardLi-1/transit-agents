// Results over time for a study, from today to its review date.
import type { Timeline } from "@transit-agents/contracts";
import type { Measurements } from "./collector.ts";
import { localClock } from "./reliability.ts";
import type { Service } from "./service.ts";

export function buildTimeline(service: Service, collector: Pick<Measurements, "reliability">, studyId: string, now = new Date()): Timeline {
  const study = service.viewStudy(studyId);
  const figures = new Map(study.figures.map((f) => [f.id, f]));
  return {
    today: localClock(Math.floor(now.getTime() / 1000)).date,
    reviewOn: study.trial?.reviewOn ?? null,
    measured: { patterns: study.watch, days: study.watch.length ? collector.reliability(study.watch) : [] },
    network: { days: collector.reliability() },
    forecast: study.project.flatMap((id) => {
      const figure = figures.get(id);
      return figure ? [{ figure: id, label: figure.label, unit: figure.unit, perWeek: figure.value }] : [];
    }),
  };
}
