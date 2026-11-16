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
  const messages: boolean[] = [];
  const live = connectLive(async () => ({ token: "t", model: "m", expiresAt: "", config: {} }), {
    onAudio() {}, onInterrupted() {}, onTranscript() {}, onToolCall: async () => [], onStatus() {},
    onServerMessage: (content) => void messages.push(content),
  }, { hasHistory: false, connect });
  await live.start();
  cbs[0]!.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h9" } } as never);
  cbs[0]!.onmessage({ serverContent: { inputTranscription: { text: "はい" } } } as never);
  await new Promise((r) => setImmediate(r));
  // Only a reply counts as content; resumption updates keep the link watch's give-up count.
  assert.deepEqual(messages, [false, true]);
  await live.reconnect();
  assert.equal(cbs.length, 2);
  assert.deepEqual((configs[1] as { sessionResumption: unknown }).sessionResumption, { handle: "h9" });
  live.close();
});

// --- role switch restarts (plan v1 Task 2) ---
type Conn = { cb: Parameters<LiveConnect>[2]; config: { sessionResumption?: { handle?: string } }; texts: string[]; closed: boolean };
function fakeLink(opts: { failFirst?: number } = {}) {
  const conns: Conn[] = [];
  const tokenArgs: Array<[boolean, boolean]> = [];
  const closedBeforeConnect: boolean[] = [];
  let failures = opts.failFirst ?? 0;
  const connect: LiveConnect = async (_t, config, callbacks) => {
    closedBeforeConnect.push(conns.every((c) => c.closed));
    if (conns.length > 0 && failures > 0) {
      failures--;
      throw new Error("network down");
    }
    const c: Conn = { cb: callbacks, config: config as Conn["config"], texts: [], closed: false };
    conns.push(c);
    return {
      sendClientContent: (p) => void c.texts.push(p.turns[0]!.parts[0]!.text),
      sendRealtimeInput() {},
      sendToolResponse() {},
      close() {
        c.closed = true;
      },
    };
  };
  const statuses: string[] = [];
  const live = connectLive(async (fallback, roleSwitch) => {
    tokenArgs.push([fallback, roleSwitch]);
    return { token: "t", model: "m", expiresAt: "", config: {} };
  }, { onAudio() {}, onInterrupted() {}, onTranscript() {}, onToolCall: async () => [], onStatus: (s) => void statuses.push(s) }, { hasHistory: false, connect });
  return { live, conns, tokenArgs, closedBeforeConnect, statuses };
}
const tick = () => new Promise((r) => setImmediate(r));

test("a reconnect closes the old connection before opening the next", async () => {
  const { live, conns, closedBeforeConnect } = fakeLink();
  await live.start();
  conns[0]!.cb.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h1" } } as never);
  await live.reconnect();
  assert.deepEqual(closedBeforeConnect, [true, true]);
  assert.ok(conns[0]!.closed);
  // The retired connection's close event arrives later: it must not start another reconnect.
  conns[0]!.cb.onclose?.({ reason: "bye" } as CloseEvent);
  await tick();
  assert.equal(conns.length, 2);
  live.close();
});

test("restart opens a new seeded session and sends only the kick", async () => {
  const { live, conns, tokenArgs } = fakeLink();
  await live.start();
  conns[0]!.cb.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h1" } } as never);
  await live.restart("交代しました");
  assert.equal(conns.length, 2);
  assert.ok(conns[0]!.closed);
  assert.equal(conns[1]!.config.sessionResumption?.handle, undefined);
  assert.deepEqual(tokenArgs, [[false, false], [true, true]]);
  assert.deepEqual(conns[1]!.texts, ["交代しました"]);
  live.close();
});

test("after restart a reconnect resumes the new session's handle", async () => {
  const { live, conns } = fakeLink();
  await live.start();
  conns[0]!.cb.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h1" } } as never);
  await live.restart("交代しました");
  conns[1]!.cb.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: "h2" } } as never);
  await live.reconnect();
  assert.equal(conns[2]!.config.sessionResumption?.handle, "h2");
  live.close();
});

test("restarts asked while another open runs collapse to one more open with the last kick", async () => {
  const { live, conns } = fakeLink();
  await live.start();
  const a = live.restart("A");
  const b = live.restart("B");
  const c = live.restart("C");
  await Promise.all([a, b, c]);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(conns.length, 3);
  assert.deepEqual(conns[1]!.texts, ["A"]);
  assert.ok(conns[1]!.closed);
  assert.deepEqual(conns[2]!.texts, ["C"]);
  live.close();
});

test("a failed restart retries with the role-switch seed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { live, conns, tokenArgs } = fakeLink({ failFirst: 1 });
  await live.start();
  await live.restart("交代しました");
  assert.equal(conns.length, 1);
  t.mock.timers.tick(1_000);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(conns.length, 2);
  assert.deepEqual(tokenArgs.at(-1), [true, true]);
  assert.deepEqual(conns[1]!.texts, ["交代しました"]);
  live.close();
});
