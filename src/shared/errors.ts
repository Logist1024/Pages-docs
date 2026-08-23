/**
 * 全站统一错误码注册表（前后端共享契约）。
 *
 * 设计原则：
 * - 每个错误路径一个稳定代号（大写蛇形，按域前缀分组），永不改动语义；
 *   需要废弃时保留代号并在文档标注「已废弃」。
 * - 响应体统一为 `{ error: string; code: ErrorCode }`：`error` 是给人看的中文文案，
 *   可随版本优化措辞；`code` 是给机器/排障看的稳定标识，用于检索文档与本表。
 * - 409 保存冲突是结构化载荷（ConflictPayload），在其上附加同款 `code` 字段，
 *   原 `error: "conflict"` 字面量保持不变以兼容旧客户端判断。
 *
 * 新增错误时：先在本表登记（含默认中文文案与 HTTP 状态），再到 docs/ERRORS.md 补一行说明。
 */

export interface ErrorDef {
  /** 默认 HTTP 状态码 */
  readonly status: number;
  /** 默认中文文案（可被调用方覆盖为更具体的动态文案） */
  readonly message: string;
}

export const ERROR_CODES = {
  /* ---------------- 系统 / 通用 ---------------- */
  /** Worker 内部异常（全局 onError 兜底） */
  SYS_INTERNAL: { status: 500, message: "服务器内部错误" },
  /** 请求的 API 路径不存在 */
  SYS_NOT_FOUND: { status: 404, message: "接口不存在" },
  /** 请求体不是合法 JSON */
  REQ_BAD_JSON: { status: 400, message: "请求体必须是 JSON" },
  /** 请求体是合法 JSON 但不是预期的对象结构 */
  REQ_BAD_BODY: { status: 400, message: "请求体格式不正确" },
  /** 路由参数不合法（如 id / token_hash 格式错误） */
  REQ_BAD_PARAM: { status: 400, message: "参数不合法" },
  /** 变更请求的 Origin 与站点不同源（CSRF 兜底） */
  CSRF_BLOCKED: { status: 403, message: "跨站请求被拒绝" },
  /** Origin 头存在但无法解析 */
  ORIGIN_INVALID: { status: 403, message: "Origin 不合法" },

  /* ---------------- 认证与会话 ---------------- */
  /** 未登录或会话已过期 */
  AUTH_REQUIRED: { status: 401, message: "请先登录" },
  /** 已登录但角色权限不足（该操作仅限 admin） */
  AUTH_FORBIDDEN: { status: 403, message: "需要 admin 角色" },
  /** 登录失败：用户名不存在或密码错误 */
  AUTH_LOGIN_FAILED: { status: 401, message: "用户名或密码错误" },
  /** 登录请求缺少用户名或密码 */
  AUTH_MISSING_FIELDS: { status: 400, message: "请输入登录名和密码" },
  /** 登录触发限流（约 10 次/分钟/IP） */
  AUTH_RATE_LIMITED: { status: 429, message: "尝试过于频繁，请一分钟后再试" },
  /** D1 绑定缺失（引导态），访问 /setup 自检 */
  DB_NOT_CONFIGURED: { status: 503, message: "数据库未配置，请访问 /setup 查看自检" },

  /* ---------------- 文档 ---------------- */
  /** 文档 id 不存在（或已被删除） */
  DOC_NOT_FOUND: { status: 404, message: "文档不存在" },
  /** PUT 缺少 base_revision_seq 字段 */
  DOC_MISSING_BASE_SEQ: { status: 400, message: "缺少 base_revision_seq" },
  /** 标题为空或超过 200 字 */
  DOC_INVALID_TITLE: { status: 400, message: "标题必填且不超过 200 字" },
  /** 正文超过 512KB 上限 */
  DOC_CONTENT_TOO_LARGE: { status: 400, message: "内容超过 512KB 上限" },
  /** path 为空或格式不合法 */
  DOC_INVALID_PATH: { status: 400, message: "path 只允许小写字母/数字/-/_，用 / 分层" },
  /** 目标 path 已被其他文档占用 */
  DOC_PATH_TAKEN: { status: 409, message: "该 path 已存在" },
  /** 更新请求没有携带任何可变更字段 */
  DOC_NO_FIELDS: { status: 400, message: "没有需要更新的字段" },
  /**
   * 乐观锁冲突：服务器版本号比请求携带的 base_revision_seq 新。
   * 注意：此码挂在 ConflictPayload 结构上（error:"conflict" + current 快照），
   * 不是普通 { error, code } 形态。
   */
  DOC_CONFLICT: { status: 409, message: "保存冲突：文档已被他人修改" },
  /**
   * 条件更新两次都未命中且版本号未被推进——服务端已自愈重试仍失败。
   * 若反复出现，通常是 D1 数据层异常，需结合 Worker 日志排查。
   */
  DOC_SAVE_NOT_APPLIED: { status: 503, message: "保存未能生效，请重试" },

  /* ---------------- 版本历史 ---------------- */
  /** 版本 id 不存在 */
  REV_NOT_FOUND: { status: 404, message: "版本不存在" },
  /** 尝试删除当前发布快照（受保护，需先更新发布或取消发布） */
  REV_SNAPSHOT_PROTECTED: {
    status: 409,
    message: "该版本是当前发布的快照，请先「更新发布」或「取消发布」后再删除",
  },

  /* ---------------- 目录 ---------------- */
  /** 目录路径为空或格式不合法 */
  FOLDER_INVALID_PATH: { status: 400, message: "目录路径只允许小写字母/数字/-/_，用 / 分层" },
  /** 目录名称为空或超过 100 字 */
  FOLDER_NAME_INVALID: { status: 400, message: "目录名称不能为空且不超过 100 字" },
  /** 目录路径与某个文档完整路径相同 */
  FOLDER_PATH_DOC_TAKEN: { status: 409, message: "该路径已被文档占用" },
  /** 显式目录行已存在（重复创建） */
  FOLDER_EXISTS: { status: 409, message: "该目录已存在" },
  /** 目录内还有文档，不能删除 */
  FOLDER_NOT_EMPTY: { status: 409, message: "目录不为空：请先移出或删除其中的文档" },
  /** 目录下还有子目录，不能删除 */
  FOLDER_HAS_CHILDREN: { status: 409, message: "目录下还有子目录，请先删除它们" },
  /** 移动目标位置被文档占用 */
  FOLDER_TARGET_DOC_TAKEN: { status: 409, message: "目标路径已被文档占用" },
  /** 移动目标位置被其他目录占用 */
  FOLDER_TARGET_FOLDER_TAKEN: { status: 409, message: "目标路径已被目录占用" },
  /** 不能把目录移动到它自身内部 */
  FOLDER_MOVE_INTO_SELF: { status: 400, message: "不能把目录移动到它自身内部" },

  /* ---------------- 目录与文档排序 ---------------- */
  /** 排序请求不合法：父路径错误、条目不属于该层级、重复、超量等（具体原因见 error 文案） */
  TREE_ORDER_INVALID: { status: 400, message: "排序数据不合法" },

  /* ---------------- 上传与媒体 ---------------- */
  /** R2（MEDIA 绑定）未配置，上传/回源不可用 */
  MEDIA_NOT_CONFIGURED: { status: 503, message: "R2 未配置：请在控制台绑定 MEDIA 存储桶（见 /setup）" },
  /** 请求不是 multipart/form-data */
  UPLOAD_BAD_FORM: { status: 400, message: "请求必须是 multipart/form-data" },
  /** 表单里缺少 file 字段 */
  UPLOAD_NO_FILE: { status: 400, message: "缺少 file 字段" },
  /** 图片类型不在白名单（png/jpg/webp/gif/avif/svg） */
  UPLOAD_UNSUPPORTED_TYPE: { status: 415, message: "仅支持图片类型：png, jpg, webp, gif, avif, svg" },
  /** 单文件超过 10MB 上限 */
  UPLOAD_TOO_LARGE: { status: 413, message: "文件超过 10MB 上限" },
  /** 上传了 0 字节的空文件 */
  UPLOAD_EMPTY: { status: 400, message: "空文件" },

  /* ---------------- 站点设置 ---------------- */
  /** 设置项校验失败（具体原因见 error 文案） */
  SETTINGS_INVALID: { status: 400, message: "设置项校验失败" },

  /* ---------------- 客户端网络层（不来自服务端响应） ---------------- */
  /** fetch 本身抛异常：断网、DNS、连接被拒等 */
  NET_FAILED: { status: 0, message: "网络错误，请检查连接后重试" },
  /** 服务端返回了非 JSON / 无法解析的响应（如 Cloudflare 错误页、网关超时） */
  NET_BAD_RESPONSE: { status: 0, message: "服务端返回了无法解析的响应" },
  /** 非 2xx 且响应体不含 code 时的兜底代号（真实状态码在 ApiError.status） */
  NET_HTTP: { status: 0, message: "请求失败" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** 构造标准错误响应体（message 覆盖默认文案时 code 保持不变） */
export function errorBody(code: ErrorCode, message?: string): { error: string; code: ErrorCode } {
  return { error: message ?? ERROR_CODES[code].message, code };
}
