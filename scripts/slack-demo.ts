// Posts one sample of each Slack notice to SLACK_WEBHOOK_URL, for a screen
// recording of Slack receiving them. Needs no service, and posts no real study.
//
// Usage: SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... [PUBLIC_URL=https://...] \
//   node scripts/slack-demo.ts
import { message, slackUrl, studyLink } from "../services/api/src/slack.ts";

const url = slackUrl(process.env.SLACK_WEBHOOK_URL);
if (!url) {
  console.error("Set SLACK_WEBHOOK_URL to a Slack incoming webhook, https://hooks.slack.com/services/...");
  process.exit(1);
}
const publicUrl = process.env.PUBLIC_URL ?? "https://transit-agents.fly.dev";
const study = "Ontario Line: Don Mills extension";
const link = studyLink(publicUrl, "ontario-line-don-mills");

const samples = [
  { headline: "Needs your call" },
  { headline: "Answer ready" },
  { headline: "Decided", detail: "Adopted, by Ana Planner" },
  { headline: "Brief changed", detail: "Extension length set to 7.5 km" },
  { headline: "Illustrative image ready", detail: "Viaduct rendering missing, Thorncliffe Park" },
];

for (const sample of samples) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message(sample, study, link)),
    signal: AbortSignal.timeout(5000),
  }).catch((error: { name?: string; cause?: { code?: string } }) => ({ ok: false, status: error.cause?.code ?? error.name }));
  // The address is a secret, so only the outcome is printed.
  console.log(`${response.ok ? "Posted" : `Not posted (${response.status})`}: ${sample.headline}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
