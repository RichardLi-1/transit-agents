// The map's Basemap menu: the ground plain, in the page's light or dark, or as
// aerial photos; and the TTC network over it, on or off.
import { useEffect, useRef, useState } from "preact/hooks";
import { LineIcon } from "./icons.tsx";

const GROUNDS: [boolean, string][] = [
  [false, "Plain"],
  [true, "Imagery"],
];

type Props = {
  imagery: boolean;
  network: boolean;
  onImagery: (shown: boolean) => void;
  onNetwork: (shown: boolean) => void;
};

export function Basemap({ imagery, network, onImagery, onNetwork }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div class="basemap" onKeyDown={(event) => event.key === "Escape" && open && close()}>
      <button ref={button} type="button" class="tool wide" aria-expanded={open} aria-controls="basemap-menu" onClick={() => setOpen(!open)}>
        <LineIcon name="layers" size={18} />
        Basemap
      </button>
      <div id="basemap-menu" ref={menu} class="popover basemap-menu" hidden={!open}>
        <fieldset class="segmented">
          <legend>Ground</legend>
          <div class="options">
            {GROUNDS.map(([photos, label]) => (
              <label key={label}>
                <input type="radio" name="ground" value={label.toLowerCase()} checked={imagery === photos} onChange={() => onImagery(photos)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div class="switches">
          <button type="button" role="switch" aria-checked={network} onClick={() => onNetwork(!network)}>
            <span class="knob" aria-hidden="true" />
            TTC network
          </button>
        </div>
      </div>
    </div>
  );
}
