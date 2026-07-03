const KEY = 'petshots.theme';

export type Theme = 'dark' | 'light';

export function getSavedTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme | null) ?? 'dark';
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(KEY, theme);
  // Keep the browser chrome (iOS status bar, Android toolbar) matching the app bg.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f4f5fa' : '#0f1220');
}
