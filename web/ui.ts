import type { AskedView, Direction } from "./api.ts";
import type { Line } from "./transcript.ts";
import { depthTag, TARGET_DEPTH, treeRows, type TreeNode } from "./tree-rows.ts";

const STATE_LABEL: Record<string, string> = {
  candidate: "未調査",
  digging: "掘っている",
  leaf: "葉",
  rejected: "却下",
  hypothesis: "仮説",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function renderTree(container: HTMLElement, nodes: TreeNode[], fresh: Set<string>): void {
  container.replaceChildren();
  for (const { node, depth } of treeRows(nodes)) {
    const shallow = node.parentId !== null && node.state === "leaf" && depth < TARGET_DEPTH;
    const row = el("div", `node s-${node.parentId === null ? "root" : node.state}${shallow ? " shallow" : ""}${fresh.has(node.id) ? " fresh" : ""}`);
    row.style.setProperty("--depth", String(depth));
    const head = el("div", "head");
    const backed = node.facts?.some((f) => f.supports);
    if (node.parentId !== null) head.append(el("span", backed ? "mark ok" : "mark", backed ? "✓" : "?"));
    head.append(el("span", "text", node.text));
    row.append(head);
    if (node.parentId !== null) {
      const meta = el("div", "meta");
      meta.append(el("span", "tag", STATE_LABEL[node.state] ?? node.state));
      meta.append(el("span", "tag depth", depthTag(depth)));
      if (node.viewpoint) meta.append(el("span", "tag", node.viewpoint));
      row.append(meta);
    }
    for (const f of node.facts ?? []) row.append(el("div", f.supports ? "fact sup" : "fact neg", `${f.supports ? "支持" : "否定"}: ${f.summary}`));
    if (node.countermeasure) row.append(el("div", "cm", `対策: ${node.countermeasure}`));
    if (node.reason) row.append(el("div", shallow ? "reason shallow-reason" : "reason", `${shallow ? "深さ不足の理由" : "理由"}: ${node.reason}`));
    container.append(row);
  }
}

export function renderTranscript(container: HTMLElement, lines: Line[]): void {
  const stick = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  container.replaceChildren(
    ...lines.map((l) => {
      const row = el("div", `line ${l.speaker}`);
      row.append(el("span", "who", l.speaker === "person" ? "あなた" : "Gemini"), el("span", "said", l.text));
      return row;
    }),
  );
  if (stick) container.scrollTop = container.scrollHeight;
}

export function readDirection(form: HTMLFormElement): Direction {
  const v = (name: string) => (form.elements.namedItem(name) as HTMLTextAreaElement).value;
  return { direction: v("direction"), reasons: v("reasons"), rejected: v("rejected"), openQuestions: v("openQuestions") };
}

export function fillDirection(form: HTMLFormElement, d: Direction): void {
  const set = (name: string, value: string) => ((form.elements.namedItem(name) as HTMLTextAreaElement).value = value);
  set("direction", d.direction);
  set("reasons", d.reasons);
  set("rejected", d.rejected);
  set("openQuestions", d.openQuestions);
}

/** What the person asked Gemini as the answerer: unverified, with search words or source pages. */
export function renderAnswers(container: HTMLElement, asked: AskedView[]): void {
  container.hidden = asked.length === 0;
  const list = container.querySelector(".asked-list") ?? container;
  list.replaceChildren(
    ...asked.map((a) => {
      const item = el("div", "asked");
      item.append(el("div", "q", `質問: ${a.question || "(聞き取れず)"}`), el("div", "a", `答え: ${a.answer}`));
      const note = el("div", "src");
      note.append(el("span", "unverified", "未確認"));
      if (a.sources.length > 0) {
        note.append(document.createTextNode(" · 出典: "));
        a.sources.forEach((src, i) => {
          if (i > 0) note.append(document.createTextNode(" / "));
          const link = el("a", undefined, src.title);
          if (/^https?:\/\//.test(src.uri)) link.href = src.uri;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          note.append(link);
        });
      } else if (a.queries.length > 0) {
        note.append(document.createTextNode(` · 検索: ${a.queries.map((q) => `「${q}」`).join(" ")}`));
      } else {
        note.append(document.createTextNode(" · 出典なし"));
      }
      item.append(note);
      return item;
    }),
  );
}
