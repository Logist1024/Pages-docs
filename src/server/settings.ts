/**
 * 站点设置（site_settings 键值表）：
 * - site_name：站点显示名称，覆盖部署变量 SITE_NAME；
 * - home_url：首页地址——访客直接访问站点根路径时默认打开的页面，
 *   也是 logo / 站点名称的跳转地址（站内以 / 开头；站外完整 http(s):// URL）；
 * - nav_links：顶部导航栏链接数组（JSON 存储）；
 * - favicon：浏览器标签页图标（data:image URI 或站内 /f/ 路径）；
 * - logo：页眉品牌 LOGO 图（data:image URI 或站内 /f/ 路径）；
 * - notice：页眉公告栏 { text, link }（JSON 存储），text 支持内联 HTML（渲染时过滤）；
 * - footer_html：页脚自定义 HTML（版权声明等，渲染时过滤）。
 *
 * 安全模型：这些富文本仅 admin 可写，属「受信内容」；渲染前经 sanitizeTrustedHtml
 * 过滤 + 全站 CSP（script-src 'self' 禁内联脚本/事件处理器）双重防护。
 * 读取失败时全部回退默认值，绝不阻塞页面渲染。
 */
import type { NavLink, NoticeBar, SiteSettings, UpdateSiteSettingsInput } from "../shared/types";

const KEY_SITE_NAME = "site_name";
const KEY_HOME_URL = "home_url";
const KEY_NAV_LINKS = "nav_links";
const KEY_FAVICON = "favicon";
const KEY_LOGO = "logo";
const KEY_NOTICE = "notice";
const KEY_FOOTER = "footer_html";
const KEY_DEFAULT_LANG = "default_lang";
const KEY_SUPPORTED_LANGS = "supported_langs";

/** 全部设置键（读取时一次取回） */
const ALL_KEYS = [KEY_SITE_NAME, KEY_HOME_URL, KEY_NAV_LINKS, KEY_FAVICON, KEY_LOGO, KEY_NOTICE, KEY_FOOTER, KEY_DEFAULT_LANG, KEY_SUPPORTED_LANGS];

export const DEFAULT_SITE_NAME = "Pages Docs";

export interface ResolvedSiteSettings {
  siteName: string;
  homeUrl: string;
  navLinks: NavLink[];
  favicon: string | null;
  logo: string | null;
  notice: NoticeBar | null;
  footer: string | null;
  defaultLang: string;
  supportedLangs: string[];
}

/**
 * 受信富文本过滤（公告栏 / 页脚 HTML）：移除脚本执行载体与危险协议。
 * 这是纵深防御的一层——即便未来 CSP 放松，注入的脚本也不会存活：
 * - 整块删除 <script>/<iframe>/<object>/<embed>/<link>/<meta>/<base>/<form>；
 * - 删除 on* 内联事件属性；
 * - href/src 的 javascript: / vbscript: 协议替换为 "#"。
 */
export function sanitizeTrustedHtml(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, "");
  // 成对块（script 里可能有任意内容，先整块删）
  out = out.replace(/<\s*(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  // 自闭合 / 未闭合的危险标签（含上面成对删除后的残留闭合符）
  out = out.replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, "");
  // on* 事件属性：onclick="…" / onload='…' / onerror=foo
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");
  // javascript: / vbscript: 协议（href、src、xlink:href 等）
  out = out.replace(
    /\s((?:xlink:)?(?:href|src|action|formaction))\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi,
    (match, attr: string, raw: string) => {
      const value = raw.replace(/^["']|["']$/g, "").trim();
      if (/^\s*(javascript|vbscript)\s*:/i.test(value)) return ` ${attr}="#"`;
      return match;
    }
  );
  return out;
}

/** favicon / logo 允许的 data:image MIME（与阅读页 CSP img-src 'self' data: 一致） */
const IMAGE_MIME_RE = /^data:image\/(png|jpeg|webp|gif|avif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/;
/** data URI 最大长度（约 300KB 原始图片） */
const MAX_IMAGE_DATA_LENGTH = 400_000;

/**
 * 校验 favicon / logo 图片值：
 * - data:image/...;base64 URI（≤ 300KB）；或
 * - 站内路径（以 / 开头且非 //，如 /f/media/2026/08/x.png）。
 * 合法返回 null，否则错误文案。
 */
export function validateImageValue(value: string, label: string): string | null {
  if (value.startsWith("data:")) {
    if (!IMAGE_MIME_RE.test(value)) return `${label}仅支持 PNG/JPEG/WebP/GIF/AVIF/SVG/ICO 的 data URI`;
    if (value.length > MAX_IMAGE_DATA_LENGTH) return `${label}不能超过 300KB`;
    return null;
  }
  if (value.startsWith("/") && !value.startsWith("//")) return null;
  return `${label}需为图片 data URI 或站内 /f/ 图片路径`;
}

/** href 校验：站内以 / 开头（排除 //），站外完整 http(s):// URL。合法返回 null，否则错误文案 */
export function validateHref(href: string): string | null {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    try {
      const u = new URL(href);
      if (u.host.length === 0) return "URL 缺少主机名";
      return null;
    } catch {
      return "完整 URL 格式不正确";
    }
  }
  if (href.startsWith("/") && !href.startsWith("//")) return null;
  return "站内路径需以 / 开头，站外填写完整 http(s):// URL";
}

export function isExternalHref(href: string): boolean {
  return href.startsWith("http://") || href.startsWith("https://");
}

interface SettingsRow {
  key: string;
  value: string;
}

/** 解析并防御性规整存储中的 nav_links JSON */
function parseNavLinks(raw: string | null): NavLink[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const links: NavLink[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const label = String((item as { label?: unknown }).label ?? "").trim();
    const href = String((item as { href?: unknown }).href ?? "").trim();
    if (label.length === 0 || href.length === 0) continue;
    if (validateHref(href) !== null) continue;
    links.push({ label: label.slice(0, 60), href });
    if (links.length >= 20) break;
  }
  return links;
}

/** 解析并防御性规整存储中的 notice JSON。text 支持内联 HTML（渲染前过滤），上限 500 字符 */
function parseNotice(raw: string | null): NoticeBar | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const text = String((parsed as { text?: unknown }).text ?? "").trim();
  if (text.length === 0) return null;
  const link = String((parsed as { link?: unknown }).link ?? "").trim();
  return { text: text.slice(0, 500), link };
}

/** PUT /api/settings 的输入校验：合法返回规整后的值（仅含提交的字段），否则返回错误文案 */
export function validateSettingsUpdate(
  input: UpdateSiteSettingsInput
): { ok: true; value: UpdateSiteSettingsInput } | { ok: false; error: string } {
  const value: UpdateSiteSettingsInput = {};

  if (input.site_name !== undefined) {
    if (input.site_name === null) {
      value.site_name = null;
    } else {
      const name = String(input.site_name).trim();
      if (name.length === 0) return { ok: false, error: "站点名称不能为空" };
      if (name.length > 100) return { ok: false, error: "站点名称不能超过 100 字" };
      value.site_name = name;
    }
  }

  if (input.home_url !== undefined) {
    if (input.home_url === null) {
      value.home_url = null;
    } else {
      const home = String(input.home_url).trim();
      if (home.length === 0) {
        value.home_url = null;
      } else {
        const err = validateHref(home);
        if (err !== null) return { ok: false, error: `首页地址不合法：${err}` };
        value.home_url = home;
      }
    }
  }

  if (input.nav_links !== undefined) {
    if (!Array.isArray(input.nav_links)) return { ok: false, error: "导航链接必须是数组" };
    if (input.nav_links.length > 20) return { ok: false, error: "导航链接最多 20 个" };
    const links: NavLink[] = [];
    for (const raw of input.nav_links) {
      const label = String(raw?.label ?? "").trim();
      const href = String(raw?.href ?? "").trim();
      // 全空的行视为「删除」，静默丢弃
      if (label.length === 0 && href.length === 0) continue;
      if (label.length === 0) return { ok: false, error: "导航链接的名称不能为空" };
      if (label.length > 60) return { ok: false, error: "导航链接名称不能超过 60 字" };
      const err = validateHref(href);
      if (err !== null) return { ok: false, error: `导航「${label}」的地址不合法：${err}` };
      links.push({ label, href });
    }
    value.nav_links = links;
  }

  if (input.favicon !== undefined) {
    if (input.favicon === null) {
      value.favicon = null;
    } else {
      const favicon = String(input.favicon).trim();
      if (favicon.length === 0) {
        value.favicon = null;
      } else {
        const err = validateImageValue(favicon, "网站图标");
        if (err !== null) return { ok: false, error: err };
        value.favicon = favicon;
      }
    }
  }

  if (input.logo !== undefined) {
    if (input.logo === null) {
      value.logo = null;
    } else {
      const logo = String(input.logo).trim();
      if (logo.length === 0) {
        value.logo = null;
      } else {
        const err = validateImageValue(logo, "LOGO 图片");
        if (err !== null) return { ok: false, error: err };
        value.logo = logo;
      }
    }
  }

  if (input.notice !== undefined) {
    if (input.notice === null) {
      value.notice = null;
    } else {
      const text = String(input.notice?.text ?? "").trim();
      if (text.length === 0) {
        // 公告文本为空视为清除公告
        value.notice = null;
      } else {
        if (text.length > 500) return { ok: false, error: "公告内容不能超过 500 字符" };
        const link = String(input.notice?.link ?? "").trim();
        if (link.length > 0) {
          const err = validateHref(link);
          if (err !== null) return { ok: false, error: `公告链接不合法：${err}` };
        }
        value.notice = { text, link };
      }
    }
  }

  if (input.footer !== undefined) {
    if (input.footer === null) {
      value.footer = null;
    } else {
      const footer = String(input.footer).trim();
      if (footer.length === 0) {
        value.footer = null;
      } else {
        if (footer.length > 4000) return { ok: false, error: "页脚内容不能超过 4000 字符" };
        value.footer = footer;
      }
    }
  }

  if (input.default_lang !== undefined) {
    if (input.default_lang === null) {
      value.default_lang = null;
    } else {
      const lang = String(input.default_lang).trim().toLowerCase();
      if (lang.length === 0) {
        value.default_lang = null;
      } else if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) {
        return { ok: false, error: "默认语言格式不合法（如 en、zh-CN）" };
      } else {
        value.default_lang = lang;
      }
    }
  }

  if (input.supported_langs !== undefined) {
    if (input.supported_langs === null) {
      value.supported_langs = null;
    } else {
      if (!Array.isArray(input.supported_langs)) return { ok: false, error: "支持的语言必须是数组" };
      const langs: string[] = [];
      for (const lang of input.supported_langs) {
        const l = String(lang).trim().toLowerCase();
        if (l.length === 0) continue;
        if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(l)) {
          return { ok: false, error: `语言代码「${l}」格式不合法（如 en、zh-CN）` };
        }
        if (!langs.includes(l)) langs.push(l);
      }
      if (langs.length === 0) return { ok: false, error: "至少需要一种支持的语言" };
      value.supported_langs = langs;
    }
  }

  return { ok: true, value };
}

/** 读取站点设置并合并默认值（DB 不可用时回退部署变量 / 内置默认） */
export async function loadSiteSettings(
  db: D1Database | undefined,
  envSiteName: string | undefined
): Promise<ResolvedSiteSettings> {
  const stored: Record<string, string> = {};
  if (db) {
    try {
      const { results } = await db
        .prepare(`SELECT key, value FROM site_settings WHERE key IN (${ALL_KEYS.map(() => "?").join(", ")})`)
        .bind(...ALL_KEYS)
        .all<SettingsRow>();
      for (const row of results) {
        stored[row.key] = row.value;
      }
    } catch {
      // 表尚未迁移 / 查询失败：使用默认值
    }
  }

  // 存储值为空字符串时视为「显式清空」，回退默认链
  const dbName = stored[KEY_SITE_NAME]?.trim() ?? "";
  const dbHome = stored[KEY_HOME_URL]?.trim() ?? "";
  const siteName = dbName.length > 0 ? dbName : envSiteName?.trim() || DEFAULT_SITE_NAME;
  const homeUrl = dbHome.length > 0 ? dbHome : "/";
  const navLinks = parseNavLinks(stored[KEY_NAV_LINKS] ?? null);
  const favicon = stored[KEY_FAVICON]?.trim() || null;
  const logo = stored[KEY_LOGO]?.trim() || null;
  const notice = parseNotice(stored[KEY_NOTICE] ?? null);
  const footer = stored[KEY_FOOTER]?.trim() || null;
  const defaultLang = stored[KEY_DEFAULT_LANG]?.trim() || "en";
  let supportedLangs: string[] = ["en"];
  try {
    const parsed = JSON.parse(stored[KEY_SUPPORTED_LANGS] ?? "[]");
    if (Array.isArray(parsed) && parsed.length > 0) {
      supportedLangs = parsed.filter((l: unknown) => typeof l === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(l));
    }
  } catch {
    // 忽略解析错误
  }

  return { siteName, homeUrl, navLinks, favicon, logo, notice, footer, defaultLang, supportedLangs };
}

function upsertSql(): string {
  return "INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)\n" +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at";
}

/** 保存设置（调用方已通过 validateSettingsUpdate 校验）。字段缺省表示不修改；value 为 null 表示清除该键（恢复默认）。 */
export async function saveSiteSettings(
  db: D1Database,
  value: UpdateSiteSettingsInput,
  updatedBy: string
): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  if (value.site_name !== undefined) {
    stmts.push(
      value.site_name === null
        ? db.prepare("DELETE FROM site_settings WHERE key = ?").bind(KEY_SITE_NAME)
        : db.prepare(upsertSql()).bind(KEY_SITE_NAME, value.site_name, updatedBy, now)
    );
  }
  if (value.home_url !== undefined) {
    stmts.push(
      value.home_url === null
        ? db.prepare("DELETE FROM site_settings WHERE key = ?").bind(KEY_HOME_URL)
        : db.prepare(upsertSql()).bind(KEY_HOME_URL, value.home_url, updatedBy, now)
    );
  }
  if (value.nav_links !== undefined) {
    stmts.push(db.prepare(upsertSql()).bind(KEY_NAV_LINKS, JSON.stringify(value.nav_links), updatedBy, now));
  }
  if (value.favicon !== undefined) {
    stmts.push(
      value.favicon === null
        ? db.prepare("DELETE FROM site_settings WHERE key = ?").bind(KEY_FAVICON)
        : db.prepare(upsertSql()).bind(KEY_FAVICON, value.favicon, updatedBy, now)
    );
  }
  if (value.logo !== undefined) {
    stmts.push(
      value.logo === null
        ? db.prepare("DELETE FROM site_settings WHERE key = ?").bind(KEY_LOGO)
        : db.prepare(upsertSql()).bind(KEY_LOGO, value.logo, updatedBy, now)
    );
  }
  if (value.notice !== undefined) {
    stmts.push(
      value.notice === null
        ? db.prepare("DELETE FROM site_settings WHERE key = ?").bind(KEY_NOTICE)
        : db.prepare(upsertSql()).bind(KEY_NOTICE, JSON.stringify(value.notice), updatedBy, now)
    );
  }
  if (value.footer !== undefined) {
    stmts.push(
      value.footer === null
        ? db.prepare("DELETE FROM site_settings WHERE key = ?").bind(KEY_FOOTER)
        : db.prepare(upsertSql()).bind(KEY_FOOTER, value.footer, updatedBy, now)
    );
  }
  if (value.default_lang !== undefined) {
    stmts.push(
      value.default_lang === null
        ? db.prepare("DELETE FROM site_settings WHERE key = ?").bind(KEY_DEFAULT_LANG)
        : db.prepare(upsertSql()).bind(KEY_DEFAULT_LANG, value.default_lang, updatedBy, now)
    );
  }
  if (value.supported_langs !== undefined) {
    stmts.push(
      value.supported_langs === null
        ? db.prepare("DELETE FROM site_settings WHERE key = ?").bind(KEY_SUPPORTED_LANGS)
        : db.prepare(upsertSql()).bind(KEY_SUPPORTED_LANGS, JSON.stringify(value.supported_langs), updatedBy, now)
    );
  }

  if (stmts.length > 0) await db.batch(stmts);
}
