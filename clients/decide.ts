// The planner's part: rate how consultation reads, then record the decision. These
// are the TTC's published staff recommendations, entered as a planner would.
import { ApiClient } from "./api.ts";
import { STUDIES } from "./seed-data.ts";

const planner = new ApiClient("planner");

for (const seed of STUDIES) {
  const id = seed.study.id;
  for (const finding of seed.findings) {
    await planner.put(`/v1/studies/${id}/findings/${finding.id}/tone`, { tone: finding.tone });
  }
  const decision = await planner.post<{ analysis: string; override: boolean }>(`/v1/studies/${id}/decisions`, seed.decision);
  console.log(id, seed.decision.outcome, `analysis ${decision.analysis}`, decision.override ? "override" : "");
}
