import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { StudyView } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { MapButtons } from "../map/MapButtons.tsx";
import { MapControls } from "../map/controls.ts";
import type { NetworkData } from "../map/engine.ts";
import { FlatMap } from "../map/flat.ts";
import { boundsOf, frameOf } from "../map/gestures.ts";
import { toPoint, ViewFeed } from "../map/projection.ts";
import { createRenderer, type MapRenderer } from "../map/renderer.ts";
import { ScheduledVehicles, type StudyLine } from "../map/vehicles.ts";
import { OVERVIEW, studyColor, VIEWS } from "../map/views.ts";
import type { Simulator } from "../simulator.ts";
import { clockAt, dateToMs, DAY_MS } from "../time.ts";
import { Needs } from "./Needs.tsx";
import type { Opened } from "./QuickLook.tsx";

// Each draft alignment option's line, in the map's metres.
const optionLines = (study: StudyView | null) =>
  (study?.findings ?? []).flatMap((finding) => (finding.option ? [finding.option.line.map(([lon, lat]) => toPoint(lat, lon))] : []));

const LIVE_REFRESH_MS = 15_000;
const LINE_DRAW_MS = 1800;
const CAMERA_MS = 1400;

const describe = (study: StudyView | null, proposed: boolean) => {
  if (!study) return "Map of the TTC network";
  const passed = study.checks.filter((c) => c.status === "pass").length;
  const tests = study.checks.length ? ` ${passed} of ${study.checks.length} tests pass.` : "";
  return `Map of the TTC network with ${study.title} highlighted.${proposed ? " Its proposed part is dashed." : ""}${tests}`;
};

type Live = { pattern: string; lat: number; lon: number };
type Renderer = MapRenderer | FlatMap;
const isFlat = (map: Renderer | null): map is FlatMap => map instanceof FlatMap;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export type Credit = { text: string; url: string };

type Props = {
  study: StudyView | null;
  simulator: Simulator;
  canCreate: boolean;
  // The study the planner chose, which brings the camera back to it.
  picked?: string | null;
  onCredit: (credit: Credit | null) => void;
  onNeed: (need: Opened, from: Element) => void;
  // Whether the engagement viewer is open, which hides the rest of the page.
  onViewer: (open: boolean) => void;
};

// The map's credit for the shown study's line, if its data asks for one, goes to
// onCredit: the page shows it after the card and chat, so it comes last when
// tabbing, though it sits over the map.
export function MapView({ study, simulator, canCreate, picked = null, onCredit, onNeed, onViewer }: Props) {
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const flatCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const network = useRef<NetworkData | null>(null);
  const lines = useRef<Record<string, StudyLine>>({});
  const scheduled = useRef<ScheduledVehicles | null>(null);
  const liveVehicles = useRef<Float32Array>(new Float32Array());
  const serviceUntil = useRef(Infinity);
  const [ready, setReady] = useState(false);
  const [flat, setFlat] = useState(false);
  // Where the camera is, for the cards pinned to the map.
  const feed = useMemo(() => new ViewFeed(), []);

  const lineKey = study?.line ?? null;
  const failing = study?.checks.some((c) => c.status === "fail") ?? false;

  // The hand moves the map. Once it has, only the hand, Reset view or a study the
  // planner picks moves it, never agents' work.
  const [moved, setMoved] = useState(false);
  const home = useRef(() => {});
  home.current = () => {
    const map = renderer.current;
    const line = lineKey ? lines.current[lineKey] : undefined;
    if (isFlat(map)) map.setCamera(null);
    else map?.flyTo(line ? (VIEWS[lineKey as string] ?? OVERVIEW) : OVERVIEW, reduced() ? 0 : CAMERA_MS);
  };
  const controls = useMemo(
    () =>
      new MapControls({
        frame: () => (feed.view ? frameOf(feed.view) : null),
        surface: () => (isFlat(renderer.current) ? flatCanvas.current : glCanvas.current),
        move: (camera) => (isFlat(renderer.current) ? renderer.current.setCamera(camera) : renderer.current?.setCamera(camera, true)),
        home: () => home.current(),
        onMoved: setMoved,
      }),
    [feed],
  );
  useEffect(() => controls.attach(glCanvas.current?.parentElement as HTMLElement), [controls]);

  // Puts the current study on whichever renderer is active.
  const showStudy = (map: Renderer, animate: boolean) => {
    const line = lineKey ? lines.current[lineKey] : undefined;
    // Draft alignment options, when the study has them, stand in for its proposed part.
    const options = optionLines(study);
    map.setStudyLines(line?.lines ?? [], line && options.length ? options : (line?.proposed ?? []), studyColor(lineKey));
    map.setStudyFailing(failing);
    scheduled.current = line ? new ScheduledVehicles(line) : null;
    if (!isFlat(map)) {
      if (!controls.moved) map.flyTo(line ? (VIEWS[lineKey as string] ?? OVERVIEW) : OVERVIEW, animate ? CAMERA_MS : 0);
      if (line) map.drawStudyLine(animate ? LINE_DRAW_MS : 0);
    }
  };

  const fallBack = () => {
    const canvas = flatCanvas.current;
    if (!canvas) return;
    controls.settle();
    const map = new FlatMap(canvas, (view) => feed.set({ kind: "flat", ...view }));
    renderer.current = map;
    setFlat(true);
    if (network.current) map.setNetwork(network.current);
    showStudy(map, false);
  };

  useEffect(() => {
    const element = glCanvas.current as HTMLCanvasElement;
    try {
      renderer.current = createRenderer(element, fallBack, (view) => {
        if (!isFlat(renderer.current)) feed.set({ kind: "tilted", ...view });
      });
    } catch {
      fallBack();
    }
    const resize = () => {
      const map = renderer.current;
      if (isFlat(map)) map.draw();
      else map?.resize(element.clientWidth, element.clientHeight, window.devicePixelRatio);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    // The map is decoration for sighted users and loads after everything else.
    const load = async () => {
      const [bin, meta, studies] = await Promise.all([
        fetch("/data/network.bin").then((r) => r.arrayBuffer()),
        fetch("/data/network.json").then((r) => r.json()),
        fetch("/data/studies.json").then((r) => r.json()),
      ]);
      network.current = { coordinates: new Int16Array(bin), polylines: meta.polylines, routes: meta.routes, unitMetres: meta.unitMetres };
      serviceUntil.current = dateToMs(meta.serviceUntil) + DAY_MS / 2;
      lines.current = studies as Record<string, StudyLine>;
      controls.bounds = boundsOf(network.current);
      const map = renderer.current;
      map?.setNetwork(network.current);
      if (map && !isFlat(map)) map.setCamera(OVERVIEW);
      setReady(true);
    };
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1));
    idle(() => void load());
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (controls.moved) controls.reset();
  }, [picked]);

  useEffect(() => {
    if (ready && renderer.current) showStudy(renderer.current, !reduced());
  }, [lineKey, ready, flat]);

  useEffect(() => {
    renderer.current?.setStudyFailing(failing);
  }, [failing, ready, flat]);

  // Options proposed while the study shows replace its proposed part where it is.
  const optionCount = optionLines(study).length;
  useEffect(() => {
    const line = lineKey ? lines.current[lineKey] : undefined;
    if (!ready || !line || !optionCount) return;
    renderer.current?.setStudyLines(line.lines, optionLines(study));
  }, [optionCount, ready, flat]);

  // Every frame of the clock: brighten the network with the timetable and move
  // scheduled vehicles. After the timetable ends, nothing is scheduled, so nothing
  // moves and the network holds still.
  useEffect(() => {
    const render = (ms: number) => {
      const map = renderer.current;
      if (!map || !ready) return;
      const covered = ms <= serviceUntil.current;
      const clock = clockAt(ms);
      if (!isFlat(map)) map.setClock(covered ? clock.dayType : null, clock.hour);
      if (simulator.live && liveVehicles.current.length) map.setVehicles(liveVehicles.current);
      else map.setVehicles(covered ? (scheduled.current?.at(clock.dayType, clock.seconds) ?? new Float32Array()) : new Float32Array());
    };
    render(simulator.now);
    const stop = simulator.subscribe(render);
    const stopState = simulator.subscribeState(() => render(simulator.now));
    return () => {
      stop();
      stopState();
    };
  }, [simulator, ready, lineKey, flat]);

  // Live vehicles only for a change that is running. An unbuilt proposal has
  // none, and today's buses on the old route would misrepresent it.
  const watched = (study?.watch ?? []).join(",");
  const routes = watched ? (study?.routes.join(",") ?? "") : "";
  useEffect(() => {
    liveVehicles.current = new Float32Array();
    if (!routes) return;
    let active = true;
    const patterns = watched ? watched.split(",") : [];
    const load = async () => {
      const response = await api(`/v1/live/vehicles?routes=${routes}`).catch(() => undefined);
      if (!active || !response?.ok) return;
      const vehicles = (await response.json()) as Live[];
      const out: number[] = [];
      for (const v of vehicles) {
        if (patterns.length && !patterns.includes(v.pattern)) continue;
        const [x, y] = toPoint(v.lat, v.lon);
        out.push(x, y, 1);
      }
      liveVehicles.current = new Float32Array(out);
      if (simulator.live) renderer.current?.setVehicles(liveVehicles.current);
    };
    void load();
    const timer = setInterval(load, LIVE_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [routes, watched, simulator]);

  const shownLine = ready && lineKey ? lines.current[lineKey] : undefined;
  const label = describe(study, Boolean(shownLine?.proposed?.length));
  const credit = shownLine?.credit;
  useEffect(() => onCredit(credit ?? null), [credit?.text, credit?.url]);
  // Back to the study, and focus to the map, as the button goes.
  const resetView = (event: MouseEvent) => {
    const focused = document.activeElement === event.currentTarget;
    controls.reset();
    if (focused) (flat ? flatCanvas : glCanvas).current?.focus();
  };
  return (
    <>
      {/* The map showing takes the keys and the gestures. */}
      <canvas ref={glCanvas} class={flat ? "map hidden" : "map"} role="application" aria-roledescription="map" aria-label={label} aria-describedby="map-keys" aria-hidden={flat} tabIndex={flat ? undefined : 0} />
      <canvas ref={flatCanvas} class={flat ? "map" : "map hidden"} role="application" aria-roledescription="map" aria-label={label} aria-describedby="map-keys" aria-hidden={!flat} tabIndex={flat ? 0 : undefined} />
      {/* Read only as the map's description, so not twice. */}
      <p id="map-keys" hidden>
        {moved && "You have moved the map. Home or Reset view goes back. "}
        Drag, scroll or use the arrow keys to move. Pinch, or plus and minus, to zoom. Shift with a drag or the arrow keys turns and tilts. Home goes back to the study.
      </p>
      {moved && (
        <button type="button" class="reset" onClick={resetView}>
          Reset view
        </button>
      )}
      <MapButtons controls={controls} flat={flat} />
      <div class="fade" aria-hidden="true" />
      <Needs study={study} feed={feed} canCreate={canCreate} onDetails={onNeed} onViewer={onViewer} />
    </>
  );
}
