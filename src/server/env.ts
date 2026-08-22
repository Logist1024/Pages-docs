import type { Role } from "../shared/types";

/** 最小结构化类型：Workers Rate Limiting binding（避免依赖具体 workers-types 版本） */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Worker 环境绑定。
 * - DB / ASSETS 为必需；PAGE_CACHE / MEDIA / LOGIN_LIMITER 缺失时全局优雅降级。
 * - ADMIN_CREDENTIALS 来自控制台 Secret（或本地 .dev.vars），绝不写入仓库。
 */
export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  PAGE_CACHE?: KVNamespace;
  MEDIA?: R2Bucket;
  LOGIN_LIMITER?: RateLimitBinding;
  ADMIN_CREDENTIALS?: string;
  SITE_NAME?: string;
  SITE_URL?: string;
};

export interface SessionUser {
  name: string;
  role: Role;
}

/** Hono 泛型环境 */
export type AppEnv = { Bindings: Env; Variables: { user?: SessionUser } };
