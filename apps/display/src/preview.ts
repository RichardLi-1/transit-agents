import type { StudyView } from "@transit-agents/contracts";

// What the card and the map show: the sliders' preview while one is on, else the
// study. A preview is a snapshot of the moment a slider moved, so the engagement
// needs, which agents and planners change while it is on, come from the study.
export function shownStudy(study: StudyView | null, preview: StudyView | null): StudyView | null {
  if (!study || !preview || preview.id !== study.id) return study;
  return preview.needs === study.needs ? preview : { ...preview, needs: study.needs };
}
