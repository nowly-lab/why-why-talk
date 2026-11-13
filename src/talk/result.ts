import { isBacked, treeSummary } from "../analysis.ts";
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
  const nodes = s.analysis.nodes
    .filter((n) => n.parentId !== null)
    .map((n) => {
      const head = `- ${n.id} ${isBacked(n) ? "✓ " : ""}${n.text} — ${STATE_LABEL[n.state]} · ${n.viewpoint ?? ""} · 親 ${n.parentId}`;
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
      return { ...n, facts: full.facts, reason: full.reason, countermeasure: full.countermeasure };
    }),
    transcript: s.transcript,
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
