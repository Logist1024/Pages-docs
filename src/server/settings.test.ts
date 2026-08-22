import { describe, expect, it } from "vitest";
import {
  sanitizeTrustedHtml,
  validateImageValue,
  validateSettingsUpdate,
} from "./settings";

describe("validateImageValue", () => {
  it("接受合法的 data:image URI", () => {
    expect(validateImageValue("data:image/png;base64,iVBORw0KGgo=", "网站图标")).toBeNull();
    expect(validateImageValue("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "LOGO 图片")).toBeNull();
    expect(validateImageValue("data:image/x-icon;base64,AAAA", "网站图标")).toBeNull();
  });

  it("拒绝非图片或非 base64 的 data URI", () => {
    expect(validateImageValue("data:text/html;base64,PGI+", "网站图标")).not.toBeNull();
    expect(validateImageValue("data:image/png,iVBOR", "网站图标")).not.toBeNull();
  });

  it("接受站内 /f/ 路径，拒绝站外 URL 与协议相对路径", () => {
    expect(validateImageValue("/f/media/2026/08/abc.png", "网站图标")).toBeNull();
    expect(validateImageValue("https://example.com/a.png", "网站图标")).not.toBeNull();
    expect(validateImageValue("//evil.com/a.png", "网站图标")).not.toBeNull();
  });

  it("拒绝超过 300KB 的 data URI", () => {
    const big = `data:image/png;base64,${"A".repeat(400_001)}`;
    expect(validateImageValue(big, "网站图标")).toContain("300KB");
  });
});

describe("validateSettingsUpdate（新增字段）", () => {
  it("favicon / logo 传 null 表示恢复默认", () => {
    const r = validateSettingsUpdate({ favicon: null, logo: null });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.favicon).toBeNull();
      expect(r.value.logo).toBeNull();
    }
  });

  it("非法 favicon 返回错误", () => {
    const r = validateSettingsUpdate({ favicon: "javascript:alert(1)" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("网站图标");
  });

  it("公告：文本为空视为清除；链接需合法；超长报错", () => {
    const cleared = validateSettingsUpdate({ notice: { text: "  ", link: "" } });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.notice).toBeNull();

    const bad = validateSettingsUpdate({ notice: { text: "公告", link: "ftp://x" } });
    expect(bad.ok).toBe(false);

    const long = validateSettingsUpdate({ notice: { text: "长".repeat(501), link: "" } });
    expect(long.ok).toBe(false);

    const ok = validateSettingsUpdate({ notice: { text: "新版本上线", link: "/docs/changelog" } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.notice).toEqual({ text: "新版本上线", link: "/docs/changelog" });
  });

  it("原有字段校验保持不变", () => {
    expect(validateSettingsUpdate({ site_name: "" }).ok).toBe(false);
    expect(validateSettingsUpdate({ nav_links: [{ label: "文档", href: "/docs/x" }] }).ok).toBe(true);
  });

  it("页脚：空串视为清除；超 4000 字符报错；合法值原样保存（渲染时才过滤）", () => {
    const cleared = validateSettingsUpdate({ footer: "   " });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.footer).toBeNull();

    const long = validateSettingsUpdate({ footer: "x".repeat(4001) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toContain("页脚");

    const ok = validateSettingsUpdate({ footer: "<p>© 2026 <a href=\"/\">Home</a></p>" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.footer).toBe("<p>© 2026 <a href=\"/\">Home</a></p>");
  });

  it("公告支持 HTML 且上限放宽到 500 字符", () => {
    const ok = validateSettingsUpdate({ notice: { text: "<strong>新</strong>版本上线", link: "" } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.notice?.text).toContain("<strong>");

    const long = validateSettingsUpdate({ notice: { text: "长".repeat(501), link: "" } });
    expect(long.ok).toBe(false);
  });
});

describe("sanitizeTrustedHtml（受信富文本过滤）", () => {
  it("保留常规内联 HTML", () => {
    const src = `<p>© <strong>2026</strong> <a href="https://x.com">官网</a> <code>v1</code></p>`;
    expect(sanitizeTrustedHtml(src)).toBe(src);
  });

  it("整块移除 script / iframe / form 等危险元素（含内容）", () => {
    expect(sanitizeTrustedHtml(`a<script>alert(1)</script>b`)).toBe("ab");
    expect(sanitizeTrustedHtml(`<iframe src="//evil"></iframe>ok`)).toBe("ok");
    expect(sanitizeTrustedHtml(`<form action="/x"><input></form>hi`)).toBe("hi");
    expect(sanitizeTrustedHtml(`<SCRIPT src="//x"></SCRIPT>ok`)).toBe("ok");
  });

  it("移除未闭合的危险标签与注释", () => {
    expect(sanitizeTrustedHtml(`<meta http-equiv="refresh" content="0">ok`)).toBe("ok");
    expect(sanitizeTrustedHtml(`a<!-- 注释 -->b`)).toBe("ab");
  });

  it("剥掉 on* 内联事件属性", () => {
    expect(sanitizeTrustedHtml(`<img src="/x.png" onerror="alert(1)">`)).not.toContain("onerror");
    expect(sanitizeTrustedHtml(`<a href="/" onclick='steal()'>x</a>`)).not.toContain("onclick");
    expect(sanitizeTrustedHtml(`<b onmouseover=evil()>x</b>`)).toBe("<b>x</b>");
  });

  it("javascript: / vbscript: 协议地址替换为 #", () => {
    expect(sanitizeTrustedHtml(`<a href="javascript:alert(1)">x</a>`)).toContain('href="#"');
    expect(sanitizeTrustedHtml(`<a HREF="JaVaScRiPt:alert(1)">x</a>`)).toContain('HREF="#"');
    expect(sanitizeTrustedHtml(`<img src="javascript:alert(1)">`)).toContain('src="#"');
  });
});
