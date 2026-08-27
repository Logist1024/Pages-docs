/**
 * 前后端共享的 API 类型（唯一契约来源）。
 * 服务端路由与客户端 admin SPA 都从这里导入，避免两边漂移。
 */

export type DocStatus = "draft" | "published";
export type Role = "admin" | "editor";

/** 文档列表项（侧栏 / 管理列表用，不含正文） */
export interface DocumentSummary {
  id: number;
  path: string;
  lang: string;
  title: string;
  status: DocStatus;
  /** 手动排序值（同级内升序在前；0 为未排序默认值） */
  sort_order: number;
  updated_at: number; // unix ms
  updated_by: string | null;
}

/** 文档详情（编辑器用） */
export interface DocumentDetail extends DocumentSummary {
  content_md: string;
  /** 单调递增的保存序号：每次成功保存 +1；自动保存请求必须携带 base_revision_seq */
  revision_seq: number;
  /** 最近一次发布的 revision id；从未发布为 null */
  current_revision_id: number | null;
  /** 当前发布快照的标题；从未发布为 null（用于「有未发布修改」检测） */
  published_title: string | null;
  /** 当前发布快照的正文；从未发布为 null */
  published_content_md: string | null;
  /** 可用的语言版本列表（用于语言切换器） */
  available_langs?: string[];
}

/** POST /api/docs · 新建文档 */
export interface CreateDocumentInput {
  path: string;
  lang?: string;
  title: string;
  content_md?: string;
}

/** PUT /api/docs/:id · 自动保存 / 改名 / 移动 */
export interface UpdateDocumentInput {
  base_revision_seq: number;
  title?: string;
  path?: string;
  lang?: string;
  content_md?: string;
}

/** 409 冲突时返回的响应体 */
export interface ConflictPayload {
  error: "conflict";
  message: string;
  current: {
    revision_seq: number;
    updated_by: string | null;
    updated_at: number;
    title: string;
    /** 服务器上当前内容，供 jsdiff 对比合并 */
    content_md: string;
  };
}

export interface SaveResult {
  ok: true;
  revision_seq: number;
  saved_at: number;
}

/** 版本历史条目 */
export interface RevisionSummary {
  id: number;
  document_id: number;
  lang: string;
  title: string;
  author_name: string;
  note: string | null;
  created_at: number;
}

/** GET /api/revisions/:id */
export interface RevisionDetail extends RevisionSummary {
  content_md: string;
}

/** GET /api/auth/me */
export interface MeInfo {
  name: string;
  role: Role;
}

/** GET /api/search?q= */
export interface SearchHit {
  id: number;
  path: string;
  lang: string;
  title: string;
  excerpt: string;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
}

/** POST /api/upload 成功响应 */
export interface UploadResult {
  url: string; // /f/media/2026/08/xxx.png
  key: string;
  filename: string;
  size: number;
}

/** 会话管理（仅 admin）。token_hash 为完整 SHA-256 哈希，无法反推会话令牌，可安全展示/用于吊销 */
export interface SessionRow {
  token_hash: string;
  name: string;
  role: Role;
  expires_at: number;
  created_at: number;
}

/** 目录信息：name 为显示名称（任意语言）；path 为访问路径（ASCII slug，URL 使用） */
export interface FolderInfo {
  path: string;
  name: string;
  /** 手动排序值（与文档同级混排，升序在前；0 为未排序默认值） */
  sort_order: number;
}

/** GET /api/folders · 显式创建的目录（空目录需要持久化；有文档的目录由 path 隐式推出） */
export interface FolderListResult {
  folders: FolderInfo[];
}

/** POST /api/folders · 新建目录；name 缺省时回退为 path 最后一段 */
export interface CreateFolderInput {
  path: string;
  name?: string;
}

/** 导航栏链接：站内填以 / 开头的路径，站外填完整 http(s):// URL */
export interface NavLink {
  label: string;
  href: string;
}

/** 页眉公告栏：显示在站点头部下方，可附带一个链接。text 支持内联 HTML（服务端会做安全过滤） */
export interface NoticeBar {
  text: string;
  /** 可选链接（站内 / 路径或完整 http(s):// URL）；空字符串表示无链接 */
  link: string;
}

/** GET /api/settings · 站点设置（公开字段，匿名可读） */
export interface SiteSettings {
  /** 站点名称；null 表示未自定义（回退部署变量 / 默认值） */
  site_name: string | null;
  /** 首页地址：访客直接访问站点根路径时默认打开的页面，也是点击站点名称的跳转目标；null 表示默认展示第一篇已发布文档 */
  home_url: string | null;
  nav_links: NavLink[];
  /** 网站图标（浏览器标签页）；data:image URI 或站内 /f/ 路径；null 表示默认 favicon */
  favicon: string | null;
  /** 界面 LOGO（页眉品牌图）；data:image URI 或站内 /f/ 路径；null 表示内置默认 LOGO */
  logo: string | null;
  /** 页眉公告栏；null 表示不显示 */
  notice: NoticeBar | null;
  /** 页脚自定义 HTML（版权声明等）；null 表示不显示页脚 */
  footer: string | null;
  /** 默认语言代码（如 en、zh-CN）；默认 en */
  default_lang: string | null;
  /** 支持的语言列表（语言代码数组，如 ["en", "zh-CN"]）；默认 ["en"] */
  supported_langs: string[] | null;
}

/** PUT /api/settings · 更新站点设置（仅 admin）；字段可选，传 null 恢复默认 */
export interface UpdateSiteSettingsInput {
  site_name?: string | null;
  home_url?: string | null;
  nav_links?: NavLink[];
  favicon?: string | null;
  logo?: string | null;
  notice?: NoticeBar | null;
  footer?: string | null;
  default_lang?: string | null;
  supported_langs?: string[] | null;
}

/** PUT /api/folders/:path · 目录改名 / 移动（name 与 path 均可选） */
export interface UpdateFolderInput {
  name?: string;
  path?: string;
}

/* ---------------- 目录与文档排序 ---------------- */

/** 排序项：目录用 path 定位，文档用 id 定位 */
export type TreeOrderItem =
  | { type: "folder"; path: string }
  | { type: "doc"; id: number };

/**
 * PUT /api/tree/order · 重排某个父目录下的直接子项（目录与文档混排）。
 * items 必须覆盖该目录下全部直接子项的完整顺序（客户端总是全量提交）；
 * 未列出的子项由服务端追加到末尾，不会丢失。
 */
export interface TreeOrderInput {
  /** 父目录路径；空字符串表示根层级 */
  parent: string;
  items: TreeOrderItem[];
}

/** /setup 自检结果项 */
export type SetupCheckState = "ok" | "warn" | "fail";

export interface SetupCheck {
  key: string;
  label: string;
  state: SetupCheckState;
  detail: string;
}

/* ---------------- 用量统计（GET /api/admin/usage，仅 admin） ---------------- */

/** 单表行数与估算字节 */
export interface TableStat {
  name: string;
  rows: number;
  bytes: number;
}

/** 按天聚合（近 N 天） */
export interface DailyCount {
  day: string; // YYYY-MM-DD
  count: number;
}

export interface D1Usage {
  tables: TableStat[];
  /** 全表估算总字节 */
  total_bytes: number;
  doc_status: { published: number; draft: number };
  /** 近 30 天每日新增版本数 */
  revisions_by_day: DailyCount[];
  /** 内容最大的文档 TOP5 */
  largest_docs: { path: string; title: string; bytes: number }[];
}

export interface R2Usage {
  configured: boolean;
  object_count: number;
  total_bytes: number;
  /** 按上传月份聚合（key 前缀 media/YYYY/MM/） */
  by_month: { month: string; count: number; bytes: number }[];
}

export interface KVUsage {
  configured: boolean;
  /** 页面缓存键数量（html:* 前缀） */
  page_cache_keys: number;
  /** 缓存内容估算字节（KV list 不返回大小，此值为抽样读取的估算或 0） */
  estimated_bytes: number;
}

export interface UsageStats {
  generated_at: number;
  d1: D1Usage;
  r2: R2Usage;
  kv: KVUsage;
}
