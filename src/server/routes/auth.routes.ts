import { Hono } from "hono";
import type { AppEnv } from "../env";
import { CLEAR_SESSION_COOKIE, getSessionUser, login, readCookie, SESSION_COOKIE, sha256Hex } from "../auth";

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  const api = new Hono<AppEnv>();

  // POST /api/auth/login —— 唯一免鉴权 API（PLAN 5）
  api.post("/auth/login", async (c) => {
    const env = c.env;
    if (!env.DB) return c.json({ error: "数据库未配置，请访问 /setup 查看自检" }, 503);

    let body: { name?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体必须是 JSON" }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || !password) return c.json({ error: "请输入登录名和密码" }, 400);

    // Rate Limiting binding：约 10 次/分钟/IP（PLAN 4.1）；绑定缺失时跳过
    if (env.LOGIN_LIMITER) {
      try {
        const ip = c.req.header("cf-connecting-ip") ?? "local";
        const result = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
        if (!result.success) {
          return c.json({ error: "尝试过于频繁，请一分钟后再试" }, 429);
        }
      } catch {
        // 本地 dev / 未开通该功能时忽略限流错误
      }
    }

    const result = await login(env, name, password);
    if (!result) return c.json({ error: "用户名或密码错误" }, 401);

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
    if (!user) return c.json({ error: "未登录" }, 401);
    return c.json(user);
  });

  app.route("/api", api);
}

export { getSessionUser };
