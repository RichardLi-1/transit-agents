import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { StudyView } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { MapButtons } from "../map/MapButtons.tsx";
import { MapControls } from "../map/controls.ts";
import type { Camera, NetworkData } from "../map/engine.ts";
import { FlatMap } from "../map/flat.ts";
import { boundsOf, frameOf } from "../map/gestures.ts";
import { cameraFor, creditOf, fileName, placesOf, search, type FeatureCollection, type Place } from "../map/layers.ts";
import { GlassPanes } from "../map/panes.ts";
import { toPoint, ViewFeed } from "../map/projection.ts";
import { createRenderer, type MapRenderer } from "../map/renderer.ts";
import { save, useLayers, type Loaded } from "../map/useLayers.ts";
import { ScheduledVehicles, type StudyLine } from "../map/vehicles.ts";
import { LINE_KEYS, OVERVIEW, studyColor, VIEWS } from "../map/views.ts";
import type { Simulator } from "../simulator.ts";
import { clockAt, dateToMs, DAY_MS } from "../time.ts";
import { Basemap } from "./Basemap.tsx";
import { LineIcon } from "./icons.tsx";
import { Layers } from "./Layers.tsx";
import { Needs } from "./Needs.tsx";
import type { Opened } from "./QuickLook.tsx";
import { currentTheme, onTheme } from "../theme.ts";

// Each draft alignment option's line, in the map's metres.
const optionLines = (study: StudyView | null) =>
  (study?.findings ?? []).flatMap((finding) => (finding.option ? [finding.option.line.map(([lon, lat]) => toPoint(lat, lon))] : []));

const LIVE_REFRESH_MS = 15_000;
const LINE_DRAW_MS = 1800;
const CAMERA_MS = 1400;
// The aerial photos' credit, as their licence asks, while they show.
const IMAGERY_CREDIT = { text: "Imagery © City of Toronto, Open Government Licence – Toronto", url: "https://open.toronto.ca/open-data-licence/" };

// How close a search result brings the camera, in metres.
const PLACE_DISTANCE = 2600;

const describe = (study: StudyView | null, proposed: boolean, layers: number) => {
  if (!study) return "Map of the TTC network";
  const passed = study.checks.filter((c) => c.status === "pass").length;
  const tests = study.checks.length ? ` ${passed} of ${study.checks.length} tests pass.` : "";
  const shown = layers ? ` ${layers} ${layers === 1 ? "layer" : "layers"} shown.` : "";
  return `Map of the TTC network with ${study.title} highlighted.${proposed ? " Its proposed part is dashed." : ""}${tests}${shown}`;
};

type Live = { pattern: string; lat: number; lon: number };
type Renderer = MapRenderer | FlatMap;
const isFlat = (map: Renderer | null): map is FlatMap => map instanceof FlatMap;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// How long after the camera's last move the map counts as still.
const SETTLE_MS = 200;

// Marks the page while the map moves, by hand or in a flight, so the glass the
// browser blurs over it can stop: that blur is redone for every pane on every
// frame, the GPU's biggest cost, and the panes clear up again once the map
// settles. The panes the map blurs itself (map/panes.ts) keep their blur.
function useMoving(feed: ViewFeed) {
  useEffect(() => {
    const root = document.documentElement;
    let first = true;
    let timer = 0;
    const stop = feed.subscribe(() => {
      // The first view is the map arriving, not moving.
      if (first) return void (first = false);
      if (!("moving" in root.dataset)) root.dataset.moving = "";
      window.clearTimeout(timer);
      timer = window.setTimeout(() => delete root.dataset.moving, SETTLE_MS);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
      delete root.dataset.moving;
    };
  }, [feed]);
}

type Props = {
  study: StudyView | null;
  simulator: Simulator;
  canCreate: boolean;
  reads: boolean;
  // Changes as agents add layers, so the list is asked for again.
  layerVersion: string;
  // The layers agents added since the page opened, by id, joined by commas.
  freshLayers?: string;
  // The study the planner chose, which brings the camera back to it.
  picked?: string | null;
  // A layer to show and zoom to, as a figure measured on it asks; n counts each ask.
  focus?: { id: string; n: number } | null;
  // The map is the backdrop behind another tab: still, and with nothing over it.
  ambient?: boolean;
  onNeed: (need: Opened, from: Element) => void;
  // Whether the engagement viewer is open, which hides the rest of the page.
  onViewer: (open: boolean) => void;
  // Over the foot of the map, such as the time bar.
  children?: ComponentChildren;
};

// The map pane: the WebGL map, or the flat one where WebGL is missing, with the
// tools along its top, the agents' layers, the engagement needs pinned to their
// places, and the credits its data asks for at its foot.
export function MapView({ study, simulator, canCreate, reads, layerVersion, freshLayers = "", picked = null, focus = null, ambient = false, onNeed, onViewer, children }: Props) {
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const flatCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const network = useRef<NetworkData | null>(null);
  const lines = useRef<Record<string, StudyLine>>({});
  const scheduled = useRef<ScheduledVehicles | null>(null);
  const liveVehicles = useRef<Float32Array>(new Float32Array());
  const serviceUntil = useRef(Infinity);
  const [ready, setReady] = useState(false);
  // As the backdrop, nothing redraws the map but a new study, a layer or the theme:
  // no flights, no line drawing in, no vehicles moving.
  const still = useRef(ambient);
  still.current = ambient;
  const [flat, setFlat] = useState(false);
  const [networkShown, setNetworkShown] = useState(true);
  // The ground as aerial photos rather than plain.
  const [imagery, setImagery] = useState(false);
  const [needsShown, setNeedsShown] = useState(true);
  const [refreshed, setRefreshed] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  // Where the camera is, for the cards pinned to the map.
  const feed = useMemo(() => new ViewFeed(), []);
  useMoving(feed);
  // The glass over the map, which the map blurs itself while it shows sharp.
  const glass = useMemo(() => new GlassPanes(), []);
  // The map turns light or dark with the page, as Settings or the system has it.
  useEffect(() => onTheme((theme) => renderer.current?.setTheme(theme === "dark")), []);

  const layers = useLayers(study?.id ?? null, reads, `${layerVersion}|${refreshed}`);

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
    else map?.flyTo(line ? (VIEWS[lineKey as string] ?? OVERVIEW) : OVERVIEW, reduced() || still.current ? 0 : CAMERA_MS);
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

  // The layers' data, and which of them show, on whichever renderer is active.
  const layerShapes = useMemo(() => layers.loaded.flatMap((loaded) => (loaded.shapes ? [loaded.shapes] : [])), [layers.loaded]);
  const shownIds = layers.shown.map(({ layer }) => layer.id).join(",");
  const putLayers = (map: Renderer) => {
    map.setLayers(layerShapes);
    map.showLayers(shownIds ? shownIds.split(",") : []);
    map.setNetworkShown(networkShown);
    map.setImagery(imagery);
  };

  const fallBack = () => {
    const canvas = flatCanvas.current;
    if (!canvas) return;
    controls.settle();
    const map = new FlatMap(canvas, (view) => feed.set({ kind: "flat", ...view }));
    map.setTheme(currentTheme() === "dark");
    renderer.current = map;
    setFlat(true);
    if (network.current) map.setNetwork(network.current);
    showStudy(map, false);
    putLayers(map);
  };

  useEffect(() => {
    const element = glCanvas.current as HTMLCanvasElement;
    try {
      renderer.current = createRenderer(
        element,
        fallBack,
        (view) => {
          if (!isFlat(renderer.current)) feed.set({ kind: "tilted", ...view });
        },
        (version) => glass.drawn(version),
      );
      renderer.current.setTheme(currentTheme() === "dark");
    } catch {
      fallBack();
    }
    const resize = () => {
      const map = renderer.current;
      // The pane is hidden behind another tab: nothing to size until it shows.
      if (!element.clientWidth || !element.clientHeight) return;
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
    const unglass = glass.attach(element, (rects, ground, version) => {
      const map = renderer.current;
      if (!map || isFlat(map)) return false;
      map.setGlassRects(rects, ground, version);
      return true;
    });
    return () => {
      observer.disconnect();
      unglass();
    };
  }, []);

  useEffect(() => glass.setShown(ready && !flat && !ambient), [ready, flat, ambient]);

  useEffect(() => {
    if (controls.moved) controls.reset();
  }, [picked]);

  useEffect(() => {
    if (ready && renderer.current) showStudy(renderer.current, !reduced() && !still.current);
  }, [lineKey, ready, flat]);

  useEffect(() => {
    renderer.current?.setStudyFailing(failing);
  }, [failing, ready, flat]);

  useEffect(() => {
    renderer.current?.setLayers(layerShapes);
  }, [layerShapes, flat]);

  useEffect(() => {
    renderer.current?.showLayers(shownIds ? shownIds.split(",") : []);
  }, [shownIds, layerShapes, flat]);

  useEffect(() => {
    renderer.current?.setNetworkShown(networkShown);
  }, [networkShown, flat]);

  useEffect(() => {
    renderer.current?.setImagery(imagery);
  }, [imagery, flat]);

  // Options proposed while the study shows replace its proposed part where it is.
  const optionCount = optionLines(study).length;
  useEffect(() => {
    const line = lineKey ? lines.current[lineKey] : undefined;
    if (!ready || !line || !optionCount) return;
    renderer.current?.setStudyLines(line.lines, optionLines(study), studyColor(lineKey));
  }, [optionCount, ready, flat]);

  // Every frame of the clock: brighten the network with the timetable and move
  // scheduled vehicles. After the timetable ends, nothing is scheduled, so nothing
  // moves and the network holds still.
  useEffect(() => {
    const render = (ms: number) => {
      const map = renderer.current;
      if (!map || !ready || still.current) return;
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
  }, [simulator, ready, lineKey, flat, ambient]);

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
      if (simulator.live && !still.current) renderer.current?.setVehicles(liveVehicles.current);
    };
    void load();
    const timer = setInterval(load, LIVE_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [routes, watched, simulator]);

  // Takes the camera somewhere, as a planner asked, on either map.
  const go = (camera: Camera) => {
    const map = renderer.current;
    if (isFlat(map)) map.setCamera(camera);
    else map?.flyTo(camera, reduced() ? 0 : CAMERA_MS);
  };
  const bearing = () => (feed.view?.kind === "tilted" ? feed.view.camera.bearing : (feed.view?.bearing ?? 0));
  const zoomTo = (loaded: Loaded) => go(cameraFor(loaded.layer.bbox, bearing()));

  // A figure measured on a layer brings it back into view, shown, and the camera to it,
  // once the layer has loaded and the pane has its size.
  const focused = useRef(0);
  useEffect(() => {
    if (!focus || focus.n === focused.current || !ready) return;
    const loaded = layers.loaded.find(({ layer }) => layer.id === focus.id);
    if (!loaded) return;
    focused.current = focus.n;
    layers.reveal(focus.id);
    const timer = window.setTimeout(() => zoomTo(loaded), 50);
    return () => window.clearTimeout(timer);
  }, [focus?.n, layers.loaded, ready]);

  const places = useMemo<Place[]>(() => {
    const needs = (study?.needs ?? []).map((need) => ({ label: need.place, layer: "Engagement", at: toPoint(need.lat, need.lon) }));
    return [...placesOf(layers.listed), ...needs];
  }, [layers.listed, study?.needs]);
  const found = search(places, query);
  const searchBox = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (searching) searchBox.current?.focus();
  }, [searching]);
  const closeSearch = () => {
    setSearching(false);
    searchButton.current?.focus();
  };
  const goTo = (place: Place) => {
    go({ x: place.at[0], y: place.at[1], distance: PLACE_DISTANCE, pitch: 0.7, bearing: bearing() });
    setSearching(false);
  };

  const saveAll = () => {
    const features = layers.shown.flatMap(({ layer, collection }) => (collection?.features ?? []).map((feature) => ({ ...feature, properties: { ...feature.properties, layer: layer.title } })));
    const all: FeatureCollection = { type: "FeatureCollection", features };
    save(all, `${study?.id ?? "map"}-layers.geojson`);
  };

  const shownLine = ready && lineKey ? lines.current[lineKey] : undefined;
  const label = describe(study, Boolean(shownLine?.proposed?.length), layers.shown.length);
  const credits = [
    ...(imagery ? [IMAGERY_CREDIT] : []),
    ...(shownLine?.credit ? [shownLine.credit] : []),
    ...layers.shown.flatMap(({ layer }) => {
      const text = creditOf(layer);
      return text && layer.dataset ? [{ text, url: layer.dataset.url }] : [];
    }),
  ].filter((credit, i, all) => all.findIndex((c) => c.text === credit.text) === i);
  const key = study ? LINE_KEYS[study.id] : undefined;

  // Back to the study, and focus to the map, as the button goes.
  const resetView = (event: MouseEvent) => {
    const focused = document.activeElement === event.currentTarget;
    controls.reset();
    if (focused) (flat ? flatCanvas : glCanvas).current?.focus();
  };
  return (
    <div class="map-pane">
      {/* The map showing takes the keys and the gestures. */}
      <canvas ref={glCanvas} class={flat ? "map hidden" : "map"} role="application" aria-roledescription="map" aria-label={label} aria-describedby="map-keys" aria-hidden={flat} tabIndex={flat || ambient ? -1 : 0} />
      <canvas ref={flatCanvas} class={flat ? "map" : "map hidden"} role="application" aria-roledescription="map" aria-label={label} aria-describedby="map-keys" aria-hidden={!flat} tabIndex={flat && !ambient ? 0 : -1} />
      {/* Read only as the map's description, so not twice. */}
      <p id="map-keys" hidden>
        {moved && "You have moved the map. Home or Reset view goes back. "}
        Drag, scroll or use the arrow keys to move. Pinch, or plus and minus, to zoom. Shift with a drag or the arrow keys turns and tilts. Home goes back to the study.
      </p>
      {needsShown && <Needs study={study} feed={feed} canCreate={canCreate} onDetails={onNeed} onViewer={onViewer} />}

      <div class="map-top">
        <div class="map-toolbar" role="group" aria-label="Map tools">
          <Basemap imagery={imagery} network={networkShown} onImagery={setImagery} onNetwork={setNetworkShown} />
          <button ref={searchButton} type="button" class="tool" aria-label="Search the map" title="Search" aria-expanded={searching} aria-controls="map-search" onClick={() => (searching ? closeSearch() : setSearching(true))}>
            <LineIcon name="search" size={18} />
          </button>
          <button type="button" class="tool" aria-label="Refresh layers" title="Refresh layers" onClick={() => setRefreshed((n) => n + 1)}>
            <LineIcon name="reset" size={18} />
          </button>
          <button type="button" class="tool" aria-label="Engagement needs" title="Engagement needs" aria-pressed={needsShown} onClick={() => setNeedsShown(!needsShown)}>
            <LineIcon name="needs" size={18} />
          </button>
        </div>
        <div id="map-search" class="map-search" hidden={!searching} onKeyDown={(event) => event.key === "Escape" && closeSearch()}>
          <input
            ref={searchBox}
            type="search"
            value={query}
            aria-label="Find a place on the map"
            placeholder="Find a place"
            autocomplete="off"
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && found[0]) goTo(found[0]);
            }}
          />
          {query.trim() && (
            <ul aria-label="Places found">
              {found.map((place, i) => (
                <li key={`${place.label}-${place.layer}-${i}`}>
                  <button type="button" onClick={() => goTo(place)}>
                    <span>{place.label}</span>
                    <span class="layer">{place.layer}</span>
                  </button>
                </li>
              ))}
              {!found.length && <li class="none">No match</li>}
            </ul>
          )}
        </div>
        <Layers
          listed={layers.listed}
          fresh={freshLayers}
          hidden={(id) => !layers.shown.some(({ layer }) => layer.id === id)}
          removed={layers.removed}
          onToggle={layers.toggle}
          onZoom={zoomTo}
          onSave={(loaded) => loaded.collection && save(loaded.collection, fileName(loaded.layer))}
          onSaveAll={saveAll}
          onRemove={layers.remove}
          onRestore={layers.restore}
        />
      </div>

      <MapButtons controls={controls} onReset={resetView} />

      <div class="map-foot">
        {children}
        {(key || credits.length > 0) && (
          <div class="map-notes">
            {key && study && (
              <p class="key" style={{ "--line": `#${studyColor(study.line)}` }}>
                <span>
                  <span class="swatch" aria-hidden="true" />
                  <span class="sr-only">Solid line: </span>
                  {key[0]}
                </span>
                <span>
                  <span class="swatch dashed" aria-hidden="true" />
                  <span class="sr-only">Dashed line: </span>
                  {key[1]}
                </span>
              </p>
            )}
            {credits.map((credit) => (
              <a key={credit.text} class="credit" href={credit.url} target="_blank" rel="noopener noreferrer">
                {credit.text}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
