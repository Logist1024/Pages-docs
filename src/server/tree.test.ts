import { describe, expect, it } from "vitest";
import { buildTree, compareTreeSiblings } from "./tree";
import type { DocumentSummary, FolderInfo } from "../shared/types";

function doc(path: string, title = path, sortOrder = 0): DocumentSummary {
  return {
    id: path.length,
    path,
    lang: "en",
    title,
    status: "published",
    sort_order: sortOrder,
    updated_at: 0,
    updated_by: null,
  };
}

function folder(path: string, name: string, sortOrder = 0): FolderInfo {
  return { path, name, sort_order: sortOrder };
}

describe("buildTree", () => {
  it("按前缀构建嵌套树，文件夹在前", () => {
    const tree = buildTree([
      doc("guide/intro", "介绍"),
      doc("api/auth", "认证"),
      doc("guide", "指南"),
      doc("changelog", "更新日志"),
      doc("guide/advanced/skills", "技巧"),
    ]);
    // 未排序时保持旧行为：目录优先（有 children 的），同级按名称排序：api、guide 是文件夹
    expect(tree.map((n) => n.segment)).toEqual(["api", "guide", "changelog"]);

    const guide = tree.find((n) => n.segment === "guide")!;
    expect(guide.doc?.path).toBe("guide"); // 同名文档共存于文件夹节点
    expect(guide.children.map((c) => c.segment)).toEqual(["advanced", "intro"]);

    const advanced = guide.children[0]!;
    expect(advanced.children[0]!.doc?.path).toBe("guide/advanced/skills");
  });

  it("空列表返回空数组", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("显式目录的显示名称合入对应节点（站点显示目录名而非路径段）", () => {
    const tree = buildTree([doc("guide/intro")], [folder("guide", "使用指南")]);
    const guide = tree.find((n) => n.segment === "guide")!;
    expect(guide.name).toBe("使用指南");
    expect(guide.fullPath).toBe("guide");
  });

  it("显式空目录也出现在树中，多级路径逐级建节点", () => {
    const tree = buildTree([], [folder("a/b", "B 目录"), folder("a", "A 目录")]);
    expect(tree.map((n) => n.segment)).toEqual(["a"]);
    expect(tree[0]!.name).toBe("A 目录");
    expect(tree[0]!.children[0]!.segment).toBe("b");
    expect(tree[0]!.children[0]!.name).toBe("B 目录");
  });

  it("未命名的隐式目录回退为路径段（name 为空或缺失）", () => {
    const tree = buildTree([doc("x/y/z")], []);
    expect(tree[0]!.name).toBeUndefined();
    expect(tree[0]!.children[0]!.name).toBeUndefined();
  });

  it("按手动排序值重排同级（目录与文档混排）", () => {
    const tree = buildTree(
      [
        doc("intro", "开始", 20),
        doc("faq", "常见问题", 10),
        doc("guide/a", "A", 5),
        doc("guide/b", "B", 1),
        doc("guide/sub/c", "C", 99),
      ],
      [folder("guide", "指南", 15)]
    );
    // 根层级按排序值：faq(10) < guide 目录(15) < intro(20)
    expect(tree.map((n) => n.segment)).toEqual(["faq", "guide", "intro"]);
    // guide 下：未排序目录 sub(0) 在前，然后 b(1) < a(5)
    const guide = tree.find((n) => n.segment === "guide")!;
    expect(guide.children.map((c) => c.segment)).toEqual(["sub", "b", "a"]);
    expect(guide.children.find((c) => c.segment === "sub")!.children[0]!.segment).toBe("c");
  });
});

describe("compareTreeSiblings", () => {
  it("排序值优先，其次目录在前，最后段名字典序", () => {
    expect(compareTreeSiblings(1, 2, "b", "a", false, false)).toBeLessThan(0);
    expect(compareTreeSiblings(0, 0, "doc-b", "doc-a", false, false)).toBeGreaterThan(0);
    expect(compareTreeSiblings(0, 0, "z-doc", "a-folder", false, true)).toBeGreaterThan(0);
    expect(compareTreeSiblings(3, 3, "", "", true, true)).toBe(0);
  });
});
