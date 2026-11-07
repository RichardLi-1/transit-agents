import { useEffect, useState } from "preact/hooks";

// The line from a number up to the folder it came from.
export function Thread({ from, folder }: { from: Element | null; folder: string | null }) {
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    const target = folder ? document.querySelector(`[data-folder="${CSS.escape(folder)}"]`) : null;
    if (!from || !target) {
      setPath(null);
      return;
    }
    const a = from.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const x1 = a.left + a.width / 2;
    const y1 = a.top;
    const x2 = b.left + b.width / 2;
    const y2 = b.bottom;
    const bend = (y1 - y2) * 0.55;
    setPath(`M${x1} ${y1} C${x1} ${y1 - bend} ${x2} ${y2 + bend} ${x2} ${y2}`);
  }, [from, folder]);

  if (!path) return null;
  return (
    <svg class="thread" aria-hidden="true">
      <path d={path} pathLength="1" />
    </svg>
  );
}
