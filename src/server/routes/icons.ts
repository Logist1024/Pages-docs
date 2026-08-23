import { Hono } from "hono";
import type { AppEnv } from "../env";

/**
 * 站外导航项的站点图标代理（GET /icon/:host）：
 * 服务端抓取目标站点的 /favicon.ico 并转发给浏览器。之所以需要同源代理：
 * 阅读页 CSP 的 img-src 限制为 'self' data: blob:，无法直接引用第三方图标地址；
 * 经 Worker 中转既能让导航栏自动展示站外图标，又不把访客 IP 泄露给第三方服务。
 * - host 仅接受公网域名（拒绝内网 IP 段与 localhost 等，防 SSRF）；
 * - 上游抓取带超时 + 大小上限，类型必须是 image/*；
 * - 抓取失败回退内置地球图标（200 返回），保证导航布局稳定；
 * - 浏览器长缓存 + Cloudflare 边缘缓存（cf.cacheTtl），重复访问零上游开销。
 */

/** 公网域名形状：至少两段、标签字符合法（IPv6 含冒号天然不匹配） */
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** 内网 / 保留目标一律拒绝（SSRF 防护；IPv4 私段、环回、链路本地） */
function isForbiddenHost(host: string): boolean {
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

const MAX_ICON_BYTES = 100 * 1024;
const UPSTREAM_TIMEOUT_MS = 4000;
const BROWSER_TTL_SECONDS = 7 * 24 * 3600;

/** 内置兜底图标：中性灰地球，与阅读页线条风格一致（<img> 场景无法继承 currentColor，用固定色） */
const FALLBACK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"` +
  ` stroke="#8a93a6" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
  `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/>` +
  `<path d="M12 3.5c2.8 2.6 4 5.3 4 8.5s-1.2 5.9-4 8.5c-2.8-2.6-4-5.3-4-8.5s1.2-5.9 4-8.5Z"/></svg>`;

function fallbackResponse(): Response {
  return new Response(FALLBACK_SVG, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // 兜底图短缓存：目标站点稍后恢复时能尽快展示真实图标
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function registerIconRoutes(app: Hono<AppEnv>): void {
  app.get("/icon/:host", async (c) => {
    const rawHost = c.req.param("host") ?? "";
    let host: string;
    try {
      // 畸形百分号编码（如 %zz）会抛异常，按无效主机处理
      host = decodeURIComponent(rawHost).toLowerCase().replace(/\.+$/, "");
    } catch {
      return c.text("Not Found", 404);
    }
    if (!HOST_RE.test(host) || isForbiddenHost(host)) {
      return c.text("Not Found", 404);
    }

    let upstream: Response | null = null;
    try {
      upstream = await fetch(`https://${host}/favicon.ico`, {
        redirect: "follow",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { Accept: "image/*", "User-Agent": "pages-docs-icon-proxy/1.0" },
        cf: { cacheTtl: 24 * 3600, cacheEverything: true },
      });
    } catch {
      return fallbackResponse();
    }

    const contentType = (upstream.headers.get("Content-Type") ?? "").toLowerCase();
    const length = Number(upstream.headers.get("Content-Length") ?? "0");
    let body: ArrayBuffer | null = null;
    if (upstream.ok && contentType.startsWith("image/") && length <= MAX_ICON_BYTES) {
      try {
        body = await upstream.arrayBuffer();
      } catch {
        body = null;
      }
    }
    if (!body || body.byteLength === 0 || body.byteLength > MAX_ICON_BYTES) {
      return fallbackResponse();
    }

    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${BROWSER_TTL_SECONDS}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
