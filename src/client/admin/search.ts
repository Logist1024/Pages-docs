/** 顶栏搜索：Enter 触发 /api/search，下拉面板展示 title + excerpt（服务端含 <mark> 高亮）。 */
import { api, errMessage } from "./api";
import { state } from "./state";
import { el, escapeHtml, toast } from "./ui";

let seqToken = 0;
let documentEscHandler: ((ev: KeyboardEvent) => void) | null = null;
let documentClickHandler: ((ev: MouseEvent) => void) | null = null;

export function initSearch(input: HTMLInputElement, panel: HTMLElement): void {
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void runSearch(input.value);
    } else if (ev.key === "Escape") {
      closePanel();
    }
  };

  // 面板打开时：Esc 关闭、点击外部关闭。
  // renderApp 每次登录都会重新装配，先移除旧监听，避免重复触发与闭包泄漏。
  if (documentEscHandler) document.removeEventListener("keydown", documentEscHandler);
  if (documentClickHandler) document.removeEventListener("click", documentClickHandler);

  documentEscHandler = (ev) => {
    if (ev.key === "Escape" && panel.classList.contains("open")) {
      closePanel();
      input.blur();
    }
  };
  document.addEventListener("keydown", documentEscHandler);

  documentClickHandler = (ev) => {
    if (!panel.classList.contains("open")) return;
    const box = panel.parentElement;
    if (box && !box.contains(ev.target as Node)) closePanel();
  };
  document.addEventListener("click", documentClickHandler);

  function runSearch(query: string): void {
    const q = query.trim();
    if (q.length === 0) {
      closePanel();
      return;
    }
    const token = ++seqToken;
    renderMessage("search-empty", "搜索中…");
    api.search(q)
      .then((res) => {
        if (token !== seqToken) return;
        renderHits(res.hits, res.total);
      })
      .catch((e: unknown) => {
        if (token !== seqToken) return;
        renderMessage("search-error", `搜索失败：${errMessage(e)}`);
        toast(`搜索失败：${errMessage(e)}`, "error");
      });
  }

  function renderMessage(cls: string, text: string): void {
    panel.innerHTML = "";
    panel.classList.add("open");
    panel.appendChild(el("div", { className: cls, text }));
  }

  function renderHits(hits: Array<{ id: number; path: string; title: string; excerpt: string }>, total: number): void {
    panel.innerHTML = "";
    if (hits.length === 0) {
      renderMessage("search-empty", "没有匹配的文档");
      return;
    }
    panel.classList.add("open");
    panel.appendChild(el("div", { className: "search-empty", text: `共 ${total} 条结果` }));
    for (const hit of hits) {
      // excerpt 由服务端生成：只含 <mark> 与已转义文本，是唯一允许 innerHTML 的字段
      const item = el("button", {
        className: "search-hit",
        attrs: { type: "button" },
      }, [
        el("div", { className: "search-hit-title", html: `${escapeHtml(hit.title)}<span class="search-hit-path">${escapeHtml(hit.path)}</span>` }),
        el("div", { className: "search-excerpt", html: hit.excerpt }),
      ]);
      item.onclick = () => {
        closePanel();
        input.blur();
        // 文档不在列表（如无权限）时按契约忽略，不跳转也不报错
        if (!state.docs.some((d) => d.id === hit.id)) return;
        location.hash = `#/doc/${hit.id}`;
      };
      panel.appendChild(item);
    }
  }

  function closePanel(): void {
    seqToken++; // 使在途响应失效
    panel.classList.remove("open");
    panel.innerHTML = "";
  }
}
