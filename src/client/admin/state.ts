/** 应用级共享状态（极简可变对象，由各模块显式读写并触发重渲染）。 */
import type { DocumentSummary, FolderInfo, MeInfo } from "../../shared/types";

export const state = {
  me: null as MeInfo | null,
  /** 文档列表缓存（展示顺序由 sort_order 决定，与服务端排序语义一致） */
  docs: [] as DocumentSummary[],
  /** 显式创建的目录（含显示名称与 sort_order；有文档的目录由 docs 的 path 隐式推出） */
  folders: [] as FolderInfo[],
  /** 当前打开的文档 id；null 表示未选中（空状态） */
  currentDocId: null as number | null,
  /** 站点品牌（来自公开的 /api/settings）：后台顶栏 / 登录页 LOGO 与站点名 */
  brand: { siteName: "", logo: null as string | null },
};

export function isAdmin(): boolean {
  return state.me?.role === "admin";
}
