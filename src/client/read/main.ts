/**
 * 阅读页渐进增强（PLAN 1 / 8）：
 * 首屏 HTML 由服务端渲染（SEO 完整）；客户端只做——
 *   1. 时间戳本地化（服务端渲染 UTC 兜底，这里改写为浏览器本地时区）
 *   2. 代码高亮（highlight.js）
 *   3. mermaid 图表懒加载渲染
 *   4. 代码块复制按钮
 *   5. 目录滚动联动（IntersectionObserver）
 *   6. 深色 / 浅色模式切换（写 pd-theme Cookie，SSR 下次直接带主题渲染）
 *   7. 页眉公告栏关闭（localStorage 记忆，按内容去重）
 */
import "./read.css";
import hljs from "highlight.js/lib/common";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 简单字符串哈希（公告内容指纹，用于关闭记忆的 key） */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/* ---------------- 深色 / 浅色模式 ---------------- */

function currentTheme(): "light" | "dark" {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/* ---------------- 页眉公告栏 ---------------- */

/** 计算公告内容指纹（关闭记忆的 key；需在移除节点前调用） */
function noticeKey(bar: HTMLElement | null): string {
  return `pd-notice-dismissed:${hashText(bar?.textContent?.trim() ?? "")}`;
}

/**
 * 全局事件委托：主题切换与公告关闭统一在 document 上监听。
 * 相比逐元素绑定，不依赖脚本执行时元素是否已存在，也不受动态重排影响。
 */
function setupDelegatedHandlers(): void {
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") return;

    const toggle = target.closest<HTMLElement>("[data-theme-toggle]");
    if (toggle) {
      const next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      // Cookie 同步给 SSR（下次请求直接带主题渲染，避免闪烁）；非敏感信息，无需 HttpOnly
      document.cookie = `pd-theme=${next}; path=/; max-age=31536000; SameSite=Lax`;
      return;
    }

    const close = target.closest<HTMLElement>("[data-notice-close]");
    if (close) {
      const bar = close.closest<HTMLElement>("[data-notice-bar]");
      const key = noticeKey(bar);
      bar?.remove();
      try {
        localStorage.setItem(key, "1");
      } catch {
        // localStorage 不可用时忽略记忆
      }
    }
  });
}

/** 页面加载时移除已被访客关闭过的公告（避免闪现） */
function dismissRememberedNotice(): void {
  const bar = document.querySelector<HTMLElement>("[data-notice-bar]");
  if (!bar) return;
  try {
    if (localStorage.getItem(noticeKey(bar)) === "1") bar.remove();
  } catch {
    // localStorage 不可用时忽略记忆，正常展示
  }
}

/** 写入剪贴板：优先 Clipboard API，非安全上下文等场景退回 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/**
 * 「复制 Markdown」按钮：抓取当前地址 + ?format=md 的源码文本并复制。
 * 复制内容与页面所见一致（登录预览草稿时拿到的是草稿源码；
 * 带 ?view=published 时拿到发布快照）。
 */
function setupCopySource(): void {
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") return;
    const btn = target.closest<HTMLButtonElement>("[data-copy-md]");
    if (!btn || btn.dataset.busy === "1") return;

    const label = btn.dataset.label ?? (btn.dataset.label = btn.textContent?.trim() || "复制 Markdown");
    btn.dataset.busy = "1";
    void (async () => {
      try {
        const u = new URL(location.href);
        u.searchParams.set("format", "md");
        const res = await fetch(u.toString(), { credentials: "same-origin" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const okFlag = await copyText(await res.text());
        btn.textContent = okFlag ? "已复制" : "复制失败";
      } catch {
        btn.textContent = "复制失败";
      }
      window.setTimeout(() => {
        btn.textContent = label;
        delete btn.dataset.busy;
      }, 1600);
    })();
  });
}

/** 本地时间 yyyy-MM-dd HH:mm */
function formatLocal(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/**
 * 把 SSR 输出的 <time data-epoch> 改写为访问者本地时区。
 * 服务端运行在 UTC，无法得知用户时区；兜底文本带 “UTC” 后缀，
 * JS 可用后替换为本地时间并在 title 里注明时区偏移。
 */
function localizeTimes(): void {
  document.querySelectorAll<HTMLTimeElement>("time[data-epoch]").forEach((node) => {
    const epoch = Number(node.dataset.epoch);
    if (!Number.isFinite(epoch)) return;
    const offsetMin = -new Date(epoch).getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const tz = `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
    node.textContent = formatLocal(epoch);
    node.title = `${tz} · 浏览器本地时间`;
    node.classList.add("dt-local");
  });
}

function highlightCode(): void {
  document.querySelectorAll<HTMLElement>("pre code[class*='language-']").forEach((block) => {
    if (block.classList.contains("language-mermaid")) return;
    try {
      hljs.highlightElement(block);
    } catch {
      // 高亮失败不影响正文
    }
  });
}

function addCopyButtons(): void {
  document.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code || code.classList.contains("language-mermaid")) return;
    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.type = "button";
    btn.textContent = "复制";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        btn.textContent = "已复制";
      } catch {
        btn.textContent = "复制失败";
      }
      setTimeout(() => (btn.textContent = "复制"), 1500);
    });
    pre.appendChild(btn);
  });
}

let mermaidLoading: Promise<typeof import("mermaid")> | null = null;

function loadMermaid() {
  mermaidLoading ??= import("mermaid").then((mod) => {
    mod.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
    return mod;
  });
  return mermaidLoading;
}

async function renderMermaidBlocks(): Promise<void> {
  const blocks = document.querySelectorAll<HTMLElement>("code.language-mermaid");
  if (blocks.length === 0) return;
  let mod: Awaited<NonNullable<typeof mermaidLoading>> | null = null;
  let seq = 0;
  for (const block of blocks) {
    const source = block.textContent ?? "";
    const pre = block.closest("pre");
    if (!pre || !source.trim()) continue;
    try {
      mod ??= await loadMermaid();
      const { svg } = await mod.default.render(`mermaid-${++seq}`, source);
      const holder = document.createElement("div");
      holder.className = "mermaid-figure";
      holder.innerHTML = svg;
      pre.replaceWith(holder);
    } catch (error) {
      console.error("[pages-docs] mermaid 渲染失败", error);
      pre.classList.add("mermaid-error"); // 失败时保留源码展示
    }
  }
}

function setupTocSpy(): void {
  const tocLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(".toc a[href^='#']"));
  if (tocLinks.length === 0) return;
  const byId = new Map<string, HTMLAnchorElement>();
  for (const link of tocLinks) {
    const id = decodeURIComponent(link.hash.slice(1));
    byId.set(id, link);
  }
  const headings = Array.from(document.querySelectorAll<HTMLElement>(".markdown-body h2[id], .markdown-body h3[id], .markdown-body h4[id]"));
  const setActive = (id: string) => {
    for (const [hid, link] of byId) link.classList.toggle("active", hid === id);
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) setActive(entry.target.id);
      }
    },
    { rootMargin: "-10% 0px -80% 0px" }
  );
  for (const h of headings) observer.observe(h);
  // 点击平滑滚动由 CSS scroll-behavior 承担
}

function boot(): void {
  localizeTimes();
  highlightCode();
  addCopyButtons();
  setupTocSpy();
  setupDelegatedHandlers();
  setupCopySource();
  dismissRememberedNotice();
  void renderMermaidBlocks();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
