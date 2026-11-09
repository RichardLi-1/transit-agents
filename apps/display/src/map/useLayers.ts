// A study's map layers, from the GIS service: the list, each layer's GeoJSON in the
// map's metres, and which this viewer has hidden or taken off the map. Taking a
// layer off only hides it here: the log keeps every layer an agent added.
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api.ts";
import type { LayerShapes } from "./engine.ts";
import { colorOf, shapesOf, type FeatureCollection, type Layer } from "./layers.ts";

export type Loaded = { layer: Layer; color: string; collection: FeatureCollection | null; shapes: LayerShapes | null };

const KEY = "map.layers";

type Kept = { hidden: string[]; removed: string[] };

function read(studyId: string): Kept {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Kept>;
    const kept = all[studyId];
    return { hidden: Array.isArray(kept?.hidden) ? kept.hidden : [], removed: Array.isArray(kept?.removed) ? kept.removed : [] };
  } catch {
    return { hidden: [], removed: [] };
  }
}

function write(studyId: string, kept: Kept) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Kept>;
    localStorage.setItem(KEY, JSON.stringify({ ...all, [studyId]: kept }));
  } catch {
    // Kept for the page only.
  }
}

// `version` changes whenever an agent adds a layer, and on Refresh.
export function useLayers(studyId: string | null, reads: boolean, version: string) {
  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [kept, setKept] = useState<Kept>({ hidden: [], removed: [] });

  useEffect(() => {
    setKept(studyId ? read(studyId) : { hidden: [], removed: [] });
  }, [studyId]);

  useEffect(() => {
    if (!studyId || !reads) return setLoaded([]);
    let live = true;
    void (async () => {
      // Until the service has layers, it answers 404: no layers.
      const response = await api(`/v1/studies/${encodeURIComponent(studyId)}/layers`).catch(() => undefined);
      const listed = response?.ok ? ((await response.json().catch(() => null)) as { layers?: Layer[] } | null) : null;
      const layers = Array.isArray(listed?.layers) ? listed.layers : [];
      const all = await Promise.all(
        layers.map(async (layer, i): Promise<Loaded> => {
          const color = colorOf(layer, i);
          const geojson = await api(`/v1/studies/${encodeURIComponent(studyId)}/layers/${encodeURIComponent(layer.id)}/geojson`).catch(() => undefined);
          const collection = geojson?.ok ? ((await geojson.json().catch(() => null)) as FeatureCollection | null) : null;
          return { layer, color, collection, shapes: collection ? { id: layer.id, color, ...shapesOf(collection) } : null };
        }),
      );
      if (live) setLoaded(all);
    })();
    return () => {
      live = false;
    };
  }, [studyId, reads, version]);

  const change = (next: Kept) => {
    setKept(next);
    if (studyId) write(studyId, next);
  };
  const listed = useMemo(() => loaded.filter(({ layer }) => !kept.removed.includes(layer.id)), [loaded, kept.removed]);
  const shown = useMemo(() => listed.filter(({ layer }) => !kept.hidden.includes(layer.id)), [listed, kept.hidden]);

  return {
    loaded,
    listed,
    shown,
    removed: loaded.length - listed.length,
    toggle: (id: string) => change({ ...kept, hidden: kept.hidden.includes(id) ? kept.hidden.filter((h) => h !== id) : [...kept.hidden, id] }),
    remove: (id: string) => change({ ...kept, removed: [...kept.removed, id] }),
    restore: () => change({ ...kept, removed: [] }),
    // Shown, and back in the list if it was taken off.
    reveal: (id: string) => change({ hidden: kept.hidden.filter((h) => h !== id), removed: kept.removed.filter((r) => r !== id) }),
  };
}

// Saves GeoJSON as a file, as a download from the page.
export function save(collection: FeatureCollection, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(collection)], { type: "application/geo+json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
