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

test("forwards groundingMetadata and turnComplete", async () => {
  let cb: Parameters<LiveConnect>[2] | undefined;
  const connect: LiveConnect = async (_t, _c, callbacks) => {
    cb = callbacks;
    return { sendClientContent() {}, sendRealtimeInput() {}, sendToolResponse() {}, close() {} };
  };
  const seen: string[] = [];
  const live = connectLive(async () => ({ token: "t", model: "m", expiresAt: "", config: {} }), {
    onAudio() {}, onInterrupted() {}, onTranscript() {}, onToolCall: async () => [], onStatus() {},
    onGrounding: (m) => seen.push(`g:${JSON.stringify(m)}`),
    onTurnComplete: () => seen.push("done"),
  }, { hasHistory: false, connect });
  await live.start();
  cb!.onmessage({ serverContent: { groundingMetadata: { webSearchQueries: ["q"] }, turnComplete: true } } as never);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['g:{"webSearchQueries":["q"]}', "done"]);
  live.close();
});

test("a tool call still gets a response when the handler throws", async () => {
  let cb: Parameters<LiveConnect>[2] | undefined;
  const sent: Array<Array<{ id?: string; name?: string; response: Record<string, unknown> }>> = [];
  const connect: LiveConnect = async (_t, _c, callbacks) => {
    cb = callbacks;
    return { sendClientContent() {}, sendRealtimeInput() {}, sendToolResponse: (p) => void sent.push(p.functionResponses), close() {} };
  };
  const live = connectLive(async () => ({ token: "t", model: "m", expiresAt: "", config: {} }), {
    onAudio() {}, onInterrupted() {}, onTranscript() {}, onStatus() {},
    onToolCall: async () => {
      throw new Error("refresh failed");
    },
  }, { hasHistory: false, connect });
  await live.start();
  cb!.onmessage({ toolCall: { functionCalls: [{ id: "c1", name: "add_whys", args: {} }, { id: "c2", name: "add_fact", args: {} }] } } as never);
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.map((r) => [r.id, r.name]), [["c1", "add_whys"], ["c2", "add_fact"]]);
  assert.match(String(sent[0]![0]!.response.error), /refresh failed/);
  live.close();
});

test("reconnect() opens a fresh connection with the resumption handle and reports server messages", async () => {
  const cbs: Array<Parameters<LiveConnect>[2]> = [];
  const configs: unknown[] = [];
  const connect: LiveConnect = async (_t, config, callbacks) => {
    cbs.push(callbacks);
    configs.push(config);
    return { sendClientContent() {}, sendRealtimeInput() {}, sendToolResponse() {}, close() {} };
  };
  let messages = 0;
  const live = connectLive(async () => ({ token: "t", model: "m", expiresAt: "", config: {} }), {
    onAudio() {}, onInterrupted() {}, onTranscript() {}, onToolCall: async () => [], onStatus() {},
    onServerMessage: () => void messages++,
  }, { hasHistory: false, connect });
  await live.start();
  cbs[0]!.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h9" } } as never);
  await new Promise((r) => setImmediate(r));
  assert.equal(messages, 1);
  await live.reconnect();
  assert.equal(cbs.length, 2);
  assert.deepEqual((configs[1] as { sessionResumption: unknown }).sessionResumption, { handle: "h9" });
  live.close();
});
