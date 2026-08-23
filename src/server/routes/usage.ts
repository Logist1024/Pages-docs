/**
 * Cloudflare 服务用量统计（GET /api/admin/usage，仅 admin）：
 * - D1：各表行数与字节估算、文档状态分布、近 30 天版本增长、内容 TOP 文档；
 * - R2：对象数 / 总字节 / 按月聚合（遍历 MEDIA 桶，最多 5000 个对象）；
 * - KV：页面缓存键数量（遍历 html:* 前缀，最多 2 万个键）。
 * 说明：Workers 请求量 / CPU 等 runtime 指标无法从 Worker 内部获取，
 * 页面上会引导到 Cloudflare 控制台的 Analytics 查看。
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getSessionUser } from "../auth";
import { fail } from "../http-error";
import type { DailyCount, D1Usage, KVUsage, R2Usage, TableStat, UsageStats } from "../../shared/types";

/** R2 list 单次最多返回 1000 个对象；这里限制总扫描量以控制耗时（免费额度内足够） */
const R2_MAX_OBJECTS = 5000;
const KV_MAX_KEYS = 20_000;

async function tableStats(db: D1Database): Promise<TableStat[]> {
  const defs: { name: string; sql: string }[] = [
    { name: "documents", sql: "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(path) + LENGTH(title) + LENGTH(content_md)), 0) AS bytes FROM documents" },
    { name: "revisions", sql: "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(title) + LENGTH(content_md) + LENGTH(COALESCE(note, '')) + LENGTH(author_name)), 0) AS bytes FROM revisions" },
    { name: "sessions", sql: "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(token_hash) + LENGTH(name)), 0) AS bytes FROM sessions" },
    { name: "attachments", sql: "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(r2_key) + LENGTH(filename)), 0) AS bytes FROM attachments" },
    { name: "folders", sql: "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(path) + LENGTH(name)), 0) AS bytes FROM folders" },
    { name: "site_settings", sql: "SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM site_settings" },
    // FTS5 为虚拟表，用 COUNT(*) 估算行数（内容表体积已含在 documents/revisions 中）
    { name: "documents_fts", sql: "SELECT COUNT(*) AS rows, 0 AS bytes FROM documents_fts" },
  ];
  const stats: TableStat[] = [];
  for (const def of defs) {
    try {
      const row = await db.prepare(def.sql).first<{ rows: number; bytes: number }>();
      stats.push({ name: def.name, rows: row?.rows ?? 0, bytes: row?.bytes ?? 0 });
    } catch {
      stats.push({ name: def.name, rows: 0, bytes: 0 });
    }
  }
  return stats;
}

async function docStatusCounts(db: D1Database): Promise<D1Usage["doc_status"]> {
  try {
    const row = await db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS published,
           COALESCE(SUM(CASE WHEN status != 'published' THEN 1 ELSE 0 END), 0) AS draft
         FROM documents`
      )
      .first<{ published: number; draft: number }>();
    return { published: row?.published ?? 0, draft: row?.draft ?? 0 };
  } catch {
    return { published: 0, draft: 0 };
  }
}

async function revisionsByDay(db: D1Database): Promise<DailyCount[]> {
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  try {
    const { results } = await db
      .prepare(
        `SELECT strftime('%Y-%m-%d', datetime(created_at / 1000, 'unixepoch')) AS day, COUNT(*) AS count
         FROM revisions WHERE created_at >= ?
         GROUP BY day ORDER BY day`
      )
      .bind(since)
      .all<{ day: string; count: number }>();
    return results.map((r) => ({ day: r.day, count: r.count }));
  } catch {
    return [];
  }
}

async function largestDocs(db: D1Database): Promise<D1Usage["largest_docs"]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT path, title, LENGTH(content_md) AS bytes
         FROM documents ORDER BY LENGTH(content_md) DESC LIMIT 5`
      )
      .all<{ path: string; title: string; bytes: number }>();
    return results;
  } catch {
    return [];
  }
}

async function d1Usage(db: D1Database): Promise<D1Usage> {
  const tables = await tableStats(db);
  return {
    tables,
    total_bytes: tables.reduce((acc, t) => acc + t.bytes, 0),
    doc_status: await docStatusCounts(db),
    revisions_by_day: await revisionsByDay(db),
    largest_docs: await largestDocs(db),
  };
}

async function r2Usage(env: AppEnv["Bindings"]): Promise<R2Usage> {
  if (!env.MEDIA) return { configured: false, object_count: 0, total_bytes: 0, by_month: [] };
  const byMonth = new Map<string, { count: number; bytes: number }>();
  let objectCount = 0;
  let totalBytes = 0;
  try {
    let cursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ cursor, limit: 1000 });
      for (const obj of page.objects) {
        objectCount += 1;
        totalBytes += obj.size;
        // key 形如 media/YYYY/MM/hex.ext
        const m = /^media\/(\d{4})\/(\d{2})\//.exec(obj.key);
        const month = m ? `${m[1]}-${m[2]}` : "其他";
        const bucket = byMonth.get(month) ?? { count: 0, bytes: 0 };
        bucket.count += 1;
        bucket.bytes += obj.size;
        byMonth.set(month, bucket);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && objectCount < R2_MAX_OBJECTS);
  } catch {
    // 列举失败时返回部分/空数据，不阻塞页面
  }
  const by_month = [...byMonth.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));
  return { configured: true, object_count: objectCount, total_bytes: by_month.reduce((a, m) => a + m.bytes, 0), by_month };
}

async function kvUsage(env: AppEnv["Bindings"]): Promise<KVUsage> {
  if (!env.PAGE_CACHE) return { configured: false, page_cache_keys: 0, estimated_bytes: 0 };
  let keys = 0;
  try {
    let cursor: string | undefined;
    do {
      const page = await env.PAGE_CACHE.list({ prefix: "html:", cursor, limit: 1000 });
      keys += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && keys < KV_MAX_KEYS);
  } catch {
    // 忽略列举失败
  }
  // KV list 不返回 value 大小；不做抽样读取（省读取配额），估算值给 0 并在前端注明
  return { configured: true, page_cache_keys: keys, estimated_bytes: 0 };
}

export function registerUsageRoutes(app: Hono<AppEnv>): void {
  app.get("/api/admin/usage", async (c) => {
    const user = await getSessionUser(c.env, c.req.raw);
    if (!user) return fail(c, "AUTH_REQUIRED");
    if (user.role !== "admin") return fail(c, "AUTH_FORBIDDEN");

    const [d1, r2, kv] = await Promise.all([d1Usage(c.env.DB), r2Usage(c.env), kvUsage(c.env)]);
    const stats: UsageStats = { generated_at: Date.now(), d1, r2, kv };
    return c.json(stats);
  });
}
