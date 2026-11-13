import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/redact.ts";

const cases: Array<[string, string]> = [
  ["Authorization: Bearer abcDEF123456.xyz", "Bearer"],
  ["key sk-proj_ABCDEFGHIJKLMNOPQRSTUV", "sk-proj_ABCDEFGHIJKLMNOPQRSTUV"],
  ["token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"],
  ["password=hunter2hunter2", "hunter2hunter2"],
  ["api_key: q1w2e3r4t5", "q1w2e3r4t5"],
  ["sha 0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef01234567"],
  ["blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w"],
];

for (const [input, secret] of cases) {
  test(`redactSecrets hides ${secret.slice(0, 12)}`, () => {
    const out = redactSecrets(input);
    assert.ok(out.includes("[REDACTED]"), out);
    if (secret !== "Bearer") assert.ok(!out.includes(secret), out);
    else assert.ok(!out.includes("abcDEF123456"), out);
  });
}

test("redactSecrets keeps a normal sentence", () => {
  const s = "決済APIのキーが期限切れで、認証エラーが 2026-11-13 10:00 から増えた";
  assert.equal(redactSecrets(s), s);
});
