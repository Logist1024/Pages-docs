/** 行级 diff 渲染（基于 jsdiff diffLines），供冲突处理与版本历史共用。 */
import { diffLines } from "diff";
import { el, escapeHtml } from "./ui";

export interface DiffViewOptions {
  /** 旧文本（渲染为红色 removed 行） */
  oldText: string;
  /** 新文本（渲染为绿色 added 行） */
  newText: string;
  /** 图例：红色代表什么 */
  removedLabel: string;
  /** 图例：绿色代表什么 */
  addedLabel: string;
  /** 上下文行（未变化部分）最多显示行数，超出折叠为省略提示；0 表示全部显示 */
  contextLimit?: number;
}

/**
 * 渲染统一的上下堆叠式 diff 视图：
 * removed 行（红）在前、added 行（绿）在后，与 diffLines(old, new) 的语义一致。
 * 所有文本均经过 escapeHtml 转义。
 */
export function renderDiffView(opts: DiffViewOptions): HTMLElement {
  const changes = diffLines(opts.oldText, opts.newText);
  const view = el("div", { className: "diff-view" }, [
    el("div", { className: "diff-legend" }, [
      el("span", { className: "lg-removed", text: opts.removedLabel }),
      el("span", { className: "lg-added", text: opts.addedLabel }),
    ]),
  ]);

  const contextLimit = opts.contextLimit ?? 4;

  // 先计算每段的行数，用于上下文折叠
  interface Segment {
    kind: "added" | "removed" | "context";
    lines: string[];
  }
  const segments: Segment[] = changes.map((change) => {
    const lines = change.value.length > 0 ? change.value.split("\n") : [];
    // diffLines 输出以 \n 结尾，split 后末尾会多一个空串，去掉
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (change.added) return { kind: "added", lines };
    if (change.removed) return { kind: "removed", lines };
    return { kind: "context", lines };
  });

  const pushLines = (kind: Segment["kind"], lines: string[]): void => {
    for (const line of lines) {
      const sign = kind === "added" ? "+" : kind === "removed" ? "−" : " ";
      const cls =
        kind === "added" ? "diff-line diff-added" : kind === "removed" ? "diff-line diff-removed" : "diff-context";
      view.appendChild(
        el("div", {
          className: cls,
          html: `<span class="diff-sign">${sign}</span>${escapeHtml(line)}`,
        }),
      );
    }
  };

  const pushEllipsis = (count: number): void => {
    view.appendChild(
      el("div", {
        className: "diff-context",
        html: `<span class="diff-sign">…</span>—— ${count} 行未变动 ——`,
      }),
    );
  };

  for (const seg of segments) {
    if (seg.kind === "context") {
      if (contextLimit > 0 && seg.lines.length > contextLimit * 2) {
        const head = seg.lines.slice(0, contextLimit);
        const tail = seg.lines.slice(-contextLimit);
        pushLines("context", head);
        pushEllipsis(seg.lines.length - head.length - tail.length);
        pushLines("context", tail);
      } else {
        pushLines("context", seg.lines);
      }
    } else {
      pushLines(seg.kind, seg.lines);
    }
  }

  if (view.querySelectorAll(".diff-line").length === 0) {
    view.appendChild(el("div", { className: "diff-none", text: "两个版本内容完全一致" }));
  }

  return view;
}
