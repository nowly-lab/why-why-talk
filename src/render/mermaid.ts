import { isBacked } from "../analysis.ts";
import type { Analysis, NodeState, WhyNode } from "../model.ts";
import { STATE_LABEL, subtreeIds } from "./tree.ts";

const CLASS_DEFS: Array<[NodeState | "root", string]> = [
  ["root", "fill:#334155,color:#fff,stroke:#334155"],
  ["candidate", "fill:#f8fafc,color:#0f172a,stroke:#94a3b8,stroke-dasharray:4 3"],
  ["digging", "fill:#dbeafe,color:#0f172a,stroke:#2563eb"],
  ["leaf", "fill:#dcfce7,color:#0f172a,stroke:#16a34a,stroke-width:2px"],
  ["rejected", "fill:#f1f5f9,color:#64748b,stroke:#cbd5e1"],
  ["hypothesis", "fill:#fef9c3,color:#0f172a,stroke:#ca8a04,stroke-dasharray:2 2"],
];

/**
 * Mermaid flowchart of the tree. Node ids equal tree ids, so a comment on a node in the
 * Plannotator Inbox diagram viewer comes back with the id the MCP tools take.
 */
export function renderMermaid(a: Analysis, opts: { maxNodes?: number } = {}): string {
  const maxNodes = opts.maxNodes ?? 40;
  let hidden = new Set<string>();
  if (a.nodes.length > maxNodes) {
    for (const state of ["rejected", "hypothesis"] as const) {
      if (a.nodes.length - hidden.size <= maxNodes) break;
      const roots = a.nodes.filter((n) => n.parentId !== null && n.state === state).map((n) => n.id);
      hidden = new Set([...hidden, ...subtreeIds(a, roots)]);
    }
  }
  const shown = a.nodes.filter((n) => !hidden.has(n.id));
  const lines = ["flowchart LR"];
  for (const n of shown) lines.push(`  ${n.id}["${label(n)}"]`);
  for (const n of shown) if (n.parentId !== null) lines.push(`  ${n.parentId} --> ${n.id}`);
  if (hidden.size > 0) {
    lines.push(`  omitted["${escape(`省略: ${hidden.size} 件(却下・仮説の枝)`)}"]`);
    lines.push("  class omitted rejected");
  }
  for (const [name, style] of CLASS_DEFS) lines.push(`  classDef ${name} ${style}`);
  for (const n of shown) lines.push(`  class ${n.id} ${n.parentId === null ? "root" : n.state}`);
  return `${lines.join("\n")}\n`;
}

function label(n: WhyNode): string {
  if (n.parentId === null) return `${escape(n.id)} 問題<br/>${escape(n.text)}`;
  const mark = isBacked(n) ? "✓ " : n.state === "candidate" ? "? " : "";
  const meta = [n.id, STATE_LABEL[n.state], n.viewpoint ?? ""];
  let out = `${mark}${escape(n.text)}<br/>${escape(meta.filter(Boolean).join(" · "))}`;
  if (n.countermeasure) out += `<br/>${escape(`対策: ${n.countermeasure}`)}`;
  return out;
}

function escape(text: string): string {
  return text
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\[/g, "#91;")
    .replace(/]/g, "#93;")
    .replace(/\|/g, "#124;")
    .replace(/`/g, "#96;")
    .replace(/\r?\n/g, "<br/>");
}
