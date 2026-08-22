import type { DocumentSummary, FolderInfo } from "../shared/types";

export interface TreeNode {
  /** 路径段名，如 guide */
  segment: string;
  /** 到此节点的完整前缀，如 guide */
  fullPath: string;
  /** 目录显示名称：显式目录（folders 表）用用户设置的名称（任意语言），隐式目录与 segment 相同 */
  name?: string;
  /** 该路径上恰好存在同 path 的文档时非空（文件夹与文档可同名共存） */
  doc?: DocumentSummary;
  children: TreeNode[];
}

/**
 * 由扁平 path 列表构建目录树。
 * 'guide' 与 'guide/intro' 共存时，'guide' 文档挂在 guide 文件夹节点上，不产生重复节点。
 * folders 为后台显式创建的目录（含显示名称）：其名称会合入对应节点，空目录也会出现在树中。
 */
export function buildTree(docs: DocumentSummary[], folders: FolderInfo[] = []): TreeNode[] {
  const roots: TreeNode[] = [];
  const index = new Map<string, TreeNode>();
  const folderNames = new Map<string, string>();
  for (const f of folders) {
    if (f.name && f.name.length > 0) folderNames.set(f.path, f.name);
  }

  const getNode = (fullPath: string, segment: string, parent: TreeNode[]): TreeNode => {
    let node = index.get(fullPath);
    if (!node) {
      node = { segment, fullPath, children: [] };
      const displayName = folderNames.get(fullPath);
      if (displayName !== undefined) node.name = displayName;
      index.set(fullPath, node);
      parent.push(node);
    } else if (node.name === undefined) {
      const displayName = folderNames.get(fullPath);
      if (displayName !== undefined) node.name = displayName;
    }
    return node;
  };

  // 按路径排序保证父节点先于子节点出现（父路径是子路径的严格前缀）
  const sorted = [...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const doc of sorted) {
    const segments = doc.path.split("/");
    let parent = roots;
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]!;
      parent = getNode(prefix, segments[i]!, parent).children;
    }
    getNode(doc.path, segments[segments.length - 1]!, parent).doc = doc;
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      const aFolder = a.children.length > 0;
      const bFolder = b.children.length > 0;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.segment.localeCompare(b.segment, "zh-Hans-CN");
    });
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
