/**
 * 全部后端 API 的 fetch 封装。
 * 错误统一抛出 ApiError（携带 status 与解析后的响应体），
 * 409 冲突可通过 getConflictPayload 取出 ConflictPayload。
 */
import type {
  ConflictPayload,
  CreateDocumentInput,
  CreateFolderInput,
  DocumentDetail,
  DocumentSummary,
  FolderListResult,
  MeInfo,
  RevisionDetail,
  RevisionSummary,
  SaveResult,
  SearchResult,
  SessionRow,
  SiteSettings,
  UpdateDocumentInput,
  UpdateFolderInput,
  UpdateSiteSettingsInput,
  UploadResult,
  UsageStats,
} from "../../shared/types";

export class ApiError extends Error {
  readonly status: number;
  /** 稳定错误码（服务端契约见 docs/ERRORS.md）；网络层/兜底场景由本模块合成 */
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 从任意异常中提取可展示的文案（永不静默失败）。附带稳定错误码便于对照 docs/ERRORS.md 排查 */
export function errMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const base = e.message || `请求失败（HTTP ${e.status}）`;
    return e.code ? `${base} [${e.code}]` : base;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 若 e 是 409 冲突且响应体符合契约，返回 ConflictPayload，否则 null */
export function getConflictPayload(e: unknown): ConflictPayload | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body as Partial<ConflictPayload> | null;
  if (
    body &&
    body.error === "conflict" &&
    typeof body.message === "string" &&
    body.current &&
    typeof body.current === "object" &&
    typeof (body.current as ConflictPayload["current"]).revision_seq === "number" &&
    typeof (body.current as ConflictPayload["current"]).content_md === "string"
  ) {
    return body as ConflictPayload;
  }
  return null;
}

function extractErrorMessage(body: unknown): string | null {
  if (body !== null && typeof body === "object" && "error" in body) {
    const v = (body as { error: unknown }).error;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** 服务端标准错误响应携带的稳定错误码（docs/ERRORS.md 契约） */
function extractErrorCode(body: unknown): string | null {
  if (body !== null && typeof body === "object" && "code" in body) {
    const v = (body as { code: unknown }).code;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "网络错误，请检查连接后重试", null, "NET_FAILED");
  }

  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    // 非 JSON 响应体（如 Cloudflare 网关错误页）单独标记，便于区分「服务端报错」与「没到服务端」
    if (text.length > 0 && body === null) {
      throw new ApiError(res.status, `服务端返回了无法解析的响应（HTTP ${res.status}）`, null, "NET_BAD_RESPONSE");
    }
    throw new ApiError(
      res.status,
      extractErrorMessage(body) ?? `请求失败（HTTP ${res.status}）`,
      body,
      extractErrorCode(body) ?? "NET_HTTP"
    );
  }
  return body as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const api = {
  /* ---- 认证 ---- */
  me(): Promise<MeInfo> {
    return request<MeInfo>("/api/auth/me");
  },
  login(name: string, password: string): Promise<MeInfo> {
    return request<MeInfo>("/api/auth/login", jsonInit("POST", { name, password }));
  },
  logout(): Promise<{ ok: true }> {
    return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
  },

  /* ---- 文档 ---- */
  listDocs(): Promise<DocumentSummary[]> {
    return request<DocumentSummary[]>("/api/docs");
  },
  getDoc(id: number): Promise<DocumentDetail> {
    return request<DocumentDetail>(`/api/docs/${id}`);
  },
  createDoc(input: CreateDocumentInput): Promise<DocumentDetail> {
    return request<DocumentDetail>("/api/docs", jsonInit("POST", input));
  },
  updateDoc(id: number, input: UpdateDocumentInput): Promise<SaveResult> {
    return request<SaveResult>(`/api/docs/${id}`, jsonInit("PUT", input));
  },
  deleteDoc(id: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/docs/${id}`, { method: "DELETE" });
  },

  /* ---- 目录 ---- */
  listFolders(): Promise<FolderListResult> {
    return request<FolderListResult>("/api/folders");
  },
  createFolder(input: CreateFolderInput): Promise<{ ok: true; path: string; name: string }> {
    return request<{ ok: true; path: string; name: string }>("/api/folders", jsonInit("POST", input));
  },
  /** 目录改名 / 移动（name 与 path 均可选，只传变更的字段） */
  updateFolder(oldPath: string, patch: UpdateFolderInput): Promise<{ ok: true; path: string; name: string }> {
    const encoded = oldPath.split("/").map(encodeURIComponent).join("/");
    return request<{ ok: true; path: string; name: string }>(`/api/folders/${encoded}`, jsonInit("PUT", patch));
  },
  deleteFolder(path: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/folders/${path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
    });
  },

  /* ---- 发布 ---- */
  publishDoc(id: number, note?: string): Promise<DocumentDetail> {
    return request<DocumentDetail>(`/api/docs/${id}/publish`, jsonInit("POST", { note }));
  },
  unpublishDoc(id: number): Promise<DocumentDetail> {
    return request<DocumentDetail>(`/api/docs/${id}/unpublish`, { method: "POST" });
  },

  /* ---- 版本历史 ---- */
  listRevisions(docId: number): Promise<RevisionSummary[]> {
    return request<RevisionSummary[]>(`/api/docs/${docId}/revisions`);
  },
  getRevision(id: number): Promise<RevisionDetail> {
    return request<RevisionDetail>(`/api/revisions/${id}`);
  },
  rollbackRevision(id: number): Promise<DocumentDetail> {
    return request<DocumentDetail>(`/api/revisions/${id}/rollback`, { method: "POST" });
  },
  /** 删除单条版本（仅 admin；当前发布中的快照会被服务端拒绝） */
  deleteRevision(id: number): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/revisions/${id}`, { method: "DELETE" });
  },
  /** 清空文档全部版本历史（仅 admin；保留当前发布快照） */
  clearRevisions(docId: number): Promise<{ ok: true; deleted: number }> {
    return request<{ ok: true; deleted: number }>(`/api/docs/${docId}/revisions`, { method: "DELETE" });
  },

  /* ---- 搜索 / 上传 ---- */
  search(q: string): Promise<SearchResult> {
    return request<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`);
  },
  upload(file: File): Promise<UploadResult> {
    const fd = new FormData();
    fd.append("file", file);
    return request<UploadResult>("/api/upload", { method: "POST", body: fd });
  },

  /* ---- 站点设置（读取公开；修改仅 admin） ---- */
  getSiteSettings(): Promise<SiteSettings> {
    return request<SiteSettings>("/api/settings");
  },
  updateSiteSettings(patch: UpdateSiteSettingsInput): Promise<SiteSettings> {
    return request<SiteSettings>("/api/settings", jsonInit("PUT", patch));
  },

  /* ---- 会话管理（仅 admin） ---- */
  listSessions(): Promise<SessionRow[]> {
    return request<SessionRow[]>("/api/admin/sessions");
  },
  revokeSession(tokenHash: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/admin/sessions/${tokenHash}`, { method: "DELETE" });
  },

  /* ---- 用量统计（仅 admin） ---- */
  getUsage(): Promise<UsageStats> {
    return request<UsageStats>("/api/admin/usage");
  },
};
