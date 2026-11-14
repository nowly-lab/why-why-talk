import { test } from "node:test";
import assert from "node:assert/strict";
import { createInputSlot, startWithLatestChoice } from "../web/mic-input.ts";

type FakeStream = { id: string; stopped: boolean; getTracks(): { stop(): void }[] };
const stream = (id: string): FakeStream => {
  const s: FakeStream = { id, stopped: false, getTracks: () => [{ stop: () => void (s.stopped = true) }] };
  return s;
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

test("a mic switch that resolves after stop() stops the late stream and attaches nothing", async () => {
  const attached: string[] = [];
  const first = stream("a");
  const slot = createInputSlot(first, { attach: (s) => void attached.push(s.id), detach: () => undefined });
  const late = deferred<FakeStream>();
  const switching = slot.switchTo(() => late.promise);
  slot.stop();
  assert.equal(first.stopped, true);
  const next = stream("b");
  late.resolve(next);
  assert.equal(await switching, "stopped");
  assert.equal(next.stopped, true);
  assert.deepEqual(attached, []);
});

test("an older switch that resolves after a newer one is stopped, the newest stream stays", async () => {
  const attached: string[] = [];
  const slot = createInputSlot(stream("a"), { attach: (s) => void attached.push(s.id), detach: () => undefined });
  const slow = deferred<FakeStream>();
  const older = slot.switchTo(() => slow.promise);
  const c = stream("c");
  assert.equal(await slot.switchTo(async () => c), "switched");
  const b = stream("b");
  slow.resolve(b);
  assert.equal(await older, "superseded");
  assert.equal(b.stopped, true);
  assert.equal(c.stopped, false);
  assert.equal(slot.current().id, "c");
  assert.deepEqual(attached, ["c"]);
});

test("a switch replaces the stream and stops the old one; a failing switch keeps the old one", async () => {
  const a = stream("a");
  const slot = createInputSlot(a, { attach: () => undefined, detach: () => undefined });
  await assert.rejects(slot.switchTo(async () => { throw new Error("NotFound"); }), /NotFound/);
  assert.equal(slot.current().id, "a");
  assert.equal(a.stopped, false);
  const b = stream("b");
  assert.equal(await slot.switchTo(async () => b), "switched");
  assert.equal(a.stopped, true);
  assert.equal(slot.current().id, "b");
});

test("a mic chosen while the first mic was still starting is applied once it has started", async () => {
  let choice = "a1";
  const gate = deferred<void>();
  const switched: string[] = [];
  const started: string[] = [];
  const pending = startWithLatestChoice(() => choice, async (id) => {
    started.push(id);
    await gate.promise;
    return { switchDevice: async (next: string) => void switched.push(next) };
  });
  choice = "b2";
  gate.resolve();
  const r = await pending;
  assert.deepEqual(started, ["a1"]);
  assert.deepEqual(switched, ["b2"]);
  assert.equal(r.used, "b2");
  assert.equal(r.switchError, undefined);
});

test("no change during start means no switch; a failing late switch keeps the first mic and reports it", async () => {
  const none: string[] = [];
  const r1 = await startWithLatestChoice(() => "a1", async () => ({ switchDevice: async (n: string) => void none.push(n) }));
  assert.deepEqual(none, []);
  assert.equal(r1.used, "a1");
  let choice = "a1";
  const r2 = await startWithLatestChoice(() => choice, async () => {
    choice = "gone";
    return { switchDevice: async () => { throw new Error("NotFound"); } };
  });
  assert.equal(r2.used, "a1");
  assert.match(r2.switchError?.message ?? "", /NotFound/);
});
