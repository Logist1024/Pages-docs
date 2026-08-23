/**
 * 系统保留路径（前后端共享契约）：
 * 这些前缀被 Worker 功能路由占用（或与旧版链接语义绑定），禁止在后台创建
 * 文档 / 目录时占用——否则创建成功却永远无法访问（被功能路由遮蔽或被旧链接跳转剥离）。
 *
 * 两档语义：
 * - 路由保留（isReservedRoutePath）：阅读页通配路由让位给功能路由的前缀；
 * - 创建保留（isReservedCreatePath）：新建 / 移动文档与目录时直接拒绝，
 *   在前者基础上额外禁用 docs（旧版链接兼容语义绑定，避免再次踩坑）。
 */

/** Worker 功能路由占用的前缀：这些路径下的请求不作为文档解析 */
export const RESERVED_ROUTE_SEGMENTS = ["admin", "api", "assets", "f", "icon"];

/** 额外禁止创建的路径：docs 与旧版 /docs/* 链接跳转语义绑定 */
export const RESERVED_CREATE_EXTRA = ["docs"];

/** 功能页文件名：站点根路径下的固定页面，不作文档路径 */
export const RESERVED_FILES = ["search", "setup", "favicon.svg", "robots.txt", "sitemap.xml", "feed.xml"];

function normalize(path: string): string {
  return path.toLowerCase().replace(/^\/+|\/+$/g, "");
}

function matches(prefixes: readonly string[], files: readonly string[], path: string): boolean {
  const lower = normalize(path);
  if ((files as readonly string[]).includes(lower)) return true;
  return (prefixes as readonly string[]).some((seg) => lower === seg || lower.startsWith(`${seg}/`));
}

/** 阅读期判定：命中功能路由前缀 / 固定页面（通配阅读路由据此放行给框架） */
export function isReservedRoutePath(path: string): boolean {
  return matches(RESERVED_ROUTE_SEGMENTS, RESERVED_FILES, path);
}

/** 创建期判定：文档 / 目录的新建、移动一律不允许落在这些路径上 */
export function isReservedCreatePath(path: string): boolean {
  return matches([...RESERVED_ROUTE_SEGMENTS, ...RESERVED_CREATE_EXTRA], RESERVED_FILES, path);
}
