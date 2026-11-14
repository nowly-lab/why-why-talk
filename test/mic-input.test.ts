import { test } from "node:test";
import assert from "node:assert/strict";
import { createInputSlot, createMicController, type SwitchResult } from "../web/mic-input.ts";

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

type FakeMic = { id: string; active: string; stopped: boolean; switchDevice(id: string): Promise<SwitchResult>; stop(): void };

/** A mic whose switches resolve when the test says so; the newest pending switch wins, like createInputSlot. */
function fakeMic(id: string, opts: { failing?: Set<string> } = {}) {
  const pending: { id: string; resolve: () => void; fail?: boolean }[] = [];
  let generation = 0;
  const failNext = new Set<number>();
  const mic: FakeMic = {
    id, active: id, stopped: false,
    switchDevice(next) {
      const mine = ++generation;
      return new Promise<SwitchResult>((resolve, reject) => {
        pending.push({ id: next, resolve: () => {
          if (opts.failing?.has(next) || failNext.has(mine)) return reject(new Error("NotFound"));
          if (mic.stopped) return resolve("stopped");
          if (mine !== generation) return resolve("superseded");
          mic.active = next;
          resolve("switched");
        } });
      });
    },
    stop() {
      mic.stopped = true;
    },
  };
  const settle = async (next: string) => {
    const i = pending.findIndex((p) => p.id === next);
    if (i < 0) throw new Error(`no pending switch to ${next}`);
    pending.splice(i, 1)[0]!.resolve();
    await new Promise((r) => setImmediate(r));
  };
  /** Makes the n-th switch request (1-based) fail. */
  const failRequest = (n: number) => void failNext.add(n);
  return { mic, settle, failRequest };
}

const controller = (initial: string, start: (id: string) => Promise<FakeMic>) => {
  const saved: string[] = [];
  const c = createMicController<FakeMic>({ start, persist: (id) => void saved.push(id) }, initial);
  return { c, saved };
};
const flush = () => new Promise((r) => setImmediate(r));

test("a mic chosen while the first mic was starting is applied once it has started", async () => {
  const gate = deferred<void>();
  const a = fakeMic("a1");
  const { c } = controller("a1", async () => (await gate.promise, a.mic));
  const starting = c.start();
  void c.choose("b2");
  gate.resolve();
  await flush();
  assert.equal(c.mic(), a.mic);
  await a.settle("b2");
  await starting;
  assert.equal(a.mic.active, "b2");
  assert.equal(c.active(), "b2");
});

test("A then B during start then C during the switch to B ends on C", async () => {
  const gate = deferred<void>();
  const a = fakeMic("a1");
  const { c } = controller("a1", async () => (await gate.promise, a.mic));
  const starting = c.start();
  void c.choose("b2");
  gate.resolve();
  await flush();
  const toC = c.choose("c3");
  await a.settle("c3");
  await a.settle("b2");
  await Promise.all([starting, toC]);
  assert.equal(a.mic.active, "c3");
  assert.equal(c.active(), "c3");
  assert.equal(c.choice(), "c3");
});

test("ending during the follow-up switch stops the mic that already started", async () => {
  const gate = deferred<void>();
  const a = fakeMic("a1");
  const { c } = controller("a1", async () => (await gate.promise, a.mic));
  const starting = c.start();
  void c.choose("b2");
  gate.resolve();
  await flush();
  c.stop();
  assert.equal(a.mic.stopped, true);
  await a.settle("b2");
  await starting;
  assert.equal(a.mic.active, "a1");
});

test("ending before the first mic has started stops it as soon as it arrives", async () => {
  const gate = deferred<void>();
  const a = fakeMic("a1");
  const { c } = controller("a1", async () => (await gate.promise, a.mic));
  const starting = c.start();
  c.stop();
  gate.resolve();
  assert.equal(await starting, null);
  assert.equal(a.mic.stopped, true);
  assert.equal(c.mic(), null);
});

test("an unplugged remembered mic falls back to the default once, and the default is what is saved", async () => {
  const started: string[] = [];
  const d = fakeMic("");
  const { c, saved } = controller("gone", async (id) => {
    started.push(id);
    if (id === "gone") throw new Error("NotFound");
    return d.mic;
  });
  await c.start();
  assert.deepEqual(started, ["gone", ""]);
  assert.equal(c.active(), "");
  assert.equal(c.choice(), "");
  assert.deepEqual(saved, [""]);
});

test("a failing switch keeps the active mic and puts the selector back to it", async () => {
  const a = fakeMic("a1", { failing: new Set(["x9"]) });
  const { c, saved } = controller("a1", async () => a.mic);
  await c.start();
  const rejected = assert.rejects(c.choose("x9"), /NotFound/);
  await a.settle("x9");
  await rejected;
  assert.equal(c.choice(), "a1");
  assert.equal(c.active(), "a1");
  assert.deepEqual(saved, ["x9", "a1"]);
});

test("a mic chosen during start that cannot be opened keeps the started mic and reports it", async () => {
  const gate = deferred<void>();
  const a = fakeMic("a1", { failing: new Set(["x9"]) });
  const errors: string[] = [];
  const c = createMicController<FakeMic>({ start: async () => (await gate.promise, a.mic), persist: () => undefined, onSwitchError: (e) => void errors.push(e.message) }, "a1");
  const starting = c.start();
  void c.choose("x9");
  gate.resolve();
  await flush();
  await a.settle("x9");
  assert.equal(await starting, a.mic);
  assert.equal(c.active(), "a1");
  assert.equal(c.choice(), "a1");
  assert.deepEqual(errors, ["NotFound"]);
});

test("an older failing request for the same mic does not undo a newer choice of it (B, A, B)", async () => {
  const a = fakeMic("a1");
  const { c } = controller("a1", async () => a.mic);
  await c.start();
  a.failRequest(1);
  const first = c.choose("b2").catch((e: Error) => e.message);
  void c.choose("a1");
  const second = c.choose("b2");
  await a.settle("b2");
  await a.settle("b2");
  assert.equal(await first, "NotFound");
  await second;
  await flush();
  assert.equal(c.choice(), "b2");
  assert.equal(c.active(), "b2");
  assert.equal(a.mic.active, "b2");
});

test("start returns null when the talk ended during the follow-up switch", async () => {
  const gate = deferred<void>();
  const a = fakeMic("a1");
  const { c } = controller("a1", async () => (await gate.promise, a.mic));
  const starting = c.start();
  void c.choose("b2");
  gate.resolve();
  await flush();
  c.stop();
  await a.settle("b2");
  assert.equal(await starting, null);
});
