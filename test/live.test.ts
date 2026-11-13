import { test } from "node:test";
import assert from "node:assert/strict";
import { connectLive, type LiveConnect } from "../web/live.ts";
import { MAX_RETRIES } from "../web/reconnect.ts";

test("a server that accepts and closes after 0.5 s ends in failed, not an endless loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let connects = 0;
  let tokens = 0;
  const statuses: string[] = [];
  const connect: LiveConnect = async (_token, _config, callbacks) => {
    connects++;
    setTimeout(() => callbacks.onclose?.({ reason: "quota" } as CloseEvent), 500);
    return { sendClientContent() {}, sendRealtimeInput() {}, sendToolResponse() {}, close() {} };
  };
  const live = connectLive(
    async () => {
      tokens++;
      return { token: "t", model: "m", expiresAt: "", config: {} };
    },
    {
      onAudio() {},
      onInterrupted() {},
      onTranscript() {},
      onToolCall: async () => [],
      onStatus: (s) => statuses.push(s),
    },
    { hasHistory: false, connect },
  );
  await live.start();
  for (let i = 0; i < 400; i++) {
    t.mock.timers.tick(500);
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(statuses.includes("failed"), statuses.join(","));
  assert.equal(connects, MAX_RETRIES + 1);
  assert.equal(tokens, MAX_RETRIES + 1);
  live.close();
});
