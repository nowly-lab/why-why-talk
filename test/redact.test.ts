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

test("redactSecrets masks a key in text with colons and equals", () => {
  for (const s of [
    "key sk-abcdefghijklmnopqrstuvwx leaked at 10:30",
    "a=1 token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 b=2",
    "at 10:30 hash 0123456789abcdef0123456789abcdef0123456789abcdef",
    "x: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w y=z",
  ]) {
    const out = redactSecrets(s);
    assert.ok(out.includes("[REDACTED]"), out);
    assert.ok(!/sk-abcdefghij|ghp_ABCDEF|0123456789abcdef0123|QUJDREVGR0hJ/.test(out), out);
    assert.ok(out.length < s.length + 20, `text was duplicated: ${out}`);
  }
});

test("redactSecrets keeps paths and URLs", () => {
  for (const s of [
    "/Users/me/src/payments/payment_webhook_handler_v2_final.ts",
    "https://github.com/nowly-lab/why-why-mcp/blob/main/src/analysis_and_rendering_helpers.ts",
    "apps/voice-service/src/handlers/settle_usage_log_after_ticket_redeemed.ts",
  ]) {
    assert.equal(redactSecrets(s), s);
  }
});

test("redactSecrets keeps git object names when asked", () => {
  const sha = "commit 0123456789abcdef0123456789abcdef01234567";
  assert.equal(redactSecrets(sha, { keepHashes: true }), sha);
  assert.ok(redactSecrets(sha).includes("[REDACTED]"));
  assert.ok(redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", { keepHashes: true }).includes("[REDACTED]"));
});

test("redactSecrets masks base64 keys that contain slashes", () => {
  for (const key of ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "Xk9f2Lq8Zt3Vb7Nw1Rs5Yh0Cm4Jd6Pg/Ae2Ui9Oo8Ee="]) {
    const out = redactSecrets(`secret key ${key} found`);
    assert.ok(out.includes("[REDACTED]") && !out.includes(key.slice(0, 12)), out);
  }
});

test("redactSecrets keeps mixed-case paths", () => {
  for (const s of [
    "src/Payments/WebhookHandler2/settleUsageLogAfterTicketRedeemed.ts",
    "/Users/Me/Projects2/PaymentService/src/WebhookHandlerV2Final.ts",
  ]) {
    assert.equal(redactSecrets(s), s);
  }
});

test("redactSecrets masks Google API keys and *_API_KEY assignments", () => {
  const key = "AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW";
  assert.equal(key.length, 39);
  assert.ok(!redactSecrets(`key ${key} here`).includes(key));
  for (const s of ["GEMINI_API_KEY=abc123def456", "OPENAI_API_KEY: sk1234567890", "MY_TOKEN=xyz987654321"]) {
    const out = redactSecrets(s);
    assert.ok(out.includes("[REDACTED]"), out);
    assert.ok(!/abc123def456|sk1234567890|xyz987654321/.test(out), out);
  }
});

test("redactSecrets masks extra exact values", () => {
  assert.equal(redactSecrets("the key is shortkey1", { extra: ["shortkey1"] }), "the key is [REDACTED]");
});
