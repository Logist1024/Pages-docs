import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { CredentialConfigError, parseAdminCredentials } from "../auth";
import { ensureMigrated, LATEST_VERSION } from "../db/migrate";
import { baseLayout, esc, themeFromRequest } from "../layout";
import { statusIcon } from "../icons";

interface Check {
  key: string;
  label: string;
  state: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
}

async function checkD1(env: Env): Promise<{ reachable: boolean; version: number | null; error: string }> {
  if (!env.DB) return { reachable: false, version: null, error: "未找到 D1 绑定（binding 名必须为 DB）" };
  try {
    await env.DB.prepare("SELECT 1").first();
    const result = await ensureMigrated(env.DB);
    return { reachable: true, version: result.to, error: "" };
  } catch (error) {
    return { reachable: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildChecks(env: Env): Promise<Check[]> {
  const checks: Promise<Check>[] = [];

  // 1. D1 与迁移
  const d1 = checkD1(env);
  checks.push(
    d1.then((r) =>
      r.reachable
        ? {
            key: "d1",
            label: "D1 数据库",
            state: "ok",
            detail: `连接正常，迁移版本 v${r.version}${r.version === LATEST_VERSION ? "（最新）" : ""}`,
          }
        : {
            key: "d1",
            label: "D1 数据库",
            state: "fail",
            detail: r.error,
            hint: "控制台 → 存储和数据库 → D1 → 创建数据库；然后在 Worker 的 Build Variables 里填 D1_DATABASE_ID。",
          }
    )
  );

  // 2. 管理员凭据
  try {
    const accounts = parseAdminCredentials(env.ADMIN_CREDENTIALS);
    const adminCount = accounts.filter((a) => a.isAdmin).length;
    checks.push(
      Promise.resolve({
        key: "credentials",
        label: "管理员凭据（ADMIN_CREDENTIALS）",
        state: "ok" as const,
        detail: `已配置 ${accounts.length} 个账号（${adminCount} 个 admin）。`,
      })
    );
  } catch (error) {
    const message =
      error instanceof CredentialConfigError ? error.message : "ADMIN_CREDENTIALS 格式不合法。";
    checks.push(
      Promise.resolve({
        key: "credentials",
        label: "管理员凭据（ADMIN_CREDENTIALS）",
        state: "fail" as const,
        detail: message,
        hint: "控制台 → 该 Worker → Settings → Variables and Secrets → 添加 Secret 类型变量 ADMIN_CREDENTIALS，值为每行一条 name:password 或 JSON 数组。",
      })
    );
  }

  // 3. R2（可选，缺失降级：图片上传不可用）
  checks.push(
    Promise.resolve(
      env.MEDIA
        ? { key: "r2", label: "R2 对象存储（MEDIA）", state: "ok" as const, detail: "绑定可用，支持图片上传。" }
        : {
            key: "r2",
            label: "R2 对象存储（MEDIA）",
            state: "warn" as const,
            detail: "未绑定：文档站可正常阅读编辑，但图片/附件上传不可用。",
            hint: "控制台 → 存储和数据库 → R2 → 创建存储桶；Build Variables 填 R2_BUCKET_NAME（建议与桶名一致）。",
          }
    )
  );

  // 4. KV（可选，缺失降级为 Cache API）
  checks.push(
    Promise.resolve(
      env.PAGE_CACHE
        ? { key: "kv", label: "KV 页面缓存（PAGE_CACHE）", state: "ok" as const, detail: "绑定可用，发布时精准失效。" }
        : {
            key: "kv",
            label: "KV 页面缓存（PAGE_CACHE）",
            state: "warn" as const,
            detail: "未绑定：自动退化为 Cache API 短 TTL 缓存（发布后最长约 60 秒边缘不一致）。",
            hint: "控制台 → 存储和数据库 → KV → 创建命名空间；Build Variables 填 KV_NAMESPACE_ID。",
          }
    )
  );

  // 5. 登录限流（可选）
  checks.push(
    Promise.resolve(
      env.LOGIN_LIMITER
        ? { key: "ratelimit", label: "登录限流（Rate Limiting binding）", state: "ok" as const, detail: "绑定可用。" }
        : {
            key: "ratelimit",
            label: "登录限流（Rate Limiting binding）",
            state: "warn" as const,
            detail: "未绑定：登录接口不限流（仍受 Workers 平台限制保护）。",
            hint: "wrangler.jsonc 的 ratelimits 配置块由部署模板生成，通常无需手动处理。",
          }
    )
  );

  return Promise.all(checks);
}

export function renderSetupPage(
  siteName: string,
  baseUrl: string,
  checks: Check[],
  opts: { favicon?: string | null; theme?: "light" | "dark" | null } = {}
): string {
  const rows = checks
    .map(
      (c) => `<li class="check check-${c.state}">
        <div class="check-head"><span class="check-state">${statusIcon(c.state, 16)}</span> <strong>${esc(c.label)}</strong></div>
        <div class="check-detail">${esc(c.detail)}</div>
        ${c.hint ? `<div class="check-hint">${esc(c.hint)}</div>` : ""}
      </li>`
    )
    .join("");
  const allOk = checks.every((c) => c.state === "ok");
  const hasFail = checks.some((c) => c.state === "fail");
  const summaryIcon = allOk ? statusIcon("ok", 18) : hasFail ? statusIcon("fail", 18) : statusIcon("warn", 18);
  const summary = allOk
    ? "一切就绪！用配置的账号登录 /admin 开始使用吧。"
    : hasFail
      ? "存在未通过项：按提示在控制台补齐后刷新本页。"
      : "核心功能可用；带警告项为可选增强，按需补齐。";
  const content = `
<main class="setup-page">
  <h1>环境自检 · ${siteName}</h1>
  <p class="setup-summary"><span class="summary-icon">${summaryIcon}</span>${summary}</p>
  <ul class="checks">${rows}</ul>
  <p class="setup-foot">本页仅显示状态，不含敏感信息；所有资源配好后各项自动变为「通过」。</p>
</main>`;
  return baseLayout({
    title: `环境自检 · ${siteName}`,
    baseUrl,
    siteName,
    content,
    bodyClass: "page-setup",
    favicon: opts.favicon,
    theme: opts.theme,
  });
}

/** /setup 自检页（PLAN 4.6）：未登录可访问，仅显示状态 */
export function registerSetupRoute(app: Hono<AppEnv>): void {
  app.get("/setup", async (c) => {
    const env = c.env;
    const siteName = env.SITE_NAME || "Pages Docs";
    let checks: Check[];
    try {
      checks = await buildChecks(env);
    } catch (error) {
      checks = [
        {
          key: "unknown",
          label: "自检过程出错",
          state: "fail",
          detail: error instanceof Error ? error.message : String(error),
        },
      ];
    }
    const url = new URL(c.req.url);
    const baseUrl = env.SITE_URL?.trim() || url.origin;
    const html = renderSetupPage(siteName, baseUrl, checks, {
      theme: themeFromRequest(c.req.raw),
    });
    return c.html(html);
  });
}
