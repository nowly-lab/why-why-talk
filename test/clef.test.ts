import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildClefRequest, clefConfigFromEnv, evaluateWithClef } from "../src/clef.ts";
import { addEvidence, addWhys, startAnalysis } from "../src/analysis.ts";
import type { Analysis } from "../src/model.ts";

const now = () => "2026-11-13T00:00:00.000Z";
const cfg = { accountId: "acc123", token: "tok", model: "clef-flash" as const };

function analysis(n: number): Analysis {
  const a = startAnalysis({ id: "x", title: "t", problem: "決済エラーが増えた" }, now);
  return addWhys(a, "n0", Array.from({ length: n }, (_, i) => ({ text: `原因${i + 1}`, viewpoint: "検知" as const })), now).analysis;
}

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("clefConfigFromEnv needs account and token", () => {
  assert.equal(clefConfigFromEnv({}), null);
  assert.equal(clefConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a" }), null);
  assert.deepEqual(clefConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" }), { accountId: "a", token: "t", model: "clef-flash" });
  assert.equal(clefConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", WHY_WHY_CLEF_MODEL: "clef" })?.model, "clef");
});

test("buildClefRequest chunks 13 nodes into 2 requests", () => {
  const a = analysis(13);
  const ids = a.nodes.slice(1).map((n) => n.id);
  const reqs = buildClefRequest(a, ids, "clef-flash");
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].nodeIds.length, 12);
  assert.equal(Object.keys(reqs[0].body.questions).length, 60);
  assert.equal(Object.keys(reqs[1].body.questions).length, 5);
  const q = reqs[0].body.questions["n1.likelihood"];
  assert.equal(q.type, "score");
  assert.deepEqual(q.criteria, ["低い", "中くらい", "高い", "ほぼ確実"]);
  assert.equal(reqs[0].body.questions["n1.supported"].type, "noul");
});

test("state contains no raw token", () => {
  let a = analysis(1);
  a = addEvidence(a, "n1", { kind: "log", ref: "r", summary: "header Bearer abcdefghijklmnop0123", supports: true }, now);
  const body = JSON.stringify(buildClefRequest(a, ["n1"], "clef-flash")[0].body);
  assert.ok(!body.includes("abcdefghijklmnop0123"));
  assert.ok(body.includes("決済エラーが増えた"));
  assert.ok(body.includes("原因1"));
});

test("parses noul and score answers", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/clef-response.json", import.meta.url), "utf8"));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const r = await evaluateWithClef(cfg, analysis(1), ["n1"], fakeFetch(200, fixture, calls));
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/cloudflare/clef-flash");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok");
  const v = r.values.n1;
  assert.equal(v.supported?.value, 0.91);
  assert.equal(v.supported?.lowConfidence, false);
  assert.ok(Math.abs((v.likelihood?.value ?? 0) - 0.8) < 1e-9);
  assert.equal(v.likelihood?.lowConfidence, false);
  assert.ok(Math.abs((v.impact?.value ?? 0) - 0.3) < 1e-9);
  assert.equal(v.impact?.lowConfidence, true);
  assert.equal(v.preventable?.value, 0.12);
});

test("noul 0.5 is low confidence", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/clef-response.json", import.meta.url), "utf8"));
  const r = await evaluateWithClef(cfg, analysis(1), ["n1"], fakeFetch(200, fixture));
  assert.equal(r.values.n1.sufficient?.lowConfidence, true);
});

test("HTTP 500 gives needsJudgment for all chunk nodes", async () => {
  const r = await evaluateWithClef(cfg, analysis(2), ["n1", "n2"], fakeFetch(500, { success: false, errors: [{ message: "boom" }] }));
  assert.deepEqual(r.values, {});
  assert.deepEqual(r.needsJudgment.map((x) => x.nodeId), ["n1", "n2"]);
  assert.match(r.needsJudgment[0].why, /500/);
  assert.equal(r.needsJudgment[0].fields.length, 5);
});

test("non-JSON body gives needsJudgment", async () => {
  const r = await evaluateWithClef(cfg, analysis(1), ["n1"], fakeFetch(200, "<html>oops"));
  assert.deepEqual(r.needsJudgment.map((x) => x.nodeId), ["n1"]);
});

test("missing answer id gives needsJudgment for that node", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/clef-response.json", import.meta.url), "utf8"));
  const r = await evaluateWithClef(cfg, analysis(2), ["n1", "n2"], fakeFetch(200, fixture));
  assert.ok(r.values.n1);
  assert.equal(r.values.n2, undefined);
  assert.deepEqual(r.needsJudgment.map((x) => x.nodeId), ["n2"]);
});

test("network failure gives needsJudgment", async () => {
  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const r = await evaluateWithClef(cfg, analysis(1), ["n1"], failing);
  assert.match(r.needsJudgment[0].why, /fetch failed/);
});
