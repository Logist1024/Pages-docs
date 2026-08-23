import { Hono } from "hono";
import type { AppEnv, SessionUser } from "../env";
import { getSessionUser } from "../auth";
import { invalidatePublishedPages } from "../cache";
import { isValidDocPath } from "../markdown";
import type {
  ConflictPayload,
  DocumentDetail,
  DocumentSummary,
  RevisionDetail,
  RevisionSummary,
} from "../../shared/types";

interface DocRow {
  id: number;
  path: string;
  title: string;
  status: string;
  content_md: string;
  revision_seq: number;
  current_revision_id: number | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

function toSummary(row: DocRow): DocumentSummary {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    status: row.status === "published" ? "published" : "draft",
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

/** 路由参数 → 正整数 id；非数字 / 非法值返回 null（调用方统一回 404，避免 NaN 进 D1 变 500） */
function toId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 构造乐观锁冲突响应体（PLAN 4.3） */
function conflictPayload(baseSeq: number, row: DocRow): ConflictPayload {
  return {
    error: "conflict",
    message: `他人已在此文档上保存过新版本（本地基于 #${baseSeq}，服务器为 #${row.revision_seq}）。`,
    current: {
      revision_seq: row.revision_seq,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
      title: row.title,
      content_md: row.content_md,
    },
  };
}

function toDetail(row: DocRow): DocumentDetail {
  return { ...toSummary(row), content_md: row.content_md, revision_seq: row.revision_seq, current_revision_id: row.current_revision_id, published_title: null, published_content_md: null };
}

/** 带发布快照的行（LEFT JOIN 当前发布版本） */
interface DocRowWithPublished extends DocRow {
  pub_title: string | null;
  pub_content: string | null;
}

function toDetailWithPublished(row: DocRowWithPublished): DocumentDetail {
  const detail = toDetail(row);
  if (row.current_revision_id !== null) {
    detail.published_title = row.pub_title;
    detail.published_content_md = row.pub_content ?? "";
  }
  return detail;
}

/** 查询文档详情并附带当前发布快照（标题 + 正文），供「有未发布修改」检测使用 */
export async function getDetailById(db: D1Database, id: number): Promise<DocumentDetail | null> {
  const row = await db
    .prepare(
      `SELECT d.*, r.title AS pub_title, r.content_md AS pub_content
       FROM documents d LEFT JOIN revisions r ON r.id = d.current_revision_id
       WHERE d.id = ?`
    )
    .bind(id)
    .first<DocRowWithPublished>();
  if (!row) return null;
  return toDetailWithPublished(row);
}

async function requireUser(c: { env: AppEnv["Bindings"]; req: { raw: Request } }): Promise<SessionUser | null> {
  return getSessionUser(c.env, c.req.raw);
}

const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_TITLE_LEN = 200;

/** 已发布文档的对外可见内容来自最近一次发布的快照（revisions），而非草稿 */
export async function getDocByPath(
  db: D1Database,
  path: string
): Promise<{ row: DocRow; publishedContent: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT d.*, r.content_md AS pub_content
       FROM documents d LEFT JOIN revisions r ON r.id = d.current_revision_id
       WHERE d.path = ?`
    )
    .bind(path)
    .first<DocRow & { pub_content: string | null }>();
  if (!row) return null;
  return { row, publishedContent: row.pub_content ?? (row.status === "published" ? row.content_md : null) };
}

export async function listPublishedPaths(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT path FROM documents WHERE status = 'published'").all<{ path: string }>();
  return results.map((r) => r.path);
}

async function invalidateAllPageCaches(env: AppEnv["Bindings"], extraPaths: string[] = []): Promise<void> {
  try {
    const paths = await listPublishedPaths(env.DB);
    await invalidatePublishedPages(env, [...new Set([...paths, ...extraPaths])]);
  } catch {
    // 失效失败仅造成短暂旧页面，不阻塞保存流程
  }
}

/** 供目录移动 / 站点设置等流程复用：失效全部已发布页 + 指定额外路径 */
export async function invalidateAllPublishedCaches(
  env: AppEnv["Bindings"],
  extraPaths: string[] = []
): Promise<void> {
  await invalidateAllPageCaches(env, extraPaths);
}

export function registerDocumentRoutes(app: Hono<AppEnv>): void {
  const api = new Hono<AppEnv>();

  // ---- 所有 /api/docs*、/api/revisions* 需要登录（PLAN 5）----

  api.use("/docs/*", async (c, next) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: "请先登录" }, 401);
    c.set("user", user);
    await next();
  });
  api.use("/revisions/*", async (c, next) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: "请先登录" }, 401);
    c.set("user", user);
    await next();
  });

  // （CSRF Origin 校验已上移到 src/server/index.ts 的全局 /api/* 中间件）

  // GET /api/docs —— 全量列表（含草稿，管理端用）
  api.get("/docs", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, path, title, status, revision_seq, current_revision_id, content_md, updated_by, created_at, updated_at FROM documents ORDER BY path"
    ).all<DocRow>();
    return c.json(results.map(toSummary));
  });

  // POST /api/docs —— 新建草稿
  api.post("/docs", async (c) => {
    const user = c.get("user")!
    let body: { path?: unknown; title?: unknown; content_md?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体必须是 JSON" }, 400);
    }
    const path = typeof body.path === "string" ? body.path.trim().toLowerCase() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content_md === "string" ? body.content_md : "";
    if (!isValidDocPath(path)) {
      return c.json({ error: "path 只允许小写字母/数字/-/_，用 / 分层，如 guide/intro" }, 400);
    }
    if (!title || title.length > MAX_TITLE_LEN) return c.json({ error: "标题必填且不超过 200 字" }, 400);
    if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
      return c.json({ error: "内容超过 512KB 上限" }, 400);
    }

    const now = Date.now();
    try {
      // RETURNING 取新 id：不依赖 meta.last_row_id（D1 生产环境可能返回 null）
      const result = await c.env.DB.prepare(
        "INSERT INTO documents (path, title, status, content_md, revision_seq, updated_by, created_at, updated_at) VALUES (?, ?, 'draft', ?, 0, ?, ?, ?) RETURNING id"
      )
        .bind(path, title, content, user.name, now, now)
        .all<{ id: number }>();
      const id = result.results[0]?.id;
      if (id === undefined) throw new Error("INSERT 未返回 id");
      return c.json(await getDetailById(c.env.DB, id), 201);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return c.json({ error: "该 path 已存在" }, 409);
      throw error;
    }
  });

  // GET /api/docs/:id
  api.get("/docs/:id", async (c) => {
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "文档不存在" }, 404);
    const detail = await getDetailById(c.env.DB, id);
    if (!detail) return c.json({ error: "文档不存在" }, 404);
    return c.json(detail);
  });

  // PUT /api/docs/:id —— 自动保存 / 改名 / 移动（base_revision_seq 冲突检测，PLAN 4.3）
  api.put("/docs/:id", async (c) => {
    const user = c.get("user")!
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "文档不存在" }, 404);
    let body: { base_revision_seq?: unknown; title?: unknown; path?: unknown; content_md?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体必须是 JSON" }, 400);
    }
    const baseSeq = typeof body.base_revision_seq === "number" ? body.base_revision_seq : null;
    if (baseSeq === null) return c.json({ error: "缺少 base_revision_seq" }, 400);

    // 预检仅用于提前返回友好错误；真正的并发防护靠下方带条件的 UPDATE
    const row = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocRow>();
    if (!row) return c.json({ error: "文档不存在" }, 404);

    const updates: string[] = [];
    const binds: (string | number)[] = [];
    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > MAX_TITLE_LEN) return c.json({ error: "标题必填且不超过 200 字" }, 400);
      updates.push("title = ?");
      binds.push(title);
    }
    if (body.content_md !== undefined) {
      const content = typeof body.content_md === "string" ? body.content_md : "";
      if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
        return c.json({ error: "内容超过 512KB 上限" }, 400);
      }
      updates.push("content_md = ?");
      binds.push(content);
    }
    if (body.path !== undefined) {
      const path = typeof body.path === "string" ? body.path.trim().toLowerCase() : "";
      if (!isValidDocPath(path)) return c.json({ error: "path 格式不合法" }, 400);
      if (path !== row.path) {
        updates.push("path = ?");
        binds.push(path);
      }
    }
    if (updates.length === 0) return c.json({ error: "没有需要更新的字段" }, 400);

    // 条件更新：WHERE 带上 base_revision_seq，把「检查 + 写入」合成一步原子操作，
    // 两个并发请求只有一个能成功，杜绝互相覆盖导致的静默丢稿。
    // 用 RETURNING 的结果集判断命中，不依赖 meta.changes —— D1 生产环境对该
    // 统计不可靠（可能返回 0/null），曾导致保存成功却误报冲突。
    updates.push("revision_seq = revision_seq + 1", "updated_by = ?", "updated_at = ?");
    binds.push(user.name, Date.now(), baseSeq, id);
    const updateSql = `UPDATE documents SET ${updates.join(", ")} WHERE id = ? AND revision_seq = ? RETURNING revision_seq`;
    const runUpdate = (): Promise<D1Result<{ revision_seq: number }>> =>
      c.env.DB.prepare(updateSql)
        .bind(...binds)
        .all<{ revision_seq: number }>();
    let result: D1Result<{ revision_seq: number }>;
    try {
      result = await runUpdate();
    } catch (error) {
      if (String(error).includes("UNIQUE")) return c.json({ error: "该 path 已存在" }, 409);
      throw error;
    }

    if (result.results.length === 0) {
      // 未命中：区分「真冲突（版本号已被并发请求推进）」与「统计假阴性」
      const freshRow = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocRow>();
      if (!freshRow) return c.json({ error: "文档不存在" }, 404);
      if (freshRow.revision_seq !== baseSeq) {
        return c.json(conflictPayload(baseSeq, freshRow), 409);
      }
      // 版本号其实未被推进：假阴性，重试一次自愈
      try {
        result = await runUpdate();
      } catch (error) {
        if (String(error).includes("UNIQUE")) return c.json({ error: "该 path 已存在" }, 409);
        throw error;
      }
      if (result.results.length === 0) {
        console.error(
          `[pages-docs] 条件更新两次未命中但版本号未变：id=${id} base=${baseSeq} server=${freshRow.revision_seq}`
        );
        return c.json({ error: "保存未能生效，请重试" }, 503);
      }
    }

    const newSeq = result.results[0]!.revision_seq;
    // 是否改动了访问路径（updates 里存在 "path = ?" 即代表路径发生了变化）
    const moved = updates.some((u) => u.startsWith("path"));
    if (moved || row.status === "published") {
      // 移动路径或已发布文档的元数据变化 → 失效缓存（内容快照未变时阅读页不受影响）
      await invalidateAllPageCaches(c.env, [row.path]);
    }
    return c.json({ ok: true as const, revision_seq: newSeq, saved_at: Date.now() });
  });

  // POST /api/docs/:id/publish —— 发布（PLAN 4.3：事务内插 revision + 更新 documents + 失效缓存）
  api.post("/docs/:id/publish", async (c) => {
    const user = c.get("user")!
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "文档不存在" }, 404);
    let note: string | null = null;
    try {
      const body = await c.req.json();
      if (body && typeof body.note === "string") note = body.note.slice(0, 500);
    } catch {
      // 无请求体也允许
    }

    const row = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocRow>();
    if (!row) return c.json({ error: "文档不存在" }, 404);

    const now = Date.now();
    // D1 batch 在同一事务内顺序执行；第二条用子查询取到刚插入的快照 id
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO revisions (document_id, title, content_md, author_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, row.title, row.content_md, user.name, note, now),
      c.env.DB.prepare(
        `UPDATE documents SET status = 'published',
           current_revision_id = (SELECT MAX(id) FROM revisions WHERE document_id = ?),
           updated_by = ?, updated_at = ? WHERE id = ?`
      ).bind(id, user.name, now, id),
    ]);

    await invalidateAllPageCaches(c.env);
    const fresh = await getDetailById(c.env.DB, id);
    return c.json(fresh!);
  });

  // POST /api/docs/:id/unpublish —— 下线回草稿
  api.post("/docs/:id/unpublish", async (c) => {
    const user = c.get("user")!
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "文档不存在" }, 404);
    const row = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocRow>();
    if (!row) return c.json({ error: "文档不存在" }, 404);
    await c.env.DB.prepare("UPDATE documents SET status = 'draft', updated_by = ?, updated_at = ? WHERE id = ?")
      .bind(user.name, Date.now(), id)
      .run();
    await invalidateAllPageCaches(c.env, [row.path]);
    const fresh = await getDetailById(c.env.DB, id);
    return c.json(fresh!);
  });

  // DELETE /api/docs/:id —— 仅 admin（PLAN 4.1 角色说明）
  api.delete("/docs/:id", async (c) => {
    const user = c.get("user")!
    if (user.role !== "admin") return c.json({ error: "需要 admin 角色" }, 403);
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "文档不存在" }, 404);
    const row = await c.env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocRow>();
    if (!row) return c.json({ error: "文档不存在" }, 404);
    // 显式清理 FTS → 删除版本（子表）→ 删除文档（父表，FK 立即约束）；
    // 最后的 AFTER DELETE 触发器查不到 revisions 行，自然成为空操作
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM documents_fts WHERE rowid = ?").bind(id),
      c.env.DB.prepare("DELETE FROM revisions WHERE document_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id),
    ]);
    await invalidateAllPageCaches(c.env, [row.path]);
    return c.json({ ok: true as const });
  });

  // GET /api/docs/:id/revisions —— 版本历史
  api.get("/docs/:id/revisions", async (c) => {
    const id = toId(c.req.param("id"));
    if (id === null) return c.json([]);
    const { results } = await c.env.DB.prepare(
      "SELECT id, document_id, title, author_name, note, created_at FROM revisions WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 100"
    )
      .bind(id)
      .all<RevisionSummary>();
    return c.json(results);
  });

  // GET /api/revisions/:id
  api.get("/revisions/:id", async (c) => {
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "版本不存在" }, 404);
    const row = await c.env.DB.prepare(
      "SELECT id, document_id, title, content_md, author_name, note, created_at FROM revisions WHERE id = ?"
    )
      .bind(id)
      .first<RevisionDetail>();
    if (!row) return c.json({ error: "版本不存在" }, 404);
    return c.json(row);
  });

  // POST /api/revisions/:id/rollback —— 以新快照方式恢复并发布
  api.post("/revisions/:id/rollback", async (c) => {
    const user = c.get("user")!
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "版本不存在" }, 404);
    const rev = await c.env.DB.prepare("SELECT * FROM revisions WHERE id = ?").bind(id).first<RevisionDetail>();
    if (!rev) return c.json({ error: "版本不存在" }, 404);
    const now = Date.now();
    // 与发布流程一致：batch 同一事务内先插快照，再原子更新文档指针
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO revisions (document_id, title, content_md, author_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(rev.document_id, rev.title, rev.content_md, user.name, `回滚自 v#${rev.id}`, now),
      c.env.DB.prepare(
        `UPDATE documents SET title = ?, content_md = ?, status = 'published',
           current_revision_id = (SELECT MAX(id) FROM revisions WHERE document_id = ?),
           updated_by = ?, updated_at = ? WHERE id = ?`
      ).bind(rev.title, rev.content_md, rev.document_id, user.name, now, rev.document_id),
    ]);
    await invalidateAllPageCaches(c.env);
    const fresh = await getDetailById(c.env.DB, rev.document_id);
    return c.json(fresh!);
  });

  // ---- 版本历史删除（仅 admin）----

  // DELETE /api/revisions/:id —— 删除单条版本；当前发布中的快照不可删除
  api.delete("/revisions/:id", async (c) => {
    const user = c.get("user")!;
    if (user.role !== "admin") return c.json({ error: "需要 admin 角色" }, 403);
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "版本不存在" }, 404);
    const rev = await c.env.DB.prepare("SELECT id, document_id FROM revisions WHERE id = ?").bind(id).first<{ id: number; document_id: number }>();
    if (!rev) return c.json({ error: "版本不存在" }, 404);
    const doc = await c.env.DB
      .prepare("SELECT current_revision_id FROM documents WHERE id = ?")
      .bind(rev.document_id)
      .first<{ current_revision_id: number | null }>();
    if (doc?.current_revision_id === id) {
      return c.json({ error: "该版本是当前发布的快照，请先「更新发布」或「取消发布」后再删除" }, 409);
    }
    await c.env.DB.prepare("DELETE FROM revisions WHERE id = ?").bind(id).run();
    return c.json({ ok: true as const });
  });

  // DELETE /api/docs/:id/revisions —— 清空该文档全部版本（保留当前发布快照）
  api.delete("/docs/:id/revisions", async (c) => {
    const user = c.get("user")!;
    if (user.role !== "admin") return c.json({ error: "需要 admin 角色" }, 403);
    const id = toId(c.req.param("id"));
    if (id === null) return c.json({ error: "文档不存在" }, 404);
    const row = await c.env.DB.prepare("SELECT id, current_revision_id FROM documents WHERE id = ?").bind(id).first<DocRow>();
    if (!row) return c.json({ error: "文档不存在" }, 404);
    const result = await c.env.DB
      .prepare(
        row.current_revision_id !== null
          ? "DELETE FROM revisions WHERE document_id = ? AND id != ?"
          : "DELETE FROM revisions WHERE document_id = ?"
      )
      .bind(...(row.current_revision_id !== null ? [id, row.current_revision_id] : [id]))
      .run();
    return c.json({ ok: true as const, deleted: result.meta.changes ?? 0 });
  });

  app.route("/api", api);
}
