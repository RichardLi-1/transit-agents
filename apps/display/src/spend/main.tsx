// The spend screen, for a display of its own: what the agents have spent, as
// four numbers on black. It loads nothing of the map or the main display.
import type { UsageEstimate } from "@transit-agents/contracts";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { isTestBuild } from "../host.ts";
import { aboutEstimate, calls, co2e, dollars, energy, tokens, unitFor, water } from "./format.ts";
import { spentUsd } from "../money.ts";
import { useUsage } from "./usage.ts";
import "./spend.css";

const COUNT_MS = 600;
const IDLE_MS = 3000;
const TEST_BUILD = isTestBuild(location.hostname);
const ABOUT_ENERGY = "about-energy";

function Spend() {
  const usage = useUsage();
  const estimate = usage?.estimate ?? null;
  useWallDisplay();
  return (
    <main>
      <h1 class="sr-only">Spend</h1>
      {TEST_BUILD && <p class="build">Test build</p>}
      <dl>
        {/* US dollars, as the main display says: in Toronto, a bare $ reads as Canadian. */}
        <Figure unit="US dollars spent" value={spentUsd(usage)} format={dollars} />
        <Figure unit="tokens" one="token" value={usage ? usage.inputTokens + usage.outputTokens : null} format={tokens} />
        <Figure unit="model calls" one="model call" value={usage ? usage.calls : null} format={calls} />
        <Energy estimate={estimate} loaded={usage !== null} />
      </dl>
      {/* Read with the energy figure, not on its own. */}
      {estimate && (
        <p id={ABOUT_ENERGY} hidden>
          {aboutEstimate(estimate.basis)}
        </p>
      )}
    </main>
  );
}

// A screen reader reads the unit, then the number. Changes aren't announced:
// they can come every second while agents work. Until the first number comes,
// its lines are held empty: a placeholder would move as the number, or its unit
// ("1 model call"), took its place.
function Figure({ unit, one = unit, value, format }: { unit: string; one?: string; value: number | null; format: (value: number) => string }) {
  const shown = useCountUp(value);
  return (
    <div>
      <dt>{shown === null ? null : unitFor(shown, one, unit)}</dt>
      <dd>{shown === null ? null : format(shown)}</dd>
    </div>
  );
}

// The energy the model calls used, with their CO₂e and water in the unit line: all at
// least, since each call counts as a median prompt. Its lines are held empty
// until the first numbers come, as the others are. A service too old to
// estimate them shows a dash.
function Energy({ estimate, loaded }: { estimate: UsageEstimate | null; loaded: boolean }) {
  const wh = useCountUp(estimate ? estimate.energyWh : null);
  const grams = useCountUp(estimate ? estimate.co2eGrams : null);
  const ml = useCountUp(estimate ? estimate.waterMl : null);
  return (
    <div>
      <dt>
        {loaded && (
          <>
            energy, at least{grams !== null && ` · ${co2e(grams)}`}
            {ml !== null && ` · ${water(ml)}`}
          </>
        )}
      </dt>
      <dd aria-describedby={estimate ? ABOUT_ENERGY : undefined}>{!loaded ? null : wh === null ? "—" : energy(wh)}</dd>
    </div>
  );
}

// Counts from the number on screen to a new one. The first number, and any
// number when motion is reduced, appears at once.
function useCountUp(target: number | null): number | null {
  const [shown, setShown] = useState(target);
  const onScreen = useRef(target);

  useEffect(() => {
    const from = onScreen.current;
    if (target === null || from === null || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onScreen.current = target;
      setShown(target);
      return;
    }
    let start: number | undefined;
    let frame = requestAnimationFrame(function step(now) {
      start ??= now;
      const progress = Math.min((now - start) / COUNT_MS, 1);
      onScreen.current = progress === 1 ? target : from + (target - from) * (1 - (1 - progress) ** 3);
      setShown(onScreen.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return shown;
}

// On a wall, the cursor hides once the mouse rests. There's no key for full
// screen: a single-letter shortcut gets in the way of keyboard and speech users
// (WCAG 2.1.4), and the browser's own full screen does the same.
function useWallDisplay() {
  useEffect(() => {
    const root = document.documentElement;
    let idle = 0;
    const wake = () => {
      root.classList.remove("idle");
      clearTimeout(idle);
      idle = window.setTimeout(() => root.classList.add("idle"), IDLE_MS);
    };
    wake();
    addEventListener("mousemove", wake);
    return () => {
      clearTimeout(idle);
      removeEventListener("mousemove", wake);
    };
  }, []);
}

render(<Spend />, document.getElementById("app") as HTMLElement);
