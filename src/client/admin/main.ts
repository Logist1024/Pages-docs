/**
 * 管理后台 SPA 入口：只做装配。
 * 启动时恢复主题 → 探测登录态（顺带拉取站点品牌）→
 * 渲染登录页或主布局（顶栏 / 侧栏树 / 编辑器），
 * 并接好 hash 路由、搜索、历史抽屉、用量看板、面板拖拽调宽等模块。
 */
import "./styles.css";
import { initTheme, currentTheme, toggleTheme } from "./theme";
initTheme(); // 尽早应用持久化主题，避免渲染后跳变

import { ApiError, api, errMessage } from "./api";
import {
  applyExternalDetail,
  flushPendingChanges,
  getCurrentContent,
  getCurrentDocId,
  openDocument,
  renderEditorView,
  setEditorVisible,
  showEmpty,
} from "./editor";
import { icon } from "./icons";
import { initHistory } from "./history";
import { destroyMemo, initMemo } from "./memo";
import { initSearch } from "./search";
import { openSiteSettingsModal } from "./settings";
import { isAdmin, state } from "./state";
import { mountTree, openNewDocModal, openNewFolderModal, refreshDocs } from "./tree";
import { el, toast } from "./ui";
import { showUsageView } from "./usage";

const appRoot = document.getElementById("app");

/** 主内容区（renderApp 时赋值；路由切换用量看板 / 编辑器视图用） */
let contentEl: HTMLElement | null = null;

/**
 * window 级监听器只注册一次：renderApp 会随每次登录重新执行，
 * 重复注册会让 hashchange / 主题同步触发 N 次。闭包经模块级转发变量
 * 指向「当前渲染」的处理函数。
 */
let routeBound = false;
let themeSyncBound = false;
let themeSyncHandler: (() => void) | null = null;

/* ---------------- 品牌信息（站点名 / LOGO / 网站图标） ---------------- */

/** 用自定义 LOGO 元素或内置默认图标 */
function brandIcon(size: number): HTMLElement {
  if (state.brand.logo) {
    return el("img", {
      className: "brand-logo-img",
      attrs: { src: state.brand.logo, alt: "", width: String(size), height: String(size) },
    });
  }
  return icon("logo", size);
}

async function loadBrand(): Promise<void> {
  try {
    const s = await api.getSiteSettings();
    state.brand.siteName = s.site_name || "Pages Docs";
    state.brand.logo = s.logo;
    // 自定义 favicon：替换 <link rel=icon>（后台 SPA 静态页默认用内置图标）
    if (s.favicon) {
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.href = s.favicon;
    }
  } catch {
    // 拉取失败不影响后台可用性：保持默认品牌
  }
}

async function boot(): Promise<void> {
  if (!appRoot) return;
  // 品牌信息（公开接口）先行加载：登录页与主布局都要用 LOGO / 站点名
  const brandReady = loadBrand().catch(() => undefined);
  try {
    state.me = await api.me();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) {
      // 非 401（网络错误 / 5xx）也要有可见反馈
      toast(`初始化失败：${errMessage(e)}`, "error");
    }
    await brandReady; // 登录页也应用站点品牌（LOGO / 图标）
    renderLogin();
    return;
  }
  await brandReady;
  renderApp();
}

/* ---------------- 登录视图 ---------------- */

function renderLogin(): void {
  if (!appRoot) return;
  destroyMemo(); // 登出 / 未登录时移除备忘录浮窗
  appRoot.innerHTML = "";
  contentEl = null;

  const nameInput = el("input", {
    className: "field-input",
    attrs: { type: "text", name: "name", autocomplete: "username", placeholder: "用户名", required: "true" },
  });
  const passwordInput = el("input", {
    className: "field-input",
    attrs: { type: "password", name: "password", autocomplete: "current-password", placeholder: "密码", required: "true" },
  });
  const errorLine = el("div", { className: "login-error" });
  const submitBtn = el("button", {
    className: "btn btn-primary",
    text: "登 录",
    attrs: { type: "submit" },
  });

  const form = el("form", {
    onSubmit: (ev) => {
      ev.preventDefault();
      const name = nameInput.value.trim();
      const password = passwordInput.value;
      if (name.length === 0 || password.length === 0) {
        errorLine.textContent = "请输入用户名和密码";
        return;
      }
      submitBtn.disabled = true;
      errorLine.textContent = "";
      api.login(name, password)
        .then((me) => {
          // 登录响应已含 MeInfo，直接进入主布局
          state.me = me;
          renderApp();
        })
        .catch((e: unknown) => {
          errorLine.textContent = errMessage(e);
          submitBtn.disabled = false;
        });
    },
  }, [
    el("div", { className: "field" }, [nameInput]),
    el("div", { className: "field" }, [passwordInput]),
    errorLine,
    submitBtn,
  ]);

  appRoot.appendChild(
    el("div", { className: "login-page" }, [
      el("div", { className: "login-card" }, [
        el("div", { className: "login-brand" }, [
          brandIcon(28),
          el("span", { text: state.brand.siteName || "Pages Docs" }),
        ]),
        el("div", { className: "login-sub", text: "管理后台 · 请登录后继续" }),
        form,
      ]),
    ]),
  );

  nameInput.focus();
}

/* ---------------- 主布局 ---------------- */

function renderApp(): void {
  if (!appRoot) return;
  appRoot.innerHTML = "";

  /* 顶栏 */
  const searchInput = el("input", {
    className: "search-input",
    attrs: { type: "search", placeholder: "搜索文档…（Enter 搜索，Esc 关闭）", autocomplete: "off" },
  });
  const searchPanel = el("div", { className: "search-panel" });
  const searchBox = el("div", { className: "search-box" }, [
    icon("search", 15),
    searchInput,
    searchPanel,
  ]);

  const userChip = el("div", { className: "user-chip" }, [
    el("span", { className: "user-name", text: state.me?.name ?? "" }),
    state.me
      ? el("span", { className: `badge badge-role-${state.me.role}`, text: state.me.role })
      : null,
  ]);

  const logoutBtn = el("button", {
    className: "btn btn-ghost btn-sm",
    text: "退出登录",
    attrs: { type: "button" },
    onClick: () => void doLogout(),
  });

  const settingsBtn = el("button", {
    className: "btn btn-ghost btn-sm",
    text: "站点设置",
    attrs: { type: "button", title: "站点名称 / 品牌形象 / 页眉公告 / 导航栏" },
    onClick: () => openSiteSettingsModal(),
  });
  settingsBtn.insertBefore(icon("gear", 14), settingsBtn.firstChild);

  /* 主题切换：显示将要切换到的目标图标（深色时显示太阳，浅色时显示月亮） */
  const themeBtn = el("button", {
    className: "btn-icon",
    attrs: { type: "button", "aria-label": "切换深色 / 浅色模式", title: "切换深色 / 浅色模式" },
    onClick: () => toggleTheme(),
  });
  const themeIconSun = icon("sun", 17);
  const themeIconMoon = icon("moon", 17);
  const syncThemeIcons = (): void => {
    const dark = currentTheme() === "dark";
    themeIconSun.style.display = dark ? "" : "none";
    themeIconMoon.style.display = dark ? "none" : "";
  };
  syncThemeIcons();
  // 只注册一次 window 监听，经转发变量指向本次渲染的图标元素
  themeSyncHandler = syncThemeIcons;
  if (!themeSyncBound) {
    themeSyncBound = true;
    window.addEventListener("pd-theme-change", () => themeSyncHandler?.());
  }
  themeBtn.appendChild(themeIconSun);
  themeBtn.appendChild(themeIconMoon);

  const toggleBtn = el("button", {
    className: "btn-icon",
    attrs: { type: "button", "aria-label": "折叠 / 展开侧栏", title: "折叠 / 展开侧栏" },
    onClick: () => layout.classList.toggle("sidebar-collapsed"),
  });
  toggleBtn.appendChild(icon("menu", 18));

  const topbar = el("header", { className: "topbar" }, [
    toggleBtn,
    el("div", { className: "brand" }, [
      brandIcon(24),
      el("span", { text: state.me?.role === "admin" ? `${state.brand.siteName || "Pages Docs"} · 管理控制台` : state.brand.siteName || "Pages Docs" }),
    ]),
    searchBox,
    el("div", { className: "topbar-right" }, [
      userChip,
      isAdmin() ? settingsBtn : null,
      el("a", { className: "view-site-link", text: "查看站点", attrs: { href: "/", target: "_blank", rel: "noopener" } }),
      themeBtn,
      logoutBtn,
    ]),
  ]);

  /* 侧栏 */
  const treeWrap = el("div", { className: "tree-wrap" });
  const refreshBtn = el("button", {
    className: "btn-icon",
    attrs: { type: "button", title: "刷新文档列表", "aria-label": "刷新文档列表" },
    onClick: () => void refreshDocs(),
  });
  refreshBtn.appendChild(icon("refresh", 15));
  const newFolderBtn = el("button", {
    className: "btn btn-ghost btn-sm",
    text: "目录",
    attrs: { type: "button", title: "新建目录" },
    onClick: () => openNewFolderModal(),
  });
  newFolderBtn.insertBefore(icon("folder", 14), newFolderBtn.firstChild);
  const newDocBtn = el("button", {
    className: "btn btn-primary btn-sm",
    text: "文档",
    attrs: { type: "button", title: "新建文档" },
    onClick: () => openNewDocModal(),
  });
  newDocBtn.insertBefore(icon("plus", 14), newDocBtn.firstChild);
  const usageBtn = el("button", {
    className: "btn btn-ghost btn-sm",
    text: "用量",
    attrs: { type: "button", title: "Cloudflare 服务用量看板（D1 / R2 / KV）" },
    onClick: () => {
      location.hash = "#/usage";
    },
  });
  usageBtn.insertBefore(icon("chart", 14), usageBtn.firstChild);

  const sidebar = el("aside", { className: "sidebar" }, [
    el("div", { className: "sidebar-head" }, [
      el("span", { className: "sidebar-title", text: "文档" }),
      el("span", { className: "spacer" }),
      refreshBtn,
      isAdmin() ? usageBtn : null,
      newFolderBtn,
      newDocBtn,
    ]),
    treeWrap,
  ]);

  /* 主区 */
  const content = el("main", { className: "content" });
  contentEl = content;
  renderEditorView(content);

  /* 侧栏拖拽调宽手柄 */
  const sidebarResizer = el("div", {
    className: "sidebar-resizer",
    attrs: { role: "separator", "aria-orientation": "vertical", title: "拖拽调整侧栏宽度（双击复位）" },
  });

  const body = el("div", { className: "admin-body" }, [sidebar, sidebarResizer, content]);
  const layout = el("div", { className: "admin-layout" }, [topbar, body]);
  appRoot.appendChild(layout);

  setupSidebarResizer(sidebar, sidebarResizer);

  /* 模块装配 */
  initSearch(searchInput, searchPanel);
  initHistory({
    getCurrentDocId,
    getCurrentContent,
    beforeReload: flushPendingChanges,
    onRolledBack: applyExternalDetail,
  });
  mountTree(treeWrap);

  // hashchange 只注册一次；route 读取模块级 contentEl / state，重复注册会导致路由执行 N 次
  if (!routeBound) {
    routeBound = true;
    window.addEventListener("hashchange", route);
  }
  route();
  void refreshDocs();

  initMemo(); // 备忘录浮窗（登录后挂载，登出时在 renderLogin 中卸载）
}

async function doLogout(): Promise<void> {
  try {
    await api.logout();
  } catch (e) {
    toast(`退出登录失败：${errMessage(e)}`, "error");
  } finally {
    state.me = null;
    state.currentDocId = null;
    renderLogin();
  }
}

/* ---------------- 侧栏宽度拖拽 ---------------- */

const SIDEBAR_WIDTH_KEY = "pd-sidebar-w";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;

/** 恢复持久化的侧栏宽度（renderApp 时调用） */
export function restoreSidebarWidth(sidebar: HTMLElement): void {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
      sidebar.style.width = `${Math.round(saved)}px`;
    }
  } catch {
    // 忽略
  }
}

function setupSidebarResizer(sidebar: HTMLElement, handle: HTMLElement): void {
  restoreSidebarWidth(sidebar);

  let dragging = false;
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    dragging = true;
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const rect = sidebar.getBoundingClientRect();
    // 以手柄为参照（侧栏可能被折叠隐藏）：用指针相对 admin-body 左缘的位置
    const bodyRect = handle.parentElement?.getBoundingClientRect();
    if (!bodyRect || bodyRect.width <= 0) return;
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX - bodyRect.left));
    sidebar.style.width = `${Math.round(w)}px`;
  });
  const finish = (): void => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("col-resizing");
    try {
      const w = Number.parseFloat(sidebar.style.width);
      if (Number.isFinite(w)) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(w)));
    } catch {
      // 忽略
    }
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("dblclick", () => {
    sidebar.style.width = "";
    try {
      localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } catch {
      // 忽略
    }
  });
}

/* ---------------- hash 路由 ---------------- */

function route(): void {
  /* 用量看板视图 */
  if (location.hash === "#/usage") {
    if (!isAdmin()) {
      location.hash = "#/";
      return;
    }
    setEditorVisible(false);
    if (contentEl) showUsageView(contentEl, true);
    return;
  }

  if (contentEl) showUsageView(contentEl, false);
  setEditorVisible(true);

  const m = /^#\/doc\/(\d+)/.exec(location.hash);
  if (!m) {
    void showEmpty();
    return;
  }
  const id = Number(m[1]);
  if (state.currentDocId === id) return;
  void openDocument(id);
}

void boot();
