#!/usr/bin/env node
/**
 * 构建变量注入脚本（零代码部署的关键一环）。
 *
 * 仓库中的 wrangler.jsonc 是带占位符的模板：
 *   - `__D1_DATABASE_ID__`            必填构建变量 D1_DATABASE_ID
 *   - kv_namespaces / r2_buckets 块   可选构建变量 KV_NAMESPACE_ID / R2_BUCKET_NAME：
 *                                     提供时写入真实值；未提供时整块移除
 *                                     （Worker 端自动优雅降级，wrangler 也会拒绝占位符格式）。
 *
 * Workers Builds 在执行 build 命令时运行本脚本：控制台 Build Variables 里填的资源 ID
 * 只出现在云端环境变量中，仓库里永远不会出现真实资源 ID。
 *
 * 本地开发无需任何真实 ID：`pnpm dev` 由 miniflare 用本地模拟器承接这些绑定。
 */
import { readFileSync, writeFileSync } from "node:fs";

const CONFIG = new URL("../wrangler.jsonc", import.meta.url);

/** 去掉 JSONC 注释（保留字符串内的注释符号），容忍尾逗号由调用方处理 */
function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function fail(message) {
  console.error(`\n[inject-wrangler] ✘ ${message}\n`);
  process.exit(1);
}

/** 去掉对象 / 数组字面量的尾逗号。逐字符扫描并跟踪字符串状态，
 *  避免正则整文替换误伤字符串字面量里形如 ", ]" 的内容 */
function stripTrailingCommas(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const raw = readFileSync(CONFIG, "utf8");
let config;
try {
  config = JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
} catch (error) {
  fail(`wrangler.jsonc 不是合法的 JSON/JSONC：${error.message}`);
}

// ---- D1（必填，仅部署时需要；本地 dev 用占位符即可） ----
const d1Id = process.env.D1_DATABASE_ID;
if (d1Id) {
  if (!UUID_RE.test(d1Id.trim())) {
    fail(`D1_DATABASE_ID 不是合法 UUID："${d1Id}"。请在 Cloudflare 控制台「存储和数据库 → D1」复制数据库 ID。`);
  }
  config.d1_databases = [
    {
      binding: "DB",
      database_name: process.env.D1_DATABASE_NAME || "pages-docs",
      database_id: d1Id.trim(),
    },
  ];
  console.log("[inject-wrangler] ✔ 已写入 D1 数据库 ID");
} else if (config.d1_databases?.[0]?.database_id === "__D1_DATABASE_ID__") {
  console.warn(
    "[inject-wrangler] ⚠ 未设置 D1_DATABASE_ID，database_id 保持占位符。\n" +
      "                  本地 pnpm dev 不受影响；正式部署前请在控制台 Build Variables 中填写。"
  );
}

// ---- KV（可选） ----
// 未提供变量时（无论 CI 还是本地）都移除占位块：wrangler 会校验 id/bucket_name 的格式，
// 保留 "__XXX__" 占位符会让 vite build / wrangler deploy 直接报配置错误。
// Worker 端对缺失绑定会自动优雅降级。本地想模拟绑定，可传合法格式的假值给 miniflare：
//   KV_NAMESPACE_ID=0123456789abcdef0123456789abcdef R2_BUCKET_NAME=local-media-bucket pnpm build
const isCI = process.env.CI === "true" || process.env.CI === "1";

const kvId = process.env.KV_NAMESPACE_ID?.trim();
if (kvId) {
  config.kv_namespaces = [{ binding: "PAGE_CACHE", id: kvId }];
  console.log("[inject-wrangler] ✔ 已写入 KV 命名空间 ID");
} else {
  delete config.kv_namespaces;
  console.log(
    `[inject-wrangler] ℹ 未设置 KV_NAMESPACE_ID，已移除 KV 绑定（页面缓存降级为 Cache API）${isCI ? "" : "；本地可用合法格式的假值模拟"}`
  );
}

// ---- R2（可选） ----
const bucket = process.env.R2_BUCKET_NAME?.trim();
if (bucket) {
  config.r2_buckets = [{ binding: "MEDIA", bucket_name: bucket }];
  console.log("[inject-wrangler] ✔ 已写入 R2 存储桶名");
} else {
  delete config.r2_buckets;
  console.log(
    `[inject-wrangler] ℹ 未设置 R2_BUCKET_NAME，已移除 R2 绑定（图片上传不可用）${isCI ? "" : "；本地可用合法格式的假值模拟"}`
  );
}

writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n");
console.log("[inject-wrangler] wrangler.jsonc 就绪");
