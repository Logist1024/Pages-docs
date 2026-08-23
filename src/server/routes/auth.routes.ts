import { Hono } from "hono";
import type { AppEnv } from "../env";
import { CLEAR_SESSION_COOKIE, getSessionUser, login, readCookie, SESSION_COOKIE, sha256Hex } from "../auth";
import { fail } from "../http-error";

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  const api = new Hono<AppEnv>();

  // POST /api/auth/login —— 唯一免鉴权 API（PLAN 5）
  api.post("/auth/login", async (c) => {
    const env = c.env;
    if (!env.DB) return fail(c, "DB_NOT_CONFIGURED");

    let body: { name?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return fail(c, "REQ_BAD_JSON");
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || !password) return fail(c, "AUTH_MISSING_FIELDS");

    // Rate Limiting binding：约 10 次/分钟/IP（PLAN 4.1）；绑定缺失时跳过
    if (env.LOGIN_LIMITER) {
      try {
        const ip = c.req.header("cf-connecting-ip") ?? "local";
        const result = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
        if (!result.success) {
          return fail(c, "AUTH_RATE_LIMITED");
        }
      } catch {
        // 本地 dev / 未开通该功能时忽略限流错误
      }
    }

    const result = await login(env, name, password);
    if (!result) return fail(c, "AUTH_LOGIN_FAILED");

    c.header("Set-Cookie", result.session.cookie);
    return c.json(result.user);
  });

  // POST /api/auth/logout
  api.post("/auth/logout", async (c) => {
    const token = readCookie(c.req.raw, SESSION_COOKIE);
    if (token && c.env.DB) {
      const tokenHash = await sha256Hex(token);
      await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run().catch(() => undefined);
    }
    c.header("Set-Cookie", CLEAR_SESSION_COOKIE);
    return c.json({ ok: true });
  });

  // GET /api/auth/me
  api.get("/auth/me", async (c) => {
    const user = await getSessionUser(c.env, c.req.raw);
    if (!user) return fail(c, "AUTH_REQUIRED", "未登录");
    return c.json(user);
  });

  app.route("/api", api);
}

export { getSessionUser };
