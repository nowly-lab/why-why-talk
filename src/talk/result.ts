import { depthOf, isBacked, shallowLeaves, TARGET_DEPTH, treeSummary } from "../analysis.ts";
import { redactSecrets } from "../redact.ts";
import { renderMermaid } from "../render/mermaid.ts";
import { STATE_LABEL } from "../render/tree.ts";
import type { TalkSession, TranscriptEntry } from "./session.ts";

const SPEAKER: Record<TranscriptEntry["speaker"], string> = { person: "あなた", gemini: "Gemini" };
const FILES = ["result.md", "result.json", "tree.mmd", "transcript.md", "session.json"];

/** The Markdown the CLI prints on 送信; the agent reads it as the result of the deep dive. */
export function renderResultMarkdown(s: TalkSession): string {
  const d = s.sent ?? s.draft;
  const section = (title: string, body: string | undefined) => `## ${title}\n\n${body?.trim() || "(なし)"}\n`;
  const depth = (id: string) => depthLabel(depthOf(s.analysis, id));
  const shallow = shallowLeaves(s.analysis).map((n) => `- ${n.id} ${n.text}（${depth(n.id)}） 理由: ${n.reason ?? ""}`);
  const nodes = s.analysis.nodes
    .filter((n) => n.parentId !== null)
    .map((n) => {
      const head = `- ${n.id} ${isBacked(n) ? "✓ " : ""}${n.text} — ${STATE_LABEL[n.state]} · ${depth(n.id)} · ${n.viewpoint ?? ""} · 親 ${n.parentId}`;
      const lines = [
        ...n.facts.map((f) => `  - ${f.supports ? "支持" : "否定"}: ${f.summary}`),
        ...(n.countermeasure ? [`  - 対策: ${n.countermeasure}`] : []),
        ...(n.reason ? [`  - 理由: ${n.reason}`] : []),
      ];
      return [head, ...lines].join("\n");
    });
  const out = [
    `# 深掘りの結果: ${s.topic}\n`,
    section("方針", d?.direction),
    section("理由", d?.reasons),
    section("見送った案", d?.rejected),
    section("残った疑問", d?.openQuestions),
    section("深さ不足の枝", shallow.join("\n")),
    section("Gemini に聞いたこと", askedMarkdown(s)),
    `## なぜの木\n\n\`\`\`mermaid\n${renderMermaid(s.analysis)}\`\`\`\n\n${nodes.join("\n") || "(なし)"}\n`,
    `## 会話の全文\n\n${transcriptLines(s.transcript)}\n`,
    "---",
    `files: ${FILES.map((f) => `${s.outDir}/${f}`).join(", ")}`,
  ];
  return redactSecrets(`${out.join("\n")}\n`);
}

export function renderTranscriptMarkdown(s: TalkSession): string {
  return `# 会話: ${s.topic}\n\n${transcriptLines(s.transcript)}\n`;
}

export function resultJson(s: TalkSession) {
  return {
    topic: s.topic,
    status: s.status,
    direction: s.sent ?? s.draft,
    tree: treeSummary(s.analysis).slice(1).map((n) => {
      const full = s.analysis.nodes.find((x) => x.id === n.id)!;
      return { ...n, shallow: n.state === "leaf" && n.depth < TARGET_DEPTH, facts: full.facts, reason: full.reason, countermeasure: full.countermeasure };
    }),
    transcript: s.transcript,
    asked: s.asked,
    startedAt: s.startedAt,
    files: FILES.map((f) => `${s.outDir}/${f}`),
  };
}

function transcriptLines(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return "(なし)";
  return entries.map((t) => `${clockTime(t.at)} ${SPEAKER[t.speaker]}: ${t.text}`).join("\n");
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** "2/5段" below the target, plain "7段" at or past it. */
export function depthLabel(depth: number): string {
  return depth < TARGET_DEPTH ? `${depth}/${TARGET_DEPTH}段` : `${depth}段`;
}

/** Answers Gemini gave as the answerer. Always marked unverified: they came from search, not from the person. */
function askedMarkdown(s: TalkSession): string {
  return s.asked
    .map((a) => {
      const source = a.sources.length > 0
        ? `出典: ${a.sources.map((x) => `[${x.title.replace(/[[\]]/g, "")}](${x.uri})`).join(" / ")}`
        : a.queries.length > 0
          ? `検索した言葉: ${a.queries.map((q) => `「${q}」`).join("")}（出典ページなし）`
          : "出典なし";
      return `### 質問: ${a.question || "(聞き取れず)"}\n\n答え（未確認）: ${a.answer}\n\n${source}`;
    })
    .join("\n\n");
}
