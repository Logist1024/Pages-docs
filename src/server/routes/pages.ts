import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getSessionUser } from "../auth";
import { etagFor, getPageCache, putPageCache, putToCacheApi, serveFromCacheApi } from "../cache";
import { excerptOf, renderMarkdown } from "../markdown";
import { buildTree, type TreeNode } from "../tree";
import { esc, renderDocPage, renderMessagePage, renderNotFoundPage, renderSearchPage, themeFromRequest } from "../layout";
import { loadSiteSettings, type ResolvedSiteSettings } from "../settings";
import { getDocByPath, getDocByPathFallback, listPublishedPaths } from "./documents";
import { searchDocuments } from "./search";
import { isReservedRoutePath } from "../../shared/reserved-paths";
import type { DocumentSummary, FolderInfo } from "../../shared/types";

function baseUrlOf(env: AppEnv["Bindings"], url: URL): string {
  const configured = env.SITE_URL?.trim().replace(/\/+$/, "");
  return configured || url.origin;
}

/** 从路径中解析语言前缀：/en/guide/intro -> { lang: "en", path: "guide/intro" } */
function parseLangFromPath(rawPath: string, defaultLang: string, supportedLangs: string[]): { lang: string; path: string; hasPrefix: boolean } {
  const segments = rawPath.split("/").filter(Boolean);
  if (segments.length === 0) return { lang: defaultLang, path: "", hasPrefix: false };
  const firstSeg = segments[0].toLowerCase();
  if (supportedLangs.includes(firstSeg)) {
    return { lang: firstSeg, path: segments.slice(1).join("/"), hasPrefix: true };
  }
  return { lang: defaultLang, path: rawPath, hasPrefix: false };
}

/** 构建带语言前缀的 URL 路径 */
function buildLangPath(lang: string, path: string, defaultLang: string): string {
  if (lang === defaultLang) return path ? `/${path}` : "/";
  return `/${lang}${path ? `/${path}` : ""}`;
}

/** 站点设置（名称/首页地址/导航/品牌/语言）；DB 不可用时回退部署变量与默认值 */
async function loadSettings(env: AppEnv["Bindings"]): Promise<ResolvedSiteSettings> {
  return loadSiteSettings(env.DB, env.SITE_NAME);
}

/** 显式创建的目录（含显示名称与排序值）；查询失败时退化为空列表，不阻塞页面渲染 */
async function loadFolders(db: D1Database): Promise<FolderInfo[]> {
  try {
    const { results } = await db.prepare("SELECT path, name, sort_order FROM folders").all<{
      path: string;
      name: string;
      sort_order: number;
    }>();
    return results.map((r) => ({
      path: r.path,
      name: r.name || r.path.split("/").pop() || r.path,
      sort_order: r.sort_order ?? 0,
    }));
  } catch {
    return [];
  }
}

async function loadPublishedDocs(db: D1Database, lang: string): Promise<DocumentSummary[]> {
  const { results } = await db
    .prepare(
      "SELECT id, path, lang, title, status, sort_order, updated_by, updated_at FROM documents WHERE status = 'published' AND lang = ? ORDER BY path"
    )
    .bind(lang)
    .all<{
      id: number;
      path: string;
      lang: string;
      title: string;
      status: string;
      sort_order: number;
      updated_by: string | null;
      updated_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    path: r.path,
    lang: r.lang,
    title: r.title,
    status: "published" as const,
    sort_order: r.sort_order ?? 0,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
  }));
}

/** 登录用户的侧栏额外包含草稿（带徽章）；匿名只查 published，避免多拉数据 */
async function loadVisibleDocs(db: D1Database, loggedIn: boolean, lang: string): Promise<DocumentSummary[]> {
  if (!loggedIn) return loadPublishedDocs(db, lang);
  const { results } = await db
    .prepare("SELECT id, path, lang, title, status, sort_order, updated_by, updated_at FROM documents WHERE lang = ? ORDER BY path")
    .bind(lang)
    .all<{
      id: number;
      path: string;
      lang: string;
      title: string;
      status: string;
      sort_order: number;
      updated_by: string | null;
      updated_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    path: r.path,
    lang: r.lang,
    title: r.title,
    status: r.status === "published" ? ("published" as const) : ("draft" as const),
    sort_order: r.sort_order ?? 0,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
  }));
}

/**
 * 站点保留路径：由 Worker 功能路由与静态资源占用，不作为文档路径解析。
 * 文档访问地址已直接映射到站点根路径，这些前缀下的请求一律放行给框架按 404 处理，
 * 避免文档路径遮蔽核心功能。清单与创建期校验共用 src/shared/reserved-paths.ts。
 */
function isReservedDocPath(path: string): boolean {
  return isReservedRoutePath(path);
}

async function notFound(env: AppEnv["Bindings"], req: Request, url: URL, path: string, settings: ResolvedSiteSettings): Promise<Response> {
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
  // 语言检测中间件：为所有阅读页路由提取语言
  const langMiddleware = async (c: any, next: any) => {
    const env = c.env;
    if (!env.DB) return c.redirect("/setup", 302);
    const settings = await loadSettings(env);
    const defaultLang = settings.defaultLang;
    const supportedLangs = settings.supportedLangs;

    const rawPath = c.req.path.replace(/^\/+/, "");
    // 保留路径直接放行
    if (isReservedDocPath(rawPath)) return next();

    const { lang, path, hasPrefix } = parseLangFromPath(rawPath, defaultLang, supportedLangs);

    // 如果是默认语言但带了前缀（理论上不该发生），重定向去掉前缀
    if (hasPrefix && lang === defaultLang) {
      const target = new URL(c.req.url);
      target.pathname = buildLangPath(defaultLang, path, defaultLang);
      return c.redirect(target.toString(), 302);
    }

    // 存储语言信息供后续处理使用
    c.set("i18n", { lang, path, hasPrefix, defaultLang, supportedLangs, settings });
    await next();
  };

  // GET / —— 站点入口：按语言重定向到首页或第一篇文档
  app.get("/", langMiddleware, async (c) => {
    const env = c.env;
    const url = new URL(c.req.url);
    const i18n = c.get("i18n")!;
    const { lang, defaultLang, supportedLangs, settings } = i18n;
    const home = settings.homeUrl.trim();
    if (home.length > 0 && home !== "/") return c.redirect(home, 302);
    let firstPath: string | null = null;
    try {
      const paths = await listPublishedPaths(env.DB, lang);
      firstPath = paths.sort()[0] ?? null;
    } catch {
      firstPath = null;
    }
    if (firstPath) return c.redirect(buildLangPath(lang, firstPath, defaultLang), 302);
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

  // GET /search —— 公开搜索页（带语言前缀）
  app.get("/search", langMiddleware, async (c) => {
    const env = c.env;
    const url = new URL(c.req.url);
    const i18n = c.get("i18n")!;
    const { lang, defaultLang, supportedLangs, settings } = i18n;
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const started = Date.now();
    const hits = q ? await searchDocuments(env.DB, q, lang) : [];
    const user = await getSessionUser(env, c.req.raw);
    const docs = await loadVisibleDocs(env.DB, user !== null, lang);
    const folders = await loadFolders(env.DB);
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
      currentLang: lang,
      supportedLangs,
      defaultLang,
    });
    return c.html(html);
  });

  // GET /sitemap.xml —— 从 D1 动态生成（多语言）
  app.get("/sitemap.xml", async (c) => {
    const env = c.env;
    if (!env.DB) return c.text("service unavailable", 503);
    const settings = await loadSettings(env);
    const base = baseUrlOf(env, new URL(c.req.url));
    const urls: string[] = [];
    for (const lang of settings.supportedLangs) {
      const docs = await loadPublishedDocs(env.DB, lang);
      urls.push(`  <url><loc>${base}${buildLangPath(lang, "", settings.defaultLang)}</loc></url>`);
      for (const d of docs) {
        urls.push(
          `  <url><loc>${base}${buildLangPath(lang, d.path, settings.defaultLang)}</loc><lastmod>${new Date(d.updated_at).toISOString()}</lastmod></url>`
        );
      }
    }
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`, 200, {
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

  // GET /feed.xml —— RSS 2.0（最近更新的 20 篇已发布文档，按语言分组）
  app.get("/feed.xml", async (c) => {
    const env = c.env;
    if (!env.DB) return c.text("service unavailable", 503);
    const settings = await loadSettings(env);
    const base = baseUrlOf(env, new URL(c.req.url));
    const siteName = settings.siteName;
    const items: string[] = [];
    for (const lang of settings.supportedLangs) {
      const docs = (await loadPublishedDocs(env.DB, lang)).sort((a, b) => b.updated_at - a.updated_at).slice(0, 20);
      for (const d of docs) {
        const record = await getDocByPath(env.DB, d.path, lang);
        const md = record?.publishedContent ?? "";
        items.push(`    <item>
      <title>${esc(d.title)}</title>
      <link>${base}${buildLangPath(lang, d.path, settings.defaultLang)}</link>
      <guid isPermaLink="true">${base}${buildLangPath(lang, d.path, settings.defaultLang)}</guid>
      <pubDate>${new Date(d.updated_at).toUTCString()}</pubDate>
      <description>${esc(excerptOf(md, 300))}</description>
    </item>`);
      }
    }
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
    <title>${esc(siteName)}</title>
    <link>${base}/</link>
    <description>${esc(siteName)} 最近更新</description>
${items.join("\n")}
</channel></rss>`,
      200,
      { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=1800" }
    );
  });

  // GET *path —— 阅读页（多语言版本）
  app.get("*", langMiddleware, async (c, next) => {
    const env = c.env;
    const i18n = c.get("i18n")!;
    const { lang, path, hasPrefix, defaultLang, supportedLangs, settings } = i18n;
    const url = new URL(c.req.url);
    const user = await getSessionUser(env, c.req.raw);
    const isAnonymous = user === null;
    const explicitTheme = themeFromRequest(c.req.raw);

    // 缓存键包含语言
    const cacheKey = `${lang}:${path}`;

    // ---- 匿名请求走缓存；登录请求永远 live 渲染且 no-store ----
    // ?format=md（复制源码）不读 HTML 缓存，统一走下方实时输出
    if (isAnonymous && !url.searchParams.has("view") && !explicitTheme && url.searchParams.get("format") !== "md") {
      if (env.PAGE_CACHE) {
        const cached = await getPageCache(env, cacheKey);
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

    // 空路径重定向到首页
    if (!path) return c.redirect(buildLangPath(lang, "", defaultLang), 302);

    // 查找文档（带语言回退）
    const record = await getDocByPathFallback(env.DB, path, lang, defaultLang);
    if (!record) {
      // 兼容旧版 /docs/* 链接
      if (/^docs(\/|$)/i.test(path)) {
        const target = new URL(c.req.url);
        target.pathname = buildLangPath(lang, path.replace(/^docs\/?/i, ""), defaultLang);
        return c.redirect(target.toString(), 302);
      }
      return notFound(env, c.req.raw, url, path, settings);
    }
    const { row, publishedContent, fallback } = record;

    // 权限：草稿仅登录可见（PLAN 1）
    if (row.status !== "published" && !user) return notFound(env, c.req.raw, url, path, settings);

    // 如果发生了语言回退，在页面顶部显示提示（可选：通过模板传递）
    const langFallbackNotice = fallback && lang !== defaultLang
      ? `<div class="lang-fallback-banner">此页面暂无 ${lang} 版本，正在显示 ${defaultLang} 版本。<a href="${buildLangPath(defaultLang, path, defaultLang)}">查看原版</a></div>`
      : "";

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

    // ---- ?format=md：直出当前所见的 Markdown 源码（阅读页「复制 Markdown」按钮的数据源）----
    if (url.searchParams.get("format") === "md") {
      const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
      headers["Cache-Control"] =
        isAnonymous && !previewingDraft && !explicitTheme ? "public, max-age=60" : "private, no-store";
      return new Response(sourceMd, { headers });
    }

    const { html: contentHtml, toc } = renderMarkdown(sourceMd);
    const visibleDocs = await loadVisibleDocs(env.DB, !isAnonymous, lang);
    const folders = await loadFolders(env.DB);
    const tree: TreeNode[] = buildTree(visibleDocs, folders);

    // 获取该文档在其他语言下的可用版本（用于 hreflang）
    const { results: langRows } = await env.DB
      .prepare("SELECT lang FROM documents WHERE path = ? AND status = 'published'")
      .bind(path)
      .all<{ lang: string }>();
    const availableLangs = langRows.map((r) => r.lang);

    const draftPreviewBanner = previewingDraft
      ? `<div class="draft-banner">正在预览未发布的修改 · <a href="?view=published">查看已发布版本</a> · <a href="/admin/#/doc-by-path/${encodeURIComponent(path)}?lang=${lang}">去编辑</a></div>`
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
      path: buildLangPath(lang, path, defaultLang),
      title: row.title,
      status: row.status === "published" ? "published" : "draft",
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      contentHtml: langFallbackNotice + draftPreviewBanner + contentHtml,
      toc,
      tree,
      user,
      excerpt: excerptOf(sourceMd),
      currentLang: lang,
      supportedLangs,
      defaultLang,
      availableLangs,
      canonicalPath: buildLangPath(lang, path, defaultLang),
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
        void putPageCache(env, cacheKey, { etag, html, generatedAt: Date.now() });
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
}