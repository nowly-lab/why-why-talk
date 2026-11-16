import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkSession } from "../src/talk/session.ts";
import { startTalkServer } from "../src/talk/server.ts";
import { TextModelError, type TextModel } from "../src/talk/text-model.ts";

/** A text model that answers from fixed strings, or fails when told to. */
function fakeText(over: Partial<TextModel> = {}): TextModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transcribe: async (a) => { calls.push(`transcribe ${a.mimeType} ${a.data.length}`); return "話した文"; },
    summarizeFile: async (f) => { calls.push(`summarize ${f.name}`); return "- 要点"; },
    splitQuestions: async () => { calls.push("split"); return ["一つめの問い", "二つめの問い"]; },
    ...over,
  };
}

/** The old one-topic setup is a deep dive over one checked question q1 ("dive"); "free" starts with no topic. */
async function setup(opts: { leaseGraceMs?: number; mode?: "dive" | "free" | "topic"; text?: TextModel } = {}) {
  const outDir = await mkdtemp(join(tmpdir(), "why-why-http-"));
  const webRoot = await mkdtemp(join(tmpdir(), "why-why-web-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(join(webRoot, "main.js"), "console.log(1)");
  const mode = opts.mode ?? "dive";
  const s = new TalkSession({ topic: mode === "free" ? null : "論点", context: "", outDir });
  if (mode === "dive") {
    s.setQuestions(["論点"]);
    s.editQuestions([{ text: "論点", checked: true }]);
    s.startDeepDive();
  }
  let minted = 0;
  const srv = await startTalkServer(s, {
    webRoot,
    text: opts.text ?? fakeText(),
    leaseGraceMs: opts.leaseGraceMs ?? 60_000,
    mint: async (o) => {
      minted++;
      return { token: `auth_tokens/t${minted}`, model: "gemini-3.8-live", expiresAt: "x", config: { fallback: o.fallback } as never };
    },
  });
  const post = (path: string, body: unknown, nonce = s.nonce) =>
    fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-why-why-session": nonce }, body: JSON.stringify(body) });
  return { s, srv, post, outDir };
}

const direction = { direction: "監視する", reasons: "r", rejected: "x", openQuestions: "q" };
const sendBody = { directions: { q1: direction } };

test("serves the page and the bundle", async () => {
  const { srv } = await setup();
  const page = await fetch(srv.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const js = await fetch(`${srv.url}/main.js`);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.equal((await fetch(`${srv.url}/../etc/passwd`)).status, 404);
  await srv.close();
});

test("session endpoint returns snapshot with nonce", async () => {
  const { s, srv } = await setup();
  const body = await (await fetch(`${srv.url}/api/session`)).json();
  assert.equal(body.topic, "論点");
  assert.equal(body.nonce, s.nonce);
  assert.equal(body.tree[0].id, "q1");
  assert.equal(body.phase, "deep_dive");
  await srv.close();
});

test("wrong nonce is 409", async () => {
  const { srv, post, s } = await setup();
  const r = await post("/api/tool", { name: "add_whys", args: { parent_id: "q1", items: [{ text: "x", viewpoint: "検知" }] } }, "old-tab");
  assert.equal(r.status, 409);
  assert.equal(s.analysis.nodes.length, 1);
  await srv.close();
});

test("bad host header is 403", async () => {
  const { srv } = await setup();
  const port = new URL(srv.url).port;
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/session", headers: { host: `evil.example:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  await srv.close();
});

test("tool endpoint applies and persists", async () => {
  const { srv, post, outDir } = await setup();
  const r = await (await post("/api/tool", { name: "add_whys", args: { parent_id: "q1", items: [{ text: "期限切れ", viewpoint: "検知" }] } })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.added, ["n1"]);
  assert.match(await readFile(join(outDir, "tree.mmd"), "utf8"), /期限切れ/);
  const bad = await (await post("/api/tool", { name: "add_fact", args: { node_id: "n9", summary: "x", supports: true } })).json();
  assert.equal(bad.ok, false);
  await srv.close();
});

test("transcript endpoint appends", async () => {
  const { srv, post, s } = await setup();
  assert.equal((await post("/api/transcript", { speaker: "person", text: "こんにちは" })).status, 200);
  assert.equal(s.transcript[0].text, "こんにちは");
  assert.equal((await post("/api/transcript", { speaker: "robot", text: "x" })).status, 400);
  await srv.close();
});

test("token endpoint returns mint result and no key", async () => {
  const { srv, post } = await setup();
  const r = await (await post("/api/token", { fallback: true })).json();
  assert.equal(r.token, "auth_tokens/t1");
  assert.deepEqual(r.config, { fallback: true });
  await srv.close();
});

test("submit resolves outcome once; second is 409", async () => {
  const { srv, post } = await setup();
  assert.equal((await post("/api/submit", { directions: { q9: direction } })).status, 400);
  assert.equal((await post("/api/submit", direction)).status, 400, "the old one-direction body is refused");
  assert.equal((await post("/api/submit", sendBody)).status, 200);
  assert.equal((await post("/api/submit", sendBody)).status, 409);
  const outcome = await srv.outcome;
  assert.equal(outcome.kind, "sent");
  assert.ok(outcome.kind === "sent" && /### 方針\n\n監視する/.test(outcome.markdown));
  await srv.close();
});

test("cancel resolves cancelled", async () => {
  const { srv, post } = await setup();
  assert.equal((await post("/api/cancel", {})).status, 200);
  assert.deepEqual(await srv.outcome, { kind: "cancelled", reason: "取りやめを押した" });
  await srv.close();
});

async function openLease(url: string): Promise<() => void> {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/lease`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  await reader.read();
  return () => ctrl.abort();
}

test("lease loss beyond grace abandons", async () => {
  const { srv } = await setup({ leaseGraceMs: 100 });
  const close = await openLease(srv.url);
  close();
  assert.deepEqual(await srv.outcome, { kind: "cancelled", reason: "タブが閉じられた" });
  await srv.close();
});

test("reload within grace keeps session", async () => {
  const { srv, post } = await setup({ leaseGraceMs: 300 });
  const close1 = await openLease(srv.url);
  close1();
  await new Promise((r) => setTimeout(r, 50));
  const close2 = await openLease(srv.url);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await post("/api/submit", sendBody)).status, 200);
  assert.equal((await srv.outcome).kind, "sent");
  close2();
  await srv.close();
});

test("the submit response reaches the page even if the caller closes the server at once", async () => {
  const { srv, post } = await setup();
  void srv.outcome.then(() => srv.close());
  const r = await post("/api/submit", sendBody);
  assert.equal(r.status, 200);
});

test("server cancel settles the outcome", async () => {
  const { srv } = await setup();
  srv.cancel("コマンドが止められた");
  assert.deepEqual(await srv.outcome, { kind: "cancelled", reason: "コマンドが止められた" });
  await srv.close();
});

// --- role and answers (plan v1 Task 4) ---
test("POST /api/role needs the nonce and switches", async () => {
  const { srv, post, s } = await setup();
  assert.equal((await post("/api/role", { role: "answerer" }, "old-tab")).status, 409);
  const r = await post("/api/role", { role: "answerer" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, role: "answerer" });
  assert.equal(s.role, "answerer");
  const snap = await (await fetch(`${srv.url}/api/session`)).json();
  assert.equal(snap.role, "answerer");
  await srv.close();
});

test("bad role is 400", async () => {
  const { srv, post } = await setup();
  assert.equal((await post("/api/role", { role: "boss" })).status, 400);
  await srv.close();
});

test("POST /api/answer stores an entry", async () => {
  const { srv, post, s } = await setup();
  const r = await post("/api/answer", { question: "q", answer: "a", queries: ["w"], sources: [{ title: "t", uri: "https://example.com" }] });
  assert.equal(r.status, 200);
  assert.equal(s.asked.length, 1);
  assert.equal((await post("/api/answer", { question: "q", answer: "" })).status, 400);
  await srv.close();
});

test("POST /api/answer trims oversized grounding instead of refusing it", async () => {
  const { srv, post, s } = await setup();
  const r = await post("/api/answer", {
    question: "q",
    answer: "a",
    queries: Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(800, "x")),
    sources: [{ title: "t".repeat(900), uri: "https://example.com/a" }, { title: "bad", uri: "not a url" }, { title: "js", uri: "javascript:alert(1)" }],
  });
  assert.equal(r.status, 200);
  assert.equal(s.asked[0]!.queries.length, 20);
  assert.ok(s.asked[0]!.queries.every((q) => q.length <= 500));
  assert.deepEqual(s.asked[0]!.sources.map((x) => [x.title.length, x.uri]), [[500, "https://example.com/a"]]);
  await srv.close();
});

test("POST /api/log appends redacted events to events.jsonl and needs the nonce", async () => {
  const { srv, post, outDir } = await setup();
  assert.equal((await post("/api/log", { events: [{ kind: "status.connected" }] }, "wrong")).status, 409);
  const ok = await post("/api/log", { events: [
    { kind: "status.reconnecting", detail: "closed 1011 token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123" },
    { kind: "tool", detail: "add_whys", ms: 42 },
  ] });
  assert.equal(ok.status, 200);
  await post("/api/log", { events: [{ kind: "gemini.silent" }] });
  const lines = (await readFile(join(outDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["status.reconnecting", "tool", "gemini.silent"]);
  assert.equal(lines[1].ms, 42);
  assert.ok(typeof lines[0].at === "string");
  assert.doesNotMatch(lines[0].detail, /ghp_/);
  await srv.close();
});

test("POST /api/log refuses oversized batches and bad kinds", async () => {
  const { srv, post } = await setup();
  const many = Array.from({ length: 51 }, () => ({ kind: "tick" }));
  assert.equal((await post("/api/log", { events: many })).status, 400);
  assert.equal((await post("/api/log", { events: [{ kind: "Bad Kind!" }] })).status, 400);
  assert.equal((await post("/api/log", { events: [{ kind: "x", detail: "a".repeat(301) }] })).status, 400);
  await srv.close();
});

// --- free talk, files, questions and dives (2026-11-16) ---
const wav = (bytes: number) => ({ data: Buffer.alloc(bytes).toString("base64"), mimeType: "audio/wav" });

test("audio is transcribed into the free talk", async () => {
  const text = fakeText();
  const { srv, post, s, outDir } = await setup({ mode: "free", text });
  const r = await post("/api/audio", wav(3200));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, text: "話した文" });
  assert.equal(s.freeTalk[0].text, "話した文");
  assert.match(await readFile(join(outDir, "transcript.md"), "utf8"), /話した文/);
  await srv.close();
});

test("a 2MB+ audio body is refused but a 1.4MB one is accepted", async () => {
  const { srv, post } = await setup({ mode: "free" });
  assert.equal((await post("/api/audio", wav(1_050_000))).status, 200);
  assert.equal((await post("/api/audio", wav(1_600_000))).status, 400);
  await srv.close();
});

test("a failing text model is 502 and changes nothing", async () => {
  const text = fakeText({ transcribe: async () => { throw new TextModelError("down"); }, splitQuestions: async () => { throw new TextModelError("bad json"); } });
  const { srv, post, s } = await setup({ mode: "free", text });
  assert.equal((await post("/api/audio", wav(10))).status, 502);
  s.appendFreeTalk("材料");
  assert.equal((await post("/api/questions/split", {})).status, 502);
  assert.equal(s.phase, "free_talk");
  await srv.close();
});

test("split refuses an empty session", async () => {
  const { srv, post } = await setup({ mode: "free" });
  const r = await post("/api/questions/split", {});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /話した内容がありません/);
  await srv.close();
});

test("split, edit, start and skip through the endpoints", async () => {
  const { srv, post, s } = await setup({ mode: "free" });
  await post("/api/audio", wav(10));
  const split = await (await post("/api/questions/split", {})).json();
  assert.deepEqual(split.questions, [{ text: "一つめの問い", checked: false }, { text: "二つめの問い", checked: false }]);
  assert.equal((await post("/api/dive/start", {})).status, 400, "nothing checked yet");
  assert.equal((await post("/api/questions", { questions: [{ text: "一つめの問い", checked: true }, { text: "二つめの問い", checked: true }] })).status, 200);
  const started = await (await post("/api/dive/start", {})).json();
  assert.deepEqual(started.current, { questionId: "q1", text: "一つめの問い" });
  const next = await (await post("/api/dive/next", {})).json();
  assert.equal(next.dives[0].status, "partial");
  assert.deepEqual(next.current, { questionId: "q2", text: "二つめの問い" });
  assert.equal(s.phase, "deep_dive");
  await srv.close();
});

test("back to free talk from the question list", async () => {
  const { srv, post, s } = await setup({ mode: "topic" });
  assert.equal(s.phase, "questions");
  assert.equal((await post("/api/free-talk", {})).status, 200);
  assert.equal(s.phase, "free_talk");
  await srv.close();
});

test("token is refused before the deep dive", async () => {
  const { srv, post } = await setup({ mode: "free" });
  assert.equal((await post("/api/token", {})).status, 409);
  await srv.close();
});

test("files are summarized; a .docx is refused with 400", async () => {
  const text = fakeText();
  const { srv, post, s } = await setup({ mode: "free", text });
  const ok = await post("/api/file", { name: "memo.md", mimeType: "text/markdown", data: Buffer.from("# メモ").toString("base64") });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).file, { name: "memo.md", mimeType: "text/markdown", summary: "- 要点" });
  assert.equal(s.files.length, 1);
  const bad = await post("/api/file", { name: "a.docx", mimeType: "application/msword", data: "AAAA" });
  assert.equal(bad.status, 400);
  assert.deepEqual(text.calls, ["summarize memo.md"]);
  await srv.close();
});

test("draft is per question", async () => {
  const { srv, post, s } = await setup();
  assert.equal((await post("/api/draft", { questionId: "q1", ...direction })).status, 200);
  assert.deepEqual(s.dives[0].draft, direction);
  await srv.close();
});
