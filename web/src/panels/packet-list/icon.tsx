/** The Packet List glyph; the same drawing as `assets/packet-list.svg`, which the manifest names. */
export function PacketListIcon({ className }: { className?: string | undefined }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M7 13h2" />
      <path d="M12 13h5" />
      <path d="M7 16.5h2" />
      <path d="M12 16.5h5" />
    </svg>
  );
}

/** Shared props of the small line icons, drawn like the app's own (24-unit grid, 2-unit stroke). */
const LINE_ICON = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function SearchIcon() {
  return (
    <svg {...LINE_ICON} className="line-icon">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function ClearIcon() {
  return (
    <svg {...LINE_ICON} className="line-icon">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/** The app's error mark: a circled exclamation. */
export function ErrorIcon() {
  return (
    <svg {...LINE_ICON} className="line-icon">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}
