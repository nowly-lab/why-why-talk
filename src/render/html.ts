import { isBacked } from "../analysis.ts";
import { FIELDS, type Analysis, type Field, type WhyNode } from "../model.ts";
import { childrenOf, priorityOf, STATE_LABEL } from "./tree.ts";

const FIELD_LABEL: Record<Field, string> = {
  supported: "裏付け",
  sufficient: "単独で起きる",
  likelihood: "有力度",
  impact: "影響",
  preventable: "防げる",
};

/** A self-contained page (no scripts) for the Plannotator Inbox HTML viewer. Every text is escaped. */
export function renderHtml(a: Analysis): string {
  const root = a.nodes.find((n) => n.parentId === null);
  const counts = new Map<string, number>();
  for (const n of a.nodes) if (n.parentId !== null) counts.set(n.state, (counts.get(n.state) ?? 0) + 1);
  const summary = (["candidate", "digging", "leaf", "hypothesis", "rejected"] as const)
    .map((s) => `<span class="pill s-${s}">${STATE_LABEL[s]} ${counts.get(s) ?? 0}</span>`)
    .join("");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)} — なぜなぜの木</title>
<style>${CSS}</style></head>
<body><main>
<p class="eyebrow">なぜなぜ分析 · ${esc(a.id)} · ${a.status === "open" ? "進行中" : "完了"} · ${esc(a.updatedAt)}</p>
<h1>${esc(a.title)}</h1>
<div class="summary">${summary}</div>
<p class="legend">✓ = 事実で裏付けあり　? = まだ裏付けなし　優先度 = 有力度 × 影響</p>
<ul class="tree">${root ? item(a, root) : ""}</ul>
</main></body></html>
`;
}

function item(a: Analysis, n: WhyNode): string {
  const kids = childrenOf(a, n.id);
  const isRoot = n.parentId === null;
  const mark = isRoot ? "" : isBacked(n) ? `<span class="mark ok">✓</span>` : `<span class="mark">?</span>`;
  const p = priorityOf(n);
  const meta = isRoot
    ? `<span class="tag">問題</span>`
    : [
        `<span class="tag s-${n.state}">${STATE_LABEL[n.state]}</span>`,
        n.viewpoint ? `<span class="tag">${esc(n.viewpoint)}</span>` : "",
        p !== null ? `<span class="tag">優先度 ${p.toFixed(2)}</span>` : "",
        n.evaluation?.stale ? `<span class="tag warn">評価が古い</span>` : "",
      ].join("");
  const fields = n.evaluation
    ? `<dl class="eval">${FIELDS.filter((f) => n.evaluation!.fields[f])
        .map((f) => {
          const v = n.evaluation!.fields[f]!;
          return `<div${v.lowConfidence ? ' class="low"' : ""}><dt>${FIELD_LABEL[f]}</dt><dd>${v.value.toFixed(2)} <small>${v.source}${v.lowConfidence ? " · 確信低" : ""}</small></dd></div>`;
        })
        .join("")}</dl>`
    : "";
  const evidence = n.evidence.length
    ? `<ul class="evidence">${n.evidence
        .map((e) => `<li class="${e.supports ? "sup" : "neg"}">${e.supports ? "支持" : "否定"} · ${esc(e.kind)} · ${esc(e.summary)} <small>${esc(e.ref)}</small></li>`)
        .join("")}</ul>`
    : "";
  const extra = [
    n.countermeasure ? `<p class="cm">対策: ${esc(n.countermeasure)}</p>` : "",
    n.reason ? `<p class="reason">理由: ${esc(n.reason)}</p>` : "",
  ].join("");
  const children = kids.length ? `<ul>${kids.map((k) => item(a, k)).join("")}</ul>` : "";
  return `<li><div class="node${isRoot ? " root" : ` s-${n.state}`}" id="${esc(n.id)}"><div class="head"><span class="id">${esc(n.id.toUpperCase())}</span>${mark}<span class="text">${esc(n.text)}</span></div><div class="meta">${meta}</div>${fields}${evidence}${extra}</div>${children}</li>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CSS = `
:root{--bg:#f8fafc;--fg:#0f172a;--muted:#64748b;--card:#fff;--border:#e2e8f0;--line:#cbd5e1;--ok:#16a34a;--warn:#ca8a04;--dig:#2563eb;--rej:#94a3b8}
@media (prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--card:#1e293b;--border:#334155;--line:#475569}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,"Hiragino Sans",sans-serif}
main{padding:24px 16px;max-width:1400px;margin:0 auto}h1{font-size:1.5rem;margin:4px 0 12px}
.eyebrow,.legend{color:var(--muted);font-size:12px;margin:0}.legend{margin:8px 0 16px}
.summary{display:flex;flex-wrap:wrap;gap:6px}.pill,.tag{border:1px solid var(--border);border-radius:999px;padding:1px 8px;font-size:12px;background:var(--card)}
.tree,.tree ul{list-style:none;margin:0;padding-left:28px;position:relative}.tree{padding-left:0}
.tree ul::before{content:"";position:absolute;left:12px;top:0;bottom:12px;border-left:1.5px solid var(--line)}
.tree li{position:relative;margin:8px 0}.tree ul>li::before{content:"";position:absolute;left:-16px;top:18px;width:14px;border-top:1.5px solid var(--line)}
.node{display:inline-block;max-width:640px;background:var(--card);border:1.5px solid var(--border);border-radius:10px;padding:8px 12px}
.node.root{border-color:var(--fg)}.node.s-digging{border-color:var(--dig)}.node.s-leaf{border-color:var(--ok);border-width:2px}
.node.s-rejected{opacity:.65}.node.s-hypothesis{border-style:dashed;border-color:var(--warn)}.node.s-candidate{border-style:dashed}
.head{display:flex;gap:6px;align-items:baseline}.id{font:600 11px ui-monospace,monospace;color:var(--muted)}.text{font-weight:600}
.mark{color:var(--muted)}.mark.ok{color:var(--ok)}.meta{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.tag.warn{border-color:var(--warn)}
.eval{display:flex;flex-wrap:wrap;gap:4px 12px;margin:6px 0 0;font-size:12px}.eval div{display:flex;gap:4px}.eval dt{color:var(--muted)}.eval dd{margin:0}.eval .low dd{color:var(--warn)}
.evidence{margin:6px 0 0;padding-left:16px;font-size:12px}.evidence .neg{color:var(--muted)}small{color:var(--muted)}
.cm{margin:6px 0 0;color:var(--ok);font-weight:600}.reason{margin:6px 0 0;color:var(--muted)}
`;
