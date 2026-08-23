import { describe, expect, it } from "vitest";
import { siteHeaderHtml } from "./layout";
import type { NavLink } from "../shared/types";

const base = {
  siteName: "测试站",
  homeUrl: "/",
  user: null,
  showSearch: false,
};

function navOf(links: NavLink[], activePath: string | null = null): string {
  const html = siteHeaderHtml({ ...base, nav: links, activePath });
  const m = /<nav class="header-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("siteHeaderHtml 站外导航项", () => {
  it("站外链接：左侧站点图标（同源代理）+ 右侧外开箭头 + 新窗口属性", () => {
    const item = navOf([{ label: "GitHub", href: "https://github.com/example" }]);
    // 图标在标签文本之前（左侧）
    const iconIdx = item.indexOf('src="/icon/github.com"');
    const labelIdx = item.indexOf(">GitHub<");
    const arrowIdx = item.indexOf("nav-ext-arrow");
    expect(iconIdx).toBeGreaterThan(-1);
    expect(labelIdx).toBeGreaterThan(iconIdx);
    expect(arrowIdx).toBeGreaterThan(labelIdx);
    expect(item).toContain('target="_blank"');
    expect(item).toContain('rel="noopener noreferrer"');
    expect(item).toContain("nav-link-ext");
  });

  it("站内链接：不渲染图标与箭头，也不带新窗口属性", () => {
    const item = navOf([{ label: "指南", href: "/guide" }]);
    expect(item).not.toContain("nav-site-icon");
    expect(item).not.toContain("nav-ext-arrow");
    expect(item).not.toContain('target="_blank"');
    expect(item).toContain(">指南<");
  });

  it("当前路径命中站内导航前缀时高亮；站外链接永不高亮", () => {
    const items = navOf(
      [
        { label: "指南", href: "/guide" },
        { label: "官网", href: "https://example.com" },
      ],
      "/guide/intro"
    );
    expect(items).toContain('class="header-nav-link active"');
    // 仅一个 active（站外项不参与高亮）
    expect(items.split("header-nav-link active").length - 1).toBe(1);
  });

  it("导航文案经 HTML 转义", () => {
    const item = navOf([{ label: "<b>x</b>", href: "/a" }]);
    expect(item).not.toContain("<b>x</b>");
    expect(item).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("无导航项且已登录时不渲染导航栏", () => {
    const html = siteHeaderHtml({ ...base, nav: [], user: { name: "alice", role: "admin" } });
    expect(html).not.toContain('<nav class="header-nav"');
  });
});
