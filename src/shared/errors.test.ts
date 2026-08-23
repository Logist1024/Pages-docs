import { describe, expect, it } from "vitest";
import { ERROR_CODES, errorBody, type ErrorCode } from "./errors";

// 错误码契约回归：注册表完整性 + 响应体形状（docs/ERRORS.md 依赖这些不变量）
describe("ERROR_CODES 注册表", () => {
  const entries = Object.entries(ERROR_CODES) as [ErrorCode, { status: number; message: string }][];

  it("所有代号全局唯一且为合法格式（大写蛇形 + 已知域前缀）", () => {
    const domains = ["SYS_", "REQ_", "CSRF_", "ORIGIN_", "AUTH_", "DB_", "DOC_", "REV_", "FOLDER_", "TREE_", "MEDIA_", "UPLOAD_", "SETTINGS_", "NET_"];
    for (const [code] of entries) {
      expect(/^[A-Z][A-Z0-9_]*$/.test(code)).toBe(true);
      expect(domains.some((d) => code.startsWith(d))).toBe(true);
    }
  });

  it("服务端错误的 HTTP 状态码在合法区间；客户端网络层代号为 0", () => {
    for (const [code, def] of entries) {
      if (code.startsWith("NET_")) {
        expect(def.status).toBe(0); // 客户端合成，真实状态码看 ApiError.status
      } else {
        expect(def.status).toBeGreaterThanOrEqual(400);
        expect(def.status).toBeLessThanOrEqual(599);
        expect([400, 401, 403, 404, 409, 413, 415, 429, 500, 503]).toContain(def.status);
      }
    }
  });

  it("每个默认文案非空", () => {
    for (const [, def] of entries) {
      expect(def.message.length).toBeGreaterThan(0);
    }
  });

  it("核心保存链路的关键代号存在（排障高频）", () => {
    for (const must of ["DOC_CONFLICT", "DOC_SAVE_NOT_APPLIED", "AUTH_REQUIRED", "SYS_INTERNAL", "MEDIA_NOT_CONFIGURED"] as const) {
      expect(Object.keys(ERROR_CODES)).toContain(must);
    }
  });
});

describe("errorBody", () => {
  it("默认使用注册表文案并携带 code", () => {
    expect(errorBody("DOC_NOT_FOUND")).toEqual({ error: "文档不存在", code: "DOC_NOT_FOUND" });
  });

  it("动态覆盖文案时 code 保持稳定", () => {
    const body = errorBody("FOLDER_TARGET_FOLDER_TAKEN", "目标路径已被目录「a」占用");
    expect(body.error).toBe("目标路径已被目录「a」占用");
    expect(body.code).toBe("FOLDER_TARGET_FOLDER_TAKEN");
  });
});
