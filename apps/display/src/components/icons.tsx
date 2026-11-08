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
