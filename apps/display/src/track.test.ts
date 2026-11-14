import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

type Helpers = {
  withoutTracking(search: string): string | null;
  source(params: URLSearchParams, referrerHost: string | null, fresh: boolean, kept: string | null): { referral: string | null; ai: string | null; fromLink: boolean };
  assistant(host: string | null): string | null;
  device(userAgent: string, platform: string): string;
};
let track: Helpers;

describe("track.js, the visit tracker every page loads", () => {
  before(async () => {
    // Outside a page it only lends its helpers, and sends nothing.
    await import(new URL("../public/track.js", import.meta.url).href);
    track = (globalThis as unknown as { __track: Helpers }).__track;
  });

  it("strips the tracking parameters and keeps the page's own", () => {
    assert.equal(track.withoutTracking("?l&nointro"), "?nointro");
    assert.equal(track.withoutTracking("?utm_source=chatgpt.com&utm_medium=x"), "");
    assert.equal(track.withoutTracking("?m=1&token=abc"), "?token=abc");
    // A sign-in's callback is left alone, and a URL with nothing to strip isn't rewritten.
    assert.equal(track.withoutTracking("?code=1&state=2"), null);
    assert.equal(track.withoutTracking(""), null);
  });

  it("takes a referral key first, then an AI assistant, then what was kept", () => {
    assert.deepEqual(track.source(new URLSearchParams("l"), null, true, "Resume"), { referral: "LinkedIn", ai: null, fromLink: true });
    assert.deepEqual(track.source(new URLSearchParams("utm_source=chatgpt.com"), null, true, null), { referral: "ChatGPT", ai: "ChatGPT", fromLink: true });
    assert.deepEqual(track.source(new URLSearchParams(""), "www.perplexity.ai", true, null), { referral: "Perplexity", ai: "Perplexity", fromLink: true });
    assert.deepEqual(track.source(new URLSearchParams(""), null, false, "Resume"), { referral: "Resume", ai: null, fromLink: false });
  });

  it("counts an AI referrer only on a fresh landing, as the referrer outlives it", () => {
    assert.deepEqual(track.source(new URLSearchParams(""), "claude.ai", false, null), { referral: null, ai: null, fromLink: false });
  });

  it("leaves another utm_source as a custom referral", () => {
    assert.deepEqual(track.source(new URLSearchParams("utm_source=newsletter"), "claude.ai", true, null), { referral: null, ai: "Claude", fromLink: false });
  });

  it("names the device", () => {
    assert.equal(track.device("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile", "iPhone"), "📱 Mobile · iOS");
    assert.equal(track.device("Mozilla/5.0 (Macintosh)", "MacIntel"), "🖥️ Desktop · macOS");
  });
});
