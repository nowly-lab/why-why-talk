import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMermaid } from "../src/render/mermaid.ts";
import { addFact, addWhys, startAnalysis, updateNode } from "../src/analysis.ts";
import type { Analysis } from "../src/model.ts";

const now = () => "2026-11-13T00:00:00.000Z";

function tricky(): Analysis {
  const a = startAnalysis({ id: "r", title: "描画", problem: "決済が\"失敗\"した" }, now);
  return addWhys(a, "n0", [
    { text: 'キー[期限]|切れ "本当?"\n2行目', viewpoint: "仕組み・道具" },
    { text: "<script>alert(1)</script>", viewpoint: "検知" },
  ], now).analysis;
}

function labels(mmd: string): string[] {
  return [...mmd.matchAll(/^\s*n\d+\["(.*)"\]/gm)].map((m) => m[1]);
}

test("mermaid starts with flowchart LR and uses tree ids", () => {
  const mmd = renderMermaid(tricky());
  assert.match(mmd, /^flowchart LR\n/);
  assert.match(mmd, /^\s*n0 --> n1$/m);
  assert.match(mmd, /^\s*n0 --> n2$/m);
});

test("mermaid escapes quotes brackets and pipes", () => {
  const ls = labels(renderMermaid(tricky()));
  assert.equal(ls.length, 3);
  for (const l of ls) {
    assert.ok(!/["[\]|<>]/.test(l.replace(/<br\/>/g, "")), l);
  }
  assert.ok(ls[1].includes("#quot;"));
  assert.ok(ls[1].includes("<br/>"));
});

test("mermaid marks backed nodes and state classes", () => {
  let a = addFact(tricky(), "n1", { summary: "401", supports: true }, now);
  a = updateNode(a, "n2", { state: "rejected", reason: "関係なし" }, now);
  const mmd = renderMermaid(a);
  assert.match(mmd, /n1\["✓ /);
  assert.match(mmd, /class n2 rejected/);
  assert.match(mmd, /classDef leaf /);
});

test("mermaid summary when over 40 nodes", () => {
  let a = startAnalysis({ id: "big", title: "t", problem: "p" }, now);
  a = addWhys(a, "n0", [{ text: "残す", viewpoint: "検知" }, { text: "却下", viewpoint: "検知" }], now).analysis;
  a = addWhys(a, "n2", Array.from({ length: 45 }, (_, i) => ({ text: `子${i}`, viewpoint: "検知" as const })), now).analysis;
  a = updateNode(a, "n2", { state: "rejected", reason: "外れ" }, now);
  const mmd = renderMermaid(a, { maxNodes: 40 });
  assert.ok(!/\bn3\b/.test(mmd));
  assert.match(mmd, /省略: 46 件/);
  assert.ok(labels(mmd).length <= 41);
});



test("render output has no token", () => {
  const a = addFact(tricky(), "n1", { summary: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 token=supersecretvalue", supports: true }, now);
  for (const out of [renderMermaid(a)]) {
    assert.ok(!out.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"));
    assert.ok(!out.includes("supersecretvalue"));
  }
});

test("mermaid escapes a leading backtick", () => {
  let a = startAnalysis({ id: "bt", title: "t", problem: "p" }, now);
  a = addWhys(a, "n0", [{ text: "`retry` was 0", viewpoint: "検知" }], now).analysis;
  a = updateNode(a, "n1", { state: "digging" }, now);
  const mmd = renderMermaid(a);
  assert.ok(!mmd.includes("`"), mmd);
  assert.ok(mmd.includes("#96;retry#96; was 0"));
});
