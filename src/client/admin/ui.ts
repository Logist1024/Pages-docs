/**
 * 通用 UI 工具：DOM 构建、HTML 转义、时间格式化、toast、模态框、确认对话框。
 * 不依赖任何框架与业务模块。
 */
import { icon } from "./icons";

/** HTML 转义：所有用户内容插入 DOM 前必须经过它（唯一例外：搜索 excerpt 由服务端生成）。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ElOptions {
  className?: string;
  /** 安全文本（textContent） */
  text?: string;
  /** 仅用于可信 HTML（内部静态结构），业务数据一律用 text */
  html?: string;
  attrs?: Record<string, string | number | boolean>;
  onClick?: (ev: MouseEvent) => void;
  onInput?: (ev: Event) => void;
  onChange?: (ev: Event) => void;
  onKeydown?: (ev: KeyboardEvent) => void;
  onSubmit?: (ev: Event) => void;
}

/**
 * 简易 DOM 构建器。
 * 注意：事件绑定使用 on* 属性而非 addEventListener——
 * 本项目 tsconfig 同时引入 @cloudflare/workers-types，
 * 其全局 EventTarget 类声明会吞掉 DOM 的类型化事件重载。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: Array<Node | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className !== undefined) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.attrs !== undefined) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      node.setAttribute(k, String(v));
    }
  }
  if (opts.onClick) node.onclick = opts.onClick;
  if (opts.onInput) node.oninput = opts.onInput;
  if (opts.onChange) node.onchange = opts.onChange;
  if (opts.onKeydown) node.onkeydown = opts.onKeydown;
  if (opts.onSubmit) node.onsubmit = opts.onSubmit;
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地时间 yyyy-MM-dd HH:mm（输入为 unix ms） */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/** 本地时间 HH:MM:SS（保存状态用） */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ---------------- Toast ---------------- */

let toastContainer: HTMLElement | null = null;

function ensureToastContainer(): HTMLElement {
  if (!toastContainer || !toastContainer.isConnected) {
    toastContainer = el("div", { className: "toast-container" });
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

/** toast 提示：type 为 success / error，3 秒后自动消失 */
export function toast(message: string, type: "success" | "error" = "success"): void {
  const container = ensureToastContainer();
  const item = el("div", { className: `toast toast-${type}` }, [
    icon(type === "success" ? "check" : "x", 15),
    el("span", { text: message }),
  ]);
  container.appendChild(item);
  window.setTimeout(() => {
    item.classList.add("leaving");
    window.setTimeout(() => item.remove(), 280);
  }, 3000);
}

/* ---------------- 模态框 ---------------- */

export interface ModalHandle {
  close(): void;
  /** 模态框根元素（overlay），可用于追加内容 */
  overlay: HTMLElement;
}

interface OpenModalOptions {
  title: string;
  content: HTMLElement;
  /** 底部按钮区（通常为若干 .btn） */
  actions?: HTMLElement[];
  /** 是否允许 Esc / 点击遮罩 / 关闭按钮关闭；冲突模态框应设为 false */
  dismissible?: boolean;
  wide?: boolean;
  onClose?: () => void;
}

const openModals: ModalHandleImpl[] = [];

/** 已自动关联过的模态框表单序号（生成唯一 form id 用） */
let modalFormSeq = 0;

class ModalHandleImpl implements ModalHandle {
  overlay: HTMLElement;
  private onClose: (() => void) | undefined;
  private closed = false;

  constructor(overlay: HTMLElement, onClose?: () => void) {
    this.overlay = overlay;
    this.onClose = onClose;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const idx = openModals.indexOf(this);
    if (idx >= 0) openModals.splice(idx, 1);
    this.overlay.remove();
    if (openModals.length === 0) {
      document.removeEventListener("keydown", modalKeydown, true);
      document.body.style.removeProperty("overflow");
    }
    this.onClose?.();
  }
}

function modalKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  const top = openModals[openModals.length - 1];
  if (top && top.overlay.dataset.dismissible === "true") {
    ev.stopPropagation();
    top.close();
  }
}

export function openModal(opts: OpenModalOptions): ModalHandle {
  const dismissible = opts.dismissible !== false;
  const closeBtn = el("button", {
    className: "btn-icon",
    attrs: { "aria-label": "关闭", type: "button" },
  });
  closeBtn.appendChild(icon("x", 15));

  const modal = el("div", { className: opts.wide ? "modal modal-wide" : "modal" }, [
    el("div", { className: "modal-head" }, [
      el("div", { className: "modal-title", text: opts.title }),
      el("div", { className: "spacer" }),
      dismissible ? closeBtn : null,
    ]),
    el("div", { className: "modal-body" }, [opts.content]),
    opts.actions && opts.actions.length > 0
      ? el("div", { className: "modal-actions" }, opts.actions)
      : null,
  ]);

  const overlay = el("div", {
    className: "modal-overlay",
    attrs: { "data-dismissible": String(dismissible), role: "dialog", "aria-modal": "true" },
  }, [modal]);

  // actions 里的提交按钮位于 <form> 之外（.modal-actions 与 .modal-body 是兄弟节点）。
  // HTML 规范要求 submit 按钮必须是表单后代或通过 form 属性关联，否则点击不会触发表单
  // 提交（新建文档/移动改名等弹窗的「创建/保存」按钮会毫无反应）。
  // 这里自动为 content 内的表单分配 id，并把 actions 中 type=submit 的按钮关联上去；
  // 关联后该按钮同时成为表单的默认按钮，输入框内按 Enter 也能正确提交。
  if (opts.actions && opts.actions.length > 0) {
    const formEl =
      opts.content instanceof HTMLFormElement
        ? opts.content
        : opts.content.querySelector("form");
    if (formEl) {
      if (formEl.id.length === 0) formEl.id = `modal-form-${++modalFormSeq}`;
      for (const btn of opts.actions) {
        if (btn instanceof HTMLButtonElement && btn.getAttribute("type") === "submit") {
          btn.setAttribute("form", formEl.id);
        }
      }
    }
  }

  const handle = new ModalHandleImpl(overlay, opts.onClose);
  closeBtn.onclick = () => handle.close();
  if (dismissible) {
    overlay.onmousedown = (ev) => {
      if (ev.target === overlay) handle.close();
    };
  }

  document.body.style.setProperty("overflow", "hidden");
  document.body.appendChild(overlay);
  openModals.push(handle);
  if (openModals.length === 1) {
    document.addEventListener("keydown", modalKeydown, true);
  }

  // 聚焦第一个可输入元素，方便直接键入
  window.requestAnimationFrame(() => {
    const first = modal.querySelector<HTMLElement>("input, textarea, select");
    first?.focus();
  });

  return handle;
}

/* ---------------- 确认对话框（Promise 化） ---------------- */

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const confirmBtn = el("button", {
      className: opts.danger ? "btn btn-danger" : "btn btn-primary",
      text: opts.confirmText ?? "确定",
      attrs: { type: "button" },
      onClick: () => {
        settle(true);
        handle.close();
      },
    });
    const cancelBtn = el("button", {
      className: "btn",
      text: opts.cancelText ?? "取消",
      attrs: { type: "button" },
      onClick: () => {
        settle(false);
        handle.close();
      },
    });

    const content = el("div", {}, [
      el("p", { className: "confirm-message", text: opts.message }),
    ]);

    const handle = openModal({
      title: opts.title ?? "请确认",
      content,
      actions: [cancelBtn, confirmBtn],
      onClose: () => settle(false),
    });
  });
}

/* ---------------- 文本输入对话框（Promise 化） ---------------- */

export interface PromptTextOptions {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmText?: string;
  multiline?: boolean;
  hint?: string;
}

/** 返回输入值；取消返回 null */
export function promptTextModal(opts: PromptTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const input = opts.multiline
      ? el("textarea", { className: "field-textarea", attrs: { placeholder: opts.placeholder ?? "" } })
      : el("input", { className: "field-input", attrs: { type: "text", placeholder: opts.placeholder ?? "" } });
    input.value = opts.value ?? "";

    const confirmBtn = el("button", {
      className: "btn btn-primary",
      text: opts.confirmText ?? "确定",
      attrs: { type: "submit" },
    });
    const cancelBtn = el("button", {
      className: "btn",
      text: "取消",
      attrs: { type: "button" },
      onClick: () => {
        settle(null);
        handle.close();
      },
    });

    const form = el("form", {
      className: "field",
      onSubmit: (ev) => {
        ev.preventDefault();
        settle(input.value);
        handle.close();
      },
    }, [
      el("label", { className: "field-label", text: opts.label }),
      input,
      opts.hint ? el("div", { className: "field-hint", text: opts.hint }) : null,
    ]);

    const handle = openModal({
      title: opts.title,
      content: form,
      actions: [cancelBtn, confirmBtn],
      onClose: () => settle(null),
    });
  });
}
