import { depthOf, isBacked, shallowLeaves, TARGET_DEPTH, treeSummary } from "../analysis.ts";
import { redactSecrets } from "../redact.ts";
import { renderMermaid } from "../render/mermaid.ts";
import { STATE_LABEL, subtreeIds } from "../render/tree.ts";
import type { Dive, DiveStatus, TalkSession, TranscriptEntry } from "./session.ts";

const SPEAKER: Record<TranscriptEntry["speaker"], string> = { person: "あなた", gemini: "Gemini" };
const FILES = ["result.md", "result.json", "tree.mmd", "transcript.md", "session.json", "events.jsonl"];

export const DIVE_LABEL: Record<DiveStatus, string> = { pending: "未着手", digging: "掘っている途中", done: "終わった", partial: "途中" };

/** The Markdown the CLI prints on 送信; the agent reads it as the result, one section per checked question. */
export function renderResultMarkdown(s: TalkSession): string {
  const section = (title: string, body: string | undefined, level = "##") => `${level} ${title}\n\n${body?.trim() || "(なし)"}\n`;
  const out = [
    `# 深掘りの結果: ${s.topic ?? `問い ${s.dives.length} 件`}\n`,
    ...s.dives.map((d, i) => diveSection(s, d, i, section)),
    section("選ばなかった問い", unchecked(s).map((t) => `- ${t}`).join("\n")),
    section("添付ファイルの要点", s.files.map((f) => `### ${f.name}\n\n${f.summary}`).join("\n\n")),
    section("Gemini に聞いたこと", askedMarkdown(s)),
    `## 自由に話した内容\n\n${transcriptLines(s.freeTalk)}\n`,
    `## 深掘りの会話の全文\n\n${transcriptLines(s.transcript)}\n`,
    "---",
    `files: ${FILES.map((f) => `${s.outDir}/${f}`).join(", ")}`,
  ];
  return redactSecrets(`${out.join("\n")}\n`);
}

function diveSection(s: TalkSession, d: Dive, i: number, section: (t: string, b: string | undefined, l?: string) => string): string {
  const a = s.analysis;
  const ids = subtreeIds(a, [d.questionId]);
  const depth = (id: string) => depthLabel(depthOf(a, id));
  const shallow = shallowLeaves(a).filter((n) => ids.has(n.id)).map((n) => `- ${n.id} ${n.text}（${depth(n.id)}） 理由: ${n.reason ?? ""}`);
  const nodes = a.nodes
    .filter((n) => n.parentId !== null && ids.has(n.id))
    .map((n) => {
      const head = `- ${n.id} ${isBacked(n) ? "✓ " : ""}${n.text} — ${STATE_LABEL[n.state]} · ${depth(n.id)} · ${n.viewpoint ?? ""} · 親 ${n.parentId}`;
      const lines = [
        ...n.facts.map((f) => `  - ${f.supports ? "支持" : "否定"}: ${f.summary}`),
        ...(n.countermeasure ? [`  - 対策: ${n.countermeasure}`] : []),
        ...(n.reason ? [`  - 理由: ${n.reason}`] : []),
      ];
      return [head, ...lines].join("\n");
    });
  return [
    `## 問い ${i + 1}: ${d.text}(${DIVE_LABEL[d.status]})\n`,
    section("方針", d.draft?.direction, "###"),
    section("理由", d.draft?.reasons, "###"),
    section("見送った案", d.draft?.rejected, "###"),
    section("残った疑問", d.draft?.openQuestions, "###"),
    section("深さ不足の枝", shallow.join("\n"), "###"),
    `### なぜの木\n\n\`\`\`mermaid\n${renderMermaid(a, { rootId: d.questionId })}\`\`\`\n\n${nodes.join("\n") || "(なし)"}\n`,
  ].join("\n");
}

function unchecked(s: TalkSession): string[] {
  return s.dives.length > 0 ? s.questions.filter((q) => !q.checked).map((q) => q.text) : s.questions.map((q) => q.text);
}

export function renderTranscriptMarkdown(s: TalkSession): string {
  return `# 会話: ${s.topic ?? "自由に話す"}\n\n## 自由に話した内容\n\n${transcriptLines(s.freeTalk)}\n\n## 深掘りの会話\n\n${transcriptLines(s.transcript)}\n`;
}

export function resultJson(s: TalkSession) {
  const summary = treeSummary(s.analysis);
  return {
    topic: s.topic,
    status: s.status,
    questions: s.dives.map((d) => {
      const ids = subtreeIds(s.analysis, [d.questionId]);
      return {
        questionId: d.questionId,
        text: d.text,
        status: d.status,
        direction: d.draft,
        tree: summary.filter((n) => n.parentId !== null && ids.has(n.id)).map((n) => {
          const full = s.analysis.nodes.find((x) => x.id === n.id)!;
          return { ...n, shallow: n.state === "leaf" && n.depth < TARGET_DEPTH, facts: full.facts, reason: full.reason, countermeasure: full.countermeasure };
        }),
      };
    }),
    unchecked: unchecked(s),
    attachments: s.files,
    freeTalk: s.freeTalk,
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
        ? `出典: ${a.sources.map((x) => (x.uri ? `[${x.title.replace(/[[\]]/g, "")}](${x.uri})` : x.title)).join(" / ")}`
        : a.queries.length > 0
          ? `検索した言葉: ${a.queries.map((q) => `「${q}」`).join("")}（出典ページなし）`
          : "出典なし";
      return `### 質問: ${a.question || "(聞き取れず)"}\n\n答え（未確認）: ${a.answer}\n\n${source}`;
    })
    .join("\n\n");
}
