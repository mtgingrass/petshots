const KEY = 'petshots.theme';

export type Theme = 'dark' | 'light';

export function getSavedTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme | null) ?? 'dark';
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(KEY, theme);
}
