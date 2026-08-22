import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItType, Token } from "markdown-it";

export interface TocEntry {
  level: number;
  id: string;
  text: string;
}

/** 目录在每次 render 前重置（Workers 每请求独立执行，无并发共享问题） */
let currentToc: TocEntry[] = [];
let usedSlugs = new Set<string>();

function inlineText(token: Token | undefined): string {
  if (!token) return "";
  const parts: string[] = [];
  const walk = (t?: Token) => {
    if (!t) return;
    if (t.type === "text" || t.type === "code_inline") parts.push(t.content);
    for (const child of t.children ?? []) walk(child);
  };
  walk(token);
  return parts.join("").trim();
}

function slugify(text: string): string {
  const base =
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]+/gu, "")
      .replace(/\s+/g, "-") || "section";
  return base;
}

function uniqueSlug(text: string): string {
  let slug = slugify(text);
  let n = 2;
  while (usedSlugs.has(slug)) {
    slug = `${slugify(text)}-${n++}`;
  }
  usedSlugs.add(slug);
  return slug;
}

function createMarkdownIt(): MarkdownItType {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

  // 外链统一补 rel/target（PLAN 5 安全清单）
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = String(tokens[idx]!.attrGet("href") ?? "");
    if (/^https?:\/\//i.test(href)) {
      tokens[idx]!.attrSet("rel", "noopener noreferrer");
      tokens[idx]!.attrSet("target", "_blank");
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  // 标题锚点 + TOC 收集
  md.core.ruler.push("pages_docs_anchor_toc", (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i]!;
      if (token.type !== "heading_open") continue;
      const level = Number.parseInt(token.tag.slice(1), 10);
      const text = inlineText(state.tokens[i + 1]);
      const id = uniqueSlug(text);
      token.attrSet("id", id);
      currentToc.push({ level, id, text });
      // 跳过 heading_close
      i++;
    }
    return true;
  });

  return md;
}

const md = createMarkdownIt();

export interface RenderResult {
  html: string;
  toc: TocEntry[];
}

/** 服务端渲染 Markdown：html:false，原始 HTML 一律转义（PLAN 4.2） */
export function renderMarkdown(source: string): RenderResult {
  currentToc = [];
  usedSlugs = new Set();
  const html = md.render(source);
  const toc = currentToc.filter((h) => h.level >= 2 && h.level <= 4);
  currentToc = [];
  return { html, toc };
}

/** 提取纯文本摘要（meta description / RSS 用） */
export function excerptOf(source: string, maxLength = 160): string {
  const stripped = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+>]\s+/gm, "")
    .replace(/(\*\*|__|~~|[*_~#|])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > maxLength ? stripped.slice(0, maxLength).trimEnd() + "…" : stripped;
}

/**
 * FTS5 MATCH 查询串转义：把用户输入拆词后全部双引号包裹，
 * 防止 AND/OR/NOT/NEAR/引号等语法注入。
 */
export function ftsQueryOf(input: string): string {
  const terms = input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^"|"$/g, ""))
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

/** 文档 path 校验：小写字母/数字开头的小写段，段内允许 - _ ，以 / 分层 */
export function isValidDocPath(path: string): boolean {
  return (
    /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/.test(path) &&
    path.length <= 200 &&
    !path.endsWith("/")
  );
}
