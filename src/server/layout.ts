import type { TocEntry } from "./markdown";
import type { TreeNode } from "./tree";
import type { SessionUser } from "./env";
import type { NavLink, NoticeBar, SearchHit } from "../shared/types";
import { iconExternalArrow, iconMoon, iconPencil, iconSun, logoMark } from "./icons";
import { isExternalHref, sanitizeTrustedHtml } from "./settings";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 从 Cookie 读取显式主题选择（pd-theme=light|dark）；未设置返回 null（跟随系统） */
export function themeFromRequest(req: Request): "light" | "dark" | null {
  const cookie = req.headers.get("Cookie") ?? "";
  const m = /(?:^|;\s*)pd-theme=(light|dark)(?:;|$)/.exec(cookie);
  return m === null ? null : (m[1] as "light" | "dark");
}

/** favicon 值 → <link rel="icon"> 标签（data URI 或站内路径；空回退内置默认） */
function faviconLink(favicon: string | null | undefined): string {
  const value = favicon?.trim();
  if (!value) return '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
  const typeM = /^data:([^;,]+)/.exec(value);
  const typeAttr = typeM ? ` type="${esc(typeM[1])}"` : "";
  return `<link rel="icon" href="${esc(value)}"${typeAttr}>`;
}

/**
 * 阅读页前端资源地址：
 * - 生产构建后为稳定命名的静态产物（/assets/read.js，见 vite.config.ts）；
 * - dev 下直接引用源文件路径（Vite 按需转换），保证本地体验一致。
 */
const READ_ASSETS =
  import.meta.env?.DEV === true
    ? { js: "/src/client/read/main.ts", css: "/src/client/read/read.css" }
    : { js: "/assets/read.js", css: "/assets/read.css" };

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 时间戳元素：服务端渲染 UTC 兜底文本（明确标注 UTC），
 * 客户端 read/main.ts 会按浏览器本地时区重写为本地时间。
 */
export function timeTag(ms: number): string {
  return `<time class="dt" data-epoch="${ms}" datetime="${new Date(ms).toISOString()}">${formatDateTime(ms)} UTC</time>`;
}

export interface BaseLayoutOptions {
  title: string;
  description?: string;
  canonicalPath?: string;
  baseUrl: string;
  siteName: string;
  content: string;
  bodyClass?: string;
  head?: string;
  /** 显式主题（来自 pd-theme Cookie）；null 表示跟随系统 */
  theme?: "light" | "dark" | null;
  /** 自定义网站图标（data URI 或站内路径） */
  favicon?: string | null;
  /** 页脚自定义 HTML（版权声明等）；空不渲染。内容为 admin 受信输入，渲染前经安全过滤 */
  footer?: string | null;
}

/** 页脚片段：admin 配置的受信 HTML，经 sanitizeTrustedHtml 过滤后输出 */
function footerHtml(footer: string | null | undefined): string {
  const raw = footer?.trim();
  if (!raw) return "";
  return `<footer class="site-footer">${sanitizeTrustedHtml(raw)}</footer>`;
}

/** 公共页面骨架：无内联脚本（CSP script-src 'self'），样式与增强脚本来自静态资源 */
export function baseLayout(opts: BaseLayoutOptions): string {
  const canonical = opts.canonicalPath ? `${opts.baseUrl}${opts.canonicalPath}` : null;
  const description =
    opts.description ?? `${opts.siteName} · 在线产品文档：匿名可读，登录后在线编辑。`;
  const themeAttr = opts.theme ? ` data-theme="${esc(opts.theme)}"` : "";
  return `<!doctype html>
<html lang="zh-CN"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta property="og:type" content="article">
<meta property="og:site_name" content="${esc(opts.siteName)}">
<meta property="og:title" content="${esc(opts.title)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ""}
${faviconLink(opts.favicon)}
<link rel="stylesheet" href="${READ_ASSETS.css}">
<script type="module" src="${READ_ASSETS.js}"></script>
${opts.head ?? ""}
</head>
<body class="${esc(opts.bodyClass ?? "")}">
${opts.content}
${footerHtml(opts.footer)}
</body>
</html>`;
}

export interface SiteHeaderOptions {
  siteName: string;
  homeUrl: string;
  nav: NavLink[];
  /** 当前页面规范路径（如 /guide/intro 或 /search），用于导航高亮；无则传 null */
  activePath?: string | null;
  /** 是否渲染搜索框（阅读页 / 搜索页） */
  showSearch?: boolean;
  /** 登录用户不显示「登录」入口（文章页已有「编辑此页」） */
  user: SessionUser | null;
  /** 自定义 LOGO 图（data URI 或站内路径）；缺省用内置 LOGO */
  logo?: string | null;
}

/** 导航高亮：站内链接与当前路径完全相等，或当前路径位于该前缀之下 */
function navItemClass(href: string, activePath: string | null): string {
  if (!activePath || isExternalHref(href) || !href.startsWith("/")) return "header-nav-link";
  if (activePath === href) return "header-nav-link active";
  if (href !== "/" && activePath.startsWith(`${href}/`)) return "header-nav-link active";
  if (href === "/" && activePath === "/") return "header-nav-link active";
  return "header-nav-link";
}

/**
 * 站外导航项：左侧自动展示对方站点图标（经同源 /icon/:host 代理抓取，
 * 规避 CSP img-src 'self' 且不向第三方泄露访客 IP），右侧渲染外开箭头。
 * host 解析失败时不输出图标（仅保留箭头）。
 */
function externalNavIcons(href: string): { icon: string; arrow: string } {
  let host = "";
  try {
    host = new URL(href).hostname;
  } catch {
    host = "";
  }
  const icon =
    host.length > 0
      ? `<img class="nav-site-icon" src="/icon/${esc(host)}" alt="" width="15" height="15" loading="lazy" decoding="async">`
      : "";
  return { icon, arrow: `<span class="nav-ext-arrow">${iconExternalArrow(11, "icon")}</span>` };
}

/**
 * 站点顶部工具栏（全宽、最高层级）：品牌（链接到可配置首页地址）+ 搜索框（左侧）+
 * 一排导航栏（右侧，加粗，后台可配置）+ 深浅色切换。
 * 匿名访客在导航尾部保留低调「登录」入口。公告栏独立由 noticeBarHtml 渲染在内容区上方。
 */
export function siteHeaderHtml(o: SiteHeaderOptions): string {
  const links = o.nav
    .map((item) => {
      const external = isExternalHref(item.href);
      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
      const cls = navItemClass(item.href, o.activePath ?? null);
      const { icon, arrow } = external ? externalNavIcons(item.href) : { icon: "", arrow: "" };
      return `<a class="${cls}${external ? " nav-link-ext" : ""}" href="${esc(item.href)}"${attrs}>${icon}<span class="nav-link-label">${esc(
        item.label
      )}</span>${arrow}</a>`;
    })
    .join("");
  const loginLink = o.user ? "" : '<a class="header-nav-link nav-login" href="/admin/">登录</a>';
  const nav = links.length > 0 || loginLink ? `<nav class="header-nav" aria-label="站点导航">${links}${loginLink}</nav>` : "";
  const search = o.showSearch
    ? `<form class="search-form" action="/search" method="get" role="search">
      <input type="search" name="q" placeholder="搜索文档…" aria-label="搜索文档">
    </form>`
    : "";
  const brand =
    o.logo && o.logo.trim().length > 0
      ? `<img class="site-logo" src="${esc(o.logo.trim())}" alt="" width="22" height="22">`
      : logoMark(22, "site-logo");
  const themeToggle = `<button class="theme-toggle" type="button" data-theme-toggle aria-label="切换深色 / 浅色模式" title="切换深色 / 浅色模式">
      <span class="theme-icon theme-icon-sun">${iconSun(16)}</span>
      <span class="theme-icon theme-icon-moon">${iconMoon(16)}</span>
    </button>`;
  return `<header class="site-header">
  <div class="header-inner">
    <a class="site-name" href="${esc(o.homeUrl || "/")}">${brand}<span>${esc(o.siteName)}</span></a>
    ${search}
    ${nav}
    ${themeToggle}
  </div>
</header>`;
}

/** 页眉公告栏（渲染在目录栏右侧、文档展示页上方）；null 不显示 */
export function noticeBarHtml(notice: NoticeBar | null | undefined): string {
  if (!notice) return "";
  return `<div class="notice-bar" data-notice-bar>
      <div class="notice-text">${sanitizeTrustedHtml(notice.text)}</div>${
        notice.link
          ? `<a class="notice-link" href="${esc(notice.link)}"${
              isExternalHref(notice.link) ? ' target="_blank" rel="noopener noreferrer"' : ""
            }>查看详情</a>`
          : ""
      }
      <button class="notice-close" type="button" data-notice-close aria-label="关闭公告">&times;</button>
    </div>`;
}

function sidebarHtml(tree: TreeNode[], activePath: string | null): string {  const renderNodes = (nodes: TreeNode[]): string =>
    nodes
      .map((node) => {
        // 目录显示名称：显式目录（后台命名，任意语言）优先，否则回退为路径段
        const folderLabel = node.name ?? node.segment;
        if (node.children.length > 0 && !node.doc) {
          return `<li class="tree-folder"><details open><summary>${esc(folderLabel)}</summary><ul>${renderNodes(
            node.children
          )}</ul></details></li>`;
        }
        if (node.doc) {
          const cls = node.doc.path === activePath ? " active" : "";
          const badge = node.doc.status === "draft" ? '<span class="badge-draft">草稿</span>' : "";
          let html = `<li class="tree-doc"><a class="tree-link${cls}" href="/${esc(node.doc.path)}">${esc(
            node.doc.title
          )}${badge}</a>`;
          if (node.children.length > 0) {
            html += `<ul class="tree-sub">${renderNodes(node.children)}</ul>`;
          }
          return html + "</li>";
        }
        // 空目录节点（显式创建、尚无文档）
        return `<li class="tree-folder"><details open><summary>${esc(folderLabel)}</summary><ul>${renderNodes(
          node.children
        )}</ul></details></li>`;
      })
      .join("");
  return `<nav class="sidebar" aria-label="文档目录"><ul class="tree-root">${
    tree.length === 0 ? '<li class="tree-empty">暂无文档</li>' : renderNodes(tree)
  }</ul></nav>`;
}

function tocHtml(toc: TocEntry[]): string {
  if (toc.length === 0) return "";
  const items = toc
    .map((t) => `<li class="toc-lv${t.level}"><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`)
    .join("");
  return `<aside class="toc" aria-label="本页目录"><div class="toc-title">本页目录</div><ul>${items}</ul></aside>`;
}

export interface DocPageOptions {
  siteName: string;
  baseUrl: string;
  path: string;
  title: string;
  status: "draft" | "published";
  updatedAt: number;
  updatedBy: string | null;
  contentHtml: string;
  toc: TocEntry[];
  tree: TreeNode[];
  user: SessionUser | null;
  excerpt: string;
  /** 站点设置：首页地址与导航栏链接 */
  homeUrl?: string;
  nav?: NavLink[];
  /** 站点设置：LOGO / 公告栏 / 网站图标 / 页脚 / 显式主题 */
  logo?: string | null;
  notice?: NoticeBar | null;
  favicon?: string | null;
  footer?: string | null;
  theme?: "light" | "dark" | null;
}

export function renderDocPage(o: DocPageOptions): string {
  const editLink =
    o.user !== null
      ? `<a class="edit-link" href="/admin/#/doc-by-path/${encodeURIComponent(o.path)}">${iconPencil(14, "icon")}<span>编辑此页</span></a>`
      : "";
  const draftBanner =
    o.status === "draft"
      ? `<div class="draft-banner">草稿预览 · 仅登录用户可见 · <a href="/admin/#/doc-by-path/${encodeURIComponent(
          o.path
        )}">去编辑</a></div>`
      : "";
  const content = `
${siteHeaderHtml({
  siteName: o.siteName,
  homeUrl: o.homeUrl ?? "/",
  nav: o.nav ?? [],
  activePath: `/${o.path}`,
  showSearch: true,
  user: o.user,
  logo: o.logo,
})}
<div class="page-layout">
  ${sidebarHtml(o.tree, o.path)}
  <div class="main-column">
    ${noticeBarHtml(o.notice)}
    <div class="main-column-body">
      <main class="article">
        ${draftBanner}
        <h1 class="article-title">${esc(o.title)}</h1>
        <div class="article-meta"><span class="meta-text">更新于 ${timeTag(o.updatedAt)}${
          o.updatedBy ? ` · ${esc(o.updatedBy)}` : ""
        }${o.status === "draft" ? " · 草稿" : ""}</span><button class="copy-src-btn" type="button" data-copy-md title="复制本文 Markdown 源码">复制 Markdown</button></div>
        <article class="markdown-body">${o.contentHtml}</article>
        ${editLink ? `<div class="article-footer">${editLink}</div>` : ""}
      </main>
      ${tocHtml(o.toc)}
    </div>
  </div>
</div>`;
  return baseLayout({
    title: `${o.title} · ${o.siteName}`,
    description: o.excerpt,
    canonicalPath: `/${o.path}`,
    baseUrl: o.baseUrl,
    siteName: o.siteName,
    content,
    bodyClass: "page-doc",
    theme: o.theme,
    favicon: o.favicon,
    footer: o.footer,
  });
}

export interface SearchPageOptions {
  siteName: string;
  baseUrl: string;
  query: string;
  hits: SearchHit[];
  tookMs: number;
  tree: TreeNode[];
  homeUrl?: string;
  nav?: NavLink[];
  user?: SessionUser | null;
  logo?: string | null;
  notice?: NoticeBar | null;
  favicon?: string | null;
  footer?: string | null;
  theme?: "light" | "dark" | null;
}

export function renderSearchPage(o: SearchPageOptions): string {
  const items = o.hits
    .map(
      (h) => `<li class="search-hit"><a href="/${esc(h.path)}"><span class="hit-title">${esc(h.title)}</span>
      <span class="hit-path">/${esc(h.path)}</span>
      <span class="hit-excerpt">${h.excerpt}</span></a></li>`
    )
    .join("");
  const content = `
${siteHeaderHtml({
  siteName: o.siteName,
  homeUrl: o.homeUrl ?? "/",
  nav: o.nav ?? [],
  activePath: "/search",
  showSearch: true,
  user: o.user ?? null,
  logo: o.logo,
})}
<div class="page-layout">
  ${sidebarHtml(o.tree, null)}
  <div class="main-column">
    ${noticeBarHtml(o.notice)}
    <div class="main-column-body">
      <main class="article">
        <h1 class="article-title">搜索：${esc(o.query)}</h1>
        <div class="article-meta">${o.hits.length} 条结果 · ${o.tookMs} ms</div>
        ${
          o.hits.length === 0
            ? '<p class="search-empty">没有匹配的文档。试试更短的关键词。</p>'
            : `<ul class="search-results">${items}</ul>`
        }
      </main>
    </div>
  </div>
</div>`;
  return baseLayout({
    title: `搜索 ${o.query} · ${o.siteName}`,
    baseUrl: o.baseUrl,
    siteName: o.siteName,
    content,
    bodyClass: "page-search",
    theme: o.theme,
    favicon: o.favicon,
    footer: o.footer,
  });
}

export interface MessagePageOptions {
  siteName: string;
  baseUrl: string;
  title: string;
  message: string;
  statusCode: number;
  showHomeLink?: boolean;
  favicon?: string | null;
  footer?: string | null;
  theme?: "light" | "dark" | null;
}

export function renderMessagePage(opts: MessagePageOptions): string {
  const content = `
<main class="message-page">
  <h1>${esc(opts.title)}</h1>
  <p>${esc(opts.message)}</p>
  ${opts.showHomeLink === false ? "" : '<p><a href="/">返回首页</a></p>'}
</main>`;
  return baseLayout({
    title: `${opts.title} · ${opts.siteName}`,
    baseUrl: opts.baseUrl,
    siteName: opts.siteName,
    content,
    bodyClass: "page-message",
    theme: opts.theme,
    favicon: opts.favicon,
    footer: opts.footer,
  });
}

/**
 * 404 页：与阅读站同一套排版语言的独立卡片。
 * 大号 404 编号 + 说明 + 返回首页 / 搜索入口，不再放置环境自检链接。
 */
export function renderNotFoundPage(opts: {
  siteName: string;
  baseUrl: string;
  path: string;
  favicon?: string | null;
  footer?: string | null;
  theme?: "light" | "dark" | null;
}): string {
  const content = `
<main class="nf-page">
  <div class="nf-card">
    <div class="nf-code" aria-hidden="true">4<span class="nf-code-zero">0</span>4</div>
    <h1 class="nf-title">页面不存在</h1>
    <p class="nf-desc">没有找到 <code class="nf-path">/${esc(opts.path)}</code>。<br>它可能尚未发布，或路径已变更。</p>
    <div class="nf-actions">
      <a class="nf-btn nf-btn-primary" href="/">返回首页</a>
      <a class="nf-btn" href="/search">搜索文档</a>
    </div>
  </div>
  <p class="nf-site">${esc(opts.siteName)}</p>
</main>`;
  return baseLayout({
    title: `页面不存在 · ${opts.siteName}`,
    baseUrl: opts.baseUrl,
    siteName: opts.siteName,
    content,
    bodyClass: "page-notfound",
    theme: opts.theme,
    favicon: opts.favicon,
    footer: opts.footer,
  });
}
