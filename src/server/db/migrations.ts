/**
 * 内嵌数据库迁移（PLAN 4.6：建表 SQL 内嵌在 Worker 代码中，首个请求自动幂等执行）。
 * 所有语句都用 IF NOT EXISTS，保证重复执行安全。
 * 注意：每条语句必须是完整的独立 SQL（触发器体作为一个整体，不能按分号切分）。
 */

export interface Migration {
  version: number;
  name: string;
  /** 完整的、按序执行的独立 SQL 语句 */
  statements: string[];
}

const SQL_USERS = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'editor',
  created_at INTEGER NOT NULL
)`;

const SQL_SESSIONS = `
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`;

const SQL_SESSIONS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name)`;

const SQL_DOCUMENTS = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  content_md TEXT NOT NULL DEFAULT '',
  revision_seq INTEGER NOT NULL DEFAULT 0,
  current_revision_id INTEGER,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const SQL_DOCUMENTS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_documents_status_path ON documents(status, path)`;

const SQL_REVISIONS = `
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  author_name TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
)`;

const SQL_REVISIONS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_revisions_doc ON revisions(document_id, created_at DESC)`;

const SQL_ATTACHMENTS = `
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  r2_key TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

// 全文搜索：普通 FTS5 表（存储文本以支持 snippet），触发器同步已发布快照
// 语义约定：documents.content_md 是工作副本（草稿）；读者可见内容 = current_revision_id 指向的 revisions.content_md。
const SQL_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, body, tokenize='unicode61'
)`;

const SQL_TRIGGER_AI = `
CREATE TRIGGER IF NOT EXISTS documents_fts_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, body)
  SELECT NEW.id, r.title, r.content_md
  FROM revisions r
  WHERE r.id = NEW.current_revision_id AND NEW.status = 'published';
END`;

const SQL_TRIGGER_AU = `
CREATE TRIGGER IF NOT EXISTS documents_fts_au AFTER UPDATE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = OLD.id;
  INSERT INTO documents_fts(rowid, title, body)
  SELECT NEW.id, r.title, r.content_md
  FROM revisions r
  WHERE r.id = NEW.current_revision_id AND NEW.status = 'published';
END`;

const SQL_TRIGGER_AD = `
CREATE TRIGGER IF NOT EXISTS documents_fts_ad AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = OLD.id;
END`;

const SQL_FOLDERS = `
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY,
  created_by TEXT,
  created_at INTEGER NOT NULL
)`;

const SQL_FOLDERS_NAME = `
ALTER TABLE folders ADD COLUMN name TEXT NOT NULL DEFAULT ''`;

const SQL_SITE_SETTINGS = `
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
)`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "0001_init",
    statements: [
      SQL_USERS,
      SQL_SESSIONS,
      SQL_SESSIONS_INDEX,
      SQL_DOCUMENTS,
      SQL_DOCUMENTS_INDEX,
      SQL_REVISIONS,
      SQL_REVISIONS_INDEX,
      SQL_ATTACHMENTS,
      SQL_FTS,
      SQL_TRIGGER_AI,
      SQL_TRIGGER_AU,
      SQL_TRIGGER_AD,
    ].map((s) => s.trim()),
  },
  {
    version: 2,
    name: "0002_folders",
    // 目录管理：文档路径仍隐式产生目录，此表只为持久化「空目录」
    statements: [SQL_FOLDERS].map((s) => s.trim()),
  },
  {
    version: 3,
    name: "0003_folder_names",
    // 目录显示名称：任意语言；访问路径（path）保持 ASCII slug 不变。
    // 历史行 name 为空时由前端回退显示 path 最后一段。
    statements: [SQL_FOLDERS_NAME].map((s) => s.trim()),
  },
  {
    version: 4,
    name: "0004_site_settings",
    // 站点设置（键值对）：site_name / home_url / nav_links(JSON 数组)，
    // 覆盖部署变量 SITE_NAME 的展示值；阅读页 SSR 直接读取。
    statements: [SQL_SITE_SETTINGS].map((s) => s.trim()),
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
