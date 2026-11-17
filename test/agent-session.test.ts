import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkSession } from "../src/talk/session.ts";
import { renderResultMarkdown, resultJson } from "../src/talk/result.ts";
import { systemInstruction } from "../src/talk/gemini.ts";
import { WhyError } from "../src/model.ts";

const now = () => "2026-11-17T03:00:00.000Z";
async function fresh() {
  return new TalkSession({ topic: null, context: "", outDir: await mkdtemp(join(tmpdir(), "why-agent-")), now });
}
async function diving() {
  const s = await fresh();
  s.addQuestion("なぜホストはフロアごとなのか", "agent");
  s.addQuestion("退室した人の席をいつ消すか", "agent");
  s.startDeepDive();
  return s;
}

test("addQuestion before the deep dive appends a checked question marked as the agent's", async () => {
  const s = await fresh();
  s.appendFreeTalk("会議の話", 0);
  const r = s.addQuestion("なぜホストはフロアごとなのか", "agent");
  assert.equal(r.questionId, null);
  assert.equal(s.phase, "questions");
  assert.deepEqual(s.questions.at(-1), { text: "なぜホストはフロアごとなのか", checked: true, by: "agent" });
});

test("addQuestion takes 20 questions in all, then refuses", async () => {
  const s = await fresh();
  for (let i = 0; i < 20; i++) s.addQuestion(`問い ${i}`, "agent");
  assert.throws(() => s.addQuestion("21件目", "agent"), (e: unknown) => e instanceof WhyError && e.code === "invalid_input");
});

test("addQuestion during the deep dive adds a pending question with its own root", async () => {
  const s = await diving();
  const r = s.addQuestion("オフィス全体のホストは要るか", "agent");
  assert.equal(r.questionId, "q3");
  assert.equal(s.dives.at(-1)?.status, "pending");
  assert.equal(s.analysis.nodes.find((n) => n.id === "q3")?.text, "オフィス全体のホストは要るか");
});

test("agentTool writes to a question that is not being dug, marked as the agent's", async () => {
  const s = await diving();
  assert.equal(s.current()?.questionId, "q1");
  const r = s.agentTool("add_whys", { parent_id: "q2", items: [{ text: "切断済みの記録が残る", viewpoint: "仕組み・道具" }] });
  assert.equal(r.ok, true);
  const node = s.analysis.nodes.find((n) => n.parentId === "q2")!;
  assert.equal(node.by, "agent");
  const f = s.agentTool("add_fact", { node_id: node.id, summary: "会議で「移るまで残る」と確認", supports: true });
  assert.equal(f.ok, true);
  assert.equal(s.analysis.nodes.find((n) => n.id === node.id)!.facts[0].by, "agent");
  assert.equal(s.agentTool("update_branch", { node_id: node.id, state: "digging" }).ok, true);
  assert.equal(s.agentTool("propose_direction", { question_id: "q2", direction: "別フロアへ移るときに消す", reasons: "今の動き", rejected: "", open_questions: "時間で消すか" }).ok, true);
  assert.equal(s.dives.find((d) => d.questionId === "q2")?.draft?.direction, "別フロアへ移るときに消す");
});

test("Gemini's applyTool still refuses a question that is not being dug", async () => {
  const s = await diving();
  const r = s.applyTool("add_whys", { parent_id: "q2", items: [{ text: "x", viewpoint: "検知" }] });
  assert.equal(r.ok, false);
});

test("agentTool refuses Gemini-only tools and a finished session", async () => {
  const s = await diving();
  assert.equal(s.agentTool("next_question" as never, {}).ok, false);
  s.cancel("テスト");
  assert.equal(s.agentTool("add_fact", { node_id: "q1", summary: "x", supports: true }).ok, false);
});

test("the result marks what the agent added", async () => {
  const s = await diving();
  s.agentTool("add_whys", { parent_id: "q1", items: [{ text: "フロアが部屋の単位だから", viewpoint: "仕組み・道具" }] });
  s.submit({});
  assert.match(renderResultMarkdown(s), /フロアが部屋の単位だから（Claude）/);
});

test("questions an agent added before the dive keep its mark on their dives", async () => {
  const s = await diving();
  assert.deepEqual(s.dives.map((d) => d.by), ["agent", "agent"]);
});

test("R1: a stale list from the page does not drop a question an agent added after it", async () => {
  const s = await fresh();
  s.addQuestion("一つめ", "agent");
  const base = s.snapshot().questionsVersion;
  s.addQuestion("あとから足した問い", "agent");
  s.editQuestions([{ text: "一つめ（直した）", checked: true, by: "agent" }], base);
  assert.deepEqual(s.questions.map((q) => q.text), ["一つめ（直した）", "あとから足した問い"]);
  // A current list replaces as before (the person deleted a question on purpose).
  s.editQuestions([{ text: "一つめ（直した）", checked: true }], s.snapshot().questionsVersion);
  assert.deepEqual(s.questions.map((q) => q.text), ["一つめ（直した）"]);
});

test("R5/R6: root facts and the agent's questions are in the result (Markdown and JSON)", async () => {
  const s = await diving();
  s.agentTool("add_fact", { node_id: "q1", summary: "ROOT MEETING FACT", supports: true });
  s.submit({});
  const md = renderResultMarkdown(s);
  assert.match(md, /ROOT MEETING FACT（Claude）/);
  assert.match(md, /## 問い 1: なぜホストはフロアごとなのか（Claude）/);
  const j = resultJson(s);
  assert.equal(j.questions[0].by, "agent");
  assert.deepEqual(j.questions[0].facts, [{ summary: "ROOT MEETING FACT", supports: true, by: "agent" }]);
});

test("R6: questions an agent added are marked in a result sent before the dive", async () => {
  const s = await fresh();
  s.addQuestion("会議で出た問い", "agent");
  s.submit({});
  assert.match(renderResultMarkdown(s), /会議で出た問い（Claude）/);
});

test("R4: Gemini's opening instruction carries the board an agent built, with facts and drafts", async () => {
  const s = await diving();
  s.agentTool("add_whys", { parent_id: "q1", items: [{ text: "AGENT REASON", viewpoint: "仕組み・道具" }] });
  s.agentTool("add_fact", { node_id: "q1", summary: "AGENT ROOT FACT", supports: true });
  s.agentTool("propose_direction", { question_id: "q2", direction: "AGENT DIRECTION", reasons: "r", rejected: "", open_questions: "" });
  const text = systemInstruction(s, { fallback: false, roleSwitch: false });
  assert.match(text, /AGENT REASON/);
  assert.match(text, /AGENT ROOT FACT/);
  assert.match(text, /AGENT DIRECTION/);
});

test("RR1: a stale page list that would push an agent question over the cap is refused, keeping the agent question", async () => {
  const s = await fresh();
  for (let i = 0; i < 19; i++) s.addQuestion(`問い ${i}`, "agent");
  const base = s.snapshot().questionsVersion;
  s.addQuestion("二十番目（エージェント）", "agent");
  const stale = Array.from({ length: 20 }, (_, i) => ({ text: `人の問い ${i}`, checked: true }));
  assert.throws(() => s.editQuestions(stale, base), (e: unknown) => e instanceof WhyError && e.code === "conflict");
  assert.ok(s.questions.some((q) => q.text === "二十番目（エージェント）"));
});

test("RR2: a person's question can be added during the deep dive (an edit that missed the agent's start)", async () => {
  const s = await diving();
  const r = s.addQuestion("入力中だった問い", "person");
  assert.equal(r.questionId, "q3");
  assert.equal(s.dives.at(-1)?.by, undefined);
});
