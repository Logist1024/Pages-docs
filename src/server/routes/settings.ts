import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getSessionUser } from "../auth";
import { fail } from "../http-error";
import { invalidatePublishedPages } from "../cache";
import { listPublishedPaths } from "./documents";
import {
  loadSiteSettings,
  saveSiteSettings,
  validateSettingsUpdate,
} from "../settings";
import type { SiteSettings } from "../../shared/types";

function toSettingsBody(resolved: Awaited<ReturnType<typeof loadSiteSettings>>): SiteSettings {
  return {
    site_name: resolved.siteName,
    home_url: resolved.homeUrl,
    nav_links: resolved.navLinks,
    favicon: resolved.favicon,
    logo: resolved.logo,
    notice: resolved.notice,
    footer: resolved.footer,
    default_lang: resolved.defaultLang,
    supported_langs: resolved.supportedLangs,
  };
}

/**
 * 站点设置 API：
 * - GET /api/settings 公开（站点名称 / 导航等本就是页面上可见的信息）；
 * - PUT /api/settings 仅 admin；保存后失效全部已发布页面缓存（导航/站名嵌在页面里）。
 */
export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/settings", async (c) => {
    const resolved = await loadSiteSettings(c.env.DB, c.env.SITE_NAME);
    return c.json(toSettingsBody(resolved));
  });

  app.put("/api/settings", async (c) => {
    const user = await getSessionUser(c.env, c.req.raw);
    if (!user) return fail(c, "AUTH_REQUIRED");
    if (user.role !== "admin") return fail(c, "AUTH_FORBIDDEN");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, "REQ_BAD_JSON");
    }
    if (body === null || typeof body !== "object") {
      return fail(c, "REQ_BAD_BODY", "请求体必须是 JSON 对象");
    }

    // CSRF 加固：与文档接口一致，浏览器变更请求校验 Origin 同源
    const origin = c.req.header("Origin");
    if (origin) {
      try {
        const host = c.req.header("Host") ?? new URL(c.req.url).host;
        if (new URL(origin).host !== host) return fail(c, "CSRF_BLOCKED");
      } catch {
        return fail(c, "ORIGIN_INVALID");
      }
    }

    const parsed = validateSettingsUpdate(body as Parameters<typeof validateSettingsUpdate>[0]);
    if (!parsed.ok) return fail(c, "SETTINGS_INVALID", parsed.error);

    await saveSiteSettings(c.env.DB, parsed.value, user.name);

    // 站名 / 导航 / 首页地址都渲染在阅读页 HTML 里，全部失效重建
    try {
      const paths = await listPublishedPaths(c.env.DB);
      await invalidatePublishedPages(c.env, [...new Set([...paths, "/"])]);
    } catch {
      // 失效失败只造成短暂旧页面
    }

    const resolved = await loadSiteSettings(c.env.DB, c.env.SITE_NAME);
    return c.json(toSettingsBody(resolved));
  });
}
