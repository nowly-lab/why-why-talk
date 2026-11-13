import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFragment, type Line } from "../web/transcript.ts";
import { nextConnection, PROACTIVE_RECONNECT_MS, type LinkState } from "../web/reconnect.ts";
import { floatToPcm16Base64, pcm16Base64ToFloat } from "../web/pcm.ts";
import { treeRows } from "../web/tree-rows.ts";

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
  assert.deepEqual(nextConnection(s, { kind: "start" }), { handle: null, fallback: false });
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
