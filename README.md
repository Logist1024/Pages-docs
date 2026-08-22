# pages-docs · 基于 Cloudflare Workers 的在线编辑文档站

对外产品文档站：**匿名访客可阅读（SSR + SEO），登录后的团队成员可在线编辑**。
内容存数据库、请求时渲染，没有 git 提交 → 构建流水线；「发布」只是改一行数据库记录。

- **编辑器**：Vditor（源码 / 即时渲染 / 所见即所得三模式），2 秒防抖自动保存 + 冲突检测；
  编辑区 / 预览区分屏比例可拖拽调整并记忆
- **发布按钮智能显隐**：已发布文档只有在草稿与线上快照**真的有差异**时才显示「更新发布」，
  未改动时不打扰；「更新发布」成功后按钮自动隐藏
- **版本历史可管理**：可删除单条旧版本、一键清空全部历史（当前发布快照受保护，需先更新或下线）
- **站点设置**：后台可改站点名称、首页地址、顶部导航栏（居右加粗，搜索框居左），还能上传
  **浏览器标签页图标（favicon）**与**界面 LOGO**、配置**页眉公告栏**与**全站页脚**
  （均支持内联 HTML——加粗 / 链接 / 代码等，脚本类内容自动过滤；公告访客可关闭并被记住）
- **深色 / 浅色模式**：阅读站与管理后台均支持跟随系统 + 手动切换；
  阅读站选择写入 Cookie（SSR 直出对应主题、无闪烁），后台选择存 localStorage。
  阅读页增强脚本以 ES Module 加载（type="module"），页面缓存键带版本号，
  SSR 结构升级时旧缓存自动失联
- **用量看板**：管理后台内置 Cloudflare 免费额度可视化（D1 存储 / R2 容量 / KV 键数 /
  Workers 请求数参考值），含近 30 天版本发布柱状图与占用明细
- **目录与文档**：目录和文档都支持随时改名与改路径（移动目录会级联搬移其下全部内容）；
  后台侧栏宽度也可拖拽调节并记忆
- **存储**：D1（文档 / 版本 / 会话 / FTS5 全文索引）+ R2（图片附件、每日备份）+ KV（页面缓存，可选）
- **运行时**：单个 Worker = Hono API + 阅读页 SSR + Static Assets 托管前端产物
- **部署**：纯网页控制台零代码部署，fork 仓库即可上线（见下文六步）

---

## 目录

1. [零代码部署（新手向，全程浏览器操作）](#零代码部署)
2. [登录与账号管理](#登录与账号管理)
3. [本地开发](#本地开发)
4. [架构与目录](#架构与目录)
5. [数据与缓存语义](#数据与缓存语义)
6. [备份与恢复](#备份与恢复)
7. [安全清单](#安全清单)
8. [常见问题](#常见问题)

> 部署后想逐项验收？见 **[TESTING.md](TESTING.md)** · Cloudflare 真机部署与验收测试指南。

---

## 零代码部署

原理：D1/KV/R2 绑定需要资源 ID。本项目把 ID 放在**控制台的 Build Variables** 里，
仓库中的 `wrangler.jsonc` 只是带占位符的模板，构建脚本（`scripts/inject-wrangler.mjs`）
会在部署前用环境变量生成最终配置——**你不需要改任何代码、不需要装任何本地工具**。

> ⚠️ **请勿使用「直接上传」入口**：本项目是 Worker（带服务端 API 与 SSR），
> 不是纯静态站。Pages「直接上传」只能托管静态文件，传上去也没有后端可用；
> 且若误传整个项目目录（含 node_modules）会触发「超过 1000 个文件上限」报错。
> 请按下面六步走「**导入 Git 仓库**」，构建在 Cloudflare 云端完成，无需上传文件。
> 熟悉命令行的也可本地 `pnpm build && pnpm deploy`（见[本地开发](#本地开发)）。

### 六步上线

**① Fork 本仓库**到你自己的 GitHub 账号。

**② 创建资源并复制 ID**（控制台 → 存储和数据库）：

| 资源 | 是否必填 | 操作 |
|---|---|---|
| D1 数据库 | **必填** | 创建数据库（名字随意，如 `pages-docs`）→ 复制**数据库 ID**（UUID） |
| KV 命名空间 | 可选 | 创建命名空间（如 `pages-docs-cache`）→ 复制 ID。不建则页面缓存退化为 Cache API 短 TTL |
| R2 存储桶 | 可选 | 创建桶（如 `pages-docs-media`）。不建则图片上传不可用，其余功能正常 |

**③ 创建 Worker**：控制台 → Workers 和 Pages → 创建 → **导入 Git 仓库** → 选 fork 的仓库，
授权 GitHub App。框架预设自动识别为 Vite，构建命令保持默认（`pnpm run build`）。

**④ 配置 Build Variables**（构建设置 → Variables）：

| 变量名 | 必填 | 值 |
|---|---|---|
| `D1_DATABASE_ID` | ✅ | ② 中复制的 D1 数据库 ID |
| `KV_NAMESPACE_ID` | 可选 | ② 中复制的 KV 命名空间 ID |
| `R2_BUCKET_NAME` | 可选 | ② 中创建的 R2 桶名 |

保存后点部署。每次 push 到 main 分支会自动构建部署。

**⑤ 配置管理员**：部署完成后进入该 Worker → 设置（Settings）→ 变量和机密（Variables and Secrets）
→ 添加 **Secret** 类型变量 `ADMIN_CREDENTIALS`，两种格式任选：

```text
alice:your-strong-password
bob:another-password
```

或 JSON 数组（密码可含冒号等任意字符）：

```json
[{"name":"alice","password":"your-strong-password"},{"name":"bob","password":"another-password"}]
```

- 数组**第一条是 admin**（可删除文档、吊销会话），其余为 editor。
- 保存即时生效，无需重新部署。
- 移除某人 = 删掉对应行（其已有会话可在 /admin 会话管理里吊销，或执行
  `DELETE FROM sessions WHERE name='某人'`）。
- 进阶：不想在控制台留明文，可本地执行 `pnpm hash-password` 生成
  `pbkdf2$迭代$salt$hash`，把它填进 password 字段。

可选变量（同面板，普通变量即可）：`SITE_NAME`（站点名）、`SITE_URL`（自定义域名，
用于 sitemap/canonical；不填自动取请求域名）。

**⑥ 自检**：访问 `https://<你的-worker-域名>/setup`，逐项确认 ✅
（缺什么补什么，配好后自动全绿），然后用配置的账号登录 `/admin` 开始使用。

### 自定义域名

Worker → 设置 → 域和路由 → 添加自定义域（域名需已接入同一 Cloudflare 账号的 DNS）。

---

## 登录与账号管理

- 登录入口：`/admin`（或任意阅读页右上角「登录」）。
- 会话存 D1（只存 token 的 SHA-256），Cookie 为 HttpOnly + Secure + SameSite=Lax，14 天有效。
- 登录接口挂 Workers Rate Limiting binding（10 次/分钟/IP），密码比较为常量时间。
- admin 登录后可在右上「更多 → 会话管理」查看/吊销所有会话。

## 本地开发

```bash
pnpm install
cp .dev.vars.example .dev.vars   # 本地管理员账号（已被 gitignore）
pnpm dev                         # http://localhost:5173
```

- 本地 dev 由 workerd 驱动，D1/R2/KV 全部是本地模拟器，**无需任何真实资源 ID**，
  `wrangler.jsonc` 里的占位符不影响。
- 本地管理员在 `.dev.vars` 里配置，格式与线上 Secret 相同。
- 常用命令：

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 本地开发（Vite + workerd，热更新） |
| `pnpm check` | TypeScript 严格类型检查 |
| `pnpm test` | 单元测试（vitest） |
| `pnpm build` | 注入构建变量 + 打包（Workers Builds 使用） |
| `pnpm deploy` | 本地构建并部署（需要 wrangler 登录与真实资源 ID） |
| `pnpm hash-password` | 生成 PBKDF2 口令哈希 |

> 注意：`wrangler.jsonc` 在部署时会被注入脚本改写（写入真实资源 ID）。
> 请不要把注入后的文件提交回仓库——仓库里应始终保留 `__D1_DATABASE_ID__` 占位符。

## 架构与目录

```
浏览器
  │ ① 匿名读者 GET /docs/guide/intro
  ▼
Cloudflare Worker（唯一入口，Hono）
  ├─ /docs/*      阅读页：D1 取已发布快照 → 服务端渲染完整 HTML → KV/Cache API 缓存
  ├─ /api/*       JSON API：登录、站点设置、文档 CRUD、版本、上传、搜索（除登录与设置读取外全部鉴权）
  ├─ /search      公开搜索页（FTS5）
  ├─ /sitemap.xml /robots.txt /feed.xml
  ├─ /setup       环境自检页（未登录可访问，仅显示状态）
  └─ 其余路径     → Static Assets（Vite 打包的 JS/CSS，免费且不占请求配额）

D1  documents / revisions / sessions / attachments / documents_fts(FTS5)
R2  MEDIA：图片附件 + backups/YYYY-MM-DD/ 每日备份
KV  PAGE_CACHE：已渲染 HTML（未绑定自动降级 Cache API）
Cron 每日 03:00 UTC 全量备份到 R2
```

```
src/
├── server/            # Worker 端（Hono）
│   ├── index.ts       # 入口：路由装配 + 安全头 + scheduled 备份
│   ├── env.ts         # 绑定类型（DB/ASSETS 必需；PAGE_CACHE/MEDIA/限流可选）
│   ├── db/migrations.ts  # 内嵌建表 SQL（FTS5 + 触发器）
│   ├── db/migrate.ts  # 自动迁移：PRAGMA user_version（退化 _migrations 表），首个请求幂等执行
│   ├── auth.ts        # ADMIN_CREDENTIALS 解析（JSON/行格式/pbkdf2）、常量时间比较、会话
│   ├── cache.ts       # KV 页面缓存 + Cache API 降级 + 发布失效
│   ├── markdown.ts    # markdown-it（html:false）+ 锚点/TOC + 摘要 + FTS 转义
│   ├── tree.ts        # path → 目录树
│   ├── layout.ts      # SSR 页面骨架（meta/canonical/OG）
│   ├── zip.ts         # 零依赖 ZIP（备份用）
│   ├── backup.ts      # Cron 备份 + 30 天保留滚动清理
│   └── routes/        # setup / auth / documents / revisions / settings / usage / upload+media / search+admin / pages
├── client/
│   ├── admin/         # 管理端 SPA（原生 TS + Vditor）
│   └── read/          # 阅读页渐进增强（高亮 / mermaid / 复制 / TOC 联动）
├── shared/types.ts    # 前后端共享 API 契约
scripts/
├── inject-wrangler.mjs  # 构建变量注入（零代码部署的关键）
└── hash-password.mjs    # PBKDF2 口令哈希生成
```

## 数据与缓存语义

- **草稿与发布**：`documents.content_md` 是工作副本（自动保存写这里）；
  读者看到的是 `current_revision_id` 指向的**发布快照**（`revisions.content_md`）。
  「发布」= 事务内插入新快照 + 更新指针 + 失效缓存；「取消发布」下线回草稿。
- **版本历史**：只在发布/回滚时写入 `revisions`，草稿自动保存不产生版本噪音；
  `revision_seq` 单调递增，用于自动保存的 `base_revision_seq` 冲突检测（409 → jsdiff 对比合并）。
  历史可清理：admin 可删除单条旧版本或一键清空；**当前发布快照不可删**
  （返回 409 提示先「更新发布」或「取消发布」），保证读者看到的版本始终完整。
- **主题与缓存**：阅读站主题由 `pd-theme` Cookie 决定（light / dark / 未设置 = 跟随系统）。
  带 Cookie 的请求**绕过 KV/Cache API 缓存**走 live 渲染（缓存键不含主题，避免串色），
  匿名无 Cookie 请求照常命中缓存。
- **全文搜索**：FTS5 外部内容表 + 触发器同步，仅收录已发布快照。
  分词器 unicode61 对中文按字/词切分有限，长句搜索建议用更短的关键词。
- **缓存**：匿名阅读页进 KV（`html:{path}`，发布时精准失效，ETag/304 支持）；
  KV 未绑定自动退化为 Cache API（60s TTL）。登录用户的请求永远 live 渲染、不缓存，
  且已发布页若有未发布修改会默认预览草稿（可 `?view=published` 看线上版）。
- **自动迁移**：建表 SQL 内嵌在 Worker 里，按 `PRAGMA user_version` 判断版本，
  处理首个请求时幂等执行；不需要 `wrangler d1 migrations apply`。

## 备份与恢复

- Cron Trigger 每日 03:00 UTC 自动执行：`backups/YYYY-MM-DD/backup.json`（全量数据）
  与 `backup.zip`（manifest + 按 path 还原的 `docs/<path>.md`）存入 R2，滚动保留 30 天。
- 手动触发：Cloudflare 控制台该 Worker → Cron Triggers → 对应任务 → Run。
- 双保险：D1 自带 Time Travel（约 30 天内任意时点恢复，控制台操作）。
- 恢复：解开 zip 得到全部 `.md` 与 `backup.json`；可在 /admin 重建，或用
  `wrangler d1 execute` 从 backup.json 批量回灌。

## 安全清单

- [x] 所有 `/api/*`（除 `/api/auth/login`）经 session 中间件；删除文档/会话管理需 admin 角色
- [x] Markdown 渲染 `html:false`，原始 HTML 一律转义；外链统一 `rel="noopener noreferrer"`
- [x] 登录接口挂 Rate Limiting binding；常量时间口令比较；支持 PBKDF2 哈希存储
- [x] Cookie：HttpOnly + Secure + SameSite=Lax；登出/吊销删除会话行
- [x] 变更类 API 增加 Origin 同源校验（CSRF 兜底）
- [x] 响应头：CSP（script-src 'self'）、X-Content-Type-Options、Referrer-Policy
- [x] `/f/*` 附件：图片类型白名单、≤10MB；SVG 以 CSP sandbox 方式渲染防脚本
- [x] `ADMIN_CREDENTIALS` 只用 Secret 类型，绝不写入 wrangler.jsonc / 仓库
- [x] `/admin`、`/api` 不出现在 sitemap/robots 允许范围

## 常见问题

**部署报「上传的文件超过了 1000 个文件上限」？**
你走的是 Pages「直接上传」入口。本项目是 Worker，请改用「导入 Git 仓库」方式
（见上文六步）；构建产物本身只有约 103 个文件，远低于上限。切勿上传 node_modules。

**部署报 `database_id` 不是合法 UUID？**
Build Variables 里的 `D1_DATABASE_ID` 没配或填错。控制台 → D1 → 你的数据库 → 复制 ID。

**/setup 提示 ADMIN_CREDENTIALS 未配置？**
Worker → 设置 → 变量和机密 → 添加的是 **Secret** 类型（不是普通文本变量），名字必须是 `ADMIN_CREDENTIALS`。

**改了 Secret 什么时候生效？**
保存即生效（Secret 保存会生成新版本），无需重新部署。已有会话不受影响，可用会话管理吊销。

**发布后个别访客短暂看到旧页面？**
KV 最终一致（约 60 秒传播），属可接受；不能接受可在控制台绑定 KV 并确认发布失效日志，
或把阅读页 `Cache-Control` 调短。

**中文搜索不准？**
FTS5 unicode61 对中文分词有限。已按词双引号包裹防注入；建议使用 2~4 字关键词。
后续可换 jieba 分词或 trigram tokenizer。

**Vditor 所见即所得模式丢格式？**
复杂表格/嵌套语法在 WYSIWYG 与 Markdown 互转时可能有少量损耗；重要文档建议用「即时渲染」模式。
