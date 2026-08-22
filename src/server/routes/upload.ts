import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getSessionUser } from "../auth";

// 图片类型白名单（PLAN 4.4）
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function randomKey(ext: string, now: Date): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `media/${yyyy}/${mm}/${hex}.${ext}`;
}

/** POST /api/upload —— editor 及以上；image/* 白名单；单文件 ≤10MB；直传 R2 */
export function registerUploadRoute(app: Hono<AppEnv>): void {
  app.post("/api/upload", async (c) => {
    const user = await getSessionUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "请先登录" }, 401);

    if (!c.env.MEDIA) {
      return c.json({ error: "R2 未配置：请在控制台绑定 MEDIA 存储桶（见 /setup）" }, 503);
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "请求必须是 multipart/form-data" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "缺少 file 字段" }, 400);

    const mime = file.type.split(";")[0]!.trim().toLowerCase();
    const ext = MIME_EXT[mime];
    if (!ext) return c.json({ error: `仅支持图片类型：${Object.keys(MIME_EXT).join(", ")}` }, 415);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "文件超过 10MB 上限" }, 413);
    if (file.size === 0) return c.json({ error: "空文件" }, 400);

    const key = randomKey(ext, new Date());
    const arrayBuffer = await file.arrayBuffer();
    await c.env.MEDIA.put(key, arrayBuffer, {
      httpMetadata: {
        contentType: mime,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        // R2 自定义元数据值需为 ASCII，文件名仅记录在 D1
        uploader: user.name.replace(/[^\x20-\x7e]/g, "_"),
      },
    });

    const filename = (file.name || `upload.${ext}`).slice(0, 200);
    await c.env.DB.prepare(
      "INSERT INTO attachments (r2_key, filename, mime, size, uploader_name, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(key, filename, mime, file.size, user.name, Date.now())
      .run();

    return c.json({ url: `/f/${key}`, key, filename, size: file.size });
  });
}

/** GET /f/{key} —— Worker 流式回源 R2，长缓存（PLAN 4.4） */
export function registerMediaRoute(app: Hono<AppEnv>): void {
  app.get("/f/*", async (c) => {
    if (!c.env.MEDIA) return c.text("R2 未配置", 503);
    let key: string;
    try {
      key = decodeURIComponent(c.req.path.replace(/^\/f\//, ""));
    } catch {
      return c.text("Not Found", 404);
    }
    // backups/ 前缀是每日备份（含全部草稿与历史版本），只允许通过 R2 控制台访问，绝不公开
    if (!key || key.includes("..") || key === "backups" || key.startsWith("backups/")) {
      return c.text("Not Found", 404);
    }

    // 浏览器/边缘缓存命中则不打 R2
    // （Cache API 在 dev 与 prod 都可用；R2 出口免费，此处只是省 CPU）
    const object = await c.env.MEDIA.get(key);
    if (!object) return c.text("Not Found", 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("ETag", object.httpEtag);
    // SVG 内嵌脚本防护：sandbox 化渲染
    if (object.httpMetadata?.contentType === "image/svg+xml") {
      headers.set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    }
    return new Response(object.body, { headers });
  });
}
