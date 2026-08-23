import { Hono } from "hono";
import type { AppEnv, SessionUser } from "../env";
import { getSessionUser } from "../auth";
import { isValidDocPath } from "../markdown";
import { invalidateAllPublishedCaches } from "./documents";
import type { UpdateFolderInput } from "../../shared/types";

/**
 * 目录管理 API。
 * 数据模型说明：目录结构主要由文档 path 隐式推出（如 guide/hello 隐含 guide/ 目录），
 * folders 表只负责持久化「空目录」与显示名称，让用户可以先建目录、可命名、可整体移动。
 */
export function registerFolderRoutes(app: Hono<AppEnv>): void {
  const api = new Hono<AppEnv>();

  async function requireUser(c: { env: AppEnv["Bindings"]; req: { raw: Request } }): Promise<SessionUser | null> {
    return getSessionUser(c.env, c.req.raw);
  }

  // 注意：中间件必须限定在 /folders* 下。
  // 若用 use("*")，由于本子应用挂载在 /api 且先于 search/settings 注册，
  // 会把「请先登录」泄漏给之后注册的所有 /api/* 公开接口。
  api.use("/folders", async (c, next) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: "请先登录" }, 401);
    c.set("user", user);
    await next();
  });
  api.use("/folders/*", async (c, next) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: "请先登录" }, 401);
    c.set("user", user);
    await next();
  });

  // GET /api/folders —— 显式创建的空目录列表（与隐式目录合并由前端处理）
  api.get("/folders", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT path, name FROM folders ORDER BY path").all<{
      path: string;
      name: string;
    }>();
    return c.json({ folders: results.map((r) => ({ path: r.path, name: r.name || r.path.split("/").pop() || r.path })) });
  });

  // POST /api/folders —— 新建目录（name 为任意语言的显示名称，可省略）
  api.post("/folders", async (c) => {
    const user = c.get("user")!;
    let body: { path?: unknown; name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体必须是 JSON" }, 400);
    }
    const path = typeof body.path === "string" ? body.path.trim().toLowerCase() : "";
    if (!isValidDocPath(path)) {
      return c.json({ error: "目录路径只允许小写字母/数字/-/_，用 / 分层" }, 400);
    }
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    if (rawName.length > 100) return c.json({ error: "目录名称不能超过 100 字" }, 400);
    const name = rawName.length > 0 ? rawName : path.split("/").pop() || path;

    // 与文档路径冲突：目录不能占用某个已存在的文档完整路径
    const doc = await c.env.DB.prepare("SELECT id FROM documents WHERE path = ?").bind(path).first<{ id: number }>();
    if (doc) return c.json({ error: "该路径已被文档占用" }, 409);

    try {
      await c.env.DB.prepare("INSERT INTO folders (path, name, created_by, created_at) VALUES (?, ?, ?, ?)")
        .bind(path, name, user.name, Date.now())
        .run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) return c.json({ error: "该目录已存在" }, 409);
      throw error;
    }
    return c.json({ ok: true as const, path, name });
  });

  // DELETE /api/folders/* —— 删除空目录（无子目录、无任何层级的文档；不存在视为已删，幂等）
  api.delete("/folders/*", async (c) => {
    const url = new URL(c.req.url);
    const raw = url.pathname.replace(/^\/api\/folders\//, "");
    let path: string;
    try {
      path = decodeURIComponent(raw).trim().toLowerCase();
    } catch {
      return c.json({ error: "路径不合法" }, 400);
    }
    if (!isValidDocPath(path)) return c.json({ error: "路径不合法" }, 400);

    // 用 substr 前缀比较而非 LIKE：路径中的 _ 会被 LIKE 当作单字符通配符，
    // 导致删除 my_docs 时误判 myXdocs/b 为其子内容（与下方 PUT 的做法一致）
    const slashPrefix = `${path}/`;
    const prefixLen = slashPrefix.length;
    const doc = await c.env.DB.prepare("SELECT id FROM documents WHERE path = ? OR substr(path, 1, ?) = ? LIMIT 1")
      .bind(path, prefixLen, slashPrefix)
      .first<{ id: number }>();
    if (doc) return c.json({ error: "目录不为空：请先移出或删除其中的文档" }, 409);

    const childFolder = await c.env.DB.prepare("SELECT path FROM folders WHERE substr(path, 1, ?) = ? LIMIT 1")
      .bind(prefixLen, slashPrefix)
      .first<{ path: string }>();
    if (childFolder) return c.json({ error: "目录下还有子目录，请先删除它们" }, 409);

    await c.env.DB.prepare("DELETE FROM folders WHERE path = ?").bind(path).run();
    return c.json({ ok: true as const });
  });

  // PUT /api/folders/* —— 目录改名（name）与移动（path），二者均可选。
  // - 改名不影响访问路径；首次命名隐式目录时插入显式行承载名称。
  // - 移动会把该目录下所有子文档与子目录级联搬到新前缀下（旧 URL 失效，缓存同步重建）；
  //   恰好与目录同名的文档（path === 目录路径）不属于目录内容，保持不动。
  api.put("/folders/*", async (c) => {
    const user = c.get("user")!;
    const url = new URL(c.req.url);
    let oldPath: string;
    try {
      oldPath = decodeURIComponent(url.pathname.replace(/^\/api\/folders\//, "")).trim().toLowerCase();
    } catch {
      return c.json({ error: "路径不合法" }, 400);
    }
    if (!isValidDocPath(oldPath)) return c.json({ error: "路径不合法" }, 400);

    let body: UpdateFolderInput;
    try {
      body = (await c.req.json()) as UpdateFolderInput;
    } catch {
      return c.json({ error: "请求体必须是 JSON" }, 400);
    }

    // ---- 名称部分 ----
    let newName: string | null = null;
    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      if (trimmed.length === 0) return c.json({ error: "目录名称不能为空" }, 400);
      if (trimmed.length > 100) return c.json({ error: "目录名称不能超过 100 字" }, 400);
      newName = trimmed;
    }

    // ---- 路径部分 ----
    let newPath: string | null = null;
    if (typeof body.path === "string") {
      const normalized = body.path.trim().toLowerCase();
      if (!isValidDocPath(normalized)) {
        return c.json({ error: "目标路径只允许小写字母/数字/-/_，用 / 分层" }, 400);
      }
      if (normalized !== oldPath) newPath = normalized;
    }

    if (newPath !== null && newPath.startsWith(`${oldPath}/`)) {
      return c.json({ error: "不能把目录移动到它自身内部" }, 400);
    }

    if (newPath !== null) {
      // 目标位置冲突检查：任何文档占用目标路径或其子路径、任何其他目录行占用目标位置。
      // 用 substr 前缀比较而非 LIKE，避免路径中 _/% 被 LIKE 当作通配符。
      const newSlash = `${newPath}/`;
      const newLen = newSlash.length; // substr(path, 1, newLen) 即前缀

      const docConflict = await c.env.DB.prepare(
        "SELECT id FROM documents WHERE path = ? OR substr(path, 1, ?) = ? LIMIT 1"
      )
        .bind(newPath, newLen, newSlash)
        .first<{ id: number }>();
      if (docConflict) return c.json({ error: "目标路径已被文档占用" }, 409);

      const folderConflict = await c.env.DB.prepare(
        "SELECT path FROM folders WHERE (path = ? OR substr(path, 1, ?) = ?) AND path != ? LIMIT 1"
      )
        .bind(newPath, newLen, newSlash, oldPath)
        .first<{ path: string }>();
      if (folderConflict) return c.json({ error: `目标路径已被目录「${folderConflict.path}」占用` }, 409);
    }

    const movedRows: string[] = [];
    if (newPath !== null) {
      const oldSlash = `${oldPath}/`;
      const oldLen = oldSlash.length;

      // 先收集受影响的已发布路径（移动后旧 path 不再可查）
      try {
        const { results } = await c.env.DB.prepare(
          "SELECT path FROM documents WHERE status = 'published' AND substr(path, 1, ?) = ?"
        )
          .bind(oldLen, oldSlash)
          .all<{ path: string }>();
        movedRows.push(...results.map((r) => r.path));
      } catch {
        // 收集失败只影响缓存精准失效，下面仍做全量失效兜底
      }

      // substr 从 1 计数：oldLen 恰好指向 "old/" 的 "/"，substr(path, oldLen) 保留斜杠，
      // 与新前缀直接拼接即得 new/rest（避免再手写分隔符）。
      const restPos = oldLen;
      await c.env.DB.batch([
        // 子文档：old/* → new/*
        c.env.DB.prepare("UPDATE documents SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?")
          .bind(newPath, restPos, oldLen, oldSlash),
        // 子目录行
        c.env.DB.prepare("UPDATE folders SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?")
          .bind(newPath, restPos, oldLen, oldSlash),
      ]);

      // 目录自身行：更新为新路径；隐式目录（无行）在同时命名时插入显式行承载名称。
      // 用 RETURNING 判断命中，避免依赖 meta.changes（D1 生产环境统计不可靠）。
      const updatedSelf = await c.env.DB.prepare("UPDATE folders SET path = ? WHERE path = ? RETURNING path")
        .bind(newPath, oldPath)
        .all<{ path: string }>();
      if (updatedSelf.results.length === 0 && newName !== null) {
        try {
          await c.env.DB.prepare("INSERT INTO folders (path, name, created_by, created_at) VALUES (?, ?, ?, ?)")
            .bind(newPath, newName, user.name, Date.now())
            .run();
        } catch {
          // 并发下行已存在：退化为仅更新名称
          await c.env.DB.prepare("UPDATE folders SET name = ? WHERE path = ?").bind(newName, newPath).run();
        }
      }
    }

    // ---- 应用名称（在路径处理之后：newPath 行已就位）----
    if (newName !== null) {
      const targetPath = newPath ?? oldPath;
      const updated = await c.env.DB.prepare("UPDATE folders SET name = ? WHERE path = ? RETURNING path")
        .bind(newName, targetPath)
        .all<{ path: string }>();
      if (updated.results.length === 0) {
        try {
          await c.env.DB.prepare("INSERT INTO folders (path, name, created_by, created_at) VALUES (?, ?, ?, ?)")
            .bind(targetPath, newName, user.name, Date.now())
            .run();
        } catch {
          // 行已存在（或并发创建）：退化为仅更新名称
          await c.env.DB.prepare("UPDATE folders SET name = ? WHERE path = ?").bind(newName, targetPath).run();
        }
      }
    }

    if (newPath !== null) {
      await invalidateAllPublishedCaches(c.env, [...movedRows, newPath]);
    }

    return c.json({ ok: true as const, path: newPath ?? oldPath, name: newName ?? "" });
  });

  app.route("/api", api);
}
