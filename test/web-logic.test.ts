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
