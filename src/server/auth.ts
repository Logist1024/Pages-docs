import type { Env, SessionUser } from "./env";
import type { Role } from "../shared/types";

// ---------------------------------------------------------------------------
// ADMIN_CREDENTIALS 解析（PLAN 4.1）
// 支持两种等价格式：
//   1) JSON 数组：[{"name":"alice","password":"s3cret"}]
//   2) 每行一条 name:password 纯文本（# 开头为注释行）
// 数组第一条视为 admin，其余为 editor。
// ---------------------------------------------------------------------------

export interface AdminAccount {
  name: string;
  password: string;
  isAdmin: boolean;
}

export class CredentialConfigError extends Error {}

export function parseAdminCredentials(raw: string | undefined): AdminAccount[] {
  if (raw === undefined || raw.trim() === "") {
    throw new CredentialConfigError(
      "未配置 Secret 变量 ADMIN_CREDENTIALS。请在 控制台 → Workers & Pages → 本 Worker → Settings → Variables and Secrets 添加。"
    );
  }

  const text = raw.trim();
  let entries: { name?: unknown; password?: unknown }[];

  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CredentialConfigError("ADMIN_CREDENTIALS 以 [ 开头但不是合法 JSON 数组。");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new CredentialConfigError("ADMIN_CREDENTIALS 必须是非空 JSON 数组。");
    }
    entries = parsed as { name?: unknown; password?: unknown }[];
  } else {
    entries = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) {
        // 注意：错误信息不能包含原始行内容（可能是密码本身），细节只进服务端日志
        console.error("[auth] ADMIN_CREDENTIALS 文本格式错误（应为 name:password），已跳过解析");
        throw new CredentialConfigError(
          "ADMIN_CREDENTIALS 文本格式错误：每行应为 name:password（冒号分隔），# 开头为注释行。"
        );
      }
      entries.push({
        name: trimmed.slice(0, idx).trim(),
        password: trimmed.slice(idx + 1).trim(),
      });
    }
  }

  const accounts: AdminAccount[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const password = typeof entry.password === "string" ? entry.password : "";
    if (!name || !password) {
      throw new CredentialConfigError("ADMIN_CREDENTIALS 中存在空的 name 或 password 字段。");
    }
    if (seen.has(name)) {
      throw new CredentialConfigError(`ADMIN_CREDENTIALS 中登录名重复：${name}`);
    }
    seen.add(name);
    accounts.push({ name, password, isAdmin: accounts.length === 0 });
  }
  if (accounts.length === 0) {
    throw new CredentialConfigError("ADMIN_CREDENTIALS 未包含任何有效账号。");
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// 口令校验：明文或 pbkdf2$迭代$saltB64$hashB64（WebCrypto 重算比对，控制台不存明文）
// ---------------------------------------------------------------------------

const PBKDF2_PREFIX = "pbkdf2$";
const DEFAULT_ITERATIONS = 210_000;

/** 常量时间比较：优先 workerd 的 crypto.subtle.timingSafeEqual，否则手写恒时循环 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = (s: string) => new TextEncoder().encode(s);
  const ab = enc(a);
  const bb = enc(b);
  const subtle = globalThis.crypto?.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  if (typeof subtle?.timingSafeEqual === "function") {
    // workerd 要求长度一致才可比较；先比长度（长度本身不是敏感信息）
    if (ab.byteLength !== bb.byteLength) return false;
    return subtle.timingSafeEqual(toArrayBuffer(ab), toArrayBuffer(bb));
  }
  const len = Math.max(ab.byteLength, bb.byteLength);
  let diff = ab.byteLength ^ bb.byteLength;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function pbkdf2Derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(new TextEncoder().encode(password)), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function verifyPassword(account: AdminAccount, input: string): Promise<boolean> {
  if (account.password.startsWith(PBKDF2_PREFIX)) {
    const parts = account.password.split("$");
    // [pbkdf2, iters, saltB64(hash-url-safe), hashB64]
    if (parts.length !== 4) return false;
    const iterations = Number.parseInt(parts[1]!, 10);
    if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 5_000_000) return false;
    const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    try {
      const salt = b64(parts[2]!);
      const expected = b64(parts[3]!);
      const actual = await pbkdf2Derive(input, salt, iterations);
      const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      // 十六进制为 ASCII 安全编码，可安全走字符串恒时比较
      return timingSafeEqualStr(toHex(actual), toHex(expected));
    } catch {
      return false;
    }
  }
  return timingSafeEqualStr(account.password, input);
}

/** 与真实账号（pbkdf2 路径）等开销的假校验，用于用户名不存在时抹平时序差 */
async function decoyVerify(): Promise<void> {
  const salt = new TextEncoder().encode("pages-docs-decoy-salt");
  await pbkdf2Derive(crypto.randomUUID(), salt, DEFAULT_ITERATIONS).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// 会话：随机 token → SHA-256 入库 → HttpOnly Cookie（14 天）
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "pd_session";
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export interface CreatedSession {
  token: string;
  expiresAt: number;
  cookie: string;
}

export async function createSession(db: D1Database, user: SessionUser): Promise<CreatedSession> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  // 同一事务内顺带清理过期会话行，避免 sessions 表无限增长
  await db.batch([
    db.prepare("INSERT INTO sessions (token_hash, name, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      tokenHash,
      user.name,
      user.role,
      expiresAt,
      now
    ),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
  ]);
  return { token, expiresAt, cookie: sessionCookie(token, SESSION_TTL_MS / 1000) };
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function getSessionUser(env: Env, request: Request): Promise<SessionUser | null> {
  if (!env.DB) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  try {
    const row = await env.DB.prepare("SELECT name, role, expires_at FROM sessions WHERE token_hash = ?")
      .bind(tokenHash)
      .first<{ name: string; role: string; expires_at: number }>();
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
      return null;
    }
    return { name: row.name, role: (row.role === "admin" ? "admin" : "editor") as Role };
  } catch {
    // 表还不存在等情况 → 视为未登录
    return null;
  }
}

/** 登录成功返回会话与身份；失败返回 null（已做常量时间处理，调用方负责限流） */
export async function login(env: Env, name: string, password: string): Promise<{ session: CreatedSession; user: SessionUser } | null> {
  let accounts: AdminAccount[];
  try {
    accounts = parseAdminCredentials(env.ADMIN_CREDENTIALS);
  } catch {
    return null;
  }
  const account = accounts.find((a) => a.name === name);
  if (!account) {
    await decoyVerify();
    return null;
  }
  const ok = await verifyPassword(account, password);
  if (!ok) return null;
  const role: Role = account.isAdmin ? "admin" : "editor";
  const user: SessionUser = { name: account.name, role };
  const session = await createSession(env.DB, user);
  return { session, user };
}
