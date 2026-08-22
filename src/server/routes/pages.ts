import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getSessionUser } from "../auth";
import { etagFor, getPageCache, putPageCache, putToCacheApi, serveFromCacheApi } from "../cache";
import { excerptOf, renderMarkdown } from "../markdown";
import { buildTree, type TreeNode } from "../tree";
import { esc, renderDocPage, renderMessagePage, renderNotFoundPage, renderSearchPage, themeFromRequest } from "../layout";
import { loadSiteSettings, type ResolvedSiteSettings } from "../settings";
import { getDocByPath, listPublishedPaths } from "./documents";
import { searchDocuments } from "./search";
import type { DocumentSummary, FolderInfo } from "../../shared/types";

function baseUrlOf(env: AppEnv["Bindings"], url: URL): string {
  const configured = env.SITE_URL?.trim().replace(/\/+$/, "");
  return configured || url.origin;
}

/** 站点设置（名称/首页地址/导航/品牌）；DB 不可用时回退部署变量与默认值 */
async function loadSettings(env: AppEnv["Bindings"]): Promise<ResolvedSiteSettings> {
  return loadSiteSettings(env.DB, env.SITE_NAME);
}

/** 显式创建的目录（含显示名称）；查询失败时退化为空列表，不阻塞页面渲染 */
async function loadFolders(db: D1Database): Promise<FolderInfo[]> {
  try {
    const { results } = await db.prepare("SELECT path, name FROM folders").all<{ path: string; name: string }>();
    return results.map((r) => ({ path: r.path, name: r.name || r.path.split("/").pop() || r.path }));
  } catch {
    return [];
  }
}

async function loadPublishedDocs(db: D1Database): Promise<DocumentSummary[]> {
  const { results } = await db
    .prepare("SELECT id, path, title, status, updated_by, updated_at FROM documents WHERE status = 'published' ORDER BY path")
    .all<{
      id: number;
      path: string;
      title: string;
      status: string;
      updated_by: string | null;
      updated_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    status: "published" as const,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
  }));
}

/** 登录用户的侧栏额外包含草稿（带徽章）；匿名只查 published，避免多拉数据 */
async function loadVisibleDocs(db: D1Database, loggedIn: boolean): Promise<DocumentSummary[]> {
  if (!loggedIn) return loadPublishedDocs(db);
  const { results } = await db
    .prepare("SELECT id, path, title, status, updated_by, updated_at FROM documents ORDER BY path")
    .all<{ id: number; path: string; title: string; status: string; updated_by: string | null; updated_at: number }>();
  return results.map((r) => ({
    id: r.id,
    path: r.path,
    title: r.title,
    status: r.status === "published" ? ("published" as const) : ("draft" as const),
    updated_at: r.updated_at,
    updated_by: r.updated_by,
  }));
}

async function notFound(env: AppEnv["Bindings"], req: Request, url: URL, path: string): Promise<Response> {
  const settings = await loadSettings(env);
  const html = renderNotFoundPage({
    siteName: settings.siteName,
    baseUrl: baseUrlOf(env, url),
    path,
    favicon: settings.favicon,
    footer: settings.footer,
    theme: themeFromRequest(req),
  });
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function registerPagesRoutes(app: Hono<AppEnv>): void {
  // GET / —— 跳转到第一篇已发布文档；无文档时显示引导页（PLAN 4.6 引导态）
  app.get("/", async (c) => {
    const env = c.env;
    const url = new URL(c.req.url);
    let firstPath: string | null = null;
    if (env.DB) {
      try {
        const paths = await listPublishedPaths(env.DB);
        firstPath = paths.sort()[0] ?? null;
      } catch {
        firstPath = null;
      }
    }
    if (firstPath) return c.redirect(`/docs/${firstPath}`, 302);
    const settings = await loadSettings(env);
    const html = renderMessagePage({
      siteName: settings.siteName,
      baseUrl: baseUrlOf(env, url),
      title: `${settings.siteName}`,
      message:
        "站点还没有已发布的文档。先访问 /setup 完成环境自检，然后登录 /admin 创建并发布第一篇文档。",
      statusCode: 200,
      favicon: settings.favicon,
      footer: settings.footer,
      theme: themeFromRequest(c.req.raw),
    });
    return c.html(html);
  });

  // GET /docs/*path —— 阅读页（PLAN 4.2）
  app.get("/docs/*", async (c) => {
    const env = c.env;
    if (!env.DB) return c.redirect("/setup", 302);
    const rawPath = c.req.path.replace(/^\/docs\/?/, "");
    let path: string;
    try {
      path = decodeURIComponent(rawPath).replace(/\/+$/, "");
    } catch {
      return notFound(env, c.req.raw, new URL(c.req.url), rawPath);
    }
    if (!path) return c.redirect("/", 302);

    const url = new URL(c.req.url);
    const user = await getSessionUser(env, c.req.raw);
    const isAnonymous = user === null;
    // 显式主题选择不走页面缓存：缓存键不含主题，带 Cookie 的请求必须实时渲染
    // 才能带上正确的 data-theme；未显式选择的请求继续吃缓存，
    // 由 CSS 的 prefers-color-scheme 自动适配系统深浅色。
    const explicitTheme = themeFromRequest(c.req.raw);

    // ---- 匿名请求走缓存；登录请求永远 live 渲染且 no-store ----
    if (isAnonymous && !url.searchParams.has("view") && !explicitTheme) {
      if (env.PAGE_CACHE) {
        const cached = await getPageCache(env, path);
        if (cached) {
          if (c.req.header("If-None-Match") === cached.etag) {
            return new Response(null, {
              status: 304,
              headers: { ETag: cached.etag, "Cache-Control": "public, max-age=60, stale-while-revalidate=600" },
            });
          }
          return new Response(cached.html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              ETag: cached.etag,
              "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
            },
          });
        }
      } else {
        const hit = await serveFromCacheApi(c.req.raw);
        if (hit) return hit;
      }
    }

    const record = await getDocByPath(env.DB, path);
    if (!record) return notFound(env, c.req.raw, url, path);
    const { row, publishedContent } = record;

    // 权限：草稿仅登录可见（PLAN 1）
    if (row.status !== "published" && !user) return notFound(env, c.req.raw, url, path);

    // 内容选择：登录用户默认预览最新草稿；匿名只见发布快照
    let sourceMd: string;
    let previewingDraft = false;
    if (user && row.status === "published") {
      const viewParam = url.searchParams.get("view");
      const hasUnpublishedChanges = row.content_md !== publishedContent;
      if (hasUnpublishedChanges && viewParam !== "published") {
        sourceMd = row.content_md;
        previewingDraft = true;
      } else {
        sourceMd = publishedContent ?? row.content_md;
      }
    } else if (row.status === "published") {
      sourceMd = publishedContent ?? row.content_md;
    } else {
      sourceMd = row.content_md;
    }

    const { html: contentHtml, toc } = renderMarkdown(sourceMd);
    const visibleDocs = await loadVisibleDocs(env.DB, !isAnonymous);
    const folders = await loadFolders(env.DB);
    const tree: TreeNode[] = buildTree(visibleDocs, folders);
    const settings = await loadSettings(env);
    const draftPreviewBanner = previewingDraft
      ? `<div class="draft-banner">正在预览未发布的修改 · <a href="?view=published">查看已发布版本</a> · <a href="/admin/#/doc-by-path/${encodeURIComponent(
          path
        )}">去编辑</a></div>`
      : "";

    const html = renderDocPage({
      siteName: settings.siteName,
      homeUrl: settings.homeUrl,
      nav: settings.navLinks,
      logo: settings.logo,
      notice: settings.notice,
      favicon: settings.favicon,
      footer: settings.footer,
      theme: themeFromRequest(c.req.raw),
      baseUrl: baseUrlOf(env, url),
      path,
      title: row.title,
      status: row.status === "published" ? "published" : "draft",
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      contentHtml: draftPreviewBanner + contentHtml,
      toc,
      tree,
      user,
      excerpt: excerptOf(sourceMd),
    });

    // 匿名 + 无显式主题 → 可缓存；带显式主题的响应不写入缓存（避免主题被固化）
    if (isAnonymous && !previewingDraft && !explicitTheme) {
      const etag = etagFor(html);
      const headers: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        ETag: etag,
        "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
      };
      if (c.req.header("If-None-Match") === etag) return new Response(null, { status: 304, headers });
      if (env.PAGE_CACHE) {
        void putPageCache(env, path, { etag, html, generatedAt: Date.now() });
      } else {
        const res = new Response(html, { headers });
        void putToCacheApi(c.req.raw, res.clone());
        return res;
      }
      return new Response(html, { headers });
    }

    // 登录态 / 草稿预览：不缓存
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" },
    });
  });

  // GET /search —— 公开搜索页
  app.get("/search", async (c) => {
    const env = c.env;
    if (!env.DB) return c.redirect("/setup", 302);
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const started = Date.now();
    const hits = q ? await searchDocuments(env.DB, q) : [];
    const url = new URL(c.req.url);
    const user = await getSessionUser(env, c.req.raw);
    const docs = await loadVisibleDocs(env.DB, user !== null);
    const folders = await loadFolders(env.DB);
    const settings = await loadSettings(env);
    const html = renderSearchPage({
      siteName: settings.siteName,
      homeUrl: settings.homeUrl,
      nav: settings.navLinks,
      logo: settings.logo,
      notice: settings.notice,
      favicon: settings.favicon,
      footer: settings.footer,
      theme: themeFromRequest(c.req.raw),
      user,
      baseUrl: baseUrlOf(env, url),
      query: q,
      hits,
      tookMs: Date.now() - started,
      tree: buildTree(docs, folders),
    });
    return c.html(html);
  });

  // GET /sitemap.xml —— 从 D1 动态生成（PLAN 1）
  app.get("/sitemap.xml", async (c) => {
    const env = c.env;
    if (!env.DB) return c.text("service unavailable", 503);
    const docs = await loadPublishedDocs(env.DB);
    const base = baseUrlOf(env, new URL(c.req.url));
    const urls = [
      `  <url><loc>${base}/</loc></url>`,
      ...docs.map(
        (d) =>
          `  <url><loc>${base}/docs/${esc(d.path)}</loc><lastmod>${new Date(d.updated_at).toISOString()}</lastmod></url>`
      ),
    ].join("\n");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`, 200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
  });

  // GET /robots.txt
  app.get("/robots.txt", async (c) => {
    const base = baseUrlOf(c.env, new URL(c.req.url));
    const body = [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /api/",
      "Disallow: /setup",
      "",
      `Sitemap: ${base}/sitemap.xml`,
      "",
    ].join("\n");
    return c.body(body, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
  });

  // GET /feed.xml —— RSS 2.0（最近更新的 20 篇已发布文档）
  app.get("/feed.xml", async (c) => {
    const env = c.env;
    if (!env.DB) return c.text("service unavailable", 503);
    const base = baseUrlOf(env, new URL(c.req.url));
    const siteName = (await loadSettings(env)).siteName;
    const docs = (await loadPublishedDocs(env.DB)).sort((a, b) => b.updated_at - a.updated_at).slice(0, 20);
    const items = (
      await Promise.all(
        docs.map(async (d) => {
          const record = await getDocByPath(env.DB, d.path);
          const md = record?.publishedContent ?? "";
          return `    <item>
      <title>${esc(d.title)}</title>
      <link>${base}/docs/${esc(d.path)}</link>
      <guid isPermaLink="true">${base}/docs/${esc(d.path)}</guid>
      <pubDate>${new Date(d.updated_at).toUTCString()}</pubDate>
      <description>${esc(excerptOf(md, 300))}</description>
    </item>`;
        })
      )
    ).join("\n");
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
    <title>${esc(siteName)}</title>
    <link>${base}/</link>
    <description>${esc(siteName)} 最近更新</description>
${items}
</channel></rss>`,
      200,
      { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=1800" }
    );
  });
}
