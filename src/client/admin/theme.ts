/**
 * 管理后台深色 / 浅色主题：
 * - 显式选择存 localStorage（"light" / "dark" / 未设置 = 跟随系统）；
 * - 通过 <html data-theme> 生效，CSS 里浅色为 :root 默认、深色为覆盖块；
 * - 切换时派发 "pd-theme-change" 事件，编辑器模块据此同步 Vditor 主题。
 */

const STORAGE_KEY = "pd-theme";
export const THEME_CHANGE_EVENT = "pd-theme-change";

export type Theme = "light" | "dark";

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 当前生效主题：显式选择优先，否则跟随系统 */
export function currentTheme(): Theme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return systemTheme();
}

/** 应用启动时尽早调用：把持久化的选择写到 <html>，避免渲染后再跳变 */
export function initTheme(): void {
  const stored = storedTheme();
  if (stored) {
    document.documentElement.dataset.theme = stored;
  }
}

export function setTheme(theme: Theme, persist: boolean): void {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // 忽略存储失败（隐私模式等）
    }
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
}

/** 在深 / 浅之间切换并持久化 */
export function toggleTheme(): void {
  setTheme(currentTheme() === "dark" ? "light" : "dark", true);
}
