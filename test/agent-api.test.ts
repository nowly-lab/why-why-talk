import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkSession } from "../src/talk/session.ts";
import { startTalkServer } from "../src/talk/server.ts";
import { writeTalkEntry, removeTalkEntry, listTalks } from "../src/talk/registry.ts";

const TOKEN = "a".repeat(64);
async function setup() {
  const outDir = await mkdtemp(join(tmpdir(), "why-agent-http-"));
  const webRoot = await mkdtemp(join(tmpdir(), "why-agent-web-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>t</title>");
  const s = new TalkSession({ topic: null, context: "", outDir });
  const srv = await startTalkServer(s, {
    webRoot,
    agentToken: TOKEN,
    text: { transcribe: async () => "", summarizeFile: async () => "", splitQuestions: async () => [] },
    mint: async () => ({ token: "t", model: "m", expiresAt: "x", config: {} as never }),
  });
  const agent = (path: string, body?: unknown, token = TOKEN) =>
    fetch(`${srv.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { s, srv, agent };
}

test("agent routes need the agent token, not the page's nonce", async () => {
  const { s, srv, agent } = await setup();
  try {
    assert.equal((await fetch(`${srv.url}/api/agent/state`)).status, 401);
    assert.equal((await agent("/api/agent/state", undefined, "b".repeat(64))).status, 401);
    const viaNonce = await fetch(`${srv.url}/api/agent/question`, { method: "POST", headers: { "content-type": "application/json", "x-why-why-session": s.nonce }, body: JSON.stringify({ text: "x" }) });
    assert.equal(viaNonce.status, 401);
    assert.equal((await agent("/api/agent/state")).status, 200);
  } finally {
    await srv.close();
  }
});

test("an agent adds questions, starts the dive without voice, and writes to any question", async () => {
  const { s, srv, agent } = await setup();
  try {
    assert.equal((await agent("/api/agent/question", { text: "なぜホストはフロアごとなのか" })).status, 200);
    assert.equal((await agent("/api/agent/question", { text: "席をいつ消すか" })).status, 200);
    assert.equal((await agent("/api/agent/start-dive", {})).status, 200);
    assert.equal(s.phase, "deep_dive");
    const r = await (await agent("/api/agent/tool", { name: "add_fact", args: { node_id: "q2", summary: "会議で確認", supports: true } })).json();
    assert.equal(r.ok, true);
    const state = await (await agent("/api/agent/state")).json();
    assert.equal(state.dives.length, 2);
    assert.equal(state.nonce, undefined, "the page's nonce is not handed to agents");
    assert.equal((await agent("/api/agent/tool", { name: "next_question", args: {} })).status, 400, "Gemini-only tools are not an agent's");
    assert.equal(s.current()?.questionId, "q1");
  } finally {
    await srv.close();
  }
});

test("a change by an agent reaches the page's lease stream as event: changed", async () => {
  const { srv, agent } = await setup();
  try {
    const ctrl = new AbortController();
    const res = await fetch(`${srv.url}/api/lease`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await agent("/api/agent/question", { text: "問い" });
    let text = "";
    while (!/event: changed/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
  } finally {
    await srv.close();
  }
});

test("the talk registry is private, lists live talks and forgets dead ones", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "why-reg-")), "talks");
  const base = { url: "http://127.0.0.1:1", token: TOKEN, topic: null, outDir: "/x", startedAt: "2026-11-17T00:00:00.000Z" };
  await writeTalkEntry(dir, { ...base, id: "live", pid: process.pid });
  await writeTalkEntry(dir, { ...base, id: "dead", pid: 2 ** 22 + 12345 });
  assert.equal(((await stat(join(dir, "live.json"))).mode & 0o777).toString(8), "600");
  assert.equal(((await stat(dir)).mode & 0o777).toString(8), "700");
  const talks = await listTalks(dir);
  assert.deepEqual(talks.map((t) => t.id), ["live"]);
  assert.deepEqual((await readdir(dir)).sort(), ["live.json"], "a dead talk's file is removed");
  await removeTalkEntry(dir, "live");
  assert.deepEqual(await listTalks(dir), []);
});
