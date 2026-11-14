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
  assert.deepEqual(bad, { error: "x", tree: [], belowTarget: [{ id: "n2", depth: 2 }] });
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
  const { submitAfterAnswers } = await import("../web/answers.ts");
  const { createAnswerCollector } = await import("../web/answers.ts");
  const q = createSerialQueue();
  const order: string[] = [];
  const c = createAnswerCollector();
  c.person("無料枠は?");
  c.gemini("10万です");
  void q(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("transcript"); });
  await submitAfterAnswers({
    queue: q,
    collector: c,
    answering: true,
    freeze: () => order.push("freeze"),
    recordAnswer: async (e) => { order.push(`answer:${e.question}`); },
    submit: async () => { order.push("submit"); },
  });
  assert.deepEqual(order, ["freeze", "transcript", "answer:無料枠は?", "submit"]);
});

test("submitAfterAnswers still submits when recording the answer fails", async () => {
  const { submitAfterAnswers, createAnswerCollector } = await import("../web/answers.ts");
  const c = createAnswerCollector();
  c.person("q");
  c.gemini("a");
  let submitted = false;
  await submitAfterAnswers({ queue: createSerialQueue(), collector: c, answering: true, freeze() {}, recordAnswer: async () => { throw new Error("x"); }, submit: async () => { submitted = true; } });
  assert.ok(submitted);
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
