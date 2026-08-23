import type { DocumentSummary, FolderInfo } from "../shared/types";

export interface TreeNode {
  /** 路径段名，如 guide */
  segment: string;
  /** 到此节点的完整前缀，如 guide */
  fullPath: string;
  /** 目录显示名称：显式目录（folders 表）用用户设置的名称（任意语言），隐式目录与 segment 相同 */
  name?: string;
  /** 手动排序值：显式目录行或文档上的 sort_order；隐式目录无值时视为 0 */
  order?: number;
  /** 该路径上恰好存在同 path 的文档时非空（文件夹与文档可同名共存） */
  doc?: DocumentSummary;
  children: TreeNode[];
}

/**
 * 同级排序（后台侧栏与阅读页目录共用同一顺序）：
 * 先按手动排序值升序；未排序（同值 0）时保持旧行为——目录在前、段名字典序。
 */
export function compareTreeSiblings(aOrder: number, bOrder: number, aSegment: string, bSegment: string, aIsFolder: boolean, bIsFolder: boolean): number {
  if (aOrder !== bOrder) return aOrder - bOrder;
  if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
  return aSegment.localeCompare(bSegment, "zh-Hans-CN");
}

/**
 * 由扁平 path 列表构建目录树。
 * 'guide' 与 'guide/intro' 共存时，'guide' 文档挂在 guide 文件夹节点上，不产生重复节点。
 * folders 为后台显式创建的目录（含显示名称与排序值）：其名称/排序会合入对应节点，空目录也会出现在树中。
 */
export function buildTree(docs: DocumentSummary[], folders: FolderInfo[] = []): TreeNode[] {
  const roots: TreeNode[] = [];
  const index = new Map<string, TreeNode>();
  const folderMeta = new Map<string, { name: string; order: number }>();
  for (const f of folders) {
    folderMeta.set(f.path, { name: f.name, order: f.sort_order ?? 0 });
  }

  const getNode = (fullPath: string, segment: string, parent: TreeNode[]): TreeNode => {
    let node = index.get(fullPath);
    if (!node) {
      node = { segment, fullPath, children: [] };
      const meta = folderMeta.get(fullPath);
      if (meta !== undefined && meta.name.length > 0) node.name = meta.name;
      index.set(fullPath, node);
      parent.push(node);
    }
    // 排序值无论节点是否首次出现都要合入（文档先到、目录行后到的场景）
    const meta = folderMeta.get(fullPath);
    if (meta !== undefined) node.order = meta.order;
    return node;
  };

  // 按路径排序保证父节点先于子节点出现（父路径是子路径的严格前缀）
  const sorted = [...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const doc of sorted) {
    const segments = doc.path.split("/");
    let parent = roots;
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segments[i]!}` : segments[i]!;
      parent = getNode(prefix, segments[i]!, parent).children;
    }
    const leaf = getNode(doc.path, segments[segments.length - 1]!, parent);
    leaf.doc = doc;
    leaf.order ??= doc.sort_order;
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) =>
      compareTreeSiblings(a.order ?? 0, b.order ?? 0, a.segment, b.segment, a.children.length > 0, b.children.length > 0)
    );
    for (const n of nodes) sortNodes(n.children);
    return nodes;
  };

  // 显式创建的空目录也要出现在树中（后台先建目录、后写文档的工作流）
  for (const folder of folders) {
    if (folder.path.length === 0) continue;
    const segments = folder.path.split("/");
    let parent = roots;
    let prefix = "";
    for (let i = 0; i < segments.length; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]!;
      parent = getNode(prefix, segments[i]!, parent).children;
    }
  }

  return sortNodes(roots);
}
