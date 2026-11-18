import { useId } from 'react';

/**
 * Arthroplasty Hero mark: a hero's shield holding a ball-and-socket joint
 * (the ball of a shoulder / hip replacement resting in its cup).
 * Original artwork, not an Arthrex logo.
 */
export function BrandMark({ size = 28 }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${id}-s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b78f2" />
          <stop offset="1" stopColor="#1640a8" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d6e3ff" />
        </linearGradient>
      </defs>
      {/* shield */}
      <path d="M16 1.8 27.6 6v8.6c0 7.4-4.9 13-11.6 15.6C9.3 27.6 4.4 22 4.4 14.6V6Z" fill={`url(#${id}-s)`} />
      <path d="M16 1.8 27.6 6v8.6c0 7.4-4.9 13-11.6 15.6C9.3 27.6 4.4 22 4.4 14.6V6Z" fill="none" stroke="#fff" strokeOpacity=".18" strokeWidth=".8" />
      {/* ball (implant head) */}
      <circle cx="16" cy="13.2" r="4.7" fill={`url(#${id}-b)`} />
      {/* socket (cup) cradling the ball */}
      <path d="M9.6 14.6a6.6 6.6 0 0 0 12.8 0" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
      {/* stem */}
      <path d="M16 22.6v2.6" stroke="#fff" strokeOpacity=".85" strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  );
}
