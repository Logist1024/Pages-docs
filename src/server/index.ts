import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { ensureMigrated } from "./db/migrate";
import { fail } from "./http-error";
import { registerSetupRoute } from "./routes/setup";
import { registerAuthRoutes } from "./routes/auth.routes";
import { registerDocumentRoutes } from "./routes/documents";
import { registerFolderRoutes } from "./routes/folders";
import { registerUploadRoute, registerMediaRoute } from "./routes/upload";
import { registerIconRoutes } from "./routes/icons";
import { registerSearchRoute, registerAdminRoutes } from "./routes/search";
import { registerPagesRoutes } from "./routes/pages";
import { registerSettingsRoutes } from "./routes/settings";
import { registerUsageRoutes } from "./routes/usage";
import { runBackup } from "./backup";

const app = new Hono<AppEnv>();

// ---- 自动迁移（PLAN 4.6）：首个请求幂等执行；每个 isolate 只跑一次 ----
let migrationPromise: Promise<void> | null = null;
app.use("*", async (c, next) => {
  if (c.env.DB && !c.req.path.startsWith("/assets/")) {
    migrationPromise ??= ensureMigrated(c.env.DB)
      .then(() => undefined)
      .catch((error) => {
        migrationPromise = null; // 失败允许下次请求重试
        throw error;
      });
    await migrationPromise;
  }
  await next();
});

// ---- 安全响应头（PLAN 5；仅作用于 Worker 生成的响应，静态资源由 Cloudflare 直接服务）----
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  const contentType = c.res.headers.get("Content-Type") ?? "";
  if (contentType.startsWith("text/html")) {
    c.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'", // Vditor / mermaid 需要内联样式
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ")
    );
  }
});

// ---- CSRF 加固：/api 变更请求校验 Origin 与 Host 同源（SameSite=Lax 之外的兜底）----
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const origin = c.req.header("Origin");
  if (!origin) return next(); // 非浏览器客户端（curl 等）依赖 SameSite 即可
  try {
    const host = c.req.header("Host") ?? new URL(c.req.url).host;
    if (new URL(origin).host !== host) return fail(c, "CSRF_BLOCKED");
  } catch {
    return fail(c, "ORIGIN_INVALID");
  }
  await next();
});

// ---- 引导态：D1 缺失时所有页面进入 /setup 引导（PLAN 4.6）----
app.use("*", async (c, next) => {
  const hasDb = Boolean(c.env.DB);
  const path = c.req.path;
  if (!hasDb && path !== "/setup" && !path.startsWith("/assets/") && !path.startsWith("/api/auth/login")) {
    return c.redirect("/setup", 302);
  }
  await next();
});

registerSetupRoute(app);
registerAuthRoutes(app);
registerSettingsRoutes(app);
registerDocumentRoutes(app);
registerFolderRoutes(app);
registerSearchRoute(app);
registerAdminRoutes(app);
registerUsageRoutes(app);
registerUploadRoute(app);
registerMediaRoute(app);
// 站外导航图标代理：必须在 registerPagesRoutes 之前注册（后者含通配阅读路由）
registerIconRoutes(app);

// ---- /admin：管理端 SPA（静态资源 admin.html，经 ASSETS 转发）----
// 必须先于 registerPagesRoutes 注册：后者包含文档阅读页的通配路由
app.get("/admin", (c) => serveAdminAsset(c));
app.get("/admin/", (c) => serveAdminAsset(c));

registerPagesRoutes(app);

async function serveAdminAsset(c: { env: Env; req: { raw: Request } }): Promise<Response> {
  const url = new URL(c.req.raw.url);
  const assetUrl = new URL("/admin.html", url.origin);
  const request = new Request(assetUrl, { method: "GET", headers: c.req.raw.headers });
  return c.env.ASSETS.fetch(request);
}

// ---- API 404 与全局错误处理（错误码契约见 docs/ERRORS.md）----
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return fail(c, "SYS_NOT_FOUND");
  }
  return c.text("Not Found", 404);
});

app.onError((error, c) => {
  console.error(`[pages-docs] [SYS_INTERNAL] ${c.req.method} ${c.req.path}:`, error);
  if (c.req.path.startsWith("/api/")) {
    return fail(c, "SYS_INTERNAL");
  }
  return c.text("Internal Server Error", 500);
});

export default {
  fetch: app.fetch,
  /** 每日备份 Cron（PLAN 4.5）：wrangler.jsonc triggers.crons */
  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runBackup(env)
        .then((r) => console.log(`[backup] ${r.ok ? "完成" : "跳过"}：${r.detail}`))
        .catch((e) => console.error("[backup] 失败：", e))
    );
  },
} as ExportedHandler<Env>;

