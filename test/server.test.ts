import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhyWhyServer, INSTRUCTIONS } from "../src/server.ts";
import { FileStore } from "../src/store.ts";
import type { ClefConfig } from "../src/clef.ts";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

async function connect(opts: { clef?: ClefConfig | null; fetchFn?: typeof fetch } = {}) {
  const store = new FileStore(await mkdtemp(join(tmpdir(), "why-why-srv-")));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 13, 0, 0, tick++)).toISOString();
  const server = createWhyWhyServer({ store, clef: opts.clef ?? null, fetchFn: opts.fetchFn, now });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as ToolResult;
    return { isError: r.isError === true, text: r.content[0]?.text ?? "", json: () => JSON.parse(r.content[0].text) };
  };
  return { client, call, store };
}

const TOOLS = [
  "add_evidence", "add_whys", "close_analysis", "evaluate", "get_analysis", "list_analyses",
  "next_branch", "record_judgment", "render", "start_analysis", "update_node",
];

test("lists 11 tools with short descriptions", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const t of tools) assert.ok((t.description ?? "").length > 0 && (t.description ?? "").length <= 2048, t.name);
});

test("instructions under 2048 chars and delivered", async () => {
  const { client } = await connect();
  assert.ok(INSTRUCTIONS.length <= 2048, String(INSTRUCTIONS.length));
  assert.equal(client.getInstructions(), INSTRUCTIONS);
  assert.match(INSTRUCTIONS, /Plannotator Inbox/);
  assert.match(INSTRUCTIONS, /secret/i);
});

test("full loop without Clef", async () => {
  const { call } = await connect();
  const started = (await call("start_analysis", { title: "決済エラー", problem: "10時から認証エラーが増えた", id: "pay" })).json();
  assert.equal(started.analysis_id, "pay");

  const added = (await call("add_whys", {
    analysis_id: "pay", parent_id: "n0",
    items: [{ text: "APIキーが期限切れ", viewpoint: "仕組み・道具" }, { text: "決済APIの障害", viewpoint: "前提・外部" }],
  })).json();
  assert.deepEqual(added.added, ["n1", "n2"]);

  await call("add_evidence", { analysis_id: "pay", node_id: "n1", kind: "log", ref: "logs/pay", summary: "401 invalid key", supports: true });

  const ev = (await call("evaluate", { analysis_id: "pay" })).json();
  assert.equal(ev.clef, "not_configured");
  assert.deepEqual(ev.needs_judgment.map((x: { node_id: string }) => x.node_id), ["n1", "n2"]);
  assert.ok(ev.questions.likelihood.criteria.length === 4);

  const nb0 = (await call("next_branch", { analysis_id: "pay" })).json();
  assert.equal(nb0.kind, "evaluate");

  await call("record_judgment", { analysis_id: "pay", node_id: "n1", values: { likelihood: 0.9, impact: 0.8, supported: 1 } });
  await call("record_judgment", { analysis_id: "pay", node_id: "n2", values: { likelihood: 0.1, impact: 0.8 } });

  const nb = (await call("next_branch", { analysis_id: "pay" })).json();
  assert.equal(nb.kind, "dig");
  assert.equal(nb.node_id, "n1");
  assert.equal(nb.text, "APIキーが期限切れ");

  await call("update_node", { analysis_id: "pay", node_id: "n1", state: "digging" });
  await call("update_node", { analysis_id: "pay", node_id: "n1", state: "leaf", countermeasure: "期限を監視して通知する" });
  await call("update_node", { analysis_id: "pay", node_id: "n2", state: "rejected", reason: "ステータスページは正常" });

  const done = (await call("next_branch", { analysis_id: "pay" })).json();
  assert.equal(done.kind, "done");

  const closed = (await call("close_analysis", { analysis_id: "pay" })).json();
  assert.equal(closed.status, "closed");

  const r = (await call("render", { analysis_id: "pay" })).json();
  assert.ok((await stat(r.mermaid_path)).isFile());
  assert.ok((await stat(r.html_path)).isFile());
  assert.match(r.mermaid, /^flowchart LR/);
  assert.match(await readFile(r.html_path, "utf8"), /期限を監視して通知する/);
  assert.match(r.inbox_hint, /attachments/);

  const list = (await call("list_analyses")).json();
  assert.equal(list.analyses[0].id, "pay");
  const got = (await call("get_analysis", { analysis_id: "pay" })).json();
  assert.equal(got.nodes.length, 3);
});

test("evaluate with fake fetch stores clef values", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/clef-response.json", import.meta.url), "utf8"));
  const fetchFn = (async () => new Response(JSON.stringify(fixture), { status: 200 })) as typeof fetch;
  const { call } = await connect({ clef: { accountId: "a", token: "t", model: "clef-flash" }, fetchFn });
  await call("start_analysis", { title: "t", problem: "p", id: "c" });
  await call("add_whys", { analysis_id: "c", parent_id: "n0", items: [{ text: "x", viewpoint: "検知" }] });
  const ev = (await call("evaluate", { analysis_id: "c", node_ids: ["n1"] })).json();
  assert.equal(ev.clef, "used");
  assert.deepEqual(ev.evaluated, ["n1"]);
  assert.deepEqual(ev.needs_judgment.map((x: { node_id: string; fields: string[] }) => [x.node_id, x.fields]), [["n1", ["sufficient", "impact"]]]);
  const got = (await call("get_analysis", { analysis_id: "c" })).json();
  assert.equal(got.nodes[1].evaluation.fields.supported.source, "clef");
  const nb = (await call("next_branch", { analysis_id: "c" })).json();
  assert.equal(nb.kind, "judge");
});

test("error result for unknown node", async () => {
  const { call } = await connect();
  await call("start_analysis", { title: "t", problem: "p", id: "e" });
  const r = await call("add_evidence", { analysis_id: "e", node_id: "n7", kind: "log", ref: "r", summary: "s", supports: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /^not_found: .*n7/);
});

test("start_analysis derives an id and refuses a duplicate", async () => {
  const { call } = await connect();
  const a = (await call("start_analysis", { title: "Payment errors", problem: "p" })).json();
  assert.match(a.analysis_id, /^[a-z0-9][a-z0-9-]*$/);
  const dup = await call("start_analysis", { title: "x", problem: "p", id: a.analysis_id });
  assert.equal(dup.isError, true);
  assert.match(dup.text, /^conflict/);
});
