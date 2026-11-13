import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkSession } from "../src/talk/session.ts";
import { FUNCTION_DECLARATIONS } from "../src/talk/tools.ts";
import { renderResultMarkdown, resultJson } from "../src/talk/result.ts";
import { WhyError } from "../src/model.ts";

function clock(start = Date.UTC(2026, 10, 13, 1, 0, 0)) {
  let t = start;
  const now = () => new Date(t).toISOString();
  return { now, advance: (ms: number) => { t += ms; } };
}

async function session() {
  const c = clock();
  const outDir = await mkdtemp(join(tmpdir(), "why-why-talk-"));
  const s = new TalkSession({ topic: "決済エラーの再発をどう防ぐか", context: "401 が40分続いた", outDir, now: c.now });
  return { s, c, outDir };
}

const direction = { direction: "キーの期限を監視して30日前に通知する", reasons: "期限を誰も把握していなかった", rejected: "手作業の確認", openQuestions: "通知先は誰か" };

test("session starts talking with the topic as root and a nonce", async () => {
  const { s } = await session();
  assert.equal(s.status, "talking");
  assert.equal(s.analysis.nodes[0].text, "決済エラーの再発をどう防ぐか");
  assert.match(s.nonce, /^[0-9a-f]{32}$/);
});

test("function declarations are the four tools", () => {
  assert.deepEqual(FUNCTION_DECLARATIONS.map((f) => f.name), ["add_whys", "add_fact", "update_branch", "propose_direction"]);
});

test("applyTool add_whys grows the tree and returns summary", async () => {
  const { s } = await session();
  const r = s.applyTool("add_whys", { parent_id: "n0", items: [{ text: "APIキーが期限切れ", viewpoint: "仕組み・道具" }, { text: "気づくのが遅れた", viewpoint: "検知" }] });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.added.length === 2 && r.tree.length === 3);
  assert.equal(s.analysis.nodes.length, 3);
});

test("applyTool wrong id returns error and leaves tree", async () => {
  const { s } = await session();
  const before = JSON.stringify(s.analysis);
  const r = s.applyTool("add_fact", { node_id: "n9", summary: "x", supports: true });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /n9/.test(r.error));
  assert.equal(JSON.stringify(s.analysis), before);
});

test("applyTool bad arguments and unknown function return errors", async () => {
  const { s } = await session();
  const bad = s.applyTool("add_whys", { parent_id: "n0", items: [{ text: "x", viewpoint: "気分" }] });
  assert.ok(!bad.ok && /viewpoint/.test(bad.error));
  const unknown = s.applyTool("delete_tree", {});
  assert.ok(!unknown.ok && /delete_tree/.test(unknown.error));
});

test("update_branch moves a branch and checks rules", async () => {
  const { s } = await session();
  s.applyTool("add_whys", { parent_id: "n0", items: [{ text: "APIキーが期限切れ", viewpoint: "仕組み・道具" }] });
  assert.ok(s.applyTool("update_branch", { node_id: "n1", state: "digging" }).ok);
  const noCm = s.applyTool("update_branch", { node_id: "n1", state: "leaf" });
  assert.ok(!noCm.ok && /countermeasure/.test(noCm.error));
  assert.ok(s.applyTool("update_branch", { node_id: "n1", state: "leaf", countermeasure: "期限の監視" }).ok);
});

test("propose_direction sets draft", async () => {
  const { s } = await session();
  const r = s.applyTool("propose_direction", { direction: "監視する", reasons: "r", rejected: "x", open_questions: "q" });
  assert.ok(r.ok);
  assert.deepEqual(s.draft, { direction: "監視する", reasons: "r", rejected: "x", openQuestions: "q" });
});

test("transcript fragments merge within 4s", async () => {
  const { s, c } = await session();
  s.appendTranscript("gemini", "なぜ、");
  c.advance(1000);
  s.appendTranscript("gemini", "期限に気づけなかったのですか?");
  c.advance(1000);
  s.appendTranscript("person", "管理する場所がなくて");
  c.advance(5000);
  s.appendTranscript("person", "あと通知もなかった");
  assert.deepEqual(s.transcript.map((t) => [t.speaker, t.text]), [
    ["gemini", "なぜ、期限に気づけなかったのですか?"],
    ["person", "管理する場所がなくて"],
    ["person", "あと通知もなかった"],
  ]);
});

test("submit requires direction", async () => {
  const { s } = await session();
  assert.throws(() => s.submit({ ...direction, direction: "  " }), (e: unknown) => e instanceof WhyError && e.code === "invalid_input");
});

test("submit twice throws conflict and cancel after submit is refused", async () => {
  const { s } = await session();
  s.submit(direction);
  assert.equal(s.status, "sent");
  assert.throws(() => s.submit(direction), (e: unknown) => e instanceof WhyError && e.code === "conflict");
  assert.throws(() => s.cancel("x"), (e: unknown) => e instanceof WhyError && e.code === "conflict");
  assert.ok(!s.applyTool("add_fact", { node_id: "n0", summary: "x", supports: true }).ok);
});

test("result markdown has all sections in order", async () => {
  const { s } = await session();
  s.applyTool("add_whys", { parent_id: "n0", items: [{ text: "APIキーが期限切れ", viewpoint: "仕組み・道具" }] });
  s.applyTool("add_fact", { node_id: "n1", summary: "応答本文が key expired", supports: true });
  s.appendTranscript("gemini", "なぜですか?");
  s.appendTranscript("person", "期限切れです");
  s.submit(direction);
  const md = renderResultMarkdown(s);
  const order = ["# 深掘りの結果: 決済エラーの再発をどう防ぐか", "## 方針", "## 理由", "## 見送った案", "## 残った疑問", "## なぜの木", "```mermaid", "## 会話の全文", "files:"];
  let at = -1;
  for (const h of order) {
    const i = md.indexOf(h, at + 1);
    assert.ok(i > at, `missing or out of order: ${h}`);
    at = i;
  }
  assert.match(md, /n1 .*APIキーが期限切れ.*未調査.*仕組み・道具/);
  assert.match(md, /支持: 応答本文が key expired/);
  assert.match(md, /\d\d:\d\d:\d\d Gemini: なぜですか\?/);
  assert.match(md, /\d\d:\d\d:\d\d あなた: 期限切れです/);
  const json = resultJson(s);
  assert.equal(json.direction.direction, direction.direction);
  assert.equal(json.tree.length, 1); // the root is the topic itself
  assert.equal(json.transcript.length, 2);
});

test("persist writes files and redacts tokens", async () => {
  const { s, outDir } = await session();
  s.appendTranscript("person", "トークンは ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 です");
  await s.persist();
  const files = await Promise.all(["session.json", "transcript.md", "tree.mmd"].map((f) => readFile(join(outDir, f), "utf8")));
  for (const f of files) assert.ok(!f.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"));
  assert.match(files[1], /\[REDACTED\]/);
  s.submit(direction);
  await s.persist();
  assert.match(await readFile(join(outDir, "result.md"), "utf8"), /## 方針/);
  assert.ok(JSON.parse(await readFile(join(outDir, "result.json"), "utf8")).direction);
});

test("context is redacted on the way in", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "why-why-talk-"));
  const s = new TalkSession({ topic: "t", context: "token=supersecretvalue123", outDir });
  assert.ok(!s.context.includes("supersecretvalue123"));
});

test("concurrent persists do not collide", async () => {
  const { s } = await session();
  for (let i = 0; i < 5; i++) s.appendTranscript("person", `発言${i}`);
  await Promise.all(Array.from({ length: 8 }, () => s.persist()));
});
