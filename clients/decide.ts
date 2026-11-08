// The planner's part: rate how consultation reads, then record the decision. These
// are the TTC's published staff recommendations, entered as a planner would. A
// change that won't go ahead keeps no engagement need for it, but gets one to
// tell people how it ended.
import { ApiClient } from "./api.ts";
import { STUDIES } from "./seed-data.ts";

const planner = new ApiClient("planner");

for (const seed of STUDIES) {
  // A study with no published decision waits for planners.
  if (!seed.decision) continue;
  const id = seed.study.id;
  for (const finding of seed.findings) {
    await planner.put(`/v1/studies/${id}/findings/${finding.id}/tone`, { tone: finding.tone });
  }
  const decision = await planner.post<{ analysis: string; override: boolean }>(`/v1/studies/${id}/decisions`, seed.decision);
  console.log(id, seed.decision.outcome, `analysis ${decision.analysis}`, decision.override ? "override" : "");
  if (!seed.outcome) continue;
  // Once each, so running decide again changes nothing.
  const { needs } = await planner.get<{ needs: { id: string }[] }>(`/v1/studies/${id}`);
  const has = (need: string) => needs.some((n) => n.id === need);
  for (const need of seed.outcome.dismiss.filter(has)) {
    await planner.post(`/v1/studies/${id}/needs/${need}/dismiss`, { reason: seed.outcome.reason });
  }
  for (const need of seed.outcome.needs.filter((n) => !has(n.id))) await planner.post(`/v1/studies/${id}/needs`, need);
}
