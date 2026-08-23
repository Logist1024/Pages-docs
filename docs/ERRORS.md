# pages-docs · 错误码对照手册

> 目的：**看到一串代码就能定位问题在哪一层、该找谁、怎么办**——不需要复现、不需要猜。
> 适用范围：`/api/*` 全部接口 + 管理后台客户端网络层。配合 `TESTING.md` 的排错速查使用。

---

## 1. 错误响应契约

服务端所有 JSON 错误响应统一为：

```json
{ "error": "给人看的中文文案", "code": "稳定错误码" }
```

- `error`：展示给用户的文案，措辞可随版本优化，**不保证稳定**；
- `code`：机器可读的稳定标识，**语义永不改变**，用于检索本文档与 Worker 日志。

两个例外形态：

| 形态 | 说明 |
|---|---|
| `409 DOC_CONFLICT`（保存冲突） | 载荷是结构化的 `{ error:"conflict", message, current:{...快照}, code:"DOC_CONFLICT" }`，客户端据此弹出冲突合并对话框 |
| 非 API 路径 | 页面类 404/500 返回 HTML 或纯文本，不带 code |

**管理后台的 toast 会把 code 附在文案末尾**，例如：

```
保存失败：保存未能生效，请重试 [DOC_SAVE_NOT_APPLIED]
```

用户报告问题时，让TA复制方括号里的代码即可。

## 2. 三步定位法

1. **拿到代码**：toast 方括号里，或浏览器 F12 → Network → 失败请求 → Response 的 `"code"` 字段；
2. **查下表**：按代码找到「含义 / 常见原因 / 处理办法」；
3. **需要深挖时**：Cloudflare 控制台 → 该 Worker → 日志（Logs）。服务端日志中：
   - 未捕获异常会以 `[pages-docs] [SYS_INTERNAL] <方法> <路径>: <堆栈>` 输出；
   - 条件更新自愈失败会输出 `[pages-docs] 条件更新两次未命中…`（对应 `DOC_SAVE_NOT_APPLIED`）。

快速分层判断：

| 现象 | 结论 |
|---|---|
| toast 带 `[NET_FAILED]` | 请求没发出去：断网 / DNS / 浏览器扩展拦截 |
| toast 带 `[NET_BAD_RESPONSE]` | 到了边缘但 Worker 没返回 JSON：Worker 崩溃（1101）或网关错误页 |
| toast 带 `[NET_HTTP]` 且 HTTP 5xx | 服务端报错但响应不是标准格式，查日志 |
| 其他 `[XXX_YYY]` | 直接查表，原因与处理都在表内 |

## 3. 错误码总表

### 系统 / 通用

| 代码 | HTTP | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `SYS_INTERNAL` | 500 | 服务器内部错误 | Worker 抛出未捕获异常；D1/KV/R2 平台故障 | 查 Worker 日志中的堆栈；偶发可重试，持续出现按堆栈定位 |
| `SYS_NOT_FOUND` | 404 | 接口不存在 | URL 拼错；请求了已下线的接口；前端版本与服务端不一致 | 核对路径；强刷新（Ctrl+F5）更新前端产物 |
| `REQ_BAD_JSON` | 400 | 请求体必须是 JSON | 客户端发送了非 JSON 体 | 重试；持续出现为前端 bug |
| `REQ_BAD_BODY` | 400 | 请求体结构不对 | JSON 合法但不是预期对象 | 同上 |
| `REQ_BAD_PARAM` | 400 | 参数不合法 | id / token_hash 等格式非法 | 检查调用参数；多为前端 bug |
| `CSRF_BLOCKED` | 403 | 跨站请求被拒绝 | 从第三方页面发起的变更请求（CSRF 防护生效） | 正常防护行为；在本站内操作即可 |
| `ORIGIN_INVALID` | 403 | Origin 头无法解析 | 代理/网关注入了畸形 Origin | 检查中间层配置 |
| `REQ_RESERVED_PATH` | 409 | 系统保留路径不能使用 | 新建/移动文档或目录到 `docs`、`admin`、`api`、`assets`、`f`、`icon` 或固定页面（如 `search`）上 | 换一个路径；这些前缀被站点功能占用，创建后也无法访问 |

### 认证与会话

| 代码 | HTTP | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `AUTH_REQUIRED` | 401 | 未登录或会话过期 | Cookie 丢失/清除；14 天会话到期；会话被 admin 吊销 | 重新登录 `/admin` |
| `AUTH_FORBIDDEN` | 403 | 需要 admin 角色 | editor 账号执行删除文档/清历史/会话管理/用量看板等 | 让 admin 操作，或在 `ADMIN_CREDENTIALS` 中调整角色（第一条才是 admin） |
| `AUTH_LOGIN_FAILED` | 401 | 用户名或密码错误 | 凭据输错；`ADMIN_CREDENTIALS` 配置与预期不符 | 核对 Secret 内容（每行 `name:password`）；注意别带空格/引号 |
| `AUTH_MISSING_FIELDS` | 400 | 登录信息不完整 | 表单提交了空字段 | 填全后重试 |
| `AUTH_RATE_LIMITED` | 429 | 登录限流 | 1 分钟内失败约 10 次 | 等 60 秒再试 |
| `DB_NOT_CONFIGURED` | 503 | 数据库未配置 | D1 绑定缺失（引导态） | 访问 `/setup` 按提示补齐绑定 |

### 文档

| 代码 | HTTP | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `DOC_NOT_FOUND` | 404 | 文档不存在 | 已被删除；id 错误 | 刷新文档列表 |
| `DOC_MISSING_BASE_SEQ` | 400 | 缺少 base_revision_seq | 前端未带版本号字段 | 前端 bug，附代码上报 |
| `DOC_INVALID_TITLE` | 400 | 标题为空或超 200 字 | 输入校验 | 改标题 |
| `DOC_CONTENT_TOO_LARGE` | 400 | 正文超 512KB | 单篇内容过大 | 拆分文档或压缩图片外链 |
| `DOC_INVALID_PATH` | 400 | path 格式不合法 | 含大写/中文/特殊字符 | 只用小写字母/数字/-/_，用 / 分层 |
| `DOC_PATH_TAKEN` | 409 | path 已存在 | 新建/移动时撞路径 | 换一个路径 |
| `DOC_NO_FIELDS` | 400 | 无可更新字段 | 请求体没带任何变更项 | 前端 bug，附代码上报 |
| `DOC_CONFLICT` | 409 | **保存冲突（乐观锁）** | 他人（或另一标签页）在你之后保存过新版本 | 按冲突对话框选择「采用服务器版本」或「保留我的版本/合并」。这是正常的数据保护机制，不是故障 |
| `DOC_SAVE_NOT_APPLIED` | 503 | 保存未能生效 | 服务端条件更新两次都未命中且版本号未被推进（数据层异常） | 先重试一次；反复出现→查 Worker 日志「条件更新两次未命中」，并到控制台检查 D1 状态。**此码出现说明乐观锁自愈已尝试过，务必上报** |

### 版本历史

| 代码 | HTTP | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `REV_NOT_FOUND` | 404 | 版本不存在 | 已被删除/清空；回滚目标失效 | 刷新历史列表 |
| `REV_SNAPSHOT_PROTECTED` | 409 | 当前发布快照不可删 | 保护机制：读者正在看的版本不能删 | 先「更新发布」生成新快照，或「取消发布」后再删 |

### 目录

| 代码 | HTTP | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `FOLDER_INVALID_PATH` | 400 | 目录路径不合法 | 格式不符 / 路径解析失败 | 只用小写字母/数字/-/_ |
| `FOLDER_NAME_INVALID` | 400 | 目录名称为空或超 100 字 | 输入校验 | 修改名称 |
| `FOLDER_PATH_DOC_TAKEN` | 409 | 路径已被文档占用 | 目录与文档同完整路径 | 换路径 |
| `FOLDER_EXISTS` | 409 | 目录已存在 | 重复创建 | 直接使用现有目录 |
| `FOLDER_NOT_EMPTY` | 409 | 目录内有文档 | 删除非空目录 | 先移出/删除其中文档 |
| `FOLDER_HAS_CHILDREN` | 409 | 目录下有子目录 | 删除含子目录的目录 | 先删除子目录 |
| `FOLDER_TARGET_DOC_TAKEN` | 409 | 移动目标被文档占用 | 目标位置已有同名文档 | 换目标路径 |
| `FOLDER_TARGET_FOLDER_TAKEN` | 409 | 移动目标被其他目录占用 | 目标已有目录行（error 文案含具体目录名） | 换目标路径 |
| `FOLDER_MOVE_INTO_SELF` | 400 | 不能移进自身 | 把目录移到自己的子路径下 | 选择其他目标 |

### 目录与文档排序

| 代码 | HTTP | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `TREE_ORDER_INVALID` | 400 | 排序请求不合法 | 条目不属于该层级 / 路径或 id 非法 / 重复 / 超过 500 项（具体原因在 error 文案里） | 刷新后台页面重新加载列表后重试；持续出现附代码上报 |

### 上传与媒体

| 代码 | HTTP | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `MEDIA_NOT_CONFIGURED` | 503 | R2 未配置 | 未创建/未绑定 MEDIA 桶 | `/setup` 查看 R2 项提示；补建桶并配 `R2_BUCKET_NAME` 后重新部署 |
| `UPLOAD_BAD_FORM` | 400 | 不是 multipart 表单 | 前端 bug 或代理改写了请求 | 重试；持续出现附代码上报 |
| `UPLOAD_NO_FILE` | 400 | 缺少 file 字段 | 未选择文件即提交 | 选择文件后重试 |
| `UPLOAD_UNSUPPORTED_TYPE` | 415 | 图片类型不在白名单 | 上传了 png/jpg/webp/gif/avif/svg 之外的文件（error 文案含允许列表） | 转成支持的格式 |
| `UPLOAD_TOO_LARGE` | 413 | 超过 10MB | 文件太大 | 压缩后再传 |
| `UPLOAD_EMPTY` | 400 | 空文件 | 0 字节文件 | 检查来源文件 |

### 站点设置

| 代码 | HTTP | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `SETTINGS_INVALID` | 400 | 设置项校验失败 | 具体 reason 在 error 文案里（如「站点名称不能为空」「导航地址不合法」「图标超过 300KB」） | 按 error 文案修正对应输入框 |

### 客户端网络层（不来自服务端）

| 代码 | HTTP* | 含义 | 常见原因 | 处理办法 |
|---|---|---|---|---|
| `NET_FAILED` | — | fetch 本身失败 | 断网；DNS 故障；浏览器扩展拦截；证书问题 | 检查本地网络后重试 |
| `NET_BAD_RESPONSE` | — | 响应不是 JSON | Worker 运行时崩溃（1101 错误页）；Cloudflare 网关错误页；代理劫持 | 结合 HTTP 状态看；1101 查 Worker 日志 |
| `NET_HTTP` | — | 非 2xx 且无标准错误体 | 兜底代号，真实状态码在括号里 | 按状态码判断：401→重新登录；5xx→查日志 |

\* 客户端合成代码没有固定 HTTP 状态；真实状态码始终在 toast 的文字或 Network 面板中。

## 4. 高频排障场景速查

| 你看到的 | 大概率是 | 第一步动作 |
|---|---|---|
| `保存失败 … [DOC_CONFLICT]` 弹窗反复出现 | 双开标签页编辑同一篇；或前端版本号状态错乱 | 刷新页面重新打开该文档；仍复现→附 Network 里 PUT 请求的请求/响应体上报 |
| `保存失败 … [DOC_SAVE_NOT_APPLIED]` | 服务端数据层异常（罕见） | 立即手动备份编辑器内容（Ctrl+A 复制），查 Worker 日志，上报 |
| `打开文档失败 … [AUTH_REQUIRED]` | 会话过期 | 退出重登 |
| `[MEDIA_NOT_CONFIGURED]` | R2 没绑 | `/setup` → 补 R2 绑定 → 重新部署 |
| 登录一直 `[AUTH_LOGIN_FAILED]` | Secret 配置格式问题 | 检查 `ADMIN_CREDENTIALS` 是否每行 `name:password`、无多余引号 |
| 所有请求都 `[NET_FAILED]` | 本地网络 | 换网络/关闭代理插件 |

## 5. 维护规范（开发者）

1. **新增错误**：先在 `src/shared/errors.ts` 的 `ERROR_CODES` 登记（status + 默认中文文案），再到本手册对应域的表格加一行；调用处用 `return fail(c, "CODE")`，动态细节用第二参覆盖文案但**不改 code**。
2. **永不复用/改义旧代码**：语义变化就新增代码，旧的标注废弃。
3. **注册表有回归测试**（`src/shared/errors.test.ts`）守护：格式、HTTP 区间、文案非空、关键码存在性。改完跑 `pnpm check && pnpm test`。
4. 客户端新增本地错误时使用 `NET_` 前缀，通过 `new ApiError(status, msg, body, "NET_XXX")` 合成。

—— 完 ——
