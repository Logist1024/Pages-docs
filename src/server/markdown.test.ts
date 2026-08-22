import { describe, expect, it } from "vitest";
import { excerptOf, ftsQueryOf, isValidDocPath, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("html:false —— 原始 HTML 一律转义（XSS 防线）", () => {
    const { html } = renderMarkdown('hello <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("外链补 rel=noopener noreferrer 与 target=_blank", () => {
    const { html } = renderMarkdown("[Google](https://google.com) [内链](./other)");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("生成标题锚点并收集 TOC", () => {
    const { html, toc } = renderMarkdown("# Title\n\n## 第一段\n\ntext\n\n### Sub **A**\n\n## 第一段");
    expect(html).toContain('id="第一段"');
    expect(toc).toEqual([
      { level: 2, id: "第一段", text: "第一段" },
      { level: 3, id: "sub-a", text: "Sub A" },
      { level: 2, id: "第一段-2", text: "第一段" },
    ]);
  });

  it("mermaid 代码块保留为 code.language-mermaid 供客户端渲染", () => {
    const { html } = renderMarkdown("```mermaid\ngraph TD; A-->B;\n```");
    expect(html).toContain("language-mermaid");
  });

  it("表格与任务列表正常渲染", () => {
    const { html } = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
  });
});

describe("excerptOf", () => {
  it("剥离 markdown 语法取纯文本", () => {
    const text = excerptOf("# 标题\n\n这是**正文**段落，含[链接](https://x.com)。\n\n```js\ncode();\n```");
    expect(text).toContain("这是正文段落");
    expect(text).not.toContain("```");
    expect(text).not.toContain("**");
  });
});

describe("ftsQueryOf", () => {
  it("拆词并双引号包裹，防 FTS5 语法注入", () => {
    expect(ftsQueryOf("hello OR world")).toBe('"hello" "OR" "world"');
    expect(ftsQueryOf('"quoted"')).toBe('"quoted"');
    expect(ftsQueryOf("  ")).toBe("");
  });
});

describe("isValidDocPath", () => {
  it("合法路径", () => {
    expect(isValidDocPath("guide/intro")).toBe(true);
    expect(isValidDocPath("a")).toBe(true);
    expect(isValidDocPath("api/v2/get-started")).toBe(true);
    expect(isValidDocPath("my_doc-1/section_2")).toBe(true);
  });
  it("非法路径", () => {
    expect(isValidDocPath("/leading")).toBe(false);
    expect(isValidDocPath("trailing/")).toBe(false);
    expect(isValidDocPath("UPPER")).toBe(false);
    expect(isValidDocPath("has space")).toBe(false);
    expect(isValidDocPath("a//b")).toBe(false);
    expect(isValidDocPath("")).toBe(false);
  });
});
