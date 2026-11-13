import type { Analysis, NodeState, WhyNode } from "../model.ts";

export const STATE_LABEL: Record<NodeState, string> = {
  candidate: "未調査",
  digging: "掘っている",
  leaf: "葉",
  rejected: "却下",
  hypothesis: "仮説",
};

export function childrenOf(a: Analysis, id: string): WhyNode[] {
  return a.nodes.filter((n) => n.parentId === id);
}

/** Ids of the nodes in the subtrees rooted at the given nodes (roots included). */
export function subtreeIds(a: Analysis, roots: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of childrenOf(a, id)) stack.push(c.id);
  }
  return out;
}
