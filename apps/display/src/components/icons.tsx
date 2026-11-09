// A macOS-style folder, drawn here so no icon files are needed.
export function FolderIcon() {
  return (
    <svg viewBox="0 0 84 66" width="84" height="66" aria-hidden="true">
      <defs>
        <linearGradient id="folder-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#5eb1ee" />
          <stop offset="1" stop-color="#3f93dc" />
        </linearGradient>
        <linearGradient id="folder-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9ad8fd" />
          <stop offset="1" stop-color="#7cc6f7" />
        </linearGradient>
      </defs>
      <path d="M6 4h22c2 0 3.300.7 4.600 2l3.800 3.800c1.200 1.300 2.500 1.900 4.300 1.900H78a6 6 0 0 1 6 6V60a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6z" fill="url(#folder-back)" />
      <rect x="0" y="15" width="84" height="51" rx="6" fill="url(#folder-front)" />
      <rect x="0" y="60" width="84" height="1" fill="#6fb8ec" opacity=".5" />
    </svg>
  );
}

export function FileIcon({ label }: { label: string }) {
  return (
    <svg viewBox="0 0 56 66" width="56" height="66" aria-hidden="true">
      <path d="M4 0h32l20 20v42a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z" fill="#fff" stroke="#d2d2d7" />
      <path d="M36 0v16a4 4 0 0 0 4 4h16" fill="#f2f2f7" stroke="#d2d2d7" />
      <text x="28" y="50" font-size="11" text-anchor="middle" fill="#6e6e73" font-weight="600">
        {label}
      </text>
    </svg>
  );
}

// A macOS-style document: a white page with a folded corner and a coloured band
// for its kind, for a source that is one document rather than several. The band
// has no letters, so the source's name is all the text its link shows.
export function DocumentIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 56 66" width="56" height="66" aria-hidden="true">
      <path d="M5 .5h30l20.5 20.5V61a4.500 4.500 0 0 1-4.500 4.500H5A4.500 4.500 0 0 1 .5 61V5A4.500 4.500 0 0 1 5 .5z" fill="#fff" stroke="#d2d2d7" />
      <path d="M35 .5V16a5 5 0 0 0 5 5h15.500" fill="#f2f2f7" stroke="#d2d2d7" />
      <path d="M10 30h26M10 35h36M10 40h30" stroke="#e5e5ea" stroke-width="2" stroke-linecap="round" />
      <rect x="6" y="48" width="44" height="9" rx="3" fill={color} />
    </svg>
  );
}

const glyph = { fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M7 4.500v15l12-7.500z" fill="currentColor" />
  </svg>
);

export const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M7 4h3.500v16H7zM13.500 4H17v16h-3.500z" fill="currentColor" />
  </svg>
);

export const NowIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M5 4v16M19 5l-9 7 9 7z" {...glyph} />
  </svg>
);

export const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M12 19V5M6 11l6-6 6 6" {...glyph} />
  </svg>
);

export const PlusIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path d="M12 5v14M5 12h14" {...glyph} />
  </svg>
);

export const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M5 12.500l4.500 4.500L19 7.500" {...glyph} stroke-width="3" />
  </svg>
);

export const CrossIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" {...glyph} stroke-width="3" />
  </svg>
);

export const StaleIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M5 12h14" {...glyph} stroke-width="3" />
  </svg>
);

export const ImageIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <rect x="3" y="4.500" width="18" height="15" rx="2.500" {...glyph} />
    <path d="M3.500 17l5-5 4 4 2.500-2.500L20.500 19" {...glyph} />
    <circle cx="15.500" cy="9" r="1.600" fill="currentColor" />
  </svg>
);

export const VideoIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <rect x="2.500" y="6" width="13" height="12" rx="2.500" {...glyph} />
    <path d="M15.500 10.500l6-3.500v10l-6-3.500z" {...glyph} />
  </svg>
);

export const AlertIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <circle cx="12" cy="12" r="9" {...glyph} />
    <path d="M12 7.500v5.500" {...glyph} />
    <circle cx="12" cy="16.500" r="1.300" fill="currentColor" />
  </svg>
);

// The app's line icons: the rail, the tabs, the map's tools and a layer's row.
// Drawn on a 24 grid with one stroke, sized by `size`.
const LINES: Record<string, string> = {
  studies: "M4 6.5h16M4 12h16M4 17.5h10",
  spend: "M12 3.5v17M16.5 7.5c-.8-1.400-2.500-2-4.500-2-2.600 0-4.500 1.300-4.500 3.300 0 4.400 9.500 2.300 9.500 6.700 0 2-1.900 3.300-4.800 3.300-2.200 0-4-.8-4.800-2.300",
  system: "M5 5h14v9H5zM9 19h6M12 14v5",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.500 20.500c.9-3.600 3.900-5.500 7.500-5.500s6.600 1.900 7.500 5.500",
  study: "M7 3.500h7l4 4v13H7zM14 3.500v4h4M10 12h5M10 15.500h5",
  map: "M9 4.500L3.500 6.500v13L9 17.500l6 2 5.500-2v-13L15 6.500zM9 4.500v13M15 6.500v13",
  files: "M3.500 7a2 2 0 0 1 2-2h4l2 2.500h7a2 2 0 0 1 2 2v8.500a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  simulator: "M12 3.500v17M3.500 12h17M7 7l10 10M17 7L7 17",
  chat: "M5 6.500h14v9H10l-4 3v-3H5z",
  layers: "M12 4l8.500 4.500L12 13 3.500 8.500zM3.500 12.500L12 17l8.500-4.500M3.500 16.500L12 21l8.500-4.500",
  search: "M10.500 17a6.500 6.500 0 1 0 0-13 6.500 6.500 0 0 0 0 13zM15.500 15.500L20 20",
  reset: "M19.500 12a7.500 7.500 0 1 1-2.200-5.300M19.500 4.500v4h-4",
  needs: "M12 7.500a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.500 9.500h13M12 9.500v5M12 14.500l-3 6M12 14.500l3 6",
  download: "M12 4v11M7.500 10.500L12 15l4.500-4.500M5 19.500h14",
  eye: "M2.500 12s3.500-6.500 9.500-6.500S21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12zM12 14.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5z",
  hidden: "M4 4l16 16M9.900 6c.7-.3 1.400-.5 2.100-.5 6 0 9.500 6.500 9.500 6.500a17 17 0 0 1-2.600 3.400M6.400 7.700C3.900 9.500 2.500 12 2.500 12S6 18.500 12 18.500c1.600 0 3-.5 4.200-1.100M10 10.200a2.500 2.500 0 0 0 3.600 3.500",
  zoom: "M12 20.500s-6.500-5.900-6.500-11a6.500 6.500 0 0 1 13 0c0 5.100-6.500 11-6.500 11zM12 11.500a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  remove: "M6 6l12 12M18 6L6 18",
  chevron: "M6 9.500l6 6 6-6",
  open: "M14 4.500h5.500V10M19.500 4.500L11 13M17 14v5.500H4.500V7H10",
  plus: "M12 5v14M5 12h14",
  restore: "M4.500 12a7.500 7.500 0 1 0 2.200-5.300M4.500 4.500v4h4",
};

export function LineIcon({ name, size = 20 }: { name: keyof typeof LINES | string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={LINES[name] ?? ""} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
