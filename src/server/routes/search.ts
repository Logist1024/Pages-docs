import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getSessionUser } from "../auth";
import { fail } from "../http-error";
import { ftsQueryOf } from "../markdown";
import { esc } from "../layout";
import type { SearchHit, SessionRow } from "../../shared/types";

export interface SearchRow {
  id: number;
  path: string;
  lang: string;
  title: string;
  excerpt: string;
}

/** FTS5 搜索（仅 published 快照）。供 /api/search 与 /search 页共用 */
export async function searchDocuments(db: D1Database, query: string, lang: string = "en", limit = 20): Promise<SearchHit[]> {
  const match = ftsQueryOf(query);
  if (!match) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT d.id, d.path, d.lang, d.title,
                snippet(documents_fts, 1, '<mark>', '</mark>', '…', 16) AS excerpt
         FROM documents_fts f
         JOIN documents d ON d.id = f.rowid
         WHERE documents_fts MATCH ?1 AND d.status = 'published' AND d.lang = ?2
         ORDER BY bm25(documents_fts)
         LIMIT ?3`
      )
      .bind(match, lang, limit)
      .all<SearchRow>();
    return results.map((r) => ({ ...r, excerpt: prettifyExcerpt(r.excerpt) }));
  } catch {
    return [];
  }
}

/**
 * 摘要去掉 markdown 标记，并保证输出 HTML 安全：
 * FTS 索引的是原始 markdown（可能含任意 HTML），因此先摘出服务端生成的
 * <mark> 高亮占位符，把剩余文本整体转义后再还原 <mark> —— 输出只含纯文本
 * 与 <mark> 两种内容，杜绝正文注入。
 */
export function prettifyExcerpt(excerpt: string | null): string {
  if (!excerpt) return "";
  const MARK_OPEN = "\u0001";
  const MARK_CLOSE = "\u0002";
  const cleaned = excerpt
    .replace(/<mark>/gi, MARK_OPEN)
    .replace(/<\/mark>/gi, MARK_CLOSE)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|~~|[*_`#])/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return esc(cleaned)
    .replace(/\u0001/g, "<mark>")
    .replace(/\u0002/g, "</mark>");
}

export function registerSearchRoute(app: Hono<AppEnv>): void {
  // 公开：只返回已发布内容的命中（PLAN 4.2 精神：未登录只见 published）
  app.get("/api/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const lang = (c.req.query("lang") ?? "en").trim().toLowerCase();
    if (!q) return c.json({ hits: [], total: 0 });
    const hits = await searchDocuments(c.env.DB, q, lang);
    return c.json({ hits, total: hits.length });
  });
}

// ---------------------------------------------------------------------------
// 会话管理（仅 admin）：列出 / 吊销（PLAN 4.1：移除某人 = 删其会话行）
// ---------------------------------------------------------------------------

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  const admin = new Hono<AppEnv>();
  admin.use("*", async (c, next) => {
    const user = await getSessionUser(c.env, c.req.raw);
    if (!user) return fail(c, "AUTH_REQUIRED");
    if (user.role !== "admin") return fail(c, "AUTH_FORBIDDEN");
    c.set("user", user);
    await next();
  });

  admin.get("/sessions", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT token_hash, name, role, expires_at, created_at FROM sessions ORDER BY created_at DESC LIMIT 200"
    ).all<SessionRow>();
    return c.json(results);
  });

  admin.delete("/sessions/:tokenHash", async (c) => {
    const tokenHash = c.req.param("tokenHash");
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return fail(c, "REQ_BAD_PARAM", "token_hash 不合法");
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return c.json({ ok: true });
  });

  // 手动触发一次备份（与每日 Cron 相同逻辑，PLAN 4.5）
  admin.post("/backup-now", async (c) => {
    const { runBackup } = await import("../backup");
    const result = await runBackup(c.env);
    return c.json(result, result.ok ? 200 : 503);
  });

  app.route("/api/admin", admin);
}
