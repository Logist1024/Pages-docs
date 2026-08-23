/**
 * 服务端错误响应助手：`return fail(c, "DOC_NOT_FOUND")` 一行完成
 * 「查注册表 → 组装 { error, code } → 按 HTTP 状态返回」。
 * 动态文案（如带具体路径/数量的提示）通过第二参覆盖，code 保持稳定。
 */
import type { Context } from "hono";
import { errorBody, ERROR_CODES, type ErrorCode } from "../shared/errors";

export function fail(c: Context, code: ErrorCode, message?: string): Response {
  return c.json(errorBody(code, message), ERROR_CODES[code].status as Parameters<typeof c.json>[1]);
}
