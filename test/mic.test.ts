import { test } from "node:test";
import assert from "node:assert/strict";
import { createSilenceWatch, loadMicChoice, meterValue, micOptions, MIC_STORAGE_KEY, rms, saveMicChoice } from "../web/mic.ts";

const dev = (kind: string, deviceId: string, label = "") => ({ kind, deviceId, label }) as MediaDeviceInfo;

test("micOptions lists audio inputs after the system default and keeps a known choice", () => {
  const r = micOptions([dev("audioinput", "default", "既定 - MacBook"), dev("audioinput", "a1", "AirPods"), dev("videoinput", "v1", "cam"), dev("audioinput", "b2", "")], "a1");
  assert.deepEqual(r.options, [{ id: "", label: "既定のマイク" }, { id: "a1", label: "AirPods" }, { id: "b2", label: "マイク 2" }]);
  assert.equal(r.selected, "a1");
});

test("micOptions falls back to the default when the saved mic is gone", () => {
  assert.equal(micOptions([dev("audioinput", "a1", "AirPods")], "gone").selected, "");
});

test("mic choice survives in storage and a broken storage does not throw", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  saveMicChoice(storage, "a1");
  assert.equal(map.get(MIC_STORAGE_KEY), "a1");
  assert.equal(loadMicChoice(storage), "a1");
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(loadMicChoice(broken), "");
  assert.doesNotThrow(() => saveMicChoice(broken, "a1"));
  assert.equal(loadMicChoice(null), "");
});

test("rms of silence is 0 and of a full-scale square is 1", () => {
  assert.equal(rms(new Float32Array(10)), 0);
  assert.equal(rms(Float32Array.from([1, -1, 1, -1])), 1);
});

test("silence watch warns once after 5 s of near-zero level and clears when sound returns", () => {
  const w = createSilenceWatch();
  assert.equal(w.sample(0, false, 0), null);
  assert.equal(w.sample(0.001, false, 4_900), null);
  assert.equal(w.sample(0, false, 5_000), "silent");
  assert.equal(w.sample(0, false, 9_000), null);
  assert.equal(w.sample(0.05, false, 9_100), "heard");
  assert.equal(w.sample(0.05, false, 9_200), null);
});

test("silence watch never warns while muted, and restarts the clock after unmuting", () => {
  const w = createSilenceWatch();
  assert.equal(w.sample(0, true, 0), null);
  assert.equal(w.sample(0, true, 20_000), null);
  assert.equal(w.sample(0, false, 20_100), null);
  assert.equal(w.sample(0, false, 25_000), null);
  assert.equal(w.sample(0, false, 25_100), "silent");
});

test("meterValue maps -60..0 dBFS to 0..1", () => {
  assert.equal(meterValue(0), 0);
  assert.equal(meterValue(1), 1);
  assert.equal(meterValue(0.001), 0);
  assert.ok(Math.abs(meterValue(0.01) - 1 / 3) < 1e-9);
});
