import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addEvidence,
  addWhys,
  applyFieldValues,
  closeAnalysis,
  isBacked,
  nextBranch,
  startAnalysis,
  updateNode,
} from "../src/analysis.ts";
import { WhyError, type Analysis } from "../src/model.ts";

const now = () => "2026-11-13T00:00:00.000Z";

function base(): Analysis {
  return startAnalysis({ id: "pay-errors", title: "決済エラー", problem: "10時から決済の認証エラーが増えた" }, now);
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

test("startAnalysis creates root n0 holding the problem", () => {
  const a = base();
  assert.equal(a.status, "open");
  assert.equal(a.nodes.length, 1);
  assert.equal(a.nodes[0].id, "n0");
  assert.equal(a.nodes[0].parentId, null);
  assert.equal(a.nodes[0].text, "10時から決済の認証エラーが増えた");
});

test("addWhys adds candidates with sequential ids", () => {
  const a = withTwo();
  assert.deepEqual(a.nodes.map((n) => n.id), ["n0", "n1", "n2"]);
  assert.ok(a.nodes.slice(1).every((n) => n.state === "candidate" && n.parentId === "n0"));
});

test("addWhys skips duplicate text under same parent", () => {
  const r = addWhys(withTwo(), "n0", [{ text: "APIキーが期限切れ", viewpoint: "検知" }], now);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.added.length, 0);
  assert.equal(r.analysis.nodes.length, 3);
});

test("addWhys rejects unknown parent", () => {
  const msg = code(() => addWhys(base(), "n9", [{ text: "x", viewpoint: "検知" }], now));
  assert.match(msg, /^not_found: .*n9/);
});

test("addWhys refuses under a rejected node", () => {
  const a = updateNode(withTwo(), "n2", { state: "rejected", reason: "ステータスページは正常" }, now);
  assert.match(code(() => addWhys(a, "n2", [{ text: "x", viewpoint: "検知" }], now)), /^invalid_state/);
});

test("addEvidence marks evaluation stale", () => {
  let a = applyFieldValues(withTwo(), "n1", { likelihood: { value: 0.8, lowConfidence: false } }, "clef", now);
  assert.equal(a.nodes[1].evaluation?.stale, false);
  a = addEvidence(a, "n1", { kind: "log", ref: "logs/pay", summary: "401 が急増", supports: true }, now);
  assert.equal(a.nodes[1].evaluation?.stale, true);
});

test("addEvidence redacts bearer token", () => {
  const a = addEvidence(withTwo(), "n1", {
    kind: "log", ref: "req", summary: "Authorization: Bearer sk_live_ABCDEFGHIJKLMNOP", supports: true,
  }, now);
  const s = a.nodes[1].evidence[0].summary;
  assert.ok(s.includes("[REDACTED]"));
  assert.ok(!s.includes("sk_live_ABCDEFGHIJKLMNOP"));
});

test("isBacked needs a supporting evidence", () => {
  let a = addEvidence(withTwo(), "n1", { kind: "log", ref: "r", summary: "否定", supports: false }, now);
  assert.equal(isBacked(a.nodes[1]), false);
  a = addEvidence(a, "n1", { kind: "log", ref: "r", summary: "支持", supports: true }, now);
  assert.equal(isBacked(a.nodes[1]), true);
});

test("applyFieldValues keeps history and overwrites only given fields", () => {
  let a = applyFieldValues(withTwo(), "n1", {
    likelihood: { value: 0.5, lowConfidence: true }, impact: { value: 0.9, lowConfidence: false },
  }, "clef", now);
  a = applyFieldValues(a, "n1", { likelihood: { value: 0.8, lowConfidence: false } }, "agent", now);
  const ev = a.nodes[1].evaluation!;
  assert.equal(ev.fields.likelihood?.value, 0.8);
  assert.equal(ev.fields.likelihood?.source, "agent");
  assert.equal(ev.fields.impact?.source, "clef");
  assert.equal(ev.history.length, 1);
  assert.equal(ev.history[0].field, "likelihood");
  assert.equal(ev.history[0].value, 0.5);
});

test("applyFieldValues rejects values outside 0..1", () => {
  assert.match(code(() => applyFieldValues(withTwo(), "n1", { impact: { value: 1.5, lowConfidence: false } }, "agent", now)), /^invalid_input/);
});

test("updateNode leaf requires countermeasure", () => {
  const a = updateNode(withTwo(), "n1", { state: "digging" }, now);
  assert.match(code(() => updateNode(a, "n1", { state: "leaf" }, now)), /^invalid_input/);
  const b = updateNode(a, "n1", { state: "leaf", countermeasure: "期限の監視と通知" }, now);
  assert.equal(b.nodes[1].state, "leaf");
  assert.equal(b.nodes[1].countermeasure, "期限の監視と通知");
});

test("updateNode refuses a transition outside the table", () => {
  assert.match(code(() => updateNode(withTwo(), "n1", { state: "leaf", countermeasure: "x" }, now)), /^invalid_state/);
});

test("rejected can return to candidate with reason", () => {
  let a = updateNode(withTwo(), "n2", { state: "rejected", reason: "正常" }, now);
  assert.match(code(() => updateNode(a, "n2", { state: "candidate" }, now)), /^invalid_input/);
  a = updateNode(a, "n2", { state: "candidate", reason: "人のコメントで見直し" }, now);
  assert.equal(a.nodes[2].state, "candidate");
});

test("root node cannot change state", () => {
  assert.match(code(() => updateNode(withTwo(), "n0", { state: "digging" }, now)), /^invalid_input/);
});

test("closeAnalysis refuses with digging node", () => {
  const a = updateNode(withTwo(), "n1", { state: "digging" }, now);
  assert.match(code(() => closeAnalysis(a, now)), /^invalid_state/);
  const closed = closeAnalysis(withTwo(), now);
  assert.equal(closed.status, "closed");
  assert.match(code(() => addWhys(closed, "n0", [{ text: "x", viewpoint: "検知" }], now)), /^invalid_state/);
});

test("nextBranch asks to evaluate unevaluated candidates", () => {
  assert.deepEqual(nextBranch(withTwo(), 0.2), { kind: "evaluate", nodeIds: ["n1", "n2"] });
});

test("nextBranch asks to evaluate stale candidates", () => {
  let a = withTwo();
  for (const id of ["n1", "n2"]) {
    a = applyFieldValues(a, id, { likelihood: { value: 0.5, lowConfidence: false }, impact: { value: 0.5, lowConfidence: false } }, "agent", now);
  }
  a = addEvidence(a, "n2", { kind: "doc", ref: "status", summary: "障害なし", supports: false }, now);
  assert.deepEqual(nextBranch(a, 0.2), { kind: "evaluate", nodeIds: ["n2"] });
});

test("nextBranch returns judge for low-confidence likelihood", () => {
  let a = withTwo();
  a = applyFieldValues(a, "n1", { likelihood: { value: 0.5, lowConfidence: true }, impact: { value: 0.9, lowConfidence: false } }, "clef", now);
  a = applyFieldValues(a, "n2", { likelihood: { value: 0.2, lowConfidence: false }, impact: { value: 0.2, lowConfidence: false } }, "clef", now);
  assert.deepEqual(nextBranch(a, 0.2), { kind: "judge", items: [{ nodeId: "n1", fields: ["likelihood"] }] });
});

test("nextBranch picks highest likelihood×impact", () => {
  let a = withTwo();
  a = applyFieldValues(a, "n1", { likelihood: { value: 0.8, lowConfidence: false }, impact: { value: 0.5, lowConfidence: false } }, "clef", now);
  a = applyFieldValues(a, "n2", { likelihood: { value: 0.6, lowConfidence: false }, impact: { value: 0.6, lowConfidence: false } }, "clef", now);
  const r = nextBranch(a, 0.2);
  assert.equal(r.kind, "dig");
  assert.equal(r.kind === "dig" && r.nodeId, "n1");
  assert.ok(r.kind === "dig" && Math.abs(r.priority - 0.4) < 1e-9);
});

test("nextBranch breaks ties by supported", () => {
  let a = withTwo();
  a = applyFieldValues(a, "n1", { likelihood: { value: 0.5, lowConfidence: false }, impact: { value: 0.8, lowConfidence: false }, supported: { value: 0.2, lowConfidence: false } }, "clef", now);
  a = applyFieldValues(a, "n2", { likelihood: { value: 0.8, lowConfidence: false }, impact: { value: 0.5, lowConfidence: false }, supported: { value: 0.9, lowConfidence: false } }, "clef", now);
  const r = nextBranch(a, 0.2);
  assert.equal(r.kind === "dig" && r.nodeId, "n2");
});

test("nextBranch done below 0.2 keeps nodes", () => {
  let a = withTwo();
  a = applyFieldValues(a, "n1", { likelihood: { value: 0.3, lowConfidence: false }, impact: { value: 0.5, lowConfidence: false } }, "agent", now);
  a = applyFieldValues(a, "n2", { likelihood: { value: 0.1, lowConfidence: false }, impact: { value: 0.9, lowConfidence: false } }, "agent", now);
  assert.deepEqual(nextBranch(a, 0.2), { kind: "done", below: ["n1", "n2"] });
  assert.equal(a.nodes.length, 3);
});

test("nextBranch done when no candidates", () => {
  assert.deepEqual(nextBranch(base(), 0.2), { kind: "done", below: [] });
});

test("addEvidence keeps commit hashes in git refs", () => {
  const a = addEvidence(withTwo(), "n1", { kind: "git", ref: "0123456789abcdef0123456789abcdef01234567", summary: "key rotated", supports: true }, now);
  assert.equal(a.nodes[1].evidence[0].ref, "0123456789abcdef0123456789abcdef01234567");
});
