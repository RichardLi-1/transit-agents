import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NeedView, StudyView } from "@transit-agents/contracts";
import { shownStudy } from "./preview.ts";

const need = (status: NeedView["status"]): NeedView => ({
  id: "sunnybrook-poster",
  title: "Engagement poster",
  place: "Sunnybrook Hospital",
  lon: -79.375262,
  lat: 43.722663,
  kinds: ["image"],
  reason: "Riders can now ride straight to the hospital.",
  citations: [],
  status,
  addedBy: "agent:replay",
  addedAt: "2026-11-07T12:00:00.000Z",
  media: [],
});

const study = (id: string, analysis: StudyView["analysis"], needs: NeedView[]): StudyView => ({
  id,
  title: id,
  brief: "",
  routes: [],
  watch: [],
  project: [],
  figures: [],
  checks: [],
  findings: [],
  analysis,
  needs,
});

describe("the study shown", () => {
  it("is the study when no slider has moved", () => {
    const live = study("lawrence", "pass", [need("needed")]);
    assert.equal(shownStudy(live, null), live);
    assert.equal(shownStudy(null, null), null);
  });

  it("is the preview while a slider is moved, with the needs as they are now", () => {
    // The preview was taken while the poster was being made. It has been made since.
    const preview = study("lawrence", "mixed", [need("creating")]);
    const live = study("lawrence", "pass", [need("ready")]);
    const shown = shownStudy(live, preview);
    assert.equal(shown?.analysis, "mixed");
    assert.equal(shown?.needs, live.needs);
    assert.equal(shown?.needs[0]?.status, "ready");
  });

  it("is the study when the preview is of another study", () => {
    const live = study("lawrence", "pass", [need("ready")]);
    assert.equal(shownStudy(live, study("rosedale", "mixed", [])), live);
  });
});
