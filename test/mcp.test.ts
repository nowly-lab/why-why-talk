import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TalkSession } from "../src/talk/session.ts";
import { startTalkServer } from "../src/talk/server.ts";
import { writeTalkEntry } from "../src/talk/registry.ts";
import { createWhyWhyMcp } from "../src/mcp/server.ts";

const TOKEN = "c".repeat(64);
async function talk(dir: string, topic: string | null = null) {
  const outDir = await mkdtemp(join(tmpdir(), "why-mcp-out-"));
  const webRoot = await mkdtemp(join(tmpdir(), "why-mcp-web-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html>");
  const s = new TalkSession({ topic, context: "", outDir });
  const srv = await startTalkServer(s, { webRoot, agentToken: TOKEN, text: { transcribe: async () => "", summarizeFile: async () => "", splitQuestions: async () => [] }, mint: async () => ({ token: "t", model: "m", expiresAt: "x", config: {} as never }) });
  await writeTalkEntry(dir, { id: s.id, url: srv.url, token: TOKEN, topic, outDir, startedAt: s.startedAt, pid: process.pid });
  return { s, srv };
}
async function client(dir: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createWhyWhyMcp({ dir }).connect(a);
  const c = new Client({ name: "claude-code", version: "test" });
  await c.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, body: JSON.parse(r.content[0].text) };
  };
  return { c, call };
}

test("an agent runs a whole talk from MCP: questions, a dive without voice, facts on any question, a draft", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "why-mcp-reg-")), "talks");
  const { s, srv } = await talk(dir);
  const { c, call } = await client(dir);
  try {
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["add_fact", "add_question", "add_whys", "get_talk", "list_talks", "propose_direction", "start_dive", "update_branch"]);
    assert.equal((await call("add_question", { text: "なぜホストはフロアごとなのか" })).error, false);
    assert.equal((await call("add_question", { text: "退室した人の席をいつ消すか" })).error, false);
    assert.equal((await call("start_dive")).error, false);
    assert.equal((await call("add_whys", { parent_id: "q2", items: [{ text: "切断済みの記録が残る", viewpoint: "仕組み・道具" }] })).error, false);
    assert.equal((await call("add_fact", { node_id: "q2", summary: "会議で確認した", supports: true })).error, false);
    assert.equal((await call("propose_direction", { question_id: "q2", direction: "移動で消す", reasons: "今の動き", rejected: "", open_questions: "時間で消すか" })).error, false);
    const got = await call("get_talk");
    assert.equal(got.body.contentType, "untrusted_talk_data");
    assert.equal(got.body.data.phase, "deep_dive");
    assert.equal(got.body.data.dives[1].draft.direction, "移動で消す");
    assert.ok(got.body.data.tree.some((n: { text: string; by?: string }) => n.text === "切断済みの記録が残る" && n.by === "agent"));
    assert.equal(JSON.stringify(got.body).includes(TOKEN), false, "the agent token never comes back");
    assert.equal(s.dives.length, 2);
  } finally {
    await c.close();
    await srv.close();
  }
});

test("talk selection: none running, one, or several", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "why-mcp-reg-")), "talks");
  const { call: none } = await client(dir);
  const r0 = await none("get_talk");
  assert.equal(r0.error, true);
  assert.match(r0.body.error, /why-why-talk/);
  const a = await talk(dir, "A の論点");
  const b = await talk(dir, "B の論点");
  const { call } = await client(dir);
  try {
    const list = await call("list_talks");
    assert.equal(list.body.data.length, 2);
    assert.equal(JSON.stringify(list.body).includes(TOKEN), false);
    const many = await call("get_talk");
    assert.equal(many.error, true);
    assert.match(many.body.error, /talk/);
    assert.equal((await call("get_talk", { talk: a.s.id })).body.data.topic, "A の論点");
  } finally {
    await a.srv.close();
    await b.srv.close();
  }
});

test("R8: a registry entry whose process lives but whose talk does not answer is not offered", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "why-mcp-reg-")), "talks");
  await writeTalkEntry(dir, { id: "stale", url: "http://127.0.0.1:9", token: TOKEN, topic: "古い", outDir: "/x", startedAt: "2026-11-17T00:00:00.000Z", pid: process.pid });
  const real = await talk(dir, "今の論点");
  const { call } = await client(dir);
  try {
    const list = await call("list_talks");
    assert.deepEqual(list.body.data.map((t: { id: string }) => t.id), [real.s.id]);
    assert.equal((await call("get_talk")).body.data.topic, "今の論点", "the only healthy talk is picked without talk:");
  } finally {
    await real.srv.close();
  }
});

test("RR5: a listener that answers 200 but is not that talk is not offered", async () => {
  const { createServer } = await import("node:http");
  const other = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<html>unrelated app</html>"); });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const port = (other.address() as { port: number }).port;
  const dir = join(await mkdtemp(join(tmpdir(), "why-mcp-reg-")), "talks");
  await writeTalkEntry(dir, { id: "imposter", url: `http://127.0.0.1:${port}`, token: TOKEN, topic: "古い", outDir: "/x", startedAt: "2026-11-17T00:00:00.000Z", pid: process.pid });
  const { call } = await client(dir);
  try {
    assert.deepEqual((await call("list_talks")).body.data, []);
  } finally {
    other.close();
  }
});
