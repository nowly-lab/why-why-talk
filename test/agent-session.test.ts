import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkSession } from "../src/talk/session.ts";
import { renderResultMarkdown } from "../src/talk/result.ts";
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
