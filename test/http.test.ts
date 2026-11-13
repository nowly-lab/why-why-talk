import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkSession } from "../src/talk/session.ts";
import { startTalkServer } from "../src/talk/server.ts";

async function setup(opts: { leaseGraceMs?: number } = {}) {
  const outDir = await mkdtemp(join(tmpdir(), "why-why-http-"));
  const webRoot = await mkdtemp(join(tmpdir(), "why-why-web-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>t</title>");
  await writeFile(join(webRoot, "main.js"), "console.log(1)");
  const s = new TalkSession({ topic: "論点", context: "", outDir });
  let minted = 0;
  const srv = await startTalkServer(s, {
    webRoot,
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
  assert.equal(body.tree[0].id, "n0");
  await srv.close();
});

test("wrong nonce is 409", async () => {
  const { srv, post, s } = await setup();
  const r = await post("/api/tool", { name: "add_whys", args: { parent_id: "n0", items: [{ text: "x", viewpoint: "検知" }] } }, "old-tab");
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
  const r = await (await post("/api/tool", { name: "add_whys", args: { parent_id: "n0", items: [{ text: "期限切れ", viewpoint: "検知" }] } })).json();
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
  assert.equal((await post("/api/submit", { ...direction, direction: "" })).status, 400);
  assert.equal((await post("/api/submit", direction)).status, 200);
  assert.equal((await post("/api/submit", direction)).status, 409);
  const outcome = await srv.outcome;
  assert.equal(outcome.kind, "sent");
  assert.ok(outcome.kind === "sent" && /## 方針\n\n監視する/.test(outcome.markdown));
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
  assert.equal((await post("/api/submit", direction)).status, 200);
  assert.equal((await srv.outcome).kind, "sent");
  close2();
  await srv.close();
});
