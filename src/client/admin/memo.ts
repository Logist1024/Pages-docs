/**
 * 管理后台备忘录浮窗（纯浏览器本地功能，不进数据库）：
 * - 左下角便签悬浮球，点击展开 / 收起备忘录；
 * - 悬浮球与备忘录面板均可按住拖拽移动，位置随手保存；
 * - 面板右下角可随意调整大小，内容自动保存。
 * 持久化全部走 localStorage：内容、球与面板的位置、面板尺寸。
 */
import { icon } from "./icons";
import { el, formatClock } from "./ui";

const CONTENT_KEY = "pd-memo-content";
const BALL_POS_KEY = "pd-memo-ball-pos";
const PANEL_POS_KEY = "pd-memo-panel-pos";
const PANEL_SIZE_KEY = "pd-memo-size";

const BALL_SIZE = 46;
const PANEL_MIN_W = 240;
const PANEL_MIN_H = 200;
const DRAG_THRESHOLD = 4;

interface Point {
  x: number;
  y: number;
}

interface Size {
  w: number;
  h: number;
}

let mounted = false;
let ball: HTMLButtonElement | null = null;
let panel: HTMLElement | null = null;
let textarea: HTMLTextAreaElement | null = null;
let statusEl: HTMLElement | null = null;
let saveTimer: number | null = null;
let sizeSaveTimer: number | null = null;
let openState = false;
/** beforeunload 只注册一次（initMemo 可能随登出→再登录重复执行） */
let unloadBound = false;

/* ---------------- localStorage 工具 ---------------- */

function readStore<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用（隐私模式等）时静默降级为仅当前会话有效
  }
}

function clampToViewport(p: Point, w: number, h: number): Point {
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  return { x: Math.min(Math.max(p.x, 0), maxX), y: Math.min(Math.max(p.y, 0), maxY) };
}

/** 把元素摆到指定坐标（fixed 定位），并清除可能存在的 bottom/right 锚定 */
function placeAt(target: HTMLElement, p: Point): void {
  target.style.left = `${Math.round(p.x)}px`;
  target.style.top = `${Math.round(p.y)}px`;
  target.style.right = "auto";
  target.style.bottom = "auto";
}

function placeDefault(target: HTMLElement, w: number, h: number): void {
  placeAt(
    target,
    clampToViewport({ x: 18, y: window.innerHeight - h - 18 }, w, h)
  );
}

/**
 * 通用拖拽：按住 handle 移动 fixed 定位的 target，结束后持久化位置。
 * 位移小于阈值视为「点击」，触发 onTap（悬浮球的展开 / 收起）。
 */
function makeDraggable(target: HTMLElement, handle: HTMLElement, posKey: string, onTap?: () => void): void {
  let active = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    // 面板标题栏内的按钮（关闭等）正常点击，不进入拖拽；
    // 注意悬浮球本身就是 <button>，不能因此被排除
    if (!handle.matches("button")) {
      const btn = (ev.target as HTMLElement | null)?.closest("button");
      if (btn) return;
    }
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    active = true;
    moved = false;
    startX = ev.clientX;
    startY = ev.clientY;
    originX = target.getBoundingClientRect().left;
    originY = target.getBoundingClientRect().top;
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!active) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    moved = true;
    document.body.classList.add("memo-dragging");
    placeAt(target, clampToViewport({ x: originX + dx, y: originY + dy }, target.offsetWidth, target.offsetHeight));
  });
  const finish = (): void => {
    if (!active) return;
    active = false;
    document.body.classList.remove("memo-dragging");
    if (moved) {
      const rect = target.getBoundingClientRect();
      writeStore(posKey, { x: Math.round(rect.left), y: Math.round(rect.top) });
    } else {
      onTap?.();
    }
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

/* ---------------- 内容自动保存 ---------------- */

function flushContentSave(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!textarea || !statusEl) return;
  writeStore(CONTENT_KEY, textarea.value);
  statusEl.textContent = `已保存 ${formatClock(Date.now())}`;
}

function scheduleContentSave(): void {
  if (!statusEl) return;
  statusEl.textContent = "编辑中…";
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushContentSave, 600);
}

/* ---------------- 面板尺寸持久化 ---------------- */

function persistPanelSize(): void {
  if (!panel) return;
  writeStore(PANEL_SIZE_KEY, { w: panel.offsetWidth, h: panel.offsetHeight });
}

function schedulePanelSizeSave(): void {
  if (sizeSaveTimer !== null) window.clearTimeout(sizeSaveTimer);
  sizeSaveTimer = window.setTimeout(() => {
    sizeSaveTimer = null;
    persistPanelSize();
  }, 300);
}

/** 视口或自身尺寸变化后，保证面板仍在可视范围内 */
function keepPanelInViewport(): void {
  if (!panel || !openState) return;
  const p = clampToViewport({ x: panel.offsetLeft, y: panel.offsetTop }, panel.offsetWidth, panel.offsetHeight);
  if (p.x !== panel.offsetLeft || p.y !== panel.offsetTop) {
    placeAt(panel, p);
    writeStore(PANEL_POS_KEY, p);
  }
}

/* ---------------- 展开 / 收起 ---------------- */

function setOpen(next: boolean): void {
  openState = next;
  ball?.classList.toggle("active", next);
  if (!panel) return;
  panel.classList.toggle("open", next);
  if (next) {
    // 先恢复上次尺寸，再恢复位置（位置钳制依赖当前尺寸）
    const savedSize = readStore<Size>(PANEL_SIZE_KEY);
    if (savedSize && Number.isFinite(savedSize.w) && Number.isFinite(savedSize.h)) {
      panel.style.width = `${clampSize(savedSize.w, PANEL_MIN_W)}px`;
      panel.style.height = `${clampSize(savedSize.h, PANEL_MIN_H)}px`;
    }
    const savedPos = readStore<Point>(PANEL_POS_KEY);
    if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
      placeAt(panel, clampToViewport(savedPos, panel.offsetWidth, panel.offsetHeight));
    } else if (ball) {
      // 首次打开：面板默认出现在悬浮球上方
      const rect = ball.getBoundingClientRect();
      placeAt(panel, clampToViewport({ x: rect.left, y: rect.top - panel.offsetHeight - 10 }, panel.offsetWidth, panel.offsetHeight));
    }
    keepPanelInViewport();
    window.requestAnimationFrame(() => textarea?.focus());
  } else {
    flushContentSave();
    persistPanelSize();
  }
}

function clampSize(v: number, min: number): number {
  return Math.round(Math.max(min, v));
}

/* ---------------- 装配 ---------------- */

/** 在管理后台挂载备忘录浮窗；重复调用为 no-op */
export function initMemo(): void {
  if (mounted) return;
  mounted = true;

  /* 悬浮球 */
  ball = el("button", {
    className: "memo-ball",
    attrs: { type: "button", title: "备忘录（可拖动）", "aria-label": "打开 / 收起备忘录" },
  });
  ball.appendChild(icon("note", 21));
  document.body.appendChild(ball);

  const savedBallPos = readStore<Point>(BALL_POS_KEY);
  if (savedBallPos && Number.isFinite(savedBallPos.x) && Number.isFinite(savedBallPos.y)) {
    placeAt(ball, clampToViewport(savedBallPos, BALL_SIZE, BALL_SIZE));
  }

  /* 面板：标题栏（拖拽移动）+ 正文 + 状态行 */
  statusEl = el("span", { className: "memo-status" });

  const closeBtn = el("button", {
    className: "btn-icon",
    attrs: { type: "button", "aria-label": "收起备忘录" },
    onClick: () => setOpen(false),
  });
  closeBtn.appendChild(icon("x", 14));

  const head = el("div", { className: "memo-head" }, [
    el("span", { className: "memo-title", text: "备忘录" }),
    el("div", { className: "spacer" }),
    statusEl,
    closeBtn,
  ]);

  textarea = el("textarea", {
    className: "memo-textarea",
    attrs: {
      placeholder: "随手记点什么…\n内容自动保存在本浏览器。",
      spellcheck: "false",
    },
  });
  textarea.value = readStore<string>(CONTENT_KEY) ?? "";
  textarea.addEventListener("input", scheduleContentSave);

  panel = el("section", {
    className: "memo-panel",
    attrs: { role: "dialog", "aria-label": "备忘录" },
  }, [head, textarea]);
  document.body.appendChild(panel);

  makeDraggable(ball, ball, BALL_POS_KEY, () => setOpen(!openState));
  // 键盘可达性：Enter / 空格切换展开（拖拽用 pointer 事件处理，与 click 解耦）
  ball.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      setOpen(!openState);
    }
  });
  makeDraggable(panel, head, PANEL_POS_KEY);

  // 原生 resize 手柄（右下角）调整面板大小；尺寸变化时跟随记录
  if ("ResizeObserver" in window && panel) {
    new ResizeObserver(() => {
      if (!openState) return;
      keepPanelInViewport();
      schedulePanelSizeSave();
    }).observe(panel);
  }

  // 浏览器窗口缩放时把两个元素收回可视范围
  window.addEventListener("resize", () => {
    if (ball) placeAt(ball, clampToViewport({ x: ball.offsetLeft, y: ball.offsetTop }, BALL_SIZE, BALL_SIZE));
    keepPanelInViewport();
  });

  // 关闭页面前兜底保存
  if (!unloadBound) {
    unloadBound = true;
    window.addEventListener("beforeunload", flushContentSave);
  }
}

/** 回到登录页等场景卸载浮窗（内容已即时落盘，直接移除节点即可） */
export function destroyMemo(): void {
  if (!mounted) return;
  flushContentSave();
  setOpen(false);
  ball?.remove();
  panel?.remove();
  ball = null;
  panel = null;
  textarea = null;
  statusEl = null;
  openState = false;
  mounted = false;
}
