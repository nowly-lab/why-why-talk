import { test } from "node:test";
import assert from "node:assert/strict";
import { addFact, addWhys, closeAnalysis, isBacked, startAnalysis, treeSummary, updateNode } from "../src/analysis.ts";
import { WhyError, type Analysis } from "../src/model.ts";

const now = () => "2026-11-13T00:00:00.000Z";

function base(): Analysis {
  return startAnalysis({ id: "pay-errors", title: "決済エラー", problem: "決済エラーの再発をどう防ぐか" }, now);
}

function withTwo(): Analysis {
  return addWhys(base(), "n0", [
    { text: "APIキーが期限切れ", viewpoint: "仕組み・道具" },
    { text: "決済APIの障害", viewpoint: "前提・外部" },
  ], now).analysis;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof WhyError);
    return `${e.code}: ${e.message}`;
  }
  assert.fail("expected WhyError");
}

test("startAnalysis creates root n0 holding the topic", () => {
  const a = base();
  assert.equal(a.status, "open");
  assert.deepEqual(a.nodes.map((n) => [n.id, n.parentId, n.text]), [["n0", null, "決済エラーの再発をどう防ぐか"]]);
});

test("addWhys adds candidates with sequential ids", () => {
  const a = withTwo();
  assert.deepEqual(a.nodes.map((n) => n.id), ["n0", "n1", "n2"]);
  assert.ok(a.nodes.slice(1).every((n) => n.state === "candidate" && n.parentId === "n0"));
});

test("addWhys skips duplicate text under same parent", () => {
  const r = addWhys(withTwo(), "n0", [{ text: "APIキーが期限切れ", viewpoint: "検知" }], now);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.analysis.nodes.length, 3);
});

test("addWhys rejects unknown parent", () => {
  assert.match(code(() => addWhys(base(), "n9", [{ text: "x", viewpoint: "検知" }], now)), /^not_found: .*n9/);
});

test("addWhys refuses under a rejected node", () => {
  const a = updateNode(withTwo(), "n2", { state: "rejected", reason: "正常" }, now);
  assert.match(code(() => addWhys(a, "n2", [{ text: "x", viewpoint: "検知" }], now)), /^invalid_state/);
});

test("addFact records a fact and redacts tokens", () => {
  const a = addFact(withTwo(), "n1", { summary: "応答に Authorization: Bearer sk_live_ABCDEFGHIJKLMNOP が出ていた", supports: true }, now);
  const f = a.nodes[1].facts[0];
  assert.equal(f.supports, true);
  assert.ok(f.summary.includes("[REDACTED]") && !f.summary.includes("sk_live_ABCDEFGHIJKLMNOP"));
});

test("isBacked needs a supporting fact", () => {
  let a = addFact(withTwo(), "n1", { summary: "否定", supports: false }, now);
  assert.equal(isBacked(a.nodes[1]), false);
  a = addFact(a, "n1", { summary: "支持", supports: true }, now);
  assert.equal(isBacked(a.nodes[1]), true);
});

test("updateNode leaf requires countermeasure", () => {
  const a = updateNode(withTwo(), "n1", { state: "digging" }, now);
  assert.match(code(() => updateNode(a, "n1", { state: "leaf" }, now)), /^invalid_input/);
  const b = updateNode(a, "n1", { state: "leaf", countermeasure: "期限の監視と通知", reason: "これ以上は外部の事情" }, now);
  assert.equal(b.nodes[1].countermeasure, "期限の監視と通知");
});

test("updateNode refuses a transition outside the table", () => {
  assert.match(code(() => updateNode(withTwo(), "n1", { state: "leaf", countermeasure: "x" }, now)), /^invalid_state/);
});

test("rejected can return to candidate with reason", () => {
  let a = updateNode(withTwo(), "n2", { state: "rejected", reason: "正常" }, now);
  assert.match(code(() => updateNode(a, "n2", { state: "candidate" }, now)), /^invalid_input/);
  a = updateNode(a, "n2", { state: "candidate", reason: "見直し" }, now);
  assert.equal(a.nodes[2].state, "candidate");
});

test("cannot dig under a stopped branch", () => {
  let a = updateNode(withTwo(), "n1", { state: "digging" }, now);
  a = addWhys(a, "n1", [{ text: "期限を誰も知らない", viewpoint: "人・体制" }], now).analysis;
  a = updateNode(a, "n1", { state: "rejected", reason: "外れ" }, now);
  assert.match(code(() => updateNode(a, "n3", { state: "digging" }, now)), /^invalid_state: .*n1/);
});

test("root node cannot change state", () => {
  assert.match(code(() => updateNode(withTwo(), "n0", { state: "digging" }, now)), /^invalid_input/);
});

test("closeAnalysis refuses with digging node", () => {
  const a = updateNode(withTwo(), "n1", { state: "digging" }, now);
  assert.match(code(() => closeAnalysis(a, now)), /^invalid_state/);
  const closed = closeAnalysis(withTwo(), now);
  assert.match(code(() => addWhys(closed, "n0", [{ text: "x", viewpoint: "検知" }], now)), /^invalid_state/);
});

test("treeSummary lists every node with state", () => {
  const a = updateNode(withTwo(), "n2", { state: "rejected", reason: "正常" }, now);
  assert.deepEqual(treeSummary(a), [
    { id: "n0", parentId: null, text: "決済エラーの再発をどう防ぐか", state: "digging", viewpoint: null, depth: 0 },
    { id: "n1", parentId: "n0", text: "APIキーが期限切れ", state: "candidate", viewpoint: "仕組み・道具", depth: 1 },
    { id: "n2", parentId: "n0", text: "決済APIの障害", state: "rejected", viewpoint: "前提・外部", depth: 1 },
  ]);
});

// --- depth (plan v1 Task 1) ---
import { depthOf, openBelowTarget, shallowLeaves, TARGET_DEPTH } from "../src/analysis.ts";

/** n0 → n1 → n2 → … a single chain of `levels` whys, every one set to digging. */
function chain(levels: number): Analysis {
  let a = base();
  let parent = "n0";
  for (let i = 1; i <= levels; i++) {
    const r = addWhys(a, parent, [{ text: `理由${i}`, viewpoint: "仕組み・道具" }], now);
    a = updateNode(r.analysis, r.added[0]!, { state: "digging" }, now);
    parent = r.added[0]!;
  }
  return a;
}

test("TARGET_DEPTH is 5", () => {
  assert.equal(TARGET_DEPTH, 5);
});

test("depthOf counts n0's child as 1", () => {
  const a = chain(2);
  assert.equal(depthOf(a, "n0"), 0);
  assert.equal(depthOf(a, "n1"), 1);
  assert.equal(depthOf(a, "n2"), 2);
});

test("treeSummary includes depth", () => {
  assert.deepEqual(treeSummary(chain(2)).map((n) => [n.id, n.depth]), [["n0", 0], ["n1", 1], ["n2", 2]]);
});

test("shallow leaf needs a reason", () => {
  const msg = code(() => updateNode(chain(2), "n2", { state: "leaf", countermeasure: "x" }, now));
  assert.match(msg, /^invalid_input: /);
  assert.match(msg, /2/);
  assert.match(msg, /5/);
});

test("shallow leaf with reason is stored and listed", () => {
  const a = updateNode(chain(2), "n2", { state: "leaf", countermeasure: "x", reason: "範囲外" }, now);
  const n2 = a.nodes.find((n) => n.id === "n2")!;
  assert.equal(n2.state, "leaf");
  assert.equal(n2.reason, "範囲外");
  assert.deepEqual(shallowLeaves(a).map((n) => n.id), ["n2"]);
});

test("depth-5 leaf needs no reason", () => {
  const a = updateNode(chain(5), "n5", { state: "leaf", countermeasure: "x" }, now);
  assert.equal(a.nodes.find((n) => n.id === "n5")!.state, "leaf");
  assert.deepEqual(shallowLeaves(a), []);
});

test("leaf reopened and dug deeper is no longer shallow", () => {
  let a = updateNode(chain(4), "n4", { state: "leaf", countermeasure: "x", reason: "一旦" }, now);
  assert.deepEqual(shallowLeaves(a).map((n) => n.id), ["n4"]);
  a = updateNode(a, "n4", { state: "digging" }, now);
  const r = addWhys(a, "n4", [{ text: "理由5", viewpoint: "仕組み・道具" }], now);
  a = updateNode(r.analysis, r.added[0]!, { state: "digging" }, now);
  a = updateNode(a, r.added[0]!, { state: "leaf", countermeasure: "y" }, now);
  assert.deepEqual(shallowLeaves(a), []);
});

test("openBelowTarget lists only the tips", () => {
  let a = chain(2);
  a = addWhys(a, "n1", [{ text: "別の理由", viewpoint: "検知" }], now).analysis; // n3 under n1, candidate
  assert.deepEqual(openBelowTarget(a), [{ id: "n2", depth: 2 }, { id: "n3", depth: 2 }]);
  assert.deepEqual(openBelowTarget(chain(5)), []);
});
