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

const talk = (w: ReturnType<typeof createLinkWatch>, from: number, to: number, opts: { muted?: boolean; level?: number } = {}) => {
  for (let t = from; t <= to; t += 100) w.voice(opts.level ?? 0.05, opts.muted ?? false, t);
};

test("link watch asks for a reconnect when the person kept talking but nothing came back for 15 s", () => {
  const w = createLinkWatch();
  w.server(0, true);
  talk(w, 8_000, 14_900);
  assert.equal(w.check(14_999, false), null);
  assert.equal(w.check(15_000, false), "reconnect");
  assert.equal(w.check(20_000, false), null);
  w.server(21_000, true);
  assert.equal(w.check(40_000, false), null);
});

test("link watch stays quiet when the person is silent or muted (Live sends nothing then)", () => {
  const w = createLinkWatch();
  w.server(0, true);
  talk(w, 100, 10_000, { level: 0.0001 });
  talk(w, 10_100, 20_000, { muted: true });
  assert.equal(w.check(60_000, false), null);
});

test("link watch forgets speech before a mute: 6 s of talk then mute does not reconnect", () => {
  const w = createLinkWatch();
  w.server(0, true);
  talk(w, 100, 6_500);
  talk(w, 6_600, 15_000, { muted: true });
  assert.equal(w.check(15_000, false), null);
});

test("link watch counts only recent speech: bursts separated by silence never add up", () => {
  const w = createLinkWatch();
  w.server(0, true);
  for (let start = 100; start < 14_000; start += 3_500) {
    talk(w, start, start + 1_000);
    talk(w, start + 1_100, start + 3_400, { level: 0.0001 });
  }
  assert.equal(w.check(15_000, false), null);
});

test("link watch needs the person to be talking now, not only earlier in the quiet period", () => {
  const w = createLinkWatch();
  w.server(0, true);
  talk(w, 100, 7_000);
  talk(w, 7_100, 15_000, { level: 0.0001 });
  assert.equal(w.check(15_000, false), null);
});

test("link watch is suspended while Gemini audio plays or a tool response is pending", () => {
  const w = createLinkWatch();
  w.server(0, true);
  talk(w, 8_000, 15_000);
  assert.equal(w.check(15_000, true), null);
  talk(w, 15_100, 29_000);
  assert.equal(w.check(29_000, true), null);
  // Busy counts as activity: the quiet period restarts when it ends.
  talk(w, 29_100, 43_900);
  assert.equal(w.check(43_900, false), null);
  assert.equal(w.check(44_000, false), "reconnect");
});

test("link watch gives up after 2 reconnects with no real reply in between (setup messages do not count)", () => {
  const w = createLinkWatch();
  w.server(0, true);
  talk(w, 8_000, 15_000);
  assert.equal(w.check(15_000, false), "reconnect");
  w.server(16_000, false);
  talk(w, 24_000, 31_000);
  assert.equal(w.check(31_000, false), "reconnect");
  w.server(32_000, false);
  talk(w, 40_000, 47_000);
  assert.equal(w.check(47_000, false), "give_up");
  w.server(48_000, false);
  talk(w, 56_000, 63_000);
  assert.equal(w.check(63_000, false), null);
  // A real reply (content) restores the watch.
  w.server(64_000, true);
  talk(w, 72_000, 79_000);
  assert.equal(w.check(79_000, false), "reconnect");
});

test("link watch does nothing before the first connection", () => {
  const w = createLinkWatch();
  talk(w, 100, 10_000);
  assert.equal(w.check(60_000, false), null);
});
