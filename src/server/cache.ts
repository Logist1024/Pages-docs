import type { Env } from "./env";

/**
 * 已渲染页面缓存（PLAN 1 / 4.2）：
 * - KV 绑定存在 → key = html:{path}，发布时精准失效（PLAN 4.3）；
 * - KV 未绑定 → 退化为 Cache API 短 TTL（60s），发布后最长 1 分钟边缘不一致（PLAN 8 已接受）。
 */

export interface CachedPage {
  etag: string;
  html: string;
  generatedAt: number;
}

/**
 * 页面缓存版本：SSR 输出结构变化（新增页眉元素 / 页脚 / 主题切换等）时 +1，
 * 旧版本的缓存键立即失联，无需逐条删除即可全局失效，避免访客看到缺元素的旧页面。
 * v4：文档访问地址去掉 /docs 前缀（页内链接 / canonical / sitemap 全部改为根路径）。
 */
export const CACHE_VERSION = "v4";
const KV_PREFIX = `html:${CACHE_VERSION}:`;
const KV_TTL_SECONDS = 7 * 24 * 3600;
const CACHE_API_TTL_SECONDS = 60;

export async function getPageCache(env: Env, path: string): Promise<CachedPage | null> {
  if (env.PAGE_CACHE) {
    try {
      const raw = await env.PAGE_CACHE.get(KV_PREFIX + path, "text");
      if (!raw) return null;
      return JSON.parse(raw) as CachedPage;
    } catch {
      return null;
    }
  }
  return null; // Cache API 的读取走 serveFromCacheApi（需要原始 Request）
}

export async function putPageCache(env: Env, path: string, page: CachedPage): Promise<void> {
  if (!env.PAGE_CACHE) return;
  try {
    await env.PAGE_CACHE.put(KV_PREFIX + path, JSON.stringify(page), { expirationTtl: KV_TTL_SECONDS });
  } catch {
    // KV 写失败（如超出每日写配额）不影响主流程
  }
}

/** Cache API 降级：读取（以请求 URL 为键）。workers-types 的 CacheStorage 才有 default */
function cacheApi(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

export async function serveFromCacheApi(request: Request): Promise<Response | null> {
  try {
    return (await cacheApi().match(request)) ?? null;
  } catch {
    return null;
  }
}

export async function putToCacheApi(request: Request, response: Response): Promise<void> {
  try {
    const res = new Response(response.body, response);
    res.headers.set("Cache-Control", `public, max-age=${CACHE_API_TTL_SECONDS}`);
    await cacheApi().put(request, res);
  } catch {
    // 忽略缓存写失败
  }
}

/**
 * 发布/删除后的缓存失效（PLAN 4.3）。
 * 每个阅读页都带全量目录侧栏，因此任何发布都会影响所有已发布页面：
 * 精准删除所有 published 路径对应的键 + 站点级页面（首页跳转依赖文档列表）。
 * KV 写配额 1k/天只用于发布回填，删除操作不受该配额约束。
 */
export async function invalidatePublishedPages(env: Env, paths: string[]): Promise<void> {
  if (!env.PAGE_CACHE) return; // Cache API 降级模式：依赖短 TTL 自然过期
  try {
    await Promise.all(
      paths.map((p) => env.PAGE_CACHE!.delete(KV_PREFIX + p)).concat([env.PAGE_CACHE.delete(KV_PREFIX + "/")])
    );
  } catch {
    // 失效失败只导致最长 KV 一致性窗口内的旧页面（PLAN 8 可接受）
  }
}

export function etagFor(html: string): string {
  // 同步 FNV-1a 足够生成弱 ETag（内容校验用，非安全用途）
  let h = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    h ^= html.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `"${(h >>> 0).toString(16)}-${html.length.toString(16)}"`;
}
