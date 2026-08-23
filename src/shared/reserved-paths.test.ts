import { describe, expect, it } from "vitest";
import { isReservedCreatePath, isReservedRoutePath } from "./reserved-paths";

describe("保留路径判定", () => {
  it("路由保留：功能前缀与固定页面命中（含子路径 / 大小写 / 首尾斜杠）", () => {
    for (const p of [
      "admin",
      "/admin",
      "api/auth",
      "API/v2",
      "f/media/2026/08/x.png",
      "icon/github.com",
      "search",
      "/robots.txt",
    ]) {
      expect(isReservedRoutePath(p), p).toBe(true);
    }
  });

  it("普通文档路径不误伤（仅整段或前缀目录匹配）", () => {
    for (const p of ["guide/intro", "docs-guide", "mydocs/a", "faq", "searching", "adminless"]) {
      expect(isReservedRoutePath(p), p).toBe(false);
      expect(isReservedCreatePath(p), p).toBe(false);
    }
  });

  it("创建期额外禁用 docs；读取期不禁用（兼容已存在的 docs 目录）", () => {
    expect(isReservedCreatePath("docs")).toBe(true);
    expect(isReservedCreatePath("docs/manual")).toBe(true);
    expect(isReservedCreatePath("/DOCS/")).toBe(true);
    expect(isReservedRoutePath("docs/manual")).toBe(false);
  });
});
