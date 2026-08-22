/**
 * 标题 → 路径片段（slug）转换：目录化建文档时路径由标题自动生成。
 * 纯函数，无 DOM 依赖，可被单元测试覆盖。
 */

const MAX_SLUG_LEN = 80;

/** 中文等无法进入 slug 的字符会被丢弃；丢弃后为空则返回空串，由调用方生成随机名 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
  return slug;
}

/** 生成唯一兜底名（纯中文标题等 slug 为空时使用），如 doc-lx2k9f3a */
export function randomDocName(): string {
  const rand = Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, "0");
  return `doc-${Date.now().toString(36)}${rand}`;
}

/** 组合目录与名称为完整 path；folder 为空串表示根目录 */
export function joinPath(folder: string, name: string): string {
  const f = folder.replace(/\/+$/, "");
  return f.length > 0 ? `${f}/${name}` : name;
}
