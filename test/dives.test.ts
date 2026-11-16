import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkSession } from "../src/talk/session.ts";
import { FUNCTION_DECLARATIONS } from "../src/talk/tools.ts";
import { WhyError } from "../src/model.ts";

const now = () => "2026-11-16T01:00:00.000Z";
const direction = { direction: "方針", reasons: "理由", rejected: "見送り", openQuestions: "疑問" };

async function fresh(topic?: string) {
  const outDir = await mkdtemp(join(tmpdir(), "why-dives-"));
  return new TalkSession({ topic, context: "", outDir, now });
}

/** A session in deep_dive over the given questions (all checked). */
async function diving(texts = ["一つめの問い", "二つめの問い", "三つめの問い"]) {
  const s = await fresh();
  s.appendFreeTalk("自由に話した");
  s.setQuestions(texts);
  s.editQuestions(texts.map((text) => ({ text, checked: true })));
  s.startDeepDive();
  return s;
}

/** Digs `n` whys under `parent` through the tools; returns the last id. */
function dig(s: TalkSession, parent: string, n: number, word = "理由"): string {
  let last = parent;
  for (let i = 0; i < n; i++) {
    const r = s.applyTool("add_whys", { parent_id: last, items: [{ text: `${word}${i}`, viewpoint: "手順・プロセス" }] });
    assert.ok(r.ok, JSON.stringify(r));
    last = r.ok ? r.added[0] : last;
    s.applyTool("update_branch", { node_id: last, state: "digging" });
  }
  return last;
}

function whyCode(fn: () => unknown): string {
  try { fn(); } catch (e) { assert.ok(e instanceof WhyError); return `${e.code}: ${e.message}`; }
  assert.fail("expected WhyError");
}

test("starts in free_talk without a topic and in questions with one", async () => {
  const a = await fresh();
  assert.equal(a.phase, "free_talk");
  assert.equal(a.topic, null);
  assert.deepEqual(a.analysis.nodes, []);
  const b = await fresh("論点");
  assert.equal(b.phase, "questions");
  assert.equal(b.topic, "論点");
});

test("hasMaterial needs free talk, a file, context or a topic", async () => {
  const s = await fresh();
  assert.equal(s.hasMaterial(), false);
  s.appendFreeTalk("   ");
  assert.equal(s.hasMaterial(), false);
  s.addFile({ name: "a.md", mimeType: "text/markdown", summary: "要点" });
  assert.equal(s.hasMaterial(), true);
  assert.equal((await fresh("論点")).hasMaterial(), true);
});

test("setQuestions keeps at most 10, all unchecked", async () => {
  const s = await fresh();
  s.appendFreeTalk("話");
  s.setQuestions(Array.from({ length: 12 }, (_, i) => `問い${i}`));
  assert.equal(s.phase, "questions");
  assert.equal(s.questions.length, 10);
  assert.ok(s.questions.every((q) => q.checked === false));
});

test("editQuestions refuses blanks and more than 10", async () => {
  const s = await fresh("論点");
  assert.match(whyCode(() => s.editQuestions([{ text: " ", checked: true }])), /^invalid_input/);
  assert.match(whyCode(() => s.editQuestions(Array.from({ length: 11 }, (_, i) => ({ text: `q${i}`, checked: false })))), /^invalid_input/);
});

test("startDeepDive needs a checked question and roots them in list order", async () => {
  const s = await fresh("論点");
  s.setQuestions(["A", "B", "C"]);
  assert.match(whyCode(() => s.startDeepDive()), /^invalid_state/);
  s.editQuestions([{ text: "A", checked: true }, { text: "B", checked: false }, { text: "C", checked: true }]);
  s.startDeepDive();
  assert.equal(s.phase, "deep_dive");
  assert.deepEqual(s.analysis.nodes.map((n) => [n.id, n.text]), [["q1", "A"], ["q2", "C"]]);
  assert.deepEqual(s.dives.map((d) => [d.questionId, d.status]), [["q1", "digging"], ["q2", "pending"]]);
  assert.deepEqual(s.current(), { questionId: "q1", text: "A" });
});

test("tools are refused outside deep_dive", async () => {
  const s = await fresh();
  const r = s.applyTool("add_whys", { parent_id: "q1", items: [{ text: "x", viewpoint: "検知" }] });
  assert.equal(r.ok, false);
});

test("function declarations include next_question and propose_direction needs question_id", () => {
  assert.deepEqual(FUNCTION_DECLARATIONS.map((f) => f.name), ["add_whys", "add_fact", "update_branch", "propose_direction", "switch_role", "next_question"]);
  const pd = FUNCTION_DECLARATIONS.find((f) => f.name === "propose_direction")!;
  assert.ok((pd.parameters!.required ?? []).includes("question_id"));
});

test("add_whys under another question is refused", async () => {
  const s = await diving();
  const r = s.applyTool("add_whys", { parent_id: "q2", items: [{ text: "x", viewpoint: "検知" }] });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /q1/.test(r.error));
});

test("gemini cannot advance before the question is ready", async () => {
  const s = await diving();
  const shallow = dig(s, "q1", 2);
  const no = s.applyTool("next_question", {});
  assert.ok(!no.ok && no.error.includes(shallow));
  assert.equal(s.dives[0].status, "digging");
  dig(s, shallow, 3, "深");
  const yes = s.applyTool("next_question", {});
  assert.ok(yes.ok, JSON.stringify(yes));
  assert.deepEqual(s.dives.map((d) => d.status), ["done", "digging", "pending"]);
  assert.ok(yes.ok && yes.current?.questionId === "q2");
});

test("the person can skip and the question becomes partial", async () => {
  const s = await diving();
  const r = s.advance("person");
  assert.equal(r.moved, true);
  assert.equal(r.finished.status, "partial");
  assert.deepEqual(r.current, { questionId: "q2", text: "二つめの問い" });
});

test("advancing past the last question leaves current null", async () => {
  const s = await diving(["一つだけ"]);
  dig(s, "q1", 5);
  const r = s.applyTool("next_question", {});
  assert.ok(r.ok && r.current === null);
  assert.equal(s.current(), null);
  const again = s.applyTool("next_question", {});
  assert.ok(again.ok);
  assert.deepEqual(s.dives.map((d) => d.status), ["done"]);
  assert.equal(s.advance("person").moved, false);
});

test("propose_direction drafts for the named question", async () => {
  const s = await diving();
  const r = s.applyTool("propose_direction", { question_id: "q1", direction: "A", reasons: "B", rejected: "C", open_questions: "D" });
  assert.ok(r.ok);
  assert.deepEqual(s.dives[0].draft, { direction: "A", reasons: "B", rejected: "C", openQuestions: "D" });
  const bad = s.applyTool("propose_direction", { question_id: "q9", direction: "A", reasons: "B", rejected: "C", open_questions: "D" });
  assert.equal(bad.ok, false);
});

test("submit requires a direction for done questions only", async () => {
  const s = await diving(["一", "二"]);
  dig(s, "q1", 5);
  s.applyTool("next_question", {});
  assert.match(whyCode(() => s.submit({})), /q1 の方針が空です/);
  s.submit({ q1: direction });
  assert.equal(s.status, "sent");
  assert.deepEqual(s.dives[0].draft, direction);
});

test("submit from free_talk is allowed", async () => {
  const s = await fresh();
  s.appendFreeTalk("話しただけ");
  s.submit({});
  assert.equal(s.status, "sent");
});

test("free talk and file summaries are redacted", async () => {
  const s = await fresh();
  const key = "AIza" + "S".repeat(35);
  s.appendFreeTalk(`鍵は ${key} です`);
  s.addFile({ name: "a.md", mimeType: "text/markdown", summary: `鍵 ${key}` });
  assert.ok(!JSON.stringify(s.snapshot()).includes(key));
});

test("backToFreeTalk only from questions", async () => {
  const s = await fresh("論点");
  s.backToFreeTalk();
  assert.equal(s.phase, "free_talk");
  const d = await diving();
  assert.match(whyCode(() => d.backToFreeTalk()), /^invalid_state/);
  assert.match(whyCode(() => d.appendFreeTalk("x")), /^invalid_state/);
  assert.match(whyCode(() => d.addFile({ name: "a.md", mimeType: "text/markdown", summary: "x" })), /^invalid_state/);
});

test("snapshot carries phase, questions, dives and current", async () => {
  const s = await diving();
  const v = s.snapshot();
  assert.equal(v.phase, "deep_dive");
  assert.equal(v.questions.length, 3);
  assert.equal(v.dives.length, 3);
  assert.deepEqual(v.current, { questionId: "q1", text: "一つめの問い" });
  assert.equal(v.freeTalk[0].text, "自由に話した");
});

// --- per-question result (task 6) ---
import { renderResultMarkdown, resultJson } from "../src/talk/result.ts";

test("result has one section per checked question with its status", async () => {
  const s = await diving(["一つめ", "二つめ", "三つめ"]);
  dig(s, "q1", 5);
  s.applyTool("propose_direction", { question_id: "q1", direction: "一つめの方針", reasons: "r", rejected: "x", open_questions: "o" });
  s.applyTool("next_question", {});
  s.advance("person");
  s.submit({});
  const md = renderResultMarkdown(s);
  assert.match(md, /^# 深掘りの結果: 問い 3 件/);
  const i1 = md.indexOf("## 問い 1: 一つめ(終わった)");
  const i2 = md.indexOf("## 問い 2: 二つめ(途中)");
  const i3 = md.indexOf("## 問い 3: 三つめ(掘っている途中)");
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, md);
  assert.ok(md.indexOf("一つめの方針") > i1 && md.indexOf("一つめの方針") < i2);
  for (const h of ["### 方針", "### 理由", "### 見送った案", "### 残った疑問", "### 深さ不足の枝", "### なぜの木"]) assert.ok(md.slice(i1, i2).includes(h), h);
});

test("each question tree only shows its own nodes", async () => {
  const s = await diving(["一つめ", "二つめ"]);
  dig(s, "q1", 1, "いちの理由");
  s.advance("person");
  dig(s, "q2", 1, "にの理由");
  s.submit({});
  const md = renderResultMarkdown(s);
  const q2 = md.indexOf("## 問い 2:");
  assert.ok(md.slice(0, q2).includes("いちの理由0") && !md.slice(0, q2).includes("にの理由0"));
  assert.ok(md.slice(q2).includes("にの理由0"));
});

test("result with a topic keeps it in the heading", async () => {
  const s = await fresh("決済エラーをどう防ぐか");
  s.submit({});
  assert.match(renderResultMarkdown(s), /^# 深掘りの結果: 決済エラーをどう防ぐか/);
});

test("sending from free_talk prints the free talk and files, no question sections", async () => {
  const s = await fresh();
  s.appendFreeTalk("論点を先に決めるとずれる");
  s.addFile({ name: "memo.md", mimeType: "text/markdown", summary: "- 要点その一" });
  s.submit({});
  const md = renderResultMarkdown(s);
  assert.match(md, /^# 深掘りの結果: 問い 0 件/);
  assert.ok(!md.includes("## 問い 1"));
  assert.match(md, /## 自由に話した内容\n\n\d\d:\d\d:\d\d あなた: 論点を先に決めるとずれる/);
  assert.match(md, /## 添付ファイルの要点\n\n### memo.md\n\n- 要点その一/);
});

test("unchecked questions are listed separately", async () => {
  const s = await fresh("論点");
  s.setQuestions(["選んだ", "選ばなかった"]);
  s.editQuestions([{ text: "選んだ", checked: true }, { text: "選ばなかった", checked: false }]);
  s.startDeepDive();
  s.submit({});
  const md = renderResultMarkdown(s);
  assert.match(md, /## 選ばなかった問い\n\n- 選ばなかった/);
  const j = resultJson(s);
  assert.deepEqual(j.unchecked, ["選ばなかった"]);
  assert.deepEqual(j.questions.map((q) => [q.questionId, q.text, q.status]), [["q1", "選んだ", "digging"]]);
});

test("resultJson carries per-question trees and attachments", async () => {
  const s = await diving(["一つめ", "二つめ"]);
  dig(s, "q1", 2);
  s.submit({});
  const j = resultJson(s);
  assert.equal(j.questions[0].tree.length, 2);
  assert.equal(j.questions[1].tree.length, 0);
  assert.deepEqual(j.attachments, []);
  assert.equal(j.freeTalk[0].text, "自由に話した");
});

test("a question never reached is marked 未着手", async () => {
  const s = await diving(["一つめ", "二つめ", "三つめ"]);
  s.submit({});
  assert.match(renderResultMarkdown(s), /## 問い 3: 三つめ\(未着手\)/);
});
