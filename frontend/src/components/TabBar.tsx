// Bottom tab bar — the app's primary navigation on phones and in the native
// iOS shell. Hidden on desktop web via CSS (see "Bottom tab bar" in index.css);
// desktop keeps the header ProfileMenu instead.
import type { JSX } from 'react';
import { hapticTap } from '../native';

export type MainTab = 'pets' | 'daily' | 'passports' | 'settings';

// Inline SVGs so the active tint (--accent) applies via currentColor — emoji
// can't be tinted and look off-brand next to iOS tab bars.
const ICONS: Record<MainTab, JSX.Element> = {
  pets: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="4.6" cy="10.2" r="2.1" />
      <circle cx="9.2" cy="6.4" r="2.3" />
      <circle cx="14.8" cy="6.4" r="2.3" />
      <circle cx="19.4" cy="10.2" r="2.1" />
      <path d="M12 10.4c-2.7 0-5 2.1-6.1 4.4-.8 1.7-.3 3.9 1.6 4.6 1.5.6 3-.2 4.5-.2s3 .8 4.5.2c1.9-.7 2.4-2.9 1.6-4.6-1.1-2.3-3.4-4.4-6.1-4.4z" />
    </svg>
  ),
  daily: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    </svg>
  ),
  // Passport-booklet: rounded card with a QR-ish mark.
  passports: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 2.5h12A2.5 2.5 0 0 1 20.5 5v14a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 19V5A2.5 2.5 0 0 1 6 2.5zm6 4.3a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm0 1.8a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM7.2 16.4h9.6v1.8H7.2z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
    </svg>
  ),
};

const LABELS: Record<MainTab, string> = {
  pets: 'Pets',
  daily: 'Daily',
  passports: 'Passport',
  settings: 'Settings',
};

// Settings is deliberately NOT a tab — it lives under the header avatar menu
// (Bevel-style). 'settings' stays in MainTab so the dashboard can mark no tab
// active while the Settings screen is up.
export function TabBar({
  active,
  onSelect,
}: {
  active: MainTab;
  onSelect: (tab: MainTab) => void;
}) {
  return (
    <nav className="tabbar" aria-label="Main">
      {(['pets', 'daily', 'passports'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          className={`tabbar__item${active === tab ? ' tabbar__item--active' : ''}`}
          aria-current={active === tab ? 'page' : undefined}
          onClick={() => {
            hapticTap();
            onSelect(tab);
          }}
        >
          {ICONS[tab]}
          <span className="tabbar__label">{LABELS[tab]}</span>
        </button>
      ))}
    </nav>
  );
}
