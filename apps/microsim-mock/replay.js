// A replay of a real Gemini computer-use run, for where no machine can drive the
// simulator live (the deployed site). Opened as /simulator/#replay. Its steps and
// words are Gemini's own, from a run on 2026-11-08; the panel says it's a replay.
(() => {
  if (location.hash !== "#replay") return;
  const SIDE = 320;
  const LAYOUT = 1440;
  const STEPS = [
    { meta: "step 1", text: "Click Edit timing to modify phase 2 green time", click: "#edit-timing" },
    { meta: "step 2", text: "Click the input field for Phase 2 Green time", click: "#p2-green" },
    { meta: "step 3", text: "Type 20 into Phase 2 green time field", type: ["#p2-green", "20"] },
    { meta: "step 4", text: "Click OK to apply signal timing change", click: "#dialog-ok" },
    { meta: "step 5", text: "Click Run simulation", click: "#run-button", after: 9500 },
    { meta: "step 6", text: "Wait for simulation to progress" },
    { meta: "step 7", text: "Gemini asks a person before saving: it changes the model file.", ask: true },
    { meta: "step 7", text: "The planner confirmed.", ask: true },
    { meta: "step 7", text: "Click Save to save the model", click: "#save-button" },
    {
      meta: "done",
      text: "I lengthened phase 2's green time from 12 to 20 seconds, and the simulation results showed that northbound left delay improved from 221.3 seconds (LOS F) to 43.9 seconds (LOS D), so the model was saved.",
    },
  ];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const zoom = Math.min(1, (innerWidth - SIDE) / LAYOUT);
  document.documentElement.style.zoom = String(zoom);
  document.documentElement.style.setProperty("--reserved-right", `${SIDE / zoom}px`);

  const panel = document.createElement("aside");
  panel.setAttribute("aria-label", "Gemini");
  panel.style.cssText = `position:fixed;top:0;right:0;bottom:0;width:${SIDE / zoom}px;zoom:${1 / zoom};width:${SIDE}px;display:flex;flex-direction:column;background:#fff;color:#111;border-left:1px solid #d0d0d6;font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;z-index:99998`;
  panel.innerHTML = `<div style="padding:16px 18px 12px;border-bottom:1px solid #e2e2e6"><div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;font-weight:700">Gemini</div><div style="font-size:12px;color:#5f5f66;margin-top:2px">Replay of a real Gemini run · Gemini 3.8 Flash</div></div><div class="log" role="log" style="flex:1;overflow-y:auto;padding:10px 18px 18px;display:flex;flex-direction:column;gap:10px"></div>`;
  const log = panel.querySelector(".log");
  const say = (meta, text, ask) => {
    const line = document.createElement("div");
    line.style.cssText = `display:grid;gap:2px;${ask ? "color:#8a4b00;font-weight:600;" : ""}`;
    line.innerHTML = '<span style="color:#5f5f66;font-size:12px;font-weight:400"></span><span></span>';
    line.children[0].textContent = meta;
    line.children[1].textContent = text;
    log.append(line);
    log.scrollTop = log.scrollHeight;
  };

  const pointer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  pointer.setAttribute("viewBox", "0 0 26 26");
  pointer.setAttribute("aria-hidden", "true");
  pointer.style.cssText = "position:fixed;left:0;top:0;width:26px;height:26px;z-index:99999;pointer-events:none;transition:transform .7s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(1px 2px 1px rgb(0 0 0/.35))";
  pointer.innerHTML = '<path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.6 15 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/>';
  const move = (el) => {
    const r = el.getBoundingClientRect();
    pointer.style.transform = `translate(${r.left + r.width / 2}px, ${r.top + r.height / 2}px)`;
  };

  const start = async () => {
    document.body.append(panel, pointer);
    pointer.style.transform = `translate(${innerWidth / zoom / 3}px, ${innerHeight / zoom / 2}px)`;
    say("task", "Lengthen phase 2's green time from 12 to 20 seconds, run the simulation, and save the model if the northbound left delay improves.");
    await sleep(1600);
    for (const step of STEPS) {
      const target = step.click ? document.querySelector(step.click) : step.type ? document.querySelector(step.type[0]) : null;
      if (target) {
        move(target);
        await sleep(850);
      }
      say(step.meta, step.text, step.ask);
      if (step.click && target) {
        target.focus();
        target.click();
      }
      if (step.type && target) {
        target.select?.();
        target.value = "";
        for (const ch of step.type[1]) {
          target.value += ch;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(180);
        }
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await sleep(step.after ?? (step.ask ? 1400 : 1100));
    }
    history.replaceState(null, "", location.pathname);
  };
  if (document.readyState === "complete") void start();
  else addEventListener("load", () => void start());
})();
