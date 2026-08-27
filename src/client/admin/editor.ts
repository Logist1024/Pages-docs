/**
 * 编辑器视图：Vditor 集成、自动保存（2s 防抖、单在途请求合并）、
 * 冲突处理、发布/取消发布、移动改名、删除、更多菜单。
 */
import Vditor from "vditor";
import "vditor/dist/index.css";
// 本地打包 hljs 暗色主题：Vditor 默认从 CDN 拉取样式，会被 CSP 拦截，
// 这里直接引入保证分屏预览里的代码高亮可用。
import "highlight.js/styles/github-dark.css";
import type { ConflictPayload, DocumentDetail, DocStatus } from "../../shared/types";
import { ApiError, api, errMessage, getConflictPayload } from "./api";
import { showConflictModal } from "./conflict";
import { icon } from "./icons";
import { openHistoryDrawer } from "./history";
import { openSessionsModal } from "./sessions";
import { isAdmin, state } from "./state";
import { THEME_CHANGE_EVENT, currentTheme } from "./theme";
import { buildFolderSelect, normalizePathInput, refreshDocs, setActiveDoc, validateDocPath } from "./tree";
import { el, confirmDialog, formatClock, openModal, promptTextModal, toast } from "./ui";

/* ---------------- 模块级状态 ---------------- */

let container: HTMLElement | null = null;
let view: HTMLElement | null = null;
let emptyState: HTMLElement | null = null;
let titleInput: HTMLInputElement | null = null;
let statusBadge: HTMLElement | null = null;
let saveStatusEl: HTMLElement | null = null;
let publishBtn: HTMLButtonElement | null = null;
let unpublishBtn: HTMLButtonElement | null = null;
let vditorMount: HTMLElement | null = null;
let vditorHost: HTMLElement | null = null;

/** document/window 级监听器只绑定一次的标记（renderEditorView 可能多次执行） */
let globalListenersBound = false;

let vditor: Vditor | null = null;
let vditorReady: Promise<void> | null = null;

/** 当前打开的文档；null 表示空状态。所有保存闭包都以此做「仍是当前文档」校验 */
let docId: number | null = null;
let currentPath = "";
let currentStatus: DocStatus | null = null;
let revisionSeq = 0;
let dirty = false;
/** 冲突模态框打开期间暂停自动保存 */
let paused = false;
/** setValue / 程序化填充期间抑制 input 触发的保存调度 */
let suppressInput = false;

let timer: number | null = null;
let inFlightPromise: Promise<void> | null = null;
let queued = false;
/** 正在等待在途请求完成以便切换文档；期间禁止链式补发 */
let switching = false;
let lastSaveFailed = false;
/** 打开请求的代际令牌：快速连点文档时丢弃过期响应 */
let openToken = 0;

let lastSavedTitle = "";
/** 当前发布快照（标题 + 正文）：用于「有未发布修改 → 才显示发布按钮」的检测 */
let publishedTitle: string | null = null;
let publishedContent: string | null = null;

type SaveStatusKind = "idle" | "unsaved" | "saving" | "saved" | "failed" | "conflict";

/* ---------------- 视图构建 ---------------- */

/** 装配编辑器视图（顶栏工具行 + Vditor 容器 + 空状态）。重新登录等场景可能再次调用。 */
export function renderEditorView(parent: HTMLElement): void {
  // 重建前先清理旧实例与状态（登出 → 再登录会重走这里）
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (vditor) {
    try {
      vditor.destroy();
    } catch {
      // 忽略销毁异常（DOM 可能已被移除）
    }
  }
  vditor = null;
  vditorReady = null;
  vditorMount = null;
  inFlightPromise = null;
  queued = false;
  switching = false;
  docId = null;
  currentPath = "";
  currentStatus = null;
  revisionSeq = 0;
  dirty = false;
  paused = false;
  suppressInput = false;
  lastSaveFailed = false;
  lastSavedTitle = "";
  publishedTitle = null;
  publishedContent = null;
  lastContent = "";
  lastTitle = "";
  if (contentCheckTimer !== null) {
    window.clearInterval(contentCheckTimer);
    contentCheckTimer = null;
  }
  openToken++;

  container = parent;

  emptyState = el("div", { className: "empty-state" }, [
    icon("doc", 44),
    el("div", { className: "empty-title", text: "尚未选择文档" }),
    el("div", { className: "empty-hint", text: "从左侧选择一篇文档开始编辑，或点击「文档」创建。" }),
  ]);

  statusBadge = el("span", { className: "badge badge-draft", text: "草稿" });

  titleInput = el("input", {
    className: "doc-title-input",
    attrs: { type: "text", placeholder: "无标题文档", autocomplete: "off", disabled: "true" },
    onInput: () => markDirty(),
  });

  saveStatusEl = el("span", { className: "save-status" });

  publishBtn = el("button", {
    className: "btn btn-primary",
    text: "发布",
    attrs: { type: "button" },
    onClick: () => void onPublishClick(),
  });

  unpublishBtn = el("button", {
    className: "btn btn-danger-outline",
    text: "取消发布",
    attrs: { type: "button" },
    onClick: () => void onUnpublishClick(),
  });
  unpublishBtn.style.display = "none";

  const historyBtn = el("button", {
    className: "btn",
    text: "历史",
    attrs: { type: "button" },
    onClick: () => openHistoryDrawerSafely(),
  });
  historyBtn.insertBefore(icon("history", 14), historyBtn.firstChild);

  const moreWrap = buildMoreMenu();

  const toolbar = el("div", { className: "editor-toolbar" }, [
    statusBadge,
    titleInput,
    saveStatusEl,
    moreWrap.spacer,
    publishBtn,
    unpublishBtn,
    historyBtn,
    moreWrap.root,
  ]);

  vditorHost = el("div", { className: "vditor-host" }, [
    el("div", { className: "vditor-mount" }),
    el("div", { className: "vditor-loading" }, [
      el("div", { className: "loading-spinner" }),
      el("span", { text: "编辑器初始化中…" }),
    ]),
  ]);
  const mountPoint = vditorHost.querySelector(".vditor-mount");
  if (!(mountPoint instanceof HTMLElement)) {
    throw new Error("vditor mount point missing");
  }

  view = el("section", { className: "editor-view" }, [toolbar, vditorHost]);
  view.style.display = "none";

  container.appendChild(emptyState);
  container.appendChild(view);
  vditorMount = mountPoint;

  // 全局监听器只注册一次：renderEditorView 会随每次登录重新执行，
  // 重复注册会导致 Ctrl+S / beforeunload 触发 N 次
  if (!globalListenersBound) {
    globalListenersBound = true;

    // ⌘/Ctrl+S 立即保存
    document.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === "s") {
        if (docId === null) return;
        ev.preventDefault();
        void requestSaveNow();
      }
    });

    // 有未保存改动时拦截页面关闭
    window.addEventListener("beforeunload", (ev) => {
      if (dirty) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    });
  }
}

function showView(which: "empty" | "editor"): void {
  if (!container || !view || !emptyState) return;
  emptyState.style.display = which === "empty" ? "flex" : "none";
  view.style.display = which === "editor" ? "flex" : "none";
}

/** 用量看板等全页视图切换时隐藏编辑器两个子视图；visible=true 时按当前状态恢复 */
export function setEditorVisible(visible: boolean): void {
  if (!visible) {
    if (view) view.style.display = "none";
    if (emptyState) emptyState.style.display = "none";
    return;
  }
  showView(docId === null ? "empty" : "editor");
}

/* ---------------- 更多菜单 ---------------- */

function buildMoreMenu(): { root: HTMLElement; spacer: HTMLElement } {
  const dropdown = el("div", { className: "menu-dropdown" });

  const renameItem = el("button", {
    className: "menu-item",
    text: "移动 / 改名…",
    attrs: { type: "button" },
    onClick: () => {
      closeMenu();
      openMoveRenameModal();
    },
  });
  dropdown.appendChild(renameItem);

  if (isAdmin()) {
    dropdown.appendChild(
      el("button", {
        className: "menu-item",
        text: "会话管理…",
        attrs: { type: "button" },
        onClick: () => {
          closeMenu();
          openSessionsModal();
        },
      }),
    );
    dropdown.appendChild(el("div", { className: "menu-sep" }));
    dropdown.appendChild(
      el("button", {
        className: "menu-item danger",
        text: "删除文档…",
        attrs: { type: "button" },
        onClick: () => {
          closeMenu();
          void onDeleteDocument();
        },
      }),
    );
  }

  const moreBtn = el("button", {
    className: "btn btn-ghost",
    text: "更多",
    attrs: { type: "button", "aria-haspopup": "true" },
  });
  moreBtn.appendChild(icon("chevronDown", 14));

  const root = el("div", { className: "editor-more" }, [moreBtn, dropdown]);

  const onOutsideClick = (ev: MouseEvent): void => {
    if (!root.contains(ev.target as Node)) closeMenu();
  };
  const closeMenu = (): void => {
    dropdown.classList.remove("open");
    document.removeEventListener("click", onOutsideClick);
  };

  moreBtn.onclick = () => {
    const opening = !dropdown.classList.contains("open");
    if (opening) {
      dropdown.classList.add("open");
      window.setTimeout(() => document.addEventListener("click", onOutsideClick), 0);
    } else {
      closeMenu();
    }
  };

  const spacer = el("div", { className: "toolbar-spacer" });
  spacer.style.flex = "1";
  return { root, spacer };
}

/* ---------------- Vditor ---------------- */

/** 当前控制台主题映射到 Vditor 的主题值（classic = 浅色） */
function vditorThemeOption(): "dark" | "classic" {
  return currentTheme() === "dark" ? "dark" : "classic";
}

/** 主题切换时同步已挂载的 Vditor 实例（仅切 class，不触发 CDN 资源加载；配色由 CSS 变量接管） */
function syncVditorTheme(): void {
  if (!vditor) return;
  try {
    vditor.setTheme(vditorThemeOption());
  } catch {
    // 忽略销毁后调用等异常
  }
}

let themeListenerBound = false;
function bindThemeListener(): void {
  if (themeListenerBound) return;
  themeListenerBound = true;
  window.addEventListener(THEME_CHANGE_EVENT, syncVditorTheme);
}

function ensureVditor(): Promise<void> {
  if (!vditorReady) {
    vditorReady = new Promise<void>((resolve) => {
      if (!vditorMount) {
        resolve();
        return;
      }
      bindThemeListener();
      vditor = new Vditor(vditorMount, {
        // 默认分屏模式：左侧源码编辑、右侧实时预览，铺满整个编辑区。
        // 工具栏的「编辑模式」按钮可在 分屏 / 即时渲染 / 所见即所得 间切换。
        mode: "sv",
        theme: vditorThemeOption(),
        height: "100%",
        cache: { enable: false },
        counter: { enable: true },
        placeholder: "开始编写 Markdown…（⌘/Ctrl + S 立即保存）",
        lang: "zh_CN",
        preview: {
          // 预览内容配色由 styles.css 映射的 CSS 变量跟随控制台主题，
          // 不引入 content-theme CDN 样式（CSP 禁止外部样式表）。
          hljs: { style: "github-dark" },
          // 仅保留预览宽度切换；移除「复制到公众号 / 复制到知乎」按钮
          actions: ["desktop", "tablet", "mobile"],
        },
        toolbar: [
          "edit-mode",
          "|",
          "headings",
          "bold",
          "italic",
          "strike",
          "link",
          "|",
          "list",
          "ordered-list",
          "check",
          "quote",
          "inline-code",
          "code",
          "table",
          "|",
          "undo",
          "redo",
          "|",
          "upload",
          "|",
          "fullscreen",
        ],
        upload: {
          accept: "image/*",
          // 返回 null 阻止 Vditor 内置 XHR，改由自定义逻辑逐个上传。
          // （返回 "" 同样会阻止默认上传，但会令 Vditor 弹出一个空的 tip 气泡）
          handler: (files) => {
            void uploadFiles(files);
            return null;
          },
        },
        after: () => {
          stripPreviewCopyButtons();
          const loading = vditorHost?.querySelector(".vditor-loading");
          if (loading) (loading as HTMLElement).style.display = "none";
          if (titleInput) titleInput.disabled = false;
          resolve();
        },
        input: () => markDirty(),
      });
      setupSplitResizer();
    });
  }
  return vditorReady;
}

/**
 * 移除预览面板的「复制到公众号 / 复制到知乎」按钮：
 * preview.actions 已排除二者，这里对 DOM 再做一次兜底清理（并把
 * 「Mobile/Wechat」文案改为「Mobile」），避免版本差异导致入口残留。
 */
function stripPreviewCopyButtons(): void {
  if (!vditorMount) return;
  vditorMount
    .querySelectorAll<HTMLButtonElement>(
      '.vditor-preview__action button[data-type="mp-wechat"], .vditor-preview__action button[data-type="zhihu"]'
    )
    .forEach((btn) => btn.remove());
  const mobileBtn = vditorMount.querySelector<HTMLButtonElement>(
    '.vditor-preview__action button[data-type="mobile"]'
  );
  if (mobileBtn && mobileBtn.textContent !== "Mobile") mobileBtn.textContent = "Mobile";
}

/* ---------------- 编辑区 / 预览区分屏拖拽 ---------------- */

const SPLIT_STORAGE_KEY = "pd-editor-split-pct";

/**
 * 在 Vditor 分屏（sv + 预览）的两个面板之间插入可拖拽分隔条：
 * - 拖动调整源码区宽度占比（20%–80%），双击恢复 50/50；
 * - 比例持久化到 localStorage，跨会话生效；
 * - 通过 MutationObserver 跟随 Vditor 的模式切换，仅分屏时显示。
 */
function setupSplitResizer(): void {
  if (!vditorMount) return;
  const content = vditorMount.querySelector<HTMLElement>(".vditor-content");
  const sv = vditorMount.querySelector<HTMLElement>(".vditor-sv");
  const preview = vditorMount.querySelector<HTMLElement>(".vditor-preview");
  if (!content || !sv || !preview || content.querySelector(".pd-split-handle")) return;

  let pct = 50;
  try {
    const saved = Number(localStorage.getItem(SPLIT_STORAGE_KEY));
    if (Number.isFinite(saved) && saved >= 20 && saved <= 80) pct = saved;
  } catch {
    // 忽略存储不可用
  }

  const applyPct = (): void => {
    sv.style.flexGrow = "0";
    sv.style.flexShrink = "0";
    sv.style.flexBasis = `${pct}%`;
  };
  applyPct();

  const handle = document.createElement("div");
  handle.className = "pd-split-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.title = "拖拽调整编辑区 / 预览区宽度（双击复位）";
  content.insertBefore(handle, preview);

  const syncVisibility = (): void => {
    const visible = sv.style.display !== "none" && preview.style.display !== "none";
    handle.style.display = visible ? "" : "none";
  };
  const mo = new MutationObserver(syncVisibility);
  mo.observe(sv, { attributes: true, attributeFilter: ["style"] });
  mo.observe(preview, { attributes: true, attributeFilter: ["style"] });
  syncVisibility();

  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!handle.classList.contains("dragging")) return;
    const rect = content.getBoundingClientRect();
    if (rect.width <= 0) return;
    pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
    applyPct();
  });
  const finishDrag = (): void => {
    if (!handle.classList.contains("dragging")) return;
    handle.classList.remove("dragging");
    document.body.classList.remove("col-resizing");
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(pct)));
    } catch {
      // 忽略
    }
  };
  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
  handle.addEventListener("dblclick", () => {
    pct = 50;
    applyPct();
    try {
      localStorage.setItem(SPLIT_STORAGE_KEY, "50");
    } catch {
      // 忽略
    }
  });
}

async function uploadFiles(files: File[]): Promise<void> {
  const targetId = docId;
  for (const file of files) {
    try {
      const res = await api.upload(file);
      if (docId !== targetId) continue; // 上传期间已切换文档，丢弃结果
      // 文件名进入 alt 文本：转义反斜杠与方括号，避免破坏图片语法
      const alt = file.name.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      vditor?.insertValue(`![${alt}](${res.url})`);
      toast(`已上传 ${file.name}`, "success");
    } catch (e) {
      toast(`上传失败（${file.name}）：${errMessage(e)}`, "error");
    }
  }
}

/* ---------------- 保存状态显示 ---------------- */

function setSaveStatus(kind: SaveStatusKind, savedAt?: number): void {
  if (!saveStatusEl) return;
  saveStatusEl.className = `save-status st-${kind}`;
  switch (kind) {
    case "idle":
      saveStatusEl.textContent = "";
      break;
    case "unsaved":
      saveStatusEl.textContent = "未保存";
      break;
    case "saving":
      saveStatusEl.textContent = "保存中…";
      break;
    case "saved":
      saveStatusEl.textContent = `已保存 ${formatClock(savedAt ?? Date.now())}`;
      break;
    case "failed":
      saveStatusEl.textContent = "保存失败";
      break;
    case "conflict":
      saveStatusEl.textContent = "保存冲突";
      break;
  }
}

function setStatusBadge(status: DocStatus): void {
  if (!statusBadge) return;
  statusBadge.className = status === "published" ? "badge badge-published" : "badge badge-draft";
  statusBadge.textContent = status === "published" ? "已发布" : "草稿";
}

/**
 * 发布按钮可见性：
 * - 草稿：常驻「发布」；
 * - 已发布：仅当存在未发布的修改（本地未保存改动，或已保存草稿与发布快照不一致）
 *   时显示「更新发布」，与线上一致时不渲染按钮。
 */
function refreshPublishButton(): void {
  if (!publishBtn || !unpublishBtn || docId === null) return;
  if (currentStatus === "published") {
    publishBtn.textContent = "更新发布";
    const changed =
      dirty ||
      (titleInput?.value ?? "") !== (publishedTitle ?? "") ||
      (vditor?.getValue() ?? "") !== (publishedContent ?? "");
    publishBtn.style.display = changed ? "" : "none";
    unpublishBtn.style.display = "";
  } else {
    publishBtn.textContent = "发布";
    publishBtn.style.display = "";
    unpublishBtn.style.display = "none";
  }
}

/* ---------------- 自动保存核心 ---------------- */

let lastContent = "";
let lastTitle = "";
let contentCheckTimer: number | null = null;

function markDirty(): void {
  if (suppressInput || docId === null) return;
  if (!dirty) {
    dirty = true;
    setSaveStatus("unsaved");
    refreshPublishButton();
    lastContent = vditor?.getValue() ?? "";
    lastTitle = titleInput?.value ?? "";
  }
  scheduleSave();
  startContentCheck();
}

function startContentCheck(): void {
  if (contentCheckTimer !== null) return;
  contentCheckTimer = window.setInterval(() => {
    if (docId === null || !dirty) {
      if (contentCheckTimer !== null) {
        window.clearInterval(contentCheckTimer);
        contentCheckTimer = null;
      }
      return;
    }
    const currentContent = vditor?.getValue() ?? "";
    const currentTitle = titleInput?.value ?? "";
    if (currentContent === lastContent && currentTitle === lastTitle) {
      dirty = false;
      setSaveStatus("idle");
      refreshPublishButton();
      if (contentCheckTimer !== null) {
        window.clearInterval(contentCheckTimer);
        contentCheckTimer = null;
      }
    } else {
      lastContent = currentContent;
      lastTitle = currentTitle;
    }
  }, 3000);
}

function scheduleSave(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void flushSave();
  }, 2000);
}

/** 用户主动触发（⌘S / 发布前）：脏或有在途请求时立即保存 */
async function requestSaveNow(): Promise<void> {
  if (docId === null) return;
  if (paused) {
    toast("请先处理保存冲突", "error");
    return;
  }
  if (dirty || inFlightPromise) await flushSave();
}

/**
 * 执行一次保存。
 * - 已有在途请求时只置 queued 标记（最新内容会在下一轮读取，天然合并）；
 * - 闭包持有发起时的 docId，await 返回后校验仍是当前文档才落本地状态，
 *   避免切走后误写新文档的 revision_seq。
 */
function flushSave(): Promise<void> {
  if (docId === null) return Promise.resolve();
  if (inFlightPromise) {
    queued = true;
    return inFlightPromise;
  }
  if (paused) return Promise.resolve();
  if (!dirty) return Promise.resolve();

  const id = docId;
  const baseSeq = revisionSeq;
  const title = titleInput?.value ?? "";
  const content = vditor?.getValue() ?? "";

  lastSaveFailed = false;
  setSaveStatus("saving");
  lastContent = content;
  lastTitle = title;

  const p = (async () => {
    try {
      const res = await api.updateDoc(id, {
        base_revision_seq: baseSeq,
        title,
        content_md: content,
      });
      if (docId !== id) return; // 已切走：丢弃旧文档的结果
      revisionSeq = res.revision_seq;
      lastSavedTitle = title;
      dirty = false;
      // 在途期间用户又输入了内容则仍视为脏
      dirty = (vditor?.getValue() ?? "") !== content || (titleInput?.value ?? "") !== title;
      setSaveStatus("saved", res.saved_at);
      refreshPublishButton();
      if (dirty) scheduleSave();
    } catch (e) {
      if (docId !== id) return;
      dirty = true;
      const conflict = getConflictPayload(e);
      if (conflict) {
        handleConflict(conflict, title, content);
      } else {
        lastSaveFailed = true;
        setSaveStatus("failed");
        toast(`保存失败：${errMessage(e)}`, "error");
      }
    }
  })();

  inFlightPromise = p.finally(() => {
    inFlightPromise = null;
    if (switching) {
      queued = false;
      return;
    }
    if (queued) {
      queued = false;
      if (dirty && docId !== null && !paused && !lastSaveFailed) void flushSave();
    }
  });
  return inFlightPromise;
}

/**
 * 切换文档前收敛所有未落盘的修改。
 * @returns false 表示无法安全切换（保存失败或冲突未处理），调用方应留在当前文档。
 */
async function settlePending(): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (!dirty && !inFlightPromise) break;
    if (paused || docId === null) break;
    if (lastSaveFailed) break;
    switching = true;
    try {
      await flushSave();
    } finally {
      switching = false;
    }
    queued = false;
  }
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  queued = false;

  if (dirty && docId !== null) {
    if (lastSaveFailed) {
      toast("当前文档有未保存的修改，且刚才保存失败，已停留在当前文档", "error");
      return false;
    }
    if (paused) {
      toast("请先处理保存冲突，再切换文档", "error");
      return false;
    }
    // 循环耗尽仍为脏（在途保存期间又有输入）：再追赶一轮；
    // 若仍未落盘（用户持续输入中），阻止切换避免静默丢稿
    switching = true;
    try {
      await flushSave();
    } finally {
      switching = false;
    }
    queued = false;
    if (dirty && docId !== null) {
      toast("正在保存当前文档的修改，请稍候再切换", "error");
      return false;
    }
  }
  return true;
}

/* ---------------- 冲突处理 ---------------- */

function handleConflict(payload: ConflictPayload, localTitle: string, localContent: string): void {
  paused = true;
  dirty = true;
  setSaveStatus("conflict");
  showConflictModal(payload, localTitle, localContent, {
    overwriteMine: (baseSeq) => resolveConflictWithLocal(baseSeq, localTitle, localContent),
    adoptServer: () => adoptServerVersion(payload),
    mergeWith: (merged, baseSeq) =>
      resolveConflictWithLocal(baseSeq, titleInput?.value ?? localTitle, merged),
  });
}

/** 用给定 base 序号提交本地内容（覆盖 / 手动合并共用） */
async function resolveConflictWithLocal(baseSeq: number, title: string, content: string): Promise<void> {
  const id = docId;
  if (id === null) return;
  setSaveStatus("saving");
  try {
    const res = await api.updateDoc(id, {
      base_revision_seq: baseSeq,
      title,
      content_md: content,
    });
    revisionSeq = res.revision_seq;
    lastSavedTitle = title;
    dirty = (vditor?.getValue() ?? "") !== content || (titleInput?.value ?? "") !== title;
    paused = false;
    lastSaveFailed = false;
    setSaveStatus("saved", res.saved_at);
    refreshPublishButton();
    toast("冲突已解决并保存", "success");
  } catch (e) {
    const conflict = getConflictPayload(e);
    if (conflict) {
      // 他人又抢先保存了：用最新服务器内容再次进入冲突流程（旧弹窗会被关闭）
      toast("冲突仍未解决，服务器又有新修改", "error");
      handleConflict(conflict, title, content);
    } else {
      paused = false;
      lastSaveFailed = true;
      setSaveStatus("failed");
      toast(`保存失败：${errMessage(e)}`, "error");
    }
  }
}

function adoptServerVersion(payload: ConflictPayload): void {
  suppressInput = true;
  vditor?.setValue(payload.current.content_md, true);
  if (titleInput) titleInput.value = payload.current.title;
  suppressInput = false;

  revisionSeq = payload.current.revision_seq;
  lastSavedTitle = payload.current.title;
  dirty = false;
  paused = false;
  lastSaveFailed = false;
  setSaveStatus("saved", payload.current.updated_at);
  refreshPublishButton();
  toast("已采用服务器版本", "success");
}

/* ---------------- 文档打开 / 关闭 ---------------- */

async function applyDetail(detail: DocumentDetail): Promise<void> {
  await ensureVditor();
  suppressInput = true;
  docId = detail.id;
  currentPath = detail.path;
  currentStatus = detail.status;
  revisionSeq = detail.revision_seq;
  dirty = false;
  paused = false;
  queued = false;
  lastSaveFailed = false;
  lastSavedTitle = detail.title;
  publishedTitle = detail.published_title;
  publishedContent = detail.published_content_md;
  lastContent = detail.content_md;
  lastTitle = detail.title;
  vditor?.setValue(detail.content_md, true);
  if (titleInput) {
    titleInput.value = detail.title;
    titleInput.disabled = false;
  }
  setStatusBadge(detail.status);
  refreshPublishButton();
  setSaveStatus("saved", detail.updated_at);
  suppressInput = false;
}

/** 打开文档（hash 路由入口）。重复打开同一文档为 no-op。 */
export async function openDocument(id: number): Promise<void> {
  if (state.currentDocId === id && docId === id) return;
  const token = ++openToken;

  const ok = await settlePending();
  if (!ok) {
    // 无法安全离开当前文档：恢复 hash 停留原地
    if (docId !== null) location.hash = `#/doc/${docId}`;
    return;
  }
  if (token !== openToken) return;

  try {
    const detail = await api.getDoc(id);
    if (token !== openToken) return;
    state.currentDocId = id;
    showView("editor");
    await applyDetail(detail);
    setActiveDoc(id);
  } catch (e) {
    if (token !== openToken) return;
    toast(`打开文档失败：${errMessage(e)}`, "error");
    if (e instanceof ApiError && e.status === 404) {
      // 文档不存在或已删除：修正 URL 并回到空状态
      location.hash = "#/";
      await showEmpty();
    }
  }
}

/** 回到空状态（未选中文档） */
export async function showEmpty(): Promise<void> {
  openToken++;
  const ok = await settlePending();
  if (!ok) {
    if (docId !== null) location.hash = `#/doc/${docId}`;
    return;
  }
  docId = null;
  currentPath = "";
  currentStatus = null;
  state.currentDocId = null;
  lastContent = "";
  lastTitle = "";
  if (contentCheckTimer !== null) {
    window.clearInterval(contentCheckTimer);
    contentCheckTimer = null;
  }
  showView("empty");
}

/* ---------------- 发布 / 取消发布 ---------------- */

/** 发布流程期间同时禁用两个按钮，避免并发触发 */
function setActionButtonsDisabled(disabled: boolean): void {
  if (publishBtn) publishBtn.disabled = disabled;
  if (unpublishBtn) unpublishBtn.disabled = disabled;
}

async function onPublishClick(): Promise<void> {
  if (docId === null) return;
  const id = docId;
  const republish = currentStatus === "published";

  // 先把本地修改落盘，避免发布到旧内容
  if (dirty || inFlightPromise) await flushSave();
  if (docId !== id) return;

  setActionButtonsDisabled(true);
  try {
    const note = await promptTextModal({
      title: republish ? "更新发布" : "发布文档",
      label: "发布备注（可选）",
      placeholder: republish ? "例如：修正示例代码 / 补充说明" : "例如：首次发布 / 更新示例代码",
      confirmText: republish ? "更新发布" : "发布",
    });
    if (note === null) return;
    const detail = await api.publishDoc(id, note.trim().length > 0 ? note.trim() : undefined);
    if (docId !== id) return;
    await applyDetail(detail);
    toast(republish ? "已更新发布（生成新版本）" : "已发布", "success");
    void refreshDocs();
  } catch (e) {
    toast(`发布失败：${errMessage(e)}`, "error");
  } finally {
    setActionButtonsDisabled(false);
  }
}

async function onUnpublishClick(): Promise<void> {
  if (docId === null) return;
  const id = docId;

  // 取消发布前也先落盘，保证草稿内容与编辑器一致
  if (dirty || inFlightPromise) await flushSave();
  if (docId !== id) return;

  setActionButtonsDisabled(true);
  try {
    const okFlag = await confirmDialog({
      title: "取消发布",
      message: "确定取消发布该文档？发布页将不再展示此文档。",
      confirmText: "取消发布",
      danger: true,
    });
    if (!okFlag) return;
    const detail = await api.unpublishDoc(id);
    if (docId !== id) return;
    await applyDetail(detail);
    toast("已取消发布", "success");
    void refreshDocs();
  } catch (e) {
    toast(`取消发布失败：${errMessage(e)}`, "error");
  } finally {
    setActionButtonsDisabled(false);
  }
}

/* ---------------- 移动 / 改名 ---------------- */

/**
 * 移动 / 改名弹窗：直接编辑完整访问路径（支持自定义多级路径），
 * 并保留「所在目录」下拉用于快速改写目录部分；手动编辑过路径后下拉不再覆盖。
 */
function openMoveRenameModal(): void {
  if (docId === null || !titleInput) return;
  const id = docId;

  const currentFolder = currentPath.includes("/") ? currentPath.slice(0, currentPath.lastIndexOf("/")) : "";

  const pathInput = el("input", {
    className: "field-input field-mono",
    attrs: { type: "text", spellcheck: "false", autocomplete: "off" },
  });
  pathInput.value = currentPath;

  const folderSelect = buildFolderSelect(currentFolder);

  const titleField = el("input", {
    className: "field-input",
    attrs: { type: "text", autocomplete: "off" },
  });
  titleField.value = titleInput.value;
  const errorLine = el("div", { className: "field-error" });
  const pathPreview = el("div", { className: "path-preview" });

  /** 用户手动编辑过路径输入框后，「所在目录」下拉不再覆盖其值 */
  let pathTouched = false;

  const updatePreview = (): void => {
    const normalized = normalizePathInput(pathInput.value);
    pathPreview.textContent = `访问地址将变为：/${normalized || "（空）"}`;
  };
  pathInput.oninput = () => {
    pathTouched = true;
    updatePreview();
  };
  folderSelect.onchange = () => {
    if (!pathTouched) {
      const name = normalizePathInput(pathInput.value).split("/").pop() ?? "";
      pathInput.value = joinFolder(folderSelect.value, name);
    }
    updatePreview();
  };
  updatePreview();

  let submitting = false;
  const confirmBtn = el("button", {
    className: "btn btn-primary",
    text: "保存",
    attrs: { type: "submit" },
  });
  const cancelBtn = el("button", {
    className: "btn",
    text: "取消",
    attrs: { type: "button" },
    onClick: () => handle.close(),
  });

  const form = el("form", {
    onSubmit: (ev) => {
      ev.preventDefault();
      if (submitting) return;
      errorLine.textContent = "";

      const newPath = normalizePathInput(pathInput.value);
      const newTitle = titleField.value.trim();

      const pathError = validateDocPath(newPath);
      if (pathError !== null) {
        errorLine.textContent = pathError;
        return;
      }
      if (newTitle.length === 0) {
        errorLine.textContent = "标题不能为空";
        return;
      }
      submitting = true;
      confirmBtn.disabled = true;
      api.updateDoc(id, {
        base_revision_seq: revisionSeq,
        path: newPath,
        title: newTitle,
      })
        .then((res) => {
          revisionSeq = res.revision_seq;
          currentPath = newPath;
          if (titleInput) titleInput.value = newTitle;
          lastSavedTitle = newTitle;
          setSaveStatus("saved", res.saved_at);
          refreshPublishButton();
          toast("已更新位置与标题", "success");
          handle.close();
          void refreshDocs();
        })
        .catch((e: unknown) => {
          submitting = false;
          confirmBtn.disabled = false;
          const conflict = getConflictPayload(e);
          if (conflict) {
            errorLine.textContent = `${conflict.message}：文档已被他人修改，请刷新页面后重试`;
          } else if (e instanceof ApiError && e.status === 409) {
            errorLine.textContent = "目标路径已存在，请更换路径";
          } else {
            errorLine.textContent = errMessage(e);
          }
        });
    },
  }, [
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "完整访问路径" }),
      pathInput,
      pathPreview,
      el("div", {
        className: "field-hint",
        text: "可包含多级子目录（会隐式创建）；修改路径会改变文档的访问地址，旧链接将失效。",
      }),
    ]),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "所在目录（快速选择）" }),
      folderSelect,
      el("div", { className: "field-hint", text: "选择后自动改写上方路径的目录部分；手动编辑过路径则以手动输入为准。" }),
    ]),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "标题" }),
      titleField,
    ]),
    errorLine,
  ]);

  const handle = openModal({
    title: "移动 / 改名",
    content: form,
    actions: [cancelBtn, confirmBtn],
    wide: true,
  });
}

/** 组合目录与文件名（目录可空表示根目录） */
function joinFolder(folder: string, name: string): string {
  const f = folder.replace(/\/+$/, "");
  return f.length > 0 ? `${f}/${name}` : name;
}

/* ---------------- 删除 ---------------- */

async function onDeleteDocument(): Promise<void> {
  if (docId === null) return;
  const id = docId;
  const name = lastSavedTitle || currentPath || `#${id}`;
  const okFlag = await confirmDialog({
    title: "删除文档",
    message: `确定删除「${name}」？此操作不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!okFlag || docId !== id) return;
  try {
    await api.deleteDoc(id);
    toast(`已删除「${name}」`, "success");
    docId = null;
    currentStatus = null;
    state.currentDocId = null;
    location.hash = "#/";
    void refreshDocs();
  } catch (e) {
    toast(`删除失败：${errMessage(e)}`, "error");
  }
}

/* ---------------- 历史 ---------------- */

function openHistoryDrawerSafely(): void {
  if (docId === null) {
    toast("请先打开一篇文档", "error");
    return;
  }
  openHistoryDrawer();
}

/* ---------------- 供外部（main / history）使用的访问器 ---------------- */

export function getCurrentDocId(): number | null {
  return docId;
}

export function getCurrentContent(): string {
  return vditor?.getValue() ?? "";
}

/** 供外部流程（如版本回滚前）确保本地修改已落盘 */
export async function flushPendingChanges(): Promise<void> {
  await requestSaveNow();
}

/** 版本回滚等外部操作拿到新的 DocumentDetail 后回填编辑器 */
export async function applyExternalDetail(detail: DocumentDetail): Promise<void> {
  if (docId !== detail.id) return;
  await applyDetail(detail);
}
