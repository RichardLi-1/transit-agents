// Who visits, from where, and what they look at, ported from hi-sg's tracker: one page
// view a visit, sent a few seconds in, and a quick bounce, to /v1/track, which writes
// the message and posts it to Discord (services/api/src/visits.ts). A plain script,
// so every page loads it, the display's and the docs' alike, and it loads nothing else.
//
// Not sent: on this machine (localhost), once a URL with ?m has been opened in this
// browser, or while "/" is held down. The page itself never waits on it.
(function () {
  // ?l, ?r … in a link that's shared, so a visit says where the link was.
  var REFERRALS = { c: "Cover Letter", l: "LinkedIn", r: "Resume", t: "Twitter/X", e: "Email", g: "GitHub", z: "Resume" };
  // People arriving from an AI assistant, by its utm_source or referrer's host.
  var ASSISTANTS = {
    "chatgpt.com": "ChatGPT",
    "chat.openai.com": "ChatGPT",
    "perplexity.ai": "Perplexity",
    "claude.ai": "Claude",
    "gemini.google.com": "Gemini",
    "copilot.microsoft.com": "Copilot",
  };
  var VISIT_DELAY_MS = 5000;
  var BOUNCE_MS = 10000;

  function assistant(hostOrSource) {
    if (!hostOrSource) return null;
    return ASSISTANTS[String(hostOrSource).toLowerCase().replace(/^www\./, "")] || null;
  }

  // The query without the tracking parameters: the referral keys, ?m and utm_*. The
  // page's own, such as ?nointro or a sign-in's, stay.
  // Each part kept as it was written, so ?nointro stays ?nointro. Null: nothing to strip.
  function withoutTracking(search) {
    var parts = String(search).replace(/^\?/, "").split("&").filter(Boolean);
    var kept = parts.filter(function (part) {
      var key = part.split("=")[0];
      try {
        key = decodeURIComponent(key.replace(/\+/g, " "));
      } catch (error) {
        // Kept as written.
      }
      return !(REFERRALS[key] || key === "m" || key.indexOf("utm_") === 0);
    });
    if (kept.length === parts.length) return null;
    return kept.length ? "?" + kept.join("&") : "";
  }

  // Where this visit came from: a referral key first, then an AI assistant, by its
  // utm_source or, with no parameters at all, its referrer; else what was kept.
  function source(params, referrerHost, fresh, kept) {
    var keys = Array.from(params.keys());
    for (var i = 0; i < keys.length; i++) if (REFERRALS[keys[i]]) return { referral: REFERRALS[keys[i]], ai: null, fromLink: true };
    var ai = fresh ? assistant(params.get("utm_source")) || assistant(referrerHost) : null;
    var aiIsSource = ai && (assistant(params.get("utm_source")) || !params.toString());
    if (aiIsSource) return { referral: ai, ai: ai, fromLink: true };
    return { referral: kept || null, ai: ai, fromLink: false };
  }

  function device(userAgent, platform) {
    var mobile = /Mobi|Android|iPhone|iPad/i.test(userAgent);
    var system = /iPhone|iPad/.test(userAgent)
      ? "iOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /Mac/.test(platform)
          ? "macOS"
          : /Win/.test(platform)
            ? "Windows"
            : /Linux/.test(platform)
              ? "Linux"
              : "Unknown";
    return (mobile ? "📱 Mobile" : "🖥️ Desktop") + " · " + system;
  }

  var helpers = { withoutTracking: withoutTracking, source: source, assistant: assistant, device: device };
  globalThis.__track = helpers;
  if (typeof document === "undefined" || typeof window === "undefined") return;

  // ─── In the page ───────────────────────────────────────────────────────────

  function read(storage, key) {
    try {
      return window[storage].getItem(key);
    } catch (error) {
      return null;
    }
  }
  function write(storage, key, value) {
    try {
      window[storage].setItem(key, value);
    } catch (error) {
      // Storage blocked: this visit only.
    }
  }

  var host = location.hostname;
  var params = new URLSearchParams(location.search);
  if (params.has("m")) write("localStorage", "skip_tracking", "1");
  var cleaned = withoutTracking(location.search);
  if (cleaned !== null) history.replaceState(history.state, "", location.pathname + cleaned + location.hash);
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || read("localStorage", "skip_tracking")) return;

  var slashHeld = false;
  window.addEventListener("keydown", function (event) {
    if (event.key === "/") slashHeld = true;
  });
  window.addEventListener("keyup", function (event) {
    if (event.key === "/") slashHeld = false;
  });

  var fresh = !read("sessionStorage", "nav_path");
  var referrer = fresh ? document.referrer : "";
  var referrerHost = null;
  try {
    referrerHost = referrer ? new URL(referrer).hostname : null;
  } catch (error) {
    referrerHost = null;
  }
  var from = source(params, referrerHost, fresh, read("localStorage", "referral_source"));
  if (from.fromLink && from.referral) write("localStorage", "referral_source", from.referral);
  var ai = from.ai ? from.ai + (assistant(referrerHost) ? " (web, referrer sent)" : " (no referrer, often the mobile app)") : null;

  var trail = [];
  try {
    trail = JSON.parse(read("sessionStorage", "nav_path") || "[]");
  } catch (error) {
    trail = [];
  }
  if (trail[trail.length - 1] !== location.pathname) trail.push(location.pathname);
  write("sessionStorage", "nav_path", JSON.stringify(trail.slice(-12)));

  // ─── Signs of a person, counted while the page is open ─────────────────────
  var started = Date.now();
  var counts = { pointerMoves: 0, touches: 0, scrolls: 0, keyPresses: 0 };
  var wasVisible = document.visibilityState === "visible";
  var interactedEarlier = read("sessionStorage", "human_seen") === "1";
  function count(name, enough) {
    return function (event) {
      if (!event.isTrusted) return;
      counts[name]++;
      if (counts[name] >= enough) write("sessionStorage", "human_seen", "1");
    };
  }
  var passive = { passive: true };
  window.addEventListener("mousemove", count("pointerMoves", 5), passive);
  window.addEventListener("touchstart", count("touches", 1), passive);
  window.addEventListener("wheel", count("scrolls", 1), passive);
  window.addEventListener("touchmove", count("scrolls", 1), passive);
  window.addEventListener("keydown", count("keyPresses", 1));
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") wasVisible = true;
  });
  function signals() {
    return {
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver === true,
      languagesCount: (navigator.languages || []).length,
      screenWidth: (window.screen && window.screen.width) || 0,
      screenHeight: (window.screen && window.screen.height) || 0,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      pluginsCount: (navigator.plugins || []).length,
      isMobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      pointerMoves: counts.pointerMoves,
      touches: counts.touches,
      scrolls: counts.scrolls,
      keyPresses: counts.keyPresses,
      wasVisible: wasVisible,
      interactedEarlier: interactedEarlier,
      msObserved: Date.now() - started,
    };
  }

  function send(body) {
    var json = JSON.stringify(body);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon("/v1/track", new Blob([json], { type: "application/json" }))) return;
    } catch (error) {
      // Falls through to fetch.
    }
    fetch("/v1/track", { method: "POST", headers: { "content-type": "application/json" }, body: json, keepalive: true }).catch(function () {});
  }

  var base = {
    path: location.pathname,
    trail: trail,
    referral: from.referral || undefined,
    ai: ai || undefined,
    referrer: referrer || undefined,
    params: params.toString() || undefined,
    device: device(navigator.userAgent, navigator.platform || ""),
    bot: /bot|crawler|spider/i.test(navigator.userAgent),
  };

  // The visit, once: a few seconds in, so the signs of a person have something to
  // say, or as the page goes, whichever comes first.
  var visitSent = false;
  function sendVisit() {
    if (visitSent || slashHeld) return;
    visitSent = true;
    send(Object.assign({ kind: "visit", signals: signals() }, base));
  }
  setTimeout(sendVisit, VISIT_DELAY_MS);

  // A quick bounce: this one page only, left within ten seconds. Once a visit.
  window.addEventListener("pagehide", function () {
    var elapsed = Date.now() - started;
    if (!slashHeld && trail.length <= 1 && elapsed <= BOUNCE_MS && !read("sessionStorage", "bounce_sent")) {
      write("sessionStorage", "bounce_sent", "1");
      send(Object.assign({ kind: "bounce", seconds: Math.round(elapsed / 1000), signals: signals() }, base));
      visitSent = true;
    }
    sendVisit();
  });
})();
