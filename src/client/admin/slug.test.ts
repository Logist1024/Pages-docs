import { describe, expect, it } from "vitest";
import { joinPath, randomDocName, slugify } from "./slug";

describe("slugify", () => {
  it("小写化并把非字母数字转成连字符", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("  Guide: Intro!  ")).toBe("guide-intro");
  });

  it("纯中文标题无可用 slug，返回空串（由调用方生成随机名）", () => {
    expect(slugify("你好世界")).toBe("");
    expect(slugify("！？——")).toBe("");
  });

  it("中英混合保留英文部分", () => {
    expect(slugify("第1章 Introduction")).toBe("1-introduction");
  });

  it("限长且不去掉尾部有效字符以外的内容", () => {
    const s = slugify("a".repeat(200));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).toBe("a".repeat(80));
  });
});

describe("randomDocName", () => {
  it("形如 doc-xxxx 且两次生成不同", () => {
    const a = randomDocName();
    const b = randomDocName();
    expect(a).toMatch(/^doc-[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});

describe("joinPath", () => {
  it("空目录表示根目录", () => {
    expect(joinPath("", "hello")).toBe("hello");
  });
  it("拼接目录与名称", () => {
    expect(joinPath("guide", "hello")).toBe("guide/hello");
    expect(joinPath("a/b", "c")).toBe("a/b/c");
  });
});
