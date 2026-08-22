import { describe, expect, it } from "vitest";
import { prettifyExcerpt } from "./search";

// 搜索摘要的安全不变量：输出只允许纯文本 + 服务端生成的 <mark> 高亮。
// FTS 索引原始 markdown，正文里的 HTML 必须被转义（回归：/search 页注入）。
describe("prettifyExcerpt", () => {
  it("空值返回空字符串", () => {
    expect(prettifyExcerpt(null)).toBe("");
    expect(prettifyExcerpt("")).toBe("");
  });

  it("保留服务端生成的 <mark> 高亮标签", () => {
    expect(prettifyExcerpt("快速<mark>开始</mark>指南")).toBe("快速<mark>开始</mark>指南");
    expect(prettifyExcerpt("<mark>a</mark>与<mark>b</mark>")).toBe("<mark>a</mark>与<mark>b</mark>");
  });

  it("转义正文中的 HTML，只放行 <mark>", () => {
    const out = prettifyExcerpt('前文 <img src=x onerror=alert(1)> 中间 <mark>关键词</mark> 后文');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toContain("<mark>关键词</mark>");
  });

  it("正文里伪装的 mark 大小写变体同样只保留标签本身", () => {
    const out = prettifyExcerpt('<MARK>x</MARK><script>alert(1)</script>');
    expect(out).not.toContain("<script");
    expect(out).toBe("<mark>x</mark>&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("去掉 markdown 标记并压缩空白", () => {
    expect(prettifyExcerpt("## 标题\n\n- **要点** `_code_`\n")).toBe("标题 要点 code");
  });
});
