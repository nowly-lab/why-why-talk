import { test } from "node:test";
import assert from "node:assert/strict";
import { createSegmenter, encodeWav, pcm16FromBase64, SEGMENT_DEFAULTS } from "../web/recorder.ts";
import { acceptDrop } from "../web/files.ts";

const RATE = 16_000;
const FRAME = 1_600; // 100 ms
const speech = () => Int16Array.from({ length: FRAME }, (_, i) => (i % 2 ? 6_000 : -6_000));
const silence = () => new Int16Array(FRAME);

function feed(seg: ReturnType<typeof createSegmenter>, pattern: Array<["s" | "q", number]>) {
  for (const [kind, ms] of pattern) for (let t = 0; t < ms; t += 100) seg.push(kind === "s" ? speech() : silence());
}

test("a segment ends after 1.5 s of silence", () => {
  const out: Int16Array[] = [];
  const seg = createSegmenter(SEGMENT_DEFAULTS, (p) => out.push(p));
  feed(seg, [["s", 2_000], ["q", 1_400]]);
  assert.equal(out.length, 0, "1.4 s of silence is still the same utterance");
  feed(seg, [["q", 100]]);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, (2_000 + 1_500) / 100 * FRAME, "the pause stays in the segment");
});

test("a segment is cut at 30 s of continuous speech", () => {
  const out: Int16Array[] = [];
  const seg = createSegmenter(SEGMENT_DEFAULTS, (p) => out.push(p));
  feed(seg, [["s", 31_000]]);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 30 * RATE);
});

test("silence alone makes no segment", () => {
  const out: Int16Array[] = [];
  const seg = createSegmenter(SEGMENT_DEFAULTS, (p) => out.push(p));
  feed(seg, [["q", 5_000], ["s", 200], ["q", 2_000]]);
  assert.equal(out.length, 0, "200 ms of sound is under minSpeechMs");
  seg.flush();
  assert.equal(out.length, 0);
});

test("flush sends the remaining speech", () => {
  const out: Int16Array[] = [];
  const seg = createSegmenter(SEGMENT_DEFAULTS, (p) => out.push(p));
  feed(seg, [["q", 3_000], ["s", 1_000]]);
  seg.flush();
  assert.equal(out.length, 1);
  assert.ok(out[0].length <= (1_000 + SEGMENT_DEFAULTS.silenceMs) / 100 * FRAME, "leading silence is dropped");
});

test("encodeWav writes a 44-byte header at 16 kHz mono", () => {
  const wav = encodeWav(Int16Array.from([1, -1, 300]), RATE);
  const v = new DataView(wav.buffer);
  const str = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
  assert.equal(wav.length, 44 + 6);
  assert.equal(str(0), "RIFF");
  assert.equal(v.getUint32(4, true), 36 + 6);
  assert.equal(str(8), "WAVE");
  assert.equal(v.getUint16(22, true), 1, "mono");
  assert.equal(v.getUint32(24, true), RATE);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(str(36), "data");
  assert.equal(v.getUint32(40, true), 6);
  assert.equal(v.getInt16(48, true), 300);
});

test("pcm16FromBase64 reads little-endian samples", () => {
  const b64 = Buffer.from(Int16Array.from([1, -2, 300]).buffer).toString("base64");
  assert.deepEqual([...pcm16FromBase64(b64)], [1, -2, 300]);
});

test("acceptDrop refuses docx and files over 10MB", () => {
  assert.deepEqual(acceptDrop({ name: "a.md", type: "", size: 10 }), { ok: true });
  assert.deepEqual(acceptDrop({ name: "shot.png", type: "image/png", size: 10 }), { ok: true });
  const docx = acceptDrop({ name: "a.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 10 });
  assert.ok(!docx.ok && /テキスト・Markdown・PDF・画像/.test(docx.reason));
  const big = acceptDrop({ name: "a.pdf", type: "application/pdf", size: 10 * 1024 * 1024 + 1 });
  assert.ok(!big.ok && /10MB/.test(big.reason));
});
