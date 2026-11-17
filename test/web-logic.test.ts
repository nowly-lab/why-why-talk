import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFragment, type Line } from "../web/transcript.ts";
import { nextConnection, PROACTIVE_RECONNECT_MS, type LinkState } from "../web/reconnect.ts";
import { floatToPcm16Base64, pcm16Base64ToFloat } from "../web/pcm.ts";
import { treeRows } from "../web/tree-rows.ts";
import { retryDelay, MAX_RETRIES, createRetryBudget } from "../web/reconnect.ts";
import { downsample } from "../web/pcm.ts";
import { createSerialQueue } from "../web/queue.ts";

test("transcript fragments merge per speaker within 4s", () => {
  let lines: Line[] = [];
  lines = appendFragment(lines, "gemini", "なぜ、", 0);
  lines = appendFragment(lines, "gemini", "気づけなかったのですか?", 1000);
  lines = appendFragment(lines, "person", "場所がなくて", 2000);
  lines = appendFragment(lines, "person", "通知もなかった", 7000);
  assert.deepEqual(lines.map((l) => [l.speaker, l.text]), [
    ["gemini", "なぜ、気づけなかったのですか?"],
    ["person", "場所がなくて"],
    ["person", "通知もなかった"],
  ]);
});

test("reconnect: first connect has no handle", () => {
  const s: LinkState = { handle: null, connectedAt: null };
  assert.deepEqual(nextConnection(s, { kind: "start", hasHistory: false }), { handle: null, fallback: false });
});

test("reconnect: goAway or close resumes with the handle", () => {
  const s: LinkState = { handle: "h1", connectedAt: 0 };
  assert.deepEqual(nextConnection(s, { kind: "goAway" }), { handle: "h1", fallback: false });
  assert.deepEqual(nextConnection(s, { kind: "closed" }), { handle: "h1", fallback: false });
});

test("reconnect: rejected or missing handle falls back to a seeded new talk", () => {
  assert.deepEqual(nextConnection({ handle: "h1", connectedAt: 0 }, { kind: "handleRejected" }), { handle: null, fallback: true });
  assert.deepEqual(nextConnection({ handle: null, connectedAt: 0 }, { kind: "closed" }), { handle: null, fallback: true });
});

test("reconnect: proactive at 25 minutes", () => {
  assert.equal(PROACTIVE_RECONNECT_MS, 25 * 60_000);
  const s: LinkState = { handle: "h2", connectedAt: 0 };
  assert.equal(nextConnection(s, { kind: "tick", now: PROACTIVE_RECONNECT_MS - 1 }), null);
  assert.deepEqual(nextConnection(s, { kind: "tick", now: PROACTIVE_RECONNECT_MS }), { handle: "h2", fallback: false });
});

test("pcm16 base64 round trip keeps samples within 1/32768", () => {
  const input = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const out = pcm16Base64ToFloat(floatToPcm16Base64(input));
  assert.equal(out.length, input.length);
  for (let i = 0; i < input.length; i++) assert.ok(Math.abs(out[i] - input[i]) <= 1 / 32768 + 1e-6, `${i}`);
});

test("pcm16 clamps out-of-range samples", () => {
  const out = pcm16Base64ToFloat(floatToPcm16Base64(new Float32Array([2, -2])));
  assert.ok(out[0] <= 1 && out[0] > 0.99);
  assert.equal(out[1], -1);
});

test("tree rows are depth-first with depth", () => {
  const nodes = [
    { id: "n0", parentId: null, text: "論点", state: "digging" },
    { id: "n1", parentId: "n0", text: "a", state: "candidate" },
    { id: "n2", parentId: "n0", text: "b", state: "rejected" },
    { id: "n3", parentId: "n1", text: "a1", state: "candidate" },
  ];
  assert.deepEqual(treeRows(nodes).map((r) => [r.node.id, r.depth]), [["n0", 0], ["n1", 1], ["n3", 2], ["n2", 1]]);
});


test("reconnect: a reloaded page with history starts seeded", () => {
  assert.deepEqual(nextConnection({ handle: null, connectedAt: null }, { kind: "start", hasHistory: true }), { handle: null, fallback: true });
  assert.deepEqual(nextConnection({ handle: null, connectedAt: null }, { kind: "start", hasHistory: false }), { handle: null, fallback: false });
});

test("reconnect: backoff doubles and caps, then gives up", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(retryDelay), [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.equal(retryDelay(MAX_RETRIES), null);
});

test("downsample 48 kHz to 16 kHz keeps a third of the samples and averages", () => {
  const input = new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6, 0.9, 0.9, 0.9]);
  const out = downsample(input, 48_000, 16_000);
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out[0] - 0.3) < 1e-6 && Math.abs(out[1] + 0.6) < 1e-6 && Math.abs(out[2] - 0.9) < 1e-6);
  assert.equal(downsample(input, 16_000, 16_000), input);
});

test("serial queue runs tasks in order even when earlier ones are slower", async () => {
  const q = createSerialQueue();
  const order: number[] = [];
  const slow = q(async () => { await new Promise((r) => setTimeout(r, 30)); order.push(1); });
  const fast = q(async () => { order.push(2); });
  const failing = q(async () => { throw new Error("x"); });
  const after = q(async () => { order.push(3); });
  await Promise.allSettled([slow, fast, failing, after]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("retry budget: connections that open then close quickly still run out", () => {
  const b = createRetryBudget();
  const delays: Array<number | null> = [];
  for (let i = 0; i < 7; i++) {
    b.connected();
    delays.push(b.failed());
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, null]);
});

test("retry budget: a connection that stayed up resets the budget", () => {
  const b = createRetryBudget();
  b.failed();
  b.failed();
  b.connected();
  b.stable();
  assert.equal(b.failed(), 1000);
});

test("tool response for Gemini keeps belowTarget", async () => {
  const { toGeminiResponse } = await import("../web/api.ts");
  const ok = toGeminiResponse({ ok: true, added: ["n1"], tree: [{ id: "n1", text: "t", state: "candidate", depth: 1 }], belowTarget: [{ id: "n1", depth: 1 }] });
  assert.deepEqual(ok.belowTarget, [{ id: "n1", depth: 1 }]);
  assert.equal(ok.result, "ok");
  const bad = toGeminiResponse({ ok: false, error: "x", tree: [], belowTarget: [{ id: "n2", depth: 2 }] });
  assert.deepEqual(bad, { error: "x", tree: [], belowTarget: [{ id: "n2", depth: 2 }], current: null });
});

test("treeRows depth matches server depth and the depth tag", async () => {
  const { depthTag } = await import("../web/tree-rows.ts");
  const nodes = [
    { id: "n0", parentId: null, text: "論点", state: "digging", depth: 0 },
    { id: "n1", parentId: "n0", text: "a", state: "digging", depth: 1 },
    { id: "n2", parentId: "n1", text: "b", state: "leaf", depth: 2, reason: "範囲外" },
  ];
  assert.deepEqual(treeRows(nodes).map((r) => r.depth), [0, 1, 2]);
  assert.equal(depthTag(2), "2/5段");
  assert.equal(depthTag(7), "7段");
});

// --- answers (plan v1 Task 5) ---
test("readGrounding reads queries and web chunks", async () => {
  const { readGrounding } = await import("../web/answers.ts");
  assert.deepEqual(
    readGrounding({ webSearchQueries: ["a", "b"], groundingChunks: [{ web: { uri: "https://x.example/p", title: "X" } }, { web: { uri: "" } }, {}] }),
    { queries: ["a", "b"], sources: [{ title: "X", uri: "https://x.example/p" }] },
  );
});

test("readGrounding tolerates missing metadata", async () => {
  const { readGrounding } = await import("../web/answers.ts");
  assert.deepEqual(readGrounding(undefined), { queries: [], sources: [] });
  assert.deepEqual(readGrounding({ webSearchQueries: "nope" }), { queries: [], sources: [] });
});

test("collector pairs the person's question with Gemini's answer", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("Workers の無料枠は");
  c.person("1日何回まで?");
  c.gemini("1日10万");
  c.gemini("リクエストです。");
  c.grounding({ queries: ["workers free limit"], sources: [] });
  c.grounding({ queries: ["workers free limit", "cloudflare 上限"], sources: [{ title: "D", uri: "https://d.example" }] });
  assert.deepEqual(c.turnComplete(), {
    question: "Workers の無料枠は1日何回まで?",
    answer: "1日10万リクエストです。",
    queries: ["workers free limit", "cloudflare 上限"],
    sources: [{ title: "D", uri: "https://d.example" }],
  });
});

test("skips an interrupted turn with no answer", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("質問");
  c.interrupted();
  assert.equal(c.turnComplete(), null);
});

test("collector resets after turnComplete", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("q1");
  c.gemini("a1");
  assert.ok(c.turnComplete());
  assert.equal(c.turnComplete(), null);
  c.person("q2");
  c.gemini("a2");
  assert.equal(c.turnComplete()?.question, "q2");
});

// --- review round 1 ---
test("an interrupted question does not leak into the next answer", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("Q1");
  c.gemini("partial");
  c.interrupted();
  assert.equal(c.turnComplete(), null);
  c.person("Q2");
  c.gemini("A2");
  assert.equal(c.turnComplete()?.question, "Q2");
});

test("a follow-up spoken before the interrupt is kept as the question", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("Q1");
  c.gemini("partial");
  c.person("Q2");
  c.interrupted();
  c.gemini("A2");
  assert.deepEqual([c.turnComplete()?.question, c.turnComplete()], ["Q2", null]);
});

test("Gemini speaking as interviewer ends the person's turn; the question said with 交代して is kept", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("昔の発言");
  c.otherTurn(); // Gemini spoke as the interviewer
  c.person("交代して。Workers の無料枠は?");
  // switch_role arrives; the page starts feeding Gemini's words
  c.gemini("10万です");
  assert.equal(c.turnComplete()?.question, "交代して。Workers の無料枠は?");
});

test("reset clears everything for a role change from the button", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("Q1");
  c.reset();
  c.gemini("A");
  assert.equal(c.turnComplete()?.question, "");
});

test("submit queued behind a pending answer runs after it", async () => {
  const q = createSerialQueue();
  const order: string[] = [];
  void q(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("transcript"); });
  void q(async () => { order.push("answer"); });
  await q(async () => { order.push("submit"); });
  assert.deepEqual(order, ["transcript", "answer", "submit"]);
});

// --- review round 2 ---
test("follow-up fragments on both sides of the interrupt stay one question", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("Q1");
  c.gemini("partial");
  c.person("Workers の");
  c.interrupted();
  c.person("無料枠は?");
  c.gemini("A2");
  assert.equal(c.turnComplete()?.question, "Workers の無料枠は?");
});

test("submitAfterAnswers freezes, records the answer in progress, then submits after queued writes", async () => {
  const { submitAfterAnswers, createAnswerCollector, createPendingAnswers } = await import("../web/answers.ts");
  const q = createSerialQueue();
  const order: string[] = [];
  const c = createAnswerCollector();
  c.person("無料枠は?");
  c.gemini("10万です");
  const pending = createPendingAnswers(async (e) => { order.push(`answer:${e.question}`); });
  void q(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("transcript"); });
  await submitAfterAnswers({ queue: q, collector: c, answering: true, freeze: () => order.push("freeze"), pending, submit: async () => { order.push("submit"); } });
  assert.deepEqual(order, ["freeze", "transcript", "answer:無料枠は?", "submit"]);
});

test("a failed answer write blocks the submit and is retried next time", async () => {
  const { submitAfterAnswers, createAnswerCollector, createPendingAnswers } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("q");
  c.gemini("a");
  let fail = true;
  const saved: string[] = [];
  const pending = createPendingAnswers(async (e) => { if (fail) throw new Error("HTTP 500"); saved.push(e.answer); });
  let submitted = 0;
  const opts = { queue: createSerialQueue(), collector: c, answering: true, freeze() {}, pending, submit: async () => { submitted++; } };
  await assert.rejects(submitAfterAnswers(opts), /Gemini の答えを記録できませんでした: HTTP 500/);
  assert.equal(submitted, 0);
  assert.equal(pending.size(), 1);
  fail = false;
  await submitAfterAnswers(opts);
  assert.deepEqual(saved, ["a"]);
  assert.equal(submitted, 1);
  assert.equal(pending.size(), 0);
});

test("an empty turnComplete after the interrupt keeps the follow-up started before it", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("Q1");
  c.gemini("partial");
  c.person("Workers の");
  c.interrupted();
  assert.equal(c.turnComplete(), null);
  c.person("無料枠は?");
  c.gemini("A2");
  assert.equal(c.turnComplete()?.question, "Workers の無料枠は?");
});

test("a stalled link resumes with the handle, or falls back to the transcript without one", () => {
  assert.deepEqual(nextConnection({ handle: "h1", connectedAt: 0 }, { kind: "stalled" }), { handle: "h1", fallback: false });
  assert.deepEqual(nextConnection({ handle: null, connectedAt: 0 }, { kind: "stalled" }), { handle: null, fallback: true });
});

test("a tool call whose local request never answers fails after the deadline instead of hanging", async (t) => {
  const { createApi } = await import("../web/api.ts");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  const api = createApi("n", { toolTimeoutMs: 30 });
  await assert.rejects(api.tool("add_whys", {}), /秒応答がありません/);
});

// --- question list (2026-11-16) ---
import { canStart, diveLabel, moveQuestion } from "../web/questions.ts";
import { toGeminiResponse } from "../web/api.ts";

test("moveQuestion moves up and down and keeps the rest", () => {
  const list = [{ text: "A", checked: false }, { text: "B", checked: true }, { text: "C", checked: false }];
  assert.deepEqual(moveQuestion(list, 2, 0).map((q) => q.text), ["C", "A", "B"]);
  assert.deepEqual(moveQuestion(list, 0, 1).map((q) => q.text), ["B", "A", "C"]);
  assert.deepEqual(moveQuestion(list, 0, -1), list, "out of range does nothing");
  assert.deepEqual(list.map((q) => q.text), ["A", "B", "C"], "the input is not changed");
});

test("canStart is false with no checks or an empty text", () => {
  assert.equal(canStart([{ text: "A", checked: false }]), false);
  assert.equal(canStart([{ text: "A", checked: true }]), true);
  assert.equal(canStart([{ text: "A", checked: true }, { text: " ", checked: false }]), false);
  assert.equal(canStart([]), false);
});

test("diveLabel covers every status", () => {
  assert.deepEqual(["pending", "digging", "done", "partial"].map((s) => diveLabel(s as never)), ["未着手", "掘っている途中", "終わった", "途中"]);
});

test("Gemini gets the current question with every tool answer", () => {
  const ok = toGeminiResponse({ ok: true, tree: [], current: { questionId: "q2", text: "二" } });
  assert.deepEqual(ok.current, { questionId: "q2", text: "二" });
  const last = toGeminiResponse({ ok: true, tree: [], current: null });
  assert.equal(last.current, null);
  const bad = toGeminiResponse({ ok: false, error: "x", tree: [], current: { questionId: "q1", text: "一" } });
  assert.deepEqual(bad.current, { questionId: "q1", text: "一" });
});

test("treeOf keeps only one question's tree", async () => {
  const { treeOf } = await import("../web/questions.ts");
  const nodes = [
    { id: "q1", parentId: null }, { id: "q2", parentId: null },
    { id: "n1", parentId: "q1" }, { id: "n2", parentId: "q2" }, { id: "n3", parentId: "n1" },
  ];
  assert.deepEqual(treeOf(nodes, "q1").map((n) => n.id), ["q1", "n1", "n3"]);
  assert.deepEqual(treeOf(nodes, "q9"), []);
});

test("selectedLabel says how many are checked", async () => {
  const { selectedLabel } = await import("../web/questions.ts");
  assert.equal(selectedLabel([{ text: "A", checked: false }]), "0件を選択中 · 1件以上選ぶと始められます");
  assert.equal(selectedLabel([{ text: "A", checked: true }, { text: "B", checked: true }]), "2件を選択中 · この順に深掘りします");
});

// --- review I2: question saves apply in order, stale answers are ignored ---
test("createLatestSaver sends one save at a time and skips superseded ones", async () => {
  const { createLatestSaver } = await import("../web/questions.ts");
  const sent: string[] = [];
  const releases: Array<() => void> = [];
  const applied: string[] = [];
  const saver = createLatestSaver<string>(
    (v) => { sent.push(v); return new Promise((r) => releases.push(() => r(`server:${v}`))); },
    (v) => applied.push(v),
  );
  void saver.save("A");
  await new Promise((r) => setTimeout(r, 0));
  void saver.save("AB");
  void saver.save("ABC");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, ["A"], "nothing else is sent while A is in flight");
  releases[0]();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, ["A", "ABC"], "AB was superseded before its turn");
  releases[1]();
  await saver.settled();
  assert.deepEqual(applied, ["server:ABC"], "only the newest answer is applied");
});

test("createLatestSaver.settled rejects when the latest save failed", async () => {
  const { createLatestSaver } = await import("../web/questions.ts");
  const saver = createLatestSaver<string>(async () => { throw new Error("400"); }, () => undefined);
  await saver.save("x").catch(() => undefined);
  await assert.rejects(saver.settled(), /400/);
});

test("a task tracker waits for every pending upload", async () => {
  const { createTaskTracker } = await import("../web/questions.ts");
  const t = createTaskTracker();
  let done = false;
  t.track(new Promise((r) => setTimeout(() => { done = true; r(undefined); }, 30)));
  t.track(Promise.reject(new Error("x")));
  await t.settled();
  assert.equal(done, true);
  assert.equal(t.pending(), 0);
});

// --- re-review R2: drain waits for saves started while waiting ---
test("createLatestSaver.drain waits for a save started during the wait", async () => {
  const { createLatestSaver } = await import("../web/questions.ts");
  const releases: Array<() => void> = [];
  const applied: string[] = [];
  const saver = createLatestSaver<string>((v) => new Promise((r) => releases.push(() => r(v))), (v) => applied.push(v));
  void saver.save("A");
  await new Promise((r) => setTimeout(r, 0));
  let drained = false;
  const d = saver.drain().then(() => { drained = true; });
  void saver.save("AB");
  releases[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(drained, false, "AB is still being saved");
  releases[1]();
  await d;
  assert.deepEqual(applied, ["AB"]);
});

test("an answer is kept when Gemini switches back in the same turn", async () => {
  const { createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.gemini("なぜ遅れたのですか?");
  c.otherTurn();
  c.person("ところで無料枠の上限って何件?");
  c.gemini("1日10万件です。");
  const entry = c.turnComplete();
  assert.deepEqual(entry && [entry.question, entry.answer], ["ところで無料枠の上限って何件?", "1日10万件です。"]);
});

test("returnsAfterAnswer only for a swap made by a question, once an answer is recorded", async () => {
  const { returnsAfterAnswer } = await import("../web/answers.ts");
  const entry = { question: "q", answer: "a", queries: [], sources: [] };
  assert.equal(returnsAfterAnswer({ role: "answerer", byQuestion: true }, entry), true);
  assert.equal(returnsAfterAnswer({ role: "answerer", byQuestion: true }, null), false);
  assert.equal(returnsAfterAnswer({ role: "answerer", byQuestion: false }, entry), false);
  assert.equal(returnsAfterAnswer({ role: "interviewer", byQuestion: true }, entry), false);
});

test("leaving the answerer records the answer once, by any path (review R3)", async () => {
  const { createAnswerCollector, createPendingAnswers, leaveAnswerer } = await import("../web/answers.ts");
  const saved: string[] = [];
  const c = createAnswerCollector();
  const pending = createPendingAnswers(async (e) => { saved.push(`${e.question}|${e.answer}|${e.queries.join(",")}`); });
  c.person("無料枠の上限は?");
  c.gemini("1日10万件です。");
  c.grounding({ queries: ["workers free limit"], sources: [] });
  assert.equal(leaveAnswerer(c, pending), true);
  assert.equal(leaveAnswerer(c, pending), false, "nothing left to record the second time");
  await pending.flush();
  assert.deepEqual(saved, ["無料枠の上限は?|1日10万件です。|workers free limit"]);
});

// --- role switch restarts (role-switch plan v1 Task 3) ---
test("restartsOnSwitch: only a role change asked for by the person starts a new session", async () => {
  const { restartsOnSwitch } = await import("../web/answers.ts");
  const asked = { role: "interviewer", byQuestion: false } as const;
  const answering = { role: "answerer", byQuestion: false } as const;
  assert.equal(restartsOnSwitch({ name: "switch_role", args: { to: "answerer" } }, { role: "answerer" }, asked), true);
  assert.equal(restartsOnSwitch({ name: "switch_role", args: { to: "interviewer", by: "request" } }, { role: "interviewer" }, answering), true);
  assert.equal(restartsOnSwitch({ name: "switch_role", args: { to: "answerer", by: "question" } }, { role: "answerer" }, asked), false);
  assert.equal(restartsOnSwitch({ name: "switch_role", args: { to: "answerer" } }, { error: "bad", role: "answerer" }, asked), false);
  assert.equal(restartsOnSwitch({ name: "switch_role", args: { to: "answerer" } }, { role: "answerer" }, answering), false);
  // A tree tool from an answerer a question swapped in means it is back to interviewing: no new session.
  assert.equal(restartsOnSwitch({ name: "add_whys", args: {} }, { role: "interviewer" }, answering), false);
  // Coming back from a question-triggered answer stays on the connection even when Gemini leaves out by.
  assert.equal(restartsOnSwitch({ name: "switch_role", args: { to: "interviewer" } }, { role: "interviewer" }, { role: "answerer", byQuestion: true }), false);
});

test("ROLE_KICK tells the new session its role", async () => {
  const { ROLE_KICK, ROLE_RESTART_WAIT_MS } = await import("../web/answers.ts");
  assert.match(ROLE_KICK.answerer, /答える係/);
  assert.match(ROLE_KICK.interviewer, /聞き手に戻って/);
  assert.equal(ROLE_RESTART_WAIT_MS, 10_000);
});

import { agentChangeNote } from "../web/questions.ts";

test("agentChangeNote tells Gemini what Claude added, in one line, and nothing when Claude added nothing", () => {
  const before = { tree: [{ id: "q1", parentId: null, text: "なぜホストはフロアごとか", state: "digging", facts: [] }], questions: [{ text: "なぜホストはフロアごとか", checked: true }] };
  const after = {
    tree: [
      { ...before.tree[0], facts: [{ summary: "会議で「部屋の単位だから」", supports: true, by: "agent" as const }] },
      { id: "n1", parentId: "q1", text: "フロアが部屋の単位だから", state: "candidate", facts: [], by: "agent" as const },
      { id: "n2", parentId: "q1", text: "Gemini が足した枝", state: "candidate", facts: [] },
    ],
    questions: [...before.questions, { text: "オフィス全体のホストは要るか", checked: true, by: "agent" as const }],
  };
  const note = agentChangeNote(before, after)!;
  assert.match(note, /^画面から: 会議の Claude が書き足しました/);
  assert.match(note, /問い「オフィス全体のホストは要るか」/);
  assert.match(note, /n1「フロアが部屋の単位だから」/);
  assert.match(note, /q1 に事実「会議で「部屋の単位だから」」/);
  assert.doesNotMatch(note, /Gemini が足した枝/);
  assert.equal(agentChangeNote(after, after), null);
});
