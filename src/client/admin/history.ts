/**
 * 版本历史抽屉：右侧滑出面板，列出修订版本，
 * 支持查看与当前内容的行级 diff、一键回滚、单条删除与清空历史（admin）。
 */
import type { DocumentDetail, RevisionDetail, RevisionSummary } from "../../shared/types";
import { api, errMessage } from "./api";
import { renderDiffView } from "./diffview";
import { icon } from "./icons";
import { isAdmin } from "./state";
import { el, confirmDialog, formatDateTime, toast } from "./ui";
import { refreshDocs } from "./tree";

export interface HistoryDeps {
  /** 当前打开的文档 id；null 表示未打开 */
  getCurrentDocId(): number | null;
  /** 当前编辑器中的 Markdown 内容 */
  getCurrentContent(): string;
  /** 回滚前确保本地修改已保存 */
  beforeReload(): Promise<void>;
  /** 回滚成功后用新的 DocumentDetail 回填编辑器 */
  onRolledBack(detail: DocumentDetail): Promise<void>;
}

let deps: HistoryDeps | null = null;

export function initHistory(d: HistoryDeps): void {
  deps = d;
}

let overlay: HTMLElement | null = null;
let drawer: HTMLElement | null = null;
let listPane: HTMLElement | null = null;
let detailPane: HTMLElement | null = null;
let escHandler: ((ev: KeyboardEvent) => void) | null = null;
/** 抽屉对应的文档 id（打开时锁定） */
let drawerDocId: number | null = null;
/** 版本详情请求代际令牌：新请求或关闭抽屉都会使在途响应失效 */
let detailToken = 0;

function teardown(): void {
  if (escHandler) {
    document.removeEventListener("keydown", escHandler);
    escHandler = null;
  }
  detailToken++; // 使在途的版本详情响应失效
  if (drawer) drawer.classList.remove("open");
  const ov = overlay;
  if (ov) {
    window.setTimeout(() => ov.remove(), 220);
  }
  overlay = null;
  drawer = null;
  listPane = null;
  detailPane = null;
  drawerDocId = null;
}

export function closeHistoryDrawer(): void {
  teardown();
}

export function openHistoryDrawer(): void {
  const docId = deps?.getCurrentDocId() ?? null;
  if (!deps || docId === null) {
    toast("请先打开一篇文档", "error");
    return;
  }

  // 若已打开则先重建，保证数据新鲜
  teardown();
  drawerDocId = docId;

  listPane = el("div", { className: "history-list" });
  detailPane = el("div", { className: "history-detail" });
  detailPane.style.display = "none";

  const closeBtn = el("button", {
    className: "btn-icon",
    attrs: { type: "button", "aria-label": "关闭历史面板" },
    onClick: () => teardown(),
  });
  closeBtn.appendChild(icon("x", 15));

  const headChildren: HTMLElement[] = [
    el("div", { className: "drawer-title", text: "版本历史" }),
    el("div", { className: "spacer" }),
  ];
  if (isAdmin()) {
    const clearBtn = el("button", {
      className: "btn btn-sm btn-danger-outline",
      text: "清空历史",
      attrs: { type: "button", title: "删除全部版本（保留当前发布快照）" },
      onClick: () => void doClearRevisions(),
    });
    clearBtn.insertBefore(icon("trash", 13), clearBtn.firstChild);
    headChildren.push(clearBtn);
  }
  headChildren.push(closeBtn);

  drawer = el("aside", { className: "history-drawer" }, [
    el("div", { className: "drawer-head" }, headChildren),
    el("div", { className: "drawer-body" }, [listPane, detailPane]),
  ]);
  overlay = el("div", { className: "drawer-overlay" });
  overlay.onmousedown = () => teardown();

  escHandler = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") teardown();
  };
  document.addEventListener("keydown", escHandler);

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
  window.requestAnimationFrame(() => drawer?.classList.add("open"));

  void loadRevisions(docId);
}

/* ---------------- 列表 ---------------- */

async function loadRevisions(docId: number): Promise<void> {
  if (!listPane) return;
  listPane.innerHTML = "";
  listPane.appendChild(el("div", { className: "loading-block", text: "加载中…" }));
  try {
    const revisions = await api.listRevisions(docId);
    if (!listPane) return;
    listPane.innerHTML = "";
    if (revisions.length === 0) {
      listPane.appendChild(el("div", { className: "loading-block", text: "暂无历史版本（发布或保存后会产生版本）" }));
      return;
    }
    for (const rev of revisions) {
      listPane.appendChild(renderRevisionItem(rev));
    }
  } catch (e) {
    if (!listPane) return;
    listPane.innerHTML = "";
    listPane.appendChild(
      el("div", { className: "error-block" }, [
        el("span", { text: `加载版本列表失败：${errMessage(e)}` }),
        el("button", {
          className: "btn btn-sm",
          text: "重试",
          attrs: { type: "button" },
          onClick: () => void loadRevisions(docId),
        }),
      ]),
    );
  }
}

function renderRevisionItem(rev: RevisionSummary): HTMLElement {
  const openDetail = (): void => void showRevisionDetail(rev.id);

  const headChildren = [
    el("span", { className: "rev-time", text: formatDateTime(rev.created_at) }),
    el("span", { className: "rev-author", text: rev.author_name }),
  ];
  if (isAdmin()) {
    const delBtn = el("button", {
      className: "btn-icon rev-delete-btn",
      attrs: { type: "button", title: "删除该版本", "aria-label": "删除该版本" },
      onClick: (ev) => {
        ev.stopPropagation();
        void doDeleteRevision(rev);
      },
    });
    delBtn.appendChild(icon("trash", 13));
    headChildren.push(el("span", { className: "spacer" }), delBtn);
  }

  // 根节点用 div（内部还要放删除按钮，button 不能嵌套 button）
  const item = el("div", {
    className: "rev-item",
    attrs: { role: "button", tabindex: "0" },
  }, [
    el("div", { className: "rev-item-head" }, headChildren),
    rev.note ? el("div", { className: "rev-note", text: rev.note }) : null,
    el("div", { className: "rev-title-line", text: `标题：${rev.title}` }),
  ]);
  item.onclick = openDetail;
  item.onkeydown = (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      openDetail();
    }
  };
  return item;
}

/* ---------------- 删除版本 ---------------- */

async function doDeleteRevision(rev: RevisionSummary): Promise<void> {
  if (drawerDocId === null) return;
  const okFlag = await confirmDialog({
    title: "删除版本",
    message: `确定删除 ${formatDateTime(rev.created_at)} 的版本（作者：${rev.author_name}）？该版本内容将永久丢失，不可恢复。`,
    confirmText: "删除",
    danger: true,
  });
  if (!okFlag) return;
  try {
    await api.deleteRevision(rev.id);
    toast("已删除该版本", "success");
    // 详情面板若正展示被删版本，回到列表
    if (detailPane && detailPane.style.display !== "none") backToList();
    if (drawerDocId !== null) void loadRevisions(drawerDocId);
  } catch (e) {
    toast(`删除失败：${errMessage(e)}`, "error");
  }
}

async function doClearRevisions(): Promise<void> {
  const docId = drawerDocId;
  if (docId === null) return;
  const okFlag = await confirmDialog({
    title: "清空版本历史",
    message: "确定清空该文档的全部版本历史？仅保留当前发布快照，其余版本将永久删除，不可恢复。",
    confirmText: "全部删除",
    danger: true,
  });
  if (!okFlag) return;
  try {
    const res = await api.clearRevisions(docId);
    toast(res.deleted > 0 ? `已清空 ${res.deleted} 条版本记录` : "没有可删除的版本记录", "success");
    if (detailPane && detailPane.style.display !== "none") backToList();
    void loadRevisions(docId);
  } catch (e) {
    toast(`清空失败：${errMessage(e)}`, "error");
  }
}

/* ---------------- 详情 + diff ---------------- */

async function showRevisionDetail(revisionId: number): Promise<void> {
  if (!deps || !detailPane || !listPane) return;
  const token = ++detailToken; // 快速连点多个版本时，只有最后一次点击能落渲染
  const currentContent = deps.getCurrentContent();

  detailPane.innerHTML = "";
  detailPane.style.display = "";
  listPane.style.display = "none";
  detailPane.appendChild(el("div", { className: "loading-block", text: "加载版本内容…" }));

  let rev: RevisionDetail;
  try {
    rev = await api.getRevision(revisionId);
  } catch (e) {
    if (token !== detailToken || !detailPane) return; // 等待期间已被新请求/关闭取代
    detailPane.innerHTML = "";
    detailPane.appendChild(
      el("div", { className: "error-block" }, [
        el("span", { text: `加载版本失败：${errMessage(e)}` }),
        el("button", {
          className: "btn btn-sm",
          text: "返回列表",
          attrs: { type: "button" },
          onClick: backToList,
        }),
      ]),
    );
    return;
  }
  if (token !== detailToken || !detailPane || !listPane) return;

  const diff = renderDiffView({
    oldText: currentContent,
    newText: rev.content_md,
    removedLabel: "当前内容（回滚将移除）",
    addedLabel: "该版本内容（回滚将恢复）",
    contextLimit: 3,
  });

  const backBtn = el("button", {
    className: "btn",
    text: "返回列表",
    attrs: { type: "button" },
    onClick: backToList,
  });
  backBtn.insertBefore(icon("arrowLeft", 14), backBtn.firstChild);
  const rollbackBtn = el("button", {
    className: "btn btn-danger-outline",
    text: "回滚到此版本",
    attrs: { type: "button" },
    onClick: () => void doRollback(rev),
  });

  detailPane.innerHTML = "";
  detailPane.appendChild(
    el("div", { className: "rev-detail-meta" }, [
      backBtn,
      el("span", { className: "rev-time", text: formatDateTime(rev.created_at) }),
      el("span", { text: `作者：${rev.author_name}` }),
      rev.note ? el("span", { className: "rev-note", text: rev.note }) : null,
    ]),
  );
  detailPane.appendChild(diff);
  detailPane.appendChild(el("div", { className: "modal-actions" }, [rollbackBtn]));
}

/** 详情面板 → 返回列表（模块级，供删除版本后复用） */
function backToList(): void {
  if (!detailPane || !listPane) return;
  detailPane.style.display = "none";
  detailPane.innerHTML = "";
  listPane.style.display = "";
}

async function doRollback(rev: RevisionDetail): Promise<void> {
  if (!deps) return;
  const okFlag = await confirmDialog({
    title: "回滚确认",
    message: `确定回滚到 ${formatDateTime(rev.created_at)} 的版本（作者：${rev.author_name}）？回滚会生成一条新版本记录。`,
    confirmText: "回滚",
    danger: true,
  });
  if (!okFlag) return;

  await deps.beforeReload();
  try {
    const detail = await api.rollbackRevision(rev.id);
    await deps.onRolledBack(detail);
    void refreshDocs();
    toast("已回滚到此版本", "success");
    teardown();
  } catch (e) {
    toast(`回滚失败：${errMessage(e)}`, "error");
  }
}
