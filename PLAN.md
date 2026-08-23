# pages-docs · 基于 Cloudflare Workers 的在线编辑文档站 —— 实施规划

> 定位：对外产品文档站。匿名访客可阅读，登录后的团队成员可在线编辑。
> 不走 git 提交 → 构建流水线；内容存数据库，请求时渲染。

## 0. 已确认的决策

| 决策点 | 结论 |
|---|---|
| 使用场景 | 对外产品文档站（匿名可读 + SEO） |
| 编辑器 | Vditor（源码 / 即时渲染 / 所见即所得三模式可切换） |
| 登录 | Cloudflare 控制台配置账号密码（Secret 变量 `ADMIN_CREDENTIALS`），分发给管理员使用；无 OAuth |
| 实时协同 | 一期不做；自动保存 + base_revision 冲突检测 |
| 运行时 | 单个 Worker：Hono API + 阅读页 SSR + Static Assets 托管前端产物 |
| 部署 | 纯网页控制台零代码部署：fork 仓库 → 控制台连 GitHub（Workers Builds）→ 建资源 → 配变量 → 自动构建上线，新手可独立完成 |

## 1. 总体架构

```
浏览器
  │ ① 匿名读者 GET /guide/intro
  ▼
Cloudflare Worker（唯一入口，Hono）
  ├─ /*           阅读页：D1 取已发布 Markdown → 服务端渲染 HTML（SEO）→ KV 页面缓存
  │               （文档路径直接映射到站点根路径，保留前缀除外）
  ├─ /api/*       JSON API：登录、文档 CRUD、版本、上传、搜索（全部鉴权）
  ├─ /sitemap.xml 从 D1 动态生成
  └─ 其余路径     → Static Assets（Vite 打包的 JS/CSS/字体，不占 CPU 配额）
  │
  ├─ D1  users / sessions / documents / revisions / FTS5 索引
  ├─ R2  图片与附件（MEDIA bucket）
  ├─ KV  已渲染页面缓存 + 发布后按路径精准失效
  └─ Cron  每日全量导出 Markdown 到 R2（内容不在 git 里，必须有备份退路）
```

要点：
- **发布 = 改一行数据库记录**，无任何构建环节。
- 阅读页**服务端渲染**出完整 HTML（标题、meta、正文都在首屏源码里），保证搜索引擎收录；客户端只做渐进增强（代码高亮、mermaid、目录滚动联动）。
- 未登录只能看到 `status = 'published'` 的内容；草稿仅登录后在 `/admin` 与预览路由可见。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 构建 | Vite + `@cloudflare/vite-plugin` | 一个命令同时构建 Worker 与前端；本地 dev 直接跑 workerd，D1/R2/KV 绑定真实可用 |
| 服务端 | Hono + TypeScript | 轻量、Workers 原生、中间件齐全 |
| 数据库 | Cloudflare D1 | SQLite；FTS5 全文检索；Time Travel ≈30 天时点恢复 |
| 缓存 | Workers KV | 存渲染好的 HTML；发布时按受影响路径删 key，失效逻辑确定性强 |
| 附件 | R2 | Worker 内 binding 直传直取，零出口流量费 |
| 编辑器 | Vditor | 三模式；自带代码高亮 / mermaid / 数学公式；粘贴图片钩子接 R2 上传 |
| 登录 | 控制台 Secret 配置的账号密码 | 凭据在 Workers 面板 Variables and Secrets 维护，改完即生效；session 存 D1，HttpOnly Cookie |

## 3. 数据模型（migrations/0001_init.sql）

```sql
-- 预留：未来升级为独立账号体系时启用；当前登录凭据来自环境 Secret，不查库
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'editor',   -- admin | editor
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,           -- SHA-256(session token)，库中不存明文
  name TEXT NOT NULL,                    -- 登录名，对应 ADMIN_CREDENTIALS 条目；吊销某管理员 = 删其会话行
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,             -- 'guide/intro'，即目录树位置 = URL 路径
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | published
  content_md TEXT NOT NULL DEFAULT '',
  current_revision_id INTEGER,
  updated_by TEXT,                       -- 操作人登录名
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE revisions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,
  author_name TEXT NOT NULL,             -- 操作人登录名
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_revisions_doc ON revisions(document_id, created_at DESC);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  r2_key TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 全文搜索（外部内容表 + 触发器同步）
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, body, content='', content_rowid='id', tokenize='unicode61'
);
-- 触发器在 documents 发布内容变化时同步 documents_fts（仅收录 published）
```

说明：
- 目录树由 `path` 字段天然构成（`guide/` 为父节点，靠前缀查询展开），一期不需要单独的树表。
- 版本历史只在「发布」动作时写入 revisions；草稿自动保存不产生版本噪音。

## 4. 关键流程

### 4.1 认证（控制台变量账号密码）

凭据完全在 Cloudflare 控制台维护（Workers & Pages → 该 Worker → Settings → Variables and Secrets），不进代码、不进 git：

- 配置 **Secret** 类型变量 `ADMIN_CREDENTIALS`，值为 JSON 数组，一条即一个管理员账号，可随时增删：

  ```json
  [
    { "name": "alice", "password": "…" },
    { "name": "bob",   "password": "…" }
  ]
  ```

- 为降低新手配置出错率，Secret 值支持两种等价格式：每行一条的 `name:password` 纯文本（推荐给新手），或 JSON 数组；解析器两者通吃。
- 每人一条独立 name，日志/revision 的 author 字段可区分操作人；移除某人 = 删该条目 + `DELETE FROM sessions WHERE name=?`，立即生效。修改 Secret 保存后自动出新版本，无需重新部署。
- 登录：`POST /api/auth/login { name, password }`
  1. Rate Limiting binding 限流（约 10 次/分钟/IP），可选再挂 Turnstile；
  2. 用 `crypto.subtle.timingSafeEqual` 常量时间比较密码，防时序侧信道；
  3. 通过 → 生成随机 token → SHA-256 存 sessions → 下发 HttpOnly + Secure + SameSite=Lax Cookie（14 天）。
- 角色：能登录即 editor；`ADMIN_CREDENTIALS` 中第一个条目视为 admin（负责删除文档、改站点配置等危险操作）。
- 加固可选项：Secret 中存 `pbkdf2$迭代$salt$hash`（本地一条命令生成），Worker 端 WebCrypto 重算比对，控制台里看不到明文。
- 已知取舍（已接受）：共享凭据无个人最小权限与完整审计；users 表保留为预留，将来升级独立账号/OAuth 时表结构不动。

### 4.2 阅读（公开）

`GET /{path}`（文档路径直接映射到站点根路径；旧 `/docs/{path}` 链接 301 跳转）
→ 查 KV 缓存 `html:{path}`，命中直接返回（带 ETag）；
→ 未命中：D1 取 published 文档 → markdown-it 渲染（`html:false`，原始 HTML 一律转义，从根上规避 XSS，无需额外 sanitizer）→ 组装含 `<title>/meta description/canonical/OG 标签` 的完整 HTML → 写 KV → 返回。

### 4.3 编辑与发布

- 编辑器每 ~2 秒防抖自动保存草稿：`PUT /api/docs/:id { base_revision_id, content_md }`。
- 若服务器上的 `updated_revision > base_revision_id` → 返回 409，前端弹出双人对比（jsdiff），手动合并——最简可靠的防覆盖机制。
- 「发布」：事务内插入 revision + 更新 documents + 删 KV 中受影响缓存键（本页 + 含目录侧边栏的所有上级页面 + sitemap）。

### 4.4 上传

编辑器粘贴/拖拽 → `POST /api/upload`（限 editor 及以上，限类型白名单 image/*，单文件 ≤10MB）→ R2 → 返回 `/f/{key}`；Worker 流式回源 R2 并加长缓存头。

### 4.5 备份（Cron Trigger，每日）

遍历 documents/revisions 导出为单个 JSON + 按 path 还原的 `.md` 目录 zip，存入 R2 `backups/YYYY-MM-DD/`。配合 D1 Time Travel 双保险。

### 4.6 自动迁移与启动自检（零代码部署的前提）

- **自动迁移**：建表 SQL 内嵌在 Worker 代码中，按 `PRAGMA user_version` 判断版本、幂等执行；Worker 处理首个请求时自动完成建表升级。彻底去掉 `wrangler d1 migrations apply` 命令行步骤。
- **`/setup` 自检页**：未登录可访问（仅显示状态，不含敏感信息），逐项检查并给出控制台操作路径：D1 可达性与迁移版本、`ADMIN_CREDENTIALS` 是否已配置且格式合法、R2 绑定与桶是否存在、KV 绑定（可选）状态。缺什么补什么，配好后自动消失。
- **优雅降级**：任一绑定缺失时进入引导态而非抛异常；KV 未绑定则页面缓存自动退化为 Cache API 短 TTL 方案。

## 5. 安全清单

- [ ] 所有 `/api/*`（除 `/api/auth/login`）经 session 中间件；admin/editor 角色校验。
- [ ] Markdown 渲染 `html:false`；外链统一补 `rel="noopener noreferrer"`。
- [ ] 登录回调与上传接口挂 Workers Rate Limiting binding。
- [ ] Cookie：HttpOnly + Secure + SameSite=Lax；session 有效期 14 天，登出删除行。
- [ ] 响应头：CSP（script-src 自身）、X-Content-Type-Options、Referrer-Policy。
- [ ] `ADMIN_CREDENTIALS` 等敏感值只用 Secret 类型（控制台面板或 `wrangler secret put`），绝不写入 wrangler.jsonc `vars` 或仓库。
- [ ] 公开面最小化：`/admin` 与所有 API 不出现在 sitemap/robots 允许范围。

## 6. 里程碑

### M0 · 脚手架（半天～一天）
pnpm 项目 + Vite/CF 插件 + Hono 入口 + wrangler 配置模板与**构建变量注入脚本** + 内嵌自动迁移 + `/setup` 自检页骨架 + Workers Builds 流水线（push 即部署）+ 本地迁移跑通 + 部署到 workers.dev 验证。

### M1 · MVP 可上线（核心，约一周业余时间）
控制台 Secret 配置管理员账号（限流 + 常量时间比较）→ 文档 CRUD（树形侧栏、新建/改名/移动 path）→ Vditor 编辑 + 自动保存 → 服务端渲染阅读页 → R2 图片上传 → 手动发布按钮。

### M2 · 体验完善
版本历史列表 + diff + 回滚 → 冲突检测 UI → FTS5 搜索框 → KV 缓存与发布失效 → Turnstile/限流 → sitemap.xml、RSS。

### M3 · 增强（按需）
每日 Cron 备份、评论（可用 giscus 免后端）、分享草稿链接、阅读统计（Workers Analytics Engine）、Yjs + Durable Objects 实时协同（预留：documents 表不动，DO 只做会话通道）。

## 7. 成本预估

小流量产品文档（日均 <10 万请求）：免费额度基本覆盖。建议开 **Workers Paid（$5/月）**：解除 10ms CPU 限制（Markdown 渲染 + 高亮更从容）、更高 D1/KB 配额。R2 免费档 10GB 对纯图床绰绰有余。

## 8. 待办风险提示

- Vditor 所见即所得模式与 Markdown 互转存在少量语法损耗（如复杂表格嵌套），上线前用真实文档过一遍；必要时默认锁定「即时渲染」模式。
- 代码高亮若在服务端做会推高 CPU；方案为首屏输出纯 `<pre><code>`（SEO 无损），客户端 Vditor.staticRender 渐进增强。
- KV 最终一致（约 60 秒传播）：发布后个别边缘节点短暂返回旧页，属可接受；不能接受则改用 DO 版本号做软失效。

## 9. 附录：Cloudflare 服务清单与用量归属

### 核心（4 个）

| 服务 | 本项目用途 | 包含的子能力 | 免费额度关注点 |
|---|---|---|---|
| Workers | 全部计算：API、SSR、定时任务 | Static Assets（前端托管）、Cron Triggers（每日备份）、Secrets（ADMIN_CREDENTIALS）、Rate Limiting binding（登录限流） | 免费 10 万请求/天、10ms CPU/请求；Paid $5/月放宽至默认 30s CPU |
| D1 | 文档/版本/会话/FTS5 索引 | Time Travel ≈30 天时点恢复 | 免费 5GB 存储 + 每日行读写配额，小站充裕 |
| R2 | 图片附件 + 备份包存储 | — | 免费 10GB 存储；出口流量永久免费 |
| KV（可选） | 已渲染 HTML 页面缓存 | 未绑定时自动降级为 Cache API 短 TTL 缓存 | 读 10 万次/天充足；**写仅 1k 次/天**，只用于发布失效与缓存回填，勿挪作高频写 |

注：Static Assets 的静态资源请求免费且不限量，不计入 Workers 请求配额——文档站流量大头（JS/CSS）实际零成本。

### 可选

- Turnstile：登录人机验证码，免费无限量（M2 接入）。
- 自定义域名：需一个接入 CF 的 DNS zone（免费）；注册商不限。
- Workers 日志/观测：面板开关，免费。

### 明确不使用

Pages（由 Workers Static Assets 取代）、Zero Trust/Access（登录已改自建）、Durable Objects（一期无实时协同，M3 预留）、Queues / Workflows / Vectorize / Hyperdrive / Workers AI（场景用不上）。

## 10. 零代码部署指南（面向新手，全程浏览器操作）

原理：D1/KV 绑定需要资源 ID，官方默认要求写进仓库配置文件。本项目改为「构建变量注入」——ID 只出现在控制台的 Build Variables 输入框里，仓库中的 `wrangler.jsonc` 是带占位符的模板，构建脚本在部署前用环境变量生成最终配置并替换。因此用户不需要改任何代码、不需要装任何本地工具。

### 新手操作步骤

1. **Fork** 项目仓库到自己的 GitHub 账号。
2. 控制台 → 存储和数据库 → **D1** → 创建数据库（名字随意）→ 复制数据库 ID（UUID）。可选：创建 KV 命名空间并复制 ID；创建 R2 存储桶（使用文档默认名即可）。
3. Workers 和 Pages → 创建 → **导入 Git 仓库** → 选择 fork 的仓库，授权 GitHub App。框架预设自动识别为 Vite，构建命令保持默认。
4. 构建设置中添加 Build Variables：必填 `D1_DATABASE_ID`；可选 `KV_NAMESPACE_ID`、`R2_BUCKET_NAME`。
5. 部署完成后进入 Worker 设置 → 变量和机密 → 添加 **Secret** `ADMIN_CREDENTIALS`（每行一个 `name:password`，或 JSON 数组）。
6. 访问 `/setup` 自检页确认全部 ✅，然后用配置的账号登录开始使用。

之后每次 push 到 main 分支自动构建部署（Workers Builds 免费档含每月构建分钟数）；改管理员密码 = 改 Secret 即时生效；绑定自定义域名在 Worker 设置里点选即可。

### 项目侧支撑清单（开发时必须实现）

- [ ] wrangler 配置模板 + 占位符替换脚本（KV/R2 变量缺省时对应绑定块整体不生成）。
- [ ] 内嵌迁移 runner（PRAGMA user_version，幂等，首个请求触发）。
- [ ] `/setup` 自检页 + 全局优雅降级（任何资源缺失进引导态）。
- [ ] README 截图级部署手册，与上述六步一一对应。
