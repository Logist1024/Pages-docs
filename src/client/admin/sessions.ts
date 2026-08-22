/** 会话管理（仅 admin）：列出全部会话并支持吊销。 */
import type { SessionRow } from "../../shared/types";
import { api, errMessage } from "./api";
import { el, formatDateTime, openModal, toast } from "./ui";

export function openSessionsModal(): void {
  const body = el("div", { className: "session-box" });

  const refreshBtn = el("button", {
    className: "btn btn-sm",
    text: "刷新",
    attrs: { type: "button" },
    onClick: () => void load(),
  });
  const closeBtn = el("button", {
    className: "btn",
    text: "关闭",
    attrs: { type: "button" },
    onClick: () => handle.close(),
  });

  const handle = openModal({
    title: "会话管理",
    content: body,
    actions: [refreshBtn, closeBtn],
    wide: true,
  });

  async function load(): Promise<void> {
    body.innerHTML = "";
    body.appendChild(el("div", { className: "loading-block", text: "加载中…" }));
    try {
      const rows = await api.listSessions();
      renderRows(rows);
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(
        el("div", { className: "error-block" }, [
          el("span", { text: `加载会话列表失败：${errMessage(e)}` }),
          el("button", {
            className: "btn btn-sm",
            text: "重试",
            attrs: { type: "button" },
            onClick: () => void load(),
          }),
        ]),
      );
      toast(`加载会话列表失败：${errMessage(e)}`, "error");
    }
  }

  function renderRows(rows: SessionRow[]): void {
    body.innerHTML = "";
    if (rows.length === 0) {
      body.appendChild(el("div", { className: "loading-block", text: "当前没有活跃会话" }));
      return;
    }

    const tbody = el("tbody");
    for (const row of rows) {
      const revokeBtn = el("button", {
        className: "btn btn-sm btn-danger-outline",
        text: "吊销",
        attrs: { type: "button" },
      });
      revokeBtn.onclick = () => {
        revokeBtn.disabled = true;
        api.revokeSession(row.token_hash)
          .then(() => {
            toast(`已吊销 ${row.name} 的会话`, "success");
            void load();
          })
          .catch((e: unknown) => {
            revokeBtn.disabled = false;
            toast(`吊销失败：${errMessage(e)}`, "error");
          });
      };

      const tr = el("tr", {}, [
        el("td", { text: row.name }),
        el("td", {}, [el("span", { className: `badge badge-role-${row.role}`, text: row.role })]),
        el("td", { className: "mono", text: formatDateTime(row.created_at) }),
        el("td", { className: "mono", text: formatDateTime(row.expires_at) }),
        el("td", { className: "mono", text: `${row.token_hash.slice(0, 12)}…`, attrs: { title: row.token_hash } }),
        el("td", {}, [revokeBtn]),
      ]);
      tbody.appendChild(tr);
    }

    body.appendChild(
      el("table", { className: "session-table" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "用户" }),
            el("th", { text: "角色" }),
            el("th", { text: "创建时间" }),
            el("th", { text: "过期时间" }),
            el("th", { text: "Token" }),
            el("th", { text: "操作" }),
          ]),
        ]),
        tbody,
      ]),
    );
  }

  void load();
}
