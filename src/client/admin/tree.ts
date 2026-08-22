/** 左侧文档树：目录树构建、折叠展开、新建文档/新建目录模态框。
 *  目录来源有两部分：文档 path 隐式推出的中间段，以及 folders 表里显式创建的空目录。 */
import type { DocumentSummary, FolderInfo, UpdateFolderInput } from "../../shared/types";
import { ApiError, api, errMessage } from "./api";
import { icon } from "./icons";
import { joinPath, randomDocName, slugify } from "./slug";
import { state } from "./state";
import { el, openModal, toast } from "./ui";

let treeContainer: HTMLElement | null = null;
let initialized = false;

/** 已展开的文件夹路径集合（跨刷新保留用户的选择） */
const expandedFolders = new Set<string>();

interface FolderNode {
  name: string;
  path: string;
  /** 显示名称：显式目录用用户设置的名称（任意语言），隐式目录回退为路径段 */
  displayName: string;
  folders: FolderNode[];
  docs: DocumentSummary[];
}

/** 校验完整 path；合法返回 null，否则返回错误文案 */
export function validateDocPath(path: string): string | null {
  const p = path.trim();
  if (p.length === 0) return "路径不能为空";
  if (!/^[a-z0-9\-_/]+$/.test(p)) return "路径仅允许小写字母、数字、连字符（-）、下划线（_）和斜杠（/）";
  if (p.startsWith("/") || p.endsWith("/")) return "路径不能以 / 开头或结尾";
  if (p.includes("//")) return "路径中不能出现连续的 /";
  if (p.length > 200) return "路径过长（最多 200 字符）";
  return null;
}

/** 校验单级目录名/文件名（不含斜杠）；导出供移动/改名弹窗复用 */
export function validateSegment(name: string): string | null {
  if (name.length === 0) return "名称不能为空";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return "仅允许小写字母、数字、连字符（-）、下划线（_），且以字母或数字开头";
  return null;
}

/** 全部目录路径 = 显式空目录 ∪ 文档路径隐式推出的父目录（去重、字典序） */
export function allFolderPaths(): string[] {
  const set = new Set<string>(state.folders.map((f) => f.path));
  for (const doc of state.docs) {
    const segments = doc.path.split("/");
    segments.pop(); // 最后一段是文件名
    let acc = "";
    for (const seg of segments) {
      acc = acc.length === 0 ? seg : `${acc}/${seg}`;
      set.add(acc);
    }
  }
  return [...set].sort();
}

/** path → 显示名称：显式目录取用户设置的名称，否则回退为路径最后一段 */
function displayNameFor(path: string): string {
  const info = state.folders.find((f) => f.path === path);
  if (info && info.name.length > 0) return info.name;
  return path.split("/").pop() || path;
}

/** 该目录子树内是否有文档或子目录（决定能否删除） */
function folderIsEmpty(path: string): boolean {
  const prefix = `${path}/`;
  if (state.docs.some((d) => d.path === path || d.path.startsWith(prefix))) return false;
  if (state.folders.some((f) => f.path !== path && f.path.startsWith(prefix))) return false;
  return true;
}

/** 把某条链路上的所有祖先目录标记为展开 */
function expandAncestors(path: string): void {
  const segments = path.split("/");
  let acc = "";
  for (const seg of segments) {
    acc = acc.length === 0 ? seg : `${acc}/${seg}`;
    if (acc !== path) expandedFolders.add(acc);
  }
}

/** 目录移动后同步平移展开状态：old/* 的展开记录改写到新前缀 */
function remapExpandedFolders(from: string, to: string): void {
  if (from === to) return;
  const fromPrefix = `${from}/`;
  const next = new Set<string>();
  for (const p of expandedFolders) {
    if (p === from) next.add(to);
    else if (p.startsWith(fromPrefix)) next.add(`${to}${p.slice(from.length)}`);
    else next.add(p);
  }
  expandedFolders.clear();
  for (const p of next) expandedFolders.add(p);
}

function buildTree(docs: DocumentSummary[]): FolderNode {
  const root: FolderNode = { name: "", path: "", displayName: "", folders: [], docs: [] };

  const ensureFolder = (fullPath: string): FolderNode => {
    const segments = fullPath.split("/");
    let cur = root;
    let acc = "";
    for (const seg of segments) {
      acc = acc.length === 0 ? seg : `${acc}/${seg}`;
      let next = cur.folders.find((f) => f.name === seg);
      if (!next) {
        next = { name: seg, path: acc, displayName: displayNameFor(acc), folders: [], docs: [] };
        cur.folders.push(next);
      }
      cur = next;
    }
    return cur;
  };

  // 先建显式目录（保证空目录也出现），再挂文档
  for (const folderPath of allFolderPaths()) ensureFolder(folderPath);
  for (const doc of docs) {
    const segments = doc.path.split("/").filter((s) => s.length > 0);
    const fileName = segments.pop();
    if (fileName === undefined) continue;
    const cur = segments.length > 0 ? ensureFolder(segments.join("/")) : root;
    cur.docs.push(doc);
  }
  return root;
}

function navigateToDoc(id: number): void {
  const target = `#/doc/${id}`;
  if (location.hash === target) {
    // hash 未变化不会触发 hashchange（如上次打开失败停留在该 hash）：
    // 手动派发一次让路由重跑，保证再次点击可以重试
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  location.hash = target;
}

function renderFolderNode(node: FolderNode, depth: number, container: HTMLElement): void {
  // 文件夹在前、叶子在后（docs 已按 path 排序，天然稳定）
  for (const folder of node.folders) {
    if (!initialized && depth === 0) expandedFolders.add(folder.path);
    const expanded = expandedFolders.has(folder.path);

    const childrenBox = el("div", { className: "tree-children" });
    const row = el("div", {
      className: expanded ? "tree-folder-row expanded" : "tree-folder-row",
      attrs: { role: "button", tabindex: "0" },
    }, [
      el("span", { className: "tree-caret" }),
      icon("folder", 15),
      el("span", { className: "tree-folder-name", text: folder.displayName, attrs: { title: folder.path } }),
      buildFolderActions(folder),
    ]);
    const toggle = (): void => {
      if (expandedFolders.has(folder.path)) expandedFolders.delete(folder.path);
      else expandedFolders.add(folder.path);
      render();
    };
    row.onclick = () => toggle();
    row.onkeydown = (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle();
      }
    };

    container.appendChild(row);
    container.appendChild(childrenBox);
    if (expanded) renderFolderNode(folder, depth + 1, childrenBox);
  }

  for (const doc of node.docs) {
    const isActive = state.currentDocId === doc.id;
    const row = el("button", {
      className: isActive ? "tree-doc-row active" : "tree-doc-row",
      attrs: { type: "button", title: doc.path },
    }, [
      el("span", { className: "tree-doc-title", text: doc.title || doc.path }),
      doc.status === "draft" ? el("span", { className: "badge badge-draft", text: "草稿" }) : null,
    ]);
    row.onclick = () => navigateToDoc(doc.id);
    container.appendChild(row);
  }
}

/** 目录行右侧的悬停操作：在此新建文档 / 重命名 / 删除空目录 */
function buildFolderActions(folder: FolderNode): HTMLElement {
  const actions = el("div", { className: "row-actions" });
  const newDocBtn = el("button", {
    className: "row-action-btn",
    attrs: { type: "button", title: `在「${folder.displayName}」中新建文档`, "aria-label": `在「${folder.displayName}」中新建文档` },
    onClick: (ev) => {
      ev.stopPropagation();
      openNewDocModal(folder.path);
    },
  });
  newDocBtn.appendChild(icon("plus", 13));
  actions.appendChild(newDocBtn);

  const renameBtn = el("button", {
    className: "row-action-btn",
    attrs: { type: "button", title: `重命名 / 移动「${folder.displayName}」`, "aria-label": `重命名 / 移动「${folder.displayName}」` },
    onClick: (ev) => {
      ev.stopPropagation();
      openFolderSettingsModal(folder);
    },
  });
  renameBtn.appendChild(icon("pencil", 13));
  actions.appendChild(renameBtn);

  if (folderIsEmpty(folder.path)) {
    const delBtn = el("button", {
      className: "row-action-btn danger",
      attrs: { type: "button", title: `删除空目录「${folder.displayName}」`, "aria-label": `删除空目录「${folder.displayName}」` },
      onClick: (ev) => {
        ev.stopPropagation();
        void deleteEmptyFolder(folder.path);
      },
    });
    delBtn.appendChild(icon("trash", 13));
    actions.appendChild(delBtn);
  }
  return actions;
}

/**
 * 目录「重命名 / 移动」弹窗：显示名称（任意语言）+ 完整访问路径。
 * 修改路径会把该目录下所有子文档与子目录一并移动，旧链接随之失效。
 */
function openFolderSettingsModal(folder: FolderNode): void {
  const nameInput = el("input", {
    className: "field-input",
    attrs: { type: "text", autocomplete: "off", placeholder: "例如：使用指南 / Tutorial" },
  });
  nameInput.value = folder.displayName;

  const pathInput = el("input", {
    className: "field-input field-mono",
    attrs: { type: "text", spellcheck: "false", autocomplete: "off" },
  });
  pathInput.value = folder.path;

  const errorLine = el("div", { className: "field-error" });
  const pathPreview = el("div", { className: "path-preview" });

  let submitting = false;

  const updatePreview = (): void => {
    const normalized = normalizePathInput(pathInput.value);
    pathPreview.textContent =
      normalized === folder.path
        ? `当前访问路径：/${folder.path}`
        : `访问路径将变为：/${normalized}（其下所有内容一并移动）`;
  };
  pathInput.oninput = updatePreview;
  updatePreview();

  const confirmBtn = el("button", {
    className: "btn btn-primary",
    text: "保存",
    attrs: { type: "submit" },
  });
  const cancelBtn = el("button", {
    className: "btn",
    text: "取消",
    attrs: { type: "button" },
    onClick: () => handle.close(),
  });

  const form = el("form", {
    onSubmit: (ev) => {
      ev.preventDefault();
      if (submitting) return;
      errorLine.textContent = "";

      const newName = nameInput.value.trim();
      if (newName.length === 0) {
        errorLine.textContent = "目录名称不能为空";
        return;
      }
      if (newName.length > 100) {
        errorLine.textContent = "目录名称不能超过 100 字";
        return;
      }
      const newPath = normalizePathInput(pathInput.value);
      const pathError = validateDocPath(newPath);
      if (pathError !== null) {
        errorLine.textContent = pathError;
        return;
      }

      // 只提交有变更的字段
      const patch: UpdateFolderInput = {};
      if (newName !== folder.displayName) patch.name = newName;
      if (newPath !== folder.path) patch.path = newPath;
      if (patch.name === undefined && patch.path === undefined) {
        handle.close();
        return;
      }

      submitting = true;
      confirmBtn.disabled = true;
      api.updateFolder(folder.path, patch)
        .then((res) => {
          handle.close();
          remapExpandedFolders(folder.path, res.path || newPath);
          expandAncestors(res.path || newPath);
          expandedFolders.add(res.path || newPath);
          toast(
            patch.path !== undefined ? `已移动至 /${res.path}` : `已重命名为「${newName}」`,
            "success"
          );
          void refreshDocs();
        })
        .catch((e: unknown) => {
          submitting = false;
          confirmBtn.disabled = false;
          errorLine.textContent =
            e instanceof ApiError && e.status === 409
              ? errMessage(e)
              : `保存失败：${errMessage(e)}`;
        });
    },
  }, [
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "目录名称（任意语言）" }),
      nameInput,
    ]),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "完整访问路径" }),
      pathInput,
      pathPreview,
      el("div", {
        className: "field-hint",
        text: "可包含多级子目录；移动会改变该目录及其下所有文档的访问地址，旧链接将失效。",
      }),
    ]),
    errorLine,
  ]);

  const handle = openModal({
    title: `编辑目录「${folder.displayName}」`,
    content: form,
    actions: [cancelBtn, confirmBtn],
    wide: true,
  });
}

async function deleteEmptyFolder(path: string): Promise<void> {
  try {
    await api.deleteFolder(path);
    toast(`已删除目录「${path}」`, "success");
    await refreshDocs();
  } catch (e) {
    toast(`删除目录失败：${errMessage(e)}`, "error");
  }
}

function render(): void {
  if (!treeContainer) return;
  treeContainer.innerHTML = "";
  if (state.docs.length === 0 && state.folders.length === 0) {
    treeContainer.appendChild(el("div", { className: "tree-empty", text: "暂无内容，点击「＋文档」创建第一篇" }));
    initialized = true;
    return;
  }
  const root = buildTree(state.docs);
  renderFolderNode(root, 0, treeContainer);
  initialized = true;
}

/** 拉取文档与目录列表并重绘树 */
export async function refreshDocs(): Promise<void> {
  try {
    const [docs, folders] = await Promise.all([
      api.listDocs(),
      api.listFolders().catch(() => ({ folders: [] as FolderInfo[] })),
    ]);
    state.docs = docs;
    state.folders = folders.folders;
    render();
  } catch (e) {
    toast(`加载文档列表失败：${errMessage(e)}`, "error");
  }
}

/** 挂载树容器并完成首次渲染 */
export function mountTree(container: HTMLElement): void {
  treeContainer = container;
}

/** 高亮当前打开的文档 */
export function setActiveDoc(id: number | null): void {
  state.currentDocId = id;
  render();
}

/* ---------------- 目录下拉选项（新建文档/新建目录/移动改名共用） ---------------- */

export function buildFolderSelect(selected?: string): HTMLSelectElement {
  const select = el("select", { className: "field-input field-select" });
  const options: Array<{ value: string; label: string }> = [
    { value: "", label: "（根目录）" },
    ...allFolderPaths().map((p) => ({ value: p, label: displayNameFor(p) })),
  ];
  // 当前所在目录一定出现在选项里（可能尚未反映到 state）
  if (selected && !options.some((o) => o.value === selected)) {
    options.push({ value: selected, label: selected });
  }
  for (const opt of options) {
    const node = el("option", { text: opt.label, attrs: { value: opt.value } });
    if (opt.value === (selected ?? "")) node.selected = true;
    select.appendChild(node);
  }
  return select;
}

/* ---------------- 新建文档模态框 ---------------- */

/** 规整用户输入的完整路径：去首尾空白与斜杠、转小写、合并连续斜杠 */
export function normalizePathInput(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * 打开新建文档弹窗；folder 指定默认所在目录（如从目录行的「＋」进入）。
 * 支持两种方式指定访问路径：
 *  1. 「所在目录」下拉 + 按标题自动生成文件名（默认）；
 *  2. 直接输入自定义完整路径（可含多级子目录，优先级更高）。
 */
export function openNewDocModal(folder = ""): void {
  let submitting = false;

  const folderSelect = buildFolderSelect(folder);
  const titleInput = el("input", {
    className: "field-input",
    attrs: { type: "text", placeholder: "文档标题", autocomplete: "off" },
  });
  const customPathInput = el("input", {
    className: "field-input field-mono",
    attrs: { type: "text", placeholder: "留空自动生成；也可自定义，如 guide/getting-started", autocomplete: "off", spellcheck: "false" },
  });
  const errorLine = el("div", { className: "field-error" });
  const pathPreview = el("div", { className: "path-preview" });

  /** 由标题生成候选文件名；纯中文等无 slug 时用随机名 */
  const candidateName = (): string => slugify(titleInput.value) || randomDocName();

  const updatePreview = (): void => {
    const custom = normalizePathInput(customPathInput.value);
    pathPreview.textContent =
      custom.length > 0
        ? `将创建为：/${custom}`
        : `将创建为：/${joinPath(folderSelect.value, candidateName())}`;
    // 自定义路径优先时弱化目录下拉，提示用户当前生效的来源
    folderSelect.disabled = custom.length > 0;
    folderSelect.classList.toggle("field-dimmed", custom.length > 0);
  };
  titleInput.oninput = updatePreview;
  folderSelect.onchange = updatePreview;
  customPathInput.oninput = updatePreview;
  updatePreview();

  const confirmBtn = el("button", {
    className: "btn btn-primary",
    text: "创建",
    attrs: { type: "submit" },
  });
  const cancelBtn = el("button", {
    className: "btn",
    text: "取消",
    attrs: { type: "button" },
    onClick: () => handle.close(),
  });

  const form = el("form", {
    onSubmit: (ev) => {
      ev.preventDefault();
      if (submitting) return;
      errorLine.textContent = "";

      const title = titleInput.value.trim();
      if (title.length === 0) {
        errorLine.textContent = "标题不能为空";
        return;
      }

      submitting = true;
      confirmBtn.disabled = true;

      // 自定义完整路径优先；否则按标题自动生成并在同名冲突时追加 -2、-3… 重试（最多 8 次）
      const customPath = normalizePathInput(customPathInput.value);
      let candidates: string[];
      if (customPath.length > 0) {
        candidates = [customPath];
      } else {
        const base = joinPath(folderSelect.value, candidateName());
        candidates = [base];
        for (let i = 2; i <= 8; i++) candidates.push(`${base}-${i}`);
        candidates.push(joinPath(folderSelect.value, randomDocName()));
      }

      const tryCreate = async (): Promise<void> => {
        let lastError: unknown = null;
        for (const candidate of candidates) {
          const pathError = validateDocPath(candidate);
          if (pathError !== null) {
            lastError = new Error(pathError);
            continue;
          }
          try {
            const detail = await api.createDoc({ path: candidate, title });
            toast(`已创建「${detail.title}」`, "success");
            handle.close();
            expandAncestors(detail.path);
            await refreshDocs();
            navigateToDoc(detail.id);
            return;
          } catch (e) {
            lastError = e;
            if (!(e instanceof ApiError && e.status === 409)) throw e;
          }
        }
        throw lastError ?? new Error("创建失败");
      };

      void tryCreate().catch((e: unknown) => {
        submitting = false;
        confirmBtn.disabled = false;
        errorLine.textContent =
          e instanceof ApiError && e.status === 409
            ? customPath.length > 0
              ? "该路径已存在，请修改自定义路径"
              : "该路径已存在，请换一个标题"
            : errMessage(e);
      });
    },
  }, [
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "标题" }),
      titleInput,
    ]),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "所在目录" }),
      folderSelect,
      el("div", { className: "field-hint", text: "不选则为根目录；新目录可先用「新建目录」创建。" }),
    ]),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "自定义访问路径（可选）" }),
      customPathInput,
      pathPreview,
      el("div", {
        className: "field-hint",
        text: "填写后优先于「所在目录」，可包含多级子目录；仅允许小写字母、数字、-、_ 和 /。",
      }),
    ]),
    errorLine,
  ]);

  const handle = openModal({
    title: "新建文档",
    content: form,
    actions: [cancelBtn, confirmBtn],
    wide: true,
  });
}

/* ---------------- 新建目录模态框 ---------------- */

/**
 * 新建目录弹窗：上级目录决定路径前缀（只读展示，切换上级目录时随之更新），
 * 输入框只填最后一段名称。目录名称支持任意语言，访问路径末段自动 slug 化。
 */
export function openNewFolderModal(parent = ""): void {
  let submitting = false;

  const folderSelect = buildFolderSelect(parent);
  const nameInput = el("input", {
    className: "field-input",
    attrs: { type: "text", placeholder: "目录名称，任意语言，如：指南 / Tutorial", autocomplete: "off" },
  });

  // 路径前缀由「上级目录」决定，只读不可编辑；输入框仅填最后一段
  const prefixEl = el("span", {
    className: "path-prefix",
    attrs: { "aria-hidden": "true" },
  });
  const slugInput = el("input", {
    className: "field-input field-mono path-segment-input",
    attrs: { type: "text", placeholder: "留空则自动生成", autocomplete: "off", spellcheck: "false" },
  });
  const pathGroup = el("div", { className: "path-input-group" }, [prefixEl, slugInput]);

  const errorLine = el("div", { className: "field-error" });
  const pathPreview = el("div", { className: "path-preview" });

  /** 用户是否手动编辑过访问路径末段（编辑后不再自动跟随名称变化） */
  let slugTouched = false;

  const updatePrefix = (): void => {
    prefixEl.textContent = folderSelect.value.length > 0 ? `/${folderSelect.value}/` : "/";
  };

  /** 访问路径最终取值：手动输入 > 名称 slug > 随机短名 */
  const resolveSlug = (): string => {
    const manual = slugInput.value.trim().toLowerCase();
    if (manual.length > 0) return manual;
    return slugify(nameInput.value) || randomDocName();
  };

  const updatePreview = (): void => {
    const manual = slugInput.value.trim().toLowerCase();
    const auto = slugify(nameInput.value);
    if (manual.length > 0) {
      pathPreview.textContent = `将创建为：${prefixEl.textContent}${manual}`;
      return;
    }
    if (auto.length > 0) {
      pathPreview.textContent = `将创建为：${prefixEl.textContent}${auto}`;
      return;
    }
    pathPreview.textContent = `将创建为：${prefixEl.textContent}（随机短名）`;
  };
  nameInput.oninput = () => {
    if (!slugTouched) slugInput.value = slugify(nameInput.value);
    updatePreview();
  };
  slugInput.oninput = () => {
    slugTouched = slugInput.value.trim().length > 0;
    updatePreview();
  };
  folderSelect.onchange = () => {
    updatePrefix();
    updatePreview();
  };
  updatePrefix();
  updatePreview();

  const confirmBtn = el("button", {
    className: "btn btn-primary",
    text: "创建",
    attrs: { type: "submit" },
  });
  const cancelBtn = el("button", {
    className: "btn",
    text: "取消",
    attrs: { type: "button" },
    onClick: () => handle.close(),
  });

  const form = el("form", {
    onSubmit: (ev) => {
      ev.preventDefault();
      if (submitting) return;
      errorLine.textContent = "";

      const displayName = nameInput.value.trim();
      if (displayName.length === 0) {
        errorLine.textContent = "目录名称不能为空";
        return;
      }
      if (displayName.length > 100) {
        errorLine.textContent = "目录名称不能超过 100 字";
        return;
      }
      const slug = resolveSlug();
      const segError = validateSegment(slug);
      if (segError !== null) {
        errorLine.textContent = `访问路径不合法：${segError}`;
        return;
      }

      submitting = true;
      confirmBtn.disabled = true;
      const path = joinPath(folderSelect.value, slug);
      api.createFolder({ path, name: displayName })
        .then(async () => {
          toast(`已创建目录「${displayName}」`, "success");
          handle.close();
          expandedFolders.add(path);
          expandAncestors(path);
          await refreshDocs();
        })
        .catch((e: unknown) => {
          submitting = false;
          confirmBtn.disabled = false;
          errorLine.textContent =
            e instanceof ApiError && e.status === 409 ? "该访问路径已存在，请换一个" : errMessage(e);
        });
    },
  }, [
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "上级目录" }),
      folderSelect,
      el("div", { className: "field-hint", text: "新目录将创建在该目录之下；左侧树中也可悬停某目录后点「＋」。" }),
    ]),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "目录名称（任意语言）" }),
      nameInput,
    ]),
    el("div", { className: "field" }, [
      el("label", { className: "field-label", text: "访问路径（最后一段）" }),
      pathGroup,
      pathPreview,
      el("div", {
        className: "field-hint",
        text: "前缀固定为上方所选目录，无法手动更改；末段用于 URL，仅支持小写字母、数字、- 和 _。",
      }),
    ]),
    errorLine,
  ]);

  const handle = openModal({
    title: "新建目录",
    content: form,
    actions: [cancelBtn, confirmBtn],
  });
}
