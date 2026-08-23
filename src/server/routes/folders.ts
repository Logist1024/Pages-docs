import { Hono } from "hono";
import type { AppEnv, SessionUser } from "../env";
import { getSessionUser } from "../auth";
import { fail } from "../http-error";
import { isValidDocPath } from "../markdown";
import { invalidateAllPublishedCaches, nextSiblingSortOrder } from "./documents";
import type { TreeOrderInput, UpdateFolderInput } from "../../shared/types";

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
    if (!user) return fail(c, "AUTH_REQUIRED");
    c.set("user", user);
    await next();
  });
  api.use("/folders/*", async (c, next) => {
    const user = await requireUser(c);
    if (!user) return fail(c, "AUTH_REQUIRED");
    c.set("user", user);
    await next();
  });
  // 目录/文档排序接口（PUT /api/tree/order）同样需要登录
  api.use("/tree/*", async (c, next) => {
    const user = await requireUser(c);
    if (!user) return fail(c, "AUTH_REQUIRED");
    c.set("user", user);
    await next();
  });

  // GET /api/folders —— 显式创建的目录列表（与隐式目录合并由前端处理）
  api.get("/folders", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT path, name, sort_order FROM folders ORDER BY path").all<{
      path: string;
      name: string;
      sort_order: number;
    }>();
    return c.json({
      folders: results.map((r) => ({
        path: r.path,
        name: r.name || r.path.split("/").pop() || r.path,
        sort_order: r.sort_order ?? 0,
      })),
    });
  });

  // POST /api/folders —— 新建目录（name 为任意语言的显示名称，可省略）
  api.post("/folders", async (c) => {
    const user = c.get("user")!;
    let body: { path?: unknown; name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return fail(c, "REQ_BAD_JSON");
    }
    const path = typeof body.path === "string" ? body.path.trim().toLowerCase() : "";
    if (!isValidDocPath(path)) {
      return fail(c, "FOLDER_INVALID_PATH");
    }
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    if (rawName.length > 100) return fail(c, "FOLDER_NAME_INVALID", "目录名称不能超过 100 字");
    const name = rawName.length > 0 ? rawName : path.split("/").pop() || path;

    // 与文档路径冲突：目录不能占用某个已存在的文档完整路径
    const doc = await c.env.DB.prepare("SELECT id FROM documents WHERE path = ?").bind(path).first<{ id: number }>();
    if (doc) return fail(c, "FOLDER_PATH_DOC_TAKEN");

    try {
      const sortOrder = await nextSiblingSortOrder(c.env.DB, path);
      await c.env.DB.prepare(
        "INSERT INTO folders (path, name, sort_order, created_by, created_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(path, name, sortOrder, user.name, Date.now())
        .run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail(c, "FOLDER_EXISTS");
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
      return fail(c, "FOLDER_INVALID_PATH", "路径不合法");
    }
    

    // 用 substr 前缀比较而非 LIKE：路径中的 _ 会被 LIKE 当作单字符通配符，
    // 导致删除 my_docs 时误判 myXdocs/b 为其子内容（与下方 PUT 的做法一致）
    const slashPrefix = `${path}/`;
    const prefixLen = slashPrefix.length;
    const doc = await c.env.DB.prepare("SELECT id FROM documents WHERE path = ? OR substr(path, 1, ?) = ? LIMIT 1")
      .bind(path, prefixLen, slashPrefix)
      .first<{ id: number }>();
    if (doc) return fail(c, "FOLDER_NOT_EMPTY");

    const childFolder = await c.env.DB.prepare("SELECT path FROM folders WHERE substr(path, 1, ?) = ? LIMIT 1")
      .bind(prefixLen, slashPrefix)
      .first<{ path: string }>();
    if (childFolder) return fail(c, "FOLDER_HAS_CHILDREN");

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
      return fail(c, "FOLDER_INVALID_PATH", "路径不合法");
    }
    if (!isValidDocPath(oldPath)) return fail(c, "FOLDER_INVALID_PATH", "路径不合法");

    let body: UpdateFolderInput;
    try {
      body = (await c.req.json()) as UpdateFolderInput;
    } catch {
      return fail(c, "REQ_BAD_JSON");
    }

    // ---- 名称部分 ----
    let newName: string | null = null;
    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      if (trimmed.length === 0) return fail(c, "FOLDER_NAME_INVALID", "目录名称不能为空");
      if (trimmed.length > 100) return fail(c, "FOLDER_NAME_INVALID", "目录名称不能超过 100 字");
      newName = trimmed;
    }

    // ---- 路径部分 ----
    let newPath: string | null = null;
    if (typeof body.path === "string") {
      const normalized = body.path.trim().toLowerCase();
      if (!isValidDocPath(normalized)) {
        return fail(c, "FOLDER_INVALID_PATH", "目标路径只允许小写字母/数字/-/_，用 / 分层");
      }
      if (normalized !== oldPath) newPath = normalized;
    }

    if (newPath !== null && newPath.startsWith(`${oldPath}/`)) {
      return fail(c, "FOLDER_MOVE_INTO_SELF");
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
      if (docConflict) return fail(c, "FOLDER_TARGET_DOC_TAKEN");

      const folderConflict = await c.env.DB.prepare(
        "SELECT path FROM folders WHERE (path = ? OR substr(path, 1, ?) = ?) AND path != ? LIMIT 1"
      )
        .bind(newPath, newLen, newSlash, oldPath)
        .first<{ path: string }>();
      if (folderConflict) return fail(c, "FOLDER_TARGET_FOLDER_TAKEN", `目标路径已被目录「${folderConflict.path}」占用`);
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

  // PUT /api/tree/order —— 重排某个父目录下的直接子项（目录与文档混排，后台侧栏与阅读页共用此顺序）。
  // 客户端全量提交该层级的新顺序；未列出的既有子项自动追加到末尾，不会丢失。
  api.put("/tree/order", async (c) => {
    const user = c.get("user")!;
    let body: TreeOrderInput;
    try {
      body = (await c.req.json()) as TreeOrderInput;
    } catch {
      return fail(c, "REQ_BAD_JSON");
    }

    const parent = typeof body?.parent === "string" ? body.parent.trim().toLowerCase() : "";
    // 空字符串表示根层级，合法；非空时按文档路径格式校验
    if (parent.length > 0 && !isValidDocPath(parent)) return fail(c, "TREE_ORDER_INVALID", "父目录路径不合法");
    if (!Array.isArray(body?.items)) return fail(c, "TREE_ORDER_INVALID", "items 必须是数组");
    if (body.items.length === 0) return fail(c, "TREE_ORDER_INVALID", "items 不能为空");
    if (body.items.length > 500) return fail(c, "TREE_ORDER_INVALID", "一次最多排序 500 个条目");

    const parentPrefix = parent.length > 0 ? `${parent}/` : "";
    const isDirectChild = (p: string): boolean =>
      parent.length === 0 ? !p.includes("/") : p.startsWith(parentPrefix) && !p.slice(parentPrefix.length).includes("/");

    type Entry = { type: "folder"; path: string; id: number | null } | { type: "doc"; path: string; id: number };
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of body.items.entries()) {
      if (raw === null || typeof raw !== "object") {
        return fail(c, "TREE_ORDER_INVALID", `第 ${index + 1} 项格式不正确`);
      }
      const item = raw as { type?: unknown; path?: unknown; id?: unknown };
      if (item.type === "folder") {
        const p = typeof item.path === "string" ? item.path.trim().toLowerCase() : "";
        if (!isValidDocPath(p) || !isDirectChild(p)) {
          return fail(c, "TREE_ORDER_INVALID", `目录「${p || "(空)"}」不是「${parent || "根目录"}」的直接子项`);
        }
        const key = `f:${p}`;
        if (seen.has(key)) return fail(c, "TREE_ORDER_INVALID", `目录「${p}」重复出现`);
        seen.add(key);
        entries.push({ type: "folder", path: p, id: null });
      } else if (item.type === "doc") {
        const id = typeof item.id === "number" && Number.isInteger(item.id) && item.id > 0 ? item.id : null;
        if (id === null) return fail(c, "TREE_ORDER_INVALID", `第 ${index + 1} 项的文档 id 不合法`);
        const key = `d:${id}`;
        if (seen.has(key)) return fail(c, "TREE_ORDER_INVALID", `文档 #${id} 重复出现`);
        seen.add(key);
        entries.push({ type: "doc", path: "", id });
      } else {
        return fail(c, "TREE_ORDER_INVALID", `第 ${index + 1} 项类型不正确`);
      }
    }

    // ---- 拉取 parent 下真实的直接子项，校验条目存在性与归属 ----
    const prefixLen = parentPrefix.length;
    const docRows =
      parent.length === 0
        ? await c.env.DB.prepare("SELECT id, path FROM documents WHERE instr(path, '/') = 0").all<{ id: number; path: string }>()
        : await c.env.DB.prepare(
            "SELECT id, path FROM documents WHERE substr(path, 1, ?) = ? AND instr(substr(path, ?), '/') = 0"
          )
            .bind(prefixLen, parentPrefix, prefixLen + 1)
            .all<{ id: number; path: string }>();
    const folderRows =
      parent.length === 0
        ? await c.env.DB.prepare("SELECT path FROM folders WHERE instr(path, '/') = 0").all<{ path: string }>()
        : await c.env.DB.prepare(
            "SELECT path FROM folders WHERE substr(path, 1, ?) = ? AND instr(substr(path, ?), '/') = 0"
          )
            .bind(prefixLen, parentPrefix, prefixLen + 1)
            .all<{ path: string }>();

    const docById = new Map(docRows.results.map((r) => [r.id, r]));
    const docPaths = new Set(docRows.results.map((r) => r.path));

    for (const entry of entries) {
      if (entry.type === "doc") {
        const row = docById.get(entry.id);
        if (!row) return fail(c, "TREE_ORDER_INVALID", `文档 #${entry.id} 不存在于「${parent || "根目录"}」下`);
        entry.path = row.path;
      } else if (docPaths.has(entry.path)) {
        return fail(c, "TREE_ORDER_INVALID", `「${entry.path}」是文档而非目录`);
      }
    }
    // 目录条目无需预先存在：隐式目录（仅由文档路径推出）排序时自动落库为显式行

    // ---- 未列出的既有子项追加到末尾（防御客户端漏交） ----
    const listedFolders = new Set(entries.filter((e) => e.type === "folder").map((e) => e.path));
    const listedDocs = new Set(entries.filter((e) => e.type === "doc").map((e) => e.id));
    for (const f of folderRows.results) {
      if (!listedFolders.has(f.path)) entries.push({ type: "folder", path: f.path, id: null });
    }
    for (const d of docRows.results) {
      if (!listedDocs.has(d.id)) entries.push({ type: "doc", path: d.path, id: d.id });
    }

    // ---- 写入：sort_order 即列表下标；缺失的目录行用 upsert 落库（幂等） ----
    const now = Date.now();
    const stmts = entries.map((entry, idx) => {
      if (entry.type === "doc") {
        return c.env.DB.prepare("UPDATE documents SET sort_order = ? WHERE id = ?").bind(idx, entry.id);
      }
      return c.env.DB.prepare(
        "INSERT INTO folders (path, name, sort_order, created_by, created_at) VALUES (?, '', ?, ?, ?)\n" +
          "ON CONFLICT(path) DO UPDATE SET sort_order = excluded.sort_order"
      ).bind(entry.path, idx, user.name, now);
    });
    if (stmts.length > 0) await c.env.DB.batch(stmts);

    // 侧栏顺序出现在所有阅读页上 → 全量失效已发布页缓存
    await invalidateAllPublishedCaches(c.env);

    return c.json({ ok: true as const, parent, ordered: entries.length });
  });

  app.route("/api", api);
}
