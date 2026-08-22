import type { Env } from "./env";
import { createZip } from "./zip";

/**
 * 每日备份（PLAN 4.5，Cron Trigger）：
 * - backup.json：documents + revisions 全量 JSON；
 * - backup.zip：按 path 还原的 .md 目录（docs/<path>.md）+ manifest；
 * 存入 R2 backups/YYYY-MM-DD/，并清理 30 天前的旧备份。
 * 内容不在 git 里，这是除 D1 Time Travel 之外的退路。
 */

interface DocBackupRow {
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

interface RevisionBackupRow {
  id: number;
  document_id: number;
  title: string;
  content_md: string;
  author_name: string;
  note: string | null;
  created_at: number;
}

const RETENTION_DAYS = 30;

export async function runBackup(env: Env): Promise<{ ok: boolean; detail: string }> {
  if (!env.MEDIA) {
    return { ok: false, detail: "R2（MEDIA）未绑定，跳过备份" };
  }
  if (!env.DB) {
    return { ok: false, detail: "D1 未绑定，跳过备份" };
  }

  const docs = await env.DB.prepare(
    "SELECT id, path, title, status, content_md, revision_seq, current_revision_id, updated_by, created_at, updated_at FROM documents"
  ).all<DocBackupRow>();
  const revisions = await env.DB.prepare(
    "SELECT id, document_id, title, content_md, author_name, note, created_at FROM revisions ORDER BY document_id, created_at"
  ).all<RevisionBackupRow>();

  const generatedAt = new Date();
  const manifest = {
    generated_at: generatedAt.toISOString(),
    site_name: env.SITE_NAME ?? "pages-docs",
    document_count: docs.results.length,
    revision_count: revisions.results.length,
  };

  const backupJson = JSON.stringify(
    { ...manifest, documents: docs.results, revisions: revisions.results },
    null,
    2
  );

  const encoder = new TextEncoder();
  const zip = createZip([
    { name: "manifest.json", data: encoder.encode(JSON.stringify(manifest, null, 2)) },
    { name: "backup.json", data: encoder.encode(backupJson) },
    ...docs.results.map((d) => ({
      name: `docs/${d.path}.md`,
      data: encoder.encode(d.content_md ?? ""),
    })),
  ]);

  const day = generatedAt.toISOString().slice(0, 10);
  await env.MEDIA.put(`backups/${day}/backup.json`, backupJson, {
    httpMetadata: { contentType: "application/json" },
  });
  await env.MEDIA.put(`backups/${day}/backup.zip`, zip, {
    httpMetadata: { contentType: "application/zip" },
  });

  // 清理过期备份（按 backups/YYYY-MM-DD/ 前缀分组；list 默认每页 1000 条，需翻页遍历）
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    const stale: string[] = [];
    let cursor: string | undefined = undefined;
    do {
      const listed = await env.MEDIA.list({ prefix: "backups/", cursor });
      for (const object of listed.objects) {
        const match = /backups\/(\d{4}-\d{2}-\d{2})\//.exec(object.key);
        if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) stale.push(object.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    await Promise.all(stale.map((key) => env.MEDIA!.delete(key)));
    if (stale.length > 0) console.log(`[backup] 清理过期备份 ${stale.length} 个对象`);
  } catch (error) {
    console.log(`[backup] 清理旧备份失败（不影响本次备份）：${String(error)}`);
  }

  return {
    ok: true,
    detail: `已备份 ${docs.results.length} 篇文档 / ${revisions.results.length} 个版本到 backups/${day}/`,
  };
}
