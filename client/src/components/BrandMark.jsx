// Neutral product mark (not an Arthrex logo): a locating crosshair inside a tray outline.
export function BrandMark({ size = 26 }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <rect x="1.8" y="3.8" width="12.4" height="8.4" rx="1.6" />
        <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        <path d="M8 1v2.2M8 12.8V15" />
      </svg>
    </span>
  );
}
