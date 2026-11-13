import { test } from "node:test";
import assert from "node:assert/strict";
import { clefConfigFromEnv, evaluateWithClef } from "../src/clef.ts";
import { addEvidence, addWhys, startAnalysis } from "../src/analysis.ts";
import { FIELDS } from "../src/model.ts";

// Calls the real Clef model. Runs only when CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are set.
const cfg = clefConfigFromEnv(process.env);

test("live Clef answers all five questions for two nodes", { skip: cfg ? false : "Cloudflare credentials not set" }, async () => {
  const now = () => new Date().toISOString();
  let a = startAnalysis({ id: "live", title: "決済エラー", problem: "2026-11-13 10:00 から、決済APIの呼び出しが 401 認証エラーで失敗し続けている" }, now);
  a = addWhys(a, "n0", [
    { text: "決済APIのキーが期限切れになった", viewpoint: "仕組み・道具" },
    { text: "決済サービス側で大規模な障害が起きた", viewpoint: "前提・外部" },
  ], now).analysis;
  a = addEvidence(a, "n1", { kind: "log", ref: "app log", summary: "401 の応答本文は 'API key expired'", supports: true }, now);
  a = addEvidence(a, "n2", { kind: "doc", ref: "status page", summary: "決済サービスのステータスページは全て正常", supports: false }, now);

  const r = await evaluateWithClef(cfg!, a, ["n1", "n2"]);
  assert.deepEqual(r.needsJudgment.filter((n) => n.why.startsWith("Clef")), [], JSON.stringify(r.needsJudgment));
  for (const id of ["n1", "n2"]) {
    for (const f of FIELDS) {
      const v = r.values[id]?.[f];
      assert.ok(v && v.value >= 0 && v.value <= 1, `${id}.${f}`);
    }
  }
  console.log(JSON.stringify(r.values, null, 2));
  assert.ok(r.values.n1.supported!.value > r.values.n2.supported!.value, "the backed cause should look more supported");
});
