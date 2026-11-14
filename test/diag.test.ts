import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiagLog, createLinkWatch, createStallWatch, NUDGE_TEXT, STALL_MS } from "../web/diag.ts";

test("diag log batches events and posts them after the flush delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const posted: unknown[][] = [];
  const log = createDiagLog(async (events) => void posted.push(events));
  log.log("status.connected");
  log.log("tool", "add_whys", 40);
  assert.equal(posted.length, 0);
  t.mock.timers.tick(2_000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posted, [[{ kind: "status.connected" }, { kind: "tool", detail: "add_whys", ms: 40 }]]);
});

test("diag log flushes at 20 events, trims long details and never throws when posting fails", async () => {
  const posted: unknown[][] = [];
  const log = createDiagLog(async (events) => {
    posted.push(events);
    throw new Error("offline");
  });
  log.log("x", "d".repeat(500));
  for (let i = 0; i < 19; i++) log.log("tick");
  await new Promise((r) => setImmediate(r));
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.length, 20);
  assert.equal((posted[0]![0] as { detail: string }).detail.length, 300);
});

test("stall watch fires once when the person spoke and Gemini said nothing for 15 s", () => {
  const w = createStallWatch();
  assert.equal(STALL_MS, 15_000);
  w.person(1_000);
  assert.equal(w.check(15_999), false);
  assert.equal(w.check(16_000), true);
  assert.equal(w.check(30_000), false);
  w.person(31_000);
  w.gemini(32_000);
  assert.equal(w.check(60_000), false);
});

test("stall watch waits for the person's last words, not the first", () => {
  const w = createStallWatch();
  w.person(0);
  w.person(10_000);
  assert.equal(w.check(20_000), false);
  assert.equal(w.check(25_000), true);
});

test("nudge text asks Gemini to continue", () => {
  assert.equal(NUDGE_TEXT, "聞こえていますか? 直前の答えに続けて質問してください。");
});

test("link watch fires when the person kept talking but nothing came back for 15 s", () => {
  const w = createLinkWatch();
  w.server(0);
  for (let t = 100; t <= 7_000; t += 100) w.voice(0.05, false, t);
  assert.equal(w.check(14_999), false);
  assert.equal(w.check(15_000), true);
  assert.equal(w.check(20_000), false);
  w.server(21_000);
  assert.equal(w.check(40_000), false);
});

test("link watch stays quiet when the person is silent or muted (Live sends nothing then)", () => {
  const w = createLinkWatch();
  w.server(0);
  for (let t = 100; t <= 10_000; t += 100) w.voice(0.0001, false, t);
  for (let t = 10_100; t <= 20_000; t += 100) w.voice(0.05, true, t);
  assert.equal(w.check(60_000), false);
});

test("link watch does nothing before the first connection", () => {
  const w = createLinkWatch();
  for (let t = 100; t <= 10_000; t += 100) w.voice(0.05, false, t);
  assert.equal(w.check(60_000), false);
});
