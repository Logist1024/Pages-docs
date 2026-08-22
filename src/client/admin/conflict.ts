/**
 * 保存冲突（HTTP 409）处理模态框：
 * 展示服务器版本与本地版本的 jsdiff 行级对比，提供三种解决方式。
 */
import type { ConflictPayload } from "../../shared/types";
import { renderDiffView } from "./diffview";
import { el, formatDateTime, openModal, type ModalHandle } from "./ui";

export interface ConflictHandlers {
  /** 以本地（我的）内容覆盖服务器；baseSeq 取自 payload.current.revision_seq */
  overwriteMine(baseSeq: number): Promise<void>;
  /** 放弃本地修改，采用服务器版本（编辑器负责回填） */
  adoptServer(): void;
  /** 以手动合并后的内容保存；baseSeq 同上 */
  mergeWith(content: string, baseSeq: number): Promise<void>;
}

let activeClose: (() => void) | null = null;

function setBusy(busy: boolean, buttons: HTMLButtonElement[]): void {
  for (const b of buttons) b.disabled = busy;
}

export function showConflictModal(
  payload: ConflictPayload,
  localTitle: string,
  localContent: string,
  handlers: ConflictHandlers,
): void {
  // 若已有冲突框打开（例如覆盖后再次 409），先关闭旧的，避免堆叠
  if (activeClose) activeClose();

  const baseSeq = payload.current.revision_seq;

  const diffBox = renderDiffView({
    oldText: payload.current.content_md,
    newText: localContent,
    removedLabel: "服务器版本",
    addedLabel: "我的版本（本地）",
    contextLimit: 3,
  });

  const mergeTextarea = el("textarea", {
    className: "field-textarea",
    attrs: { spellcheck: "false" },
  });
  mergeTextarea.value = localContent;
  const mergeBox = el("div", { className: "field" }, [
    el("label", { className: "field-label", text: "手动合并（已预填我的版本，可参照上方差异修改）" }),
    mergeTextarea,
  ]);
  mergeBox.style.display = "none";

  const meta = payload.current.updated_by
    ? `服务器版本由 ${payload.current.updated_by} 于 ${formatDateTime(payload.current.updated_at)} 保存`
    : `服务器版本保存于 ${formatDateTime(payload.current.updated_at)}`;
  const titleNote =
    localTitle !== payload.current.title
      ? ` 标题也不一致：本地「${localTitle}」，服务器「${payload.current.title}」。`
      : "";

  const message = el("div", {
    className: "conflict-message",
    text: `${payload.message}（${meta}）。${titleNote || "请选择处理方式："}`,
  });

  const actionButtons: HTMLButtonElement[] = [];

  const overwriteBtn = el("button", {
    className: "btn btn-primary",
    text: "以我的版本覆盖",
    attrs: { type: "button" },
  });
  const adoptBtn = el("button", {
    className: "btn",
    text: "采用服务器版本",
    attrs: { type: "button" },
  });
  const mergeBtn = el("button", {
    className: "btn",
    text: "手动合并",
    attrs: { type: "button" },
  });
  actionButtons.push(overwriteBtn, adoptBtn, mergeBtn);

  const mergeSaveBtn = el("button", {
    className: "btn btn-primary",
    text: "保存合并结果",
    attrs: { type: "button" },
  });
  const mergeBackBtn = el("button", {
    className: "btn",
    text: "返回对比",
    attrs: { type: "button" },
  });

  let handle: ModalHandle | null = null;
  const close = (): void => {
    handle?.close();
  };
  const register = (h: ModalHandle): void => {
    handle = h;
    activeClose = () => {
      activeClose = null;
      h.close();
    };
  };

  overwriteBtn.onclick = () => {
    setBusy(true, [...actionButtons, mergeSaveBtn]);
    handlers
      .overwriteMine(baseSeq)
      .then(() => close())
      .catch(() => {
        // 失败反馈由编辑器负责（toast / 再次弹出冲突框）
        setBusy(false, [...actionButtons, mergeSaveBtn]);
      });
  };

  adoptBtn.onclick = () => {
    handlers.adoptServer();
    close();
  };

  mergeBtn.onclick = () => {
    diffBox.style.display = "none";
    mergeBox.style.display = "";
    actionsBox.style.display = "none";
    mergeActionsBox.style.display = "";
    mergeTextarea.focus();
  };

  mergeBackBtn.onclick = () => {
    mergeBox.style.display = "none";
    diffBox.style.display = "";
    mergeActionsBox.style.display = "none";
    actionsBox.style.display = "";
  };

  mergeSaveBtn.onclick = () => {
    setBusy(true, [...actionButtons, mergeSaveBtn]);
    handlers
      .mergeWith(mergeTextarea.value, baseSeq)
      .then(() => close())
      .catch(() => {
        setBusy(false, [...actionButtons, mergeSaveBtn]);
      });
  };

  const actionsBox = el("div", { className: "conflict-actions-group" }, [
    overwriteBtn,
    adoptBtn,
    mergeBtn,
  ]);
  const mergeActionsBox = el("div", { className: "conflict-actions-group" }, [
    mergeBackBtn,
    mergeSaveBtn,
  ]);
  mergeActionsBox.style.display = "none";

  const content = el("div", {}, [message, actionsBox, mergeActionsBox, diffBox, mergeBox]);

  const h = openModal({
    title: "保存冲突：文档已被他人修改",
    content,
    wide: true,
    dismissible: false,
    onClose: () => {
      if (activeClose && handle === h) activeClose = null;
    },
  });
  register(h);
}
