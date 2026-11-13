export type TreeNode = {
  id: string;
  parentId: string | null;
  text: string;
  state: string;
  viewpoint?: string | null;
  facts?: Array<{ summary: string; supports: boolean }>;
  reason?: string;
  countermeasure?: string;
};

/** Depth-first rows (children in insertion order) for drawing the tree as an indented list. */
export function treeRows<T extends TreeNode>(nodes: T[]): Array<{ node: T; depth: number }> {
  const children = new Map<string | null, T[]>();
  for (const n of nodes) {
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const rows: Array<{ node: T; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of children.get(parent) ?? []) {
      rows.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
