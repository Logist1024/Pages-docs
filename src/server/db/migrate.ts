import { LATEST_VERSION, MIGRATIONS } from "./migrations";

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

/**
 * 迁移版本读取：优先 PRAGMA user_version（PLAN 4.6）；
 * 若运行环境不支持该 PRAGMA 则自动退化为 _migrations 表，两种模式都幂等。
 */
async function readVersion(db: D1Database): Promise<{ mode: "pragma" | "table"; version: number }> {
  try {
    const row = await db.prepare("PRAGMA user_version").first<{ user_version?: number }>();
    if (row && typeof row.user_version === "number") {
      return { mode: "pragma", version: row.user_version };
    }
  } catch {
    // 落入 table 模式
  }
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)"
    )
    .run();
  const row = await db.prepare("SELECT version FROM _migrations WHERE id = 1").first<{ version: number }>();
  return { mode: "table", version: row?.version ?? 0 };
}

async function writeVersion(db: D1Database, mode: "pragma" | "table", version: number): Promise<void> {
  if (mode === "pragma") {
    await db.prepare(`PRAGMA user_version = ${Number(version)}`).run();
  } else {
    await db
      .prepare(
        "INSERT INTO _migrations (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version"
      )
      .bind(version)
      .run();
  }
}

/** 幂等执行所有未应用的迁移；成功返回版本区间。失败抛出原始错误。 */
export async function ensureMigrated(db: D1Database): Promise<MigrationResult> {
  const { mode, version } = await readVersion(db);
  let current = version;
  const applied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    // D1 batch 在同一事务内顺序执行，任一语句失败整体回滚
    await db.batch(migration.statements.map((sql) => db.prepare(sql)));
    current = migration.version;
    applied.push(migration.name);
  }

  if (applied.length > 0 || current !== version) {
    await writeVersion(db, mode, current);
  }
  return { from: version, to: current, applied };
}

export { LATEST_VERSION };
