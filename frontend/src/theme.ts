/** Light (default) or dark, remembered in this browser. */
export type Theme = "light" | "dark";
const THEME_KEY = "ui.theme";

export function initialTheme(): Theme {
  try { return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* the choice lasts this visit only */ }
}
