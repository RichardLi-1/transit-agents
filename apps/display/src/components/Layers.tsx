// The map's Layers panel, as Waypoint has it: each layer an agent added, with its
// colour, its name, and a button each to show or hide it, zoom to it, save its
// GeoJSON and take it off this viewer's map. Taken off is never deleted: the log
// keeps every layer, and Restore brings them back. Folded to a pill with its count,
// it opens by itself when an agent adds a layer.
import { useEffect, useState } from "preact/hooks";
import type { Loaded } from "../map/useLayers.ts";
import { LineIcon } from "./icons.tsx";

type Props = {
  listed: Loaded[];
  // The layers agents added since the page opened, by id, joined by commas.
  fresh: string;
  hidden: (id: string) => boolean;
  removed: number;
  onToggle: (id: string) => void;
  onZoom: (loaded: Loaded) => void;
  onSave: (loaded: Loaded) => void;
  onSaveAll: () => void;
  onRemove: (id: string) => void;
  onRestore: () => void;
};

const KIND = { points: "points", lines: "lines", polygons: "areas" } as const;
// Never by itself on a phone, where it would cover most of the map.
const phone = () => window.matchMedia("(max-width: 860px)").matches;

export function Layers({ listed, fresh, hidden, removed, onToggle, onZoom, onSave, onSaveAll, onRemove, onRestore }: Props) {
  const [open, setOpen] = useState(() => Boolean(fresh) && !phone());
  useEffect(() => {
    if (fresh && !phone()) setOpen(true);
  }, [fresh]);
  if (!listed.length && !removed) return null;
  return (
    <section class={open ? "layers-panel open" : "layers-panel"} aria-labelledby="layers-title">
      <header>
        <h2 id="layers-title">
          <button type="button" class="layers-fold" aria-expanded={open} aria-controls="layer-list" onClick={() => setOpen(!open)}>
            <LineIcon name="layers" size={18} />
            {`Layers (${listed.length})`}
            <LineIcon name="chevron" size={16} />
          </button>
        </h2>
        {open && removed > 0 && (
          <button type="button" class="tool" aria-label={`Restore ${removed} removed ${removed === 1 ? "layer" : "layers"}`} title="Restore" onClick={onRestore}>
            <LineIcon name="restore" size={16} />
          </button>
        )}
        {open && listed.length > 0 && (
          <button type="button" class="tool" aria-label="Download shown layers" title="Download" onClick={onSaveAll}>
            <LineIcon name="download" size={16} />
          </button>
        )}
      </header>
      <ul id="layer-list" hidden={!open}>
        {listed.map((loaded) => {
          const { layer, color, collection } = loaded;
          const off = hidden(layer.id);
          return (
            <li key={layer.id} class={off ? "off" : undefined}>
              <span class="swatch" style={{ background: `#${color}` }} aria-hidden="true" />
              <span class="name" title={layer.title}>
                {layer.title}
                <span class="sr-only">{`, ${layer.featureCount} ${KIND[layer.kind] ?? "features"}${off ? ", hidden" : ""}`}</span>
              </span>
              <button type="button" class="tool" aria-pressed={!off} aria-label={`Show ${layer.title}`} title={off ? "Show" : "Hide"} onClick={() => onToggle(layer.id)}>
                <LineIcon name={off ? "hidden" : "eye"} size={16} />
              </button>
              <button type="button" class="tool" aria-label={`Zoom to ${layer.title}`} title="Zoom to" onClick={() => onZoom(loaded)}>
                <LineIcon name="zoom" size={16} />
              </button>
              <button type="button" class="tool" aria-label={`Download ${layer.title}`} title="Download GeoJSON" disabled={!collection} onClick={() => onSave(loaded)}>
                <LineIcon name="download" size={16} />
              </button>
              <button type="button" class="tool" aria-label={`Remove ${layer.title} from view`} title="Remove from view" onClick={() => onRemove(layer.id)}>
                <LineIcon name="remove" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
