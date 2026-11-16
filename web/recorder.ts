/** Splits the free-talk microphone stream into utterances that are transcribed one by one. No DOM: tested in Node. */
export type SegmenterOptions = { sampleRate: number; silenceMs: number; maxMs: number; minSpeechMs: number; prerollMs: number; threshold: number };

export const SEGMENT_DEFAULTS: SegmenterOptions = {
  sampleRate: 16_000,
  // A Japanese pause inside a sentence is often near 1 s (voice trial 2026-11-14); end an utterance after 1.5 s.
  silenceMs: 1_500,
  maxMs: 30_000,
  // Coughs and clicks shorter than this are not sent.
  minSpeechMs: 300,
  // Keep a little sound from before the first loud frame so the first syllable is not cut.
  prerollMs: 300,
  // RMS of a frame in [0, 1]. Quiet speech was missed before (2026-11-14), so keep this low.
  threshold: 0.01,
};

export function createSegmenter(opts: SegmenterOptions, onSegment: (pcm: Int16Array) => void): { push(frame: Int16Array): void; flush(): void } {
  const msOf = (samples: number) => (samples / opts.sampleRate) * 1000;
  let preroll: Int16Array[] = [];
  let frames: Int16Array[] = [];
  let started = false;
  let speechMs = 0;
  let silenceRunMs = 0;
  let bufferedMs = 0;

  const reset = () => {
    frames = [];
    preroll = [];
    started = false;
    speechMs = 0;
    silenceRunMs = 0;
    bufferedMs = 0;
  };
  const emit = () => {
    if (speechMs >= opts.minSpeechMs) onSegment(concat(frames));
    reset();
  };

  return {
    push(frame) {
      const ms = msOf(frame.length);
      const loud = rms16(frame) >= opts.threshold;
      if (!started) {
        if (!loud) {
          preroll.push(frame);
          let kept = preroll.reduce((n, f) => n + msOf(f.length), 0);
          while (preroll.length > 0 && kept > opts.prerollMs) kept -= msOf(preroll.shift()!.length);
          return;
        }
        started = true;
        frames = [...preroll, frame];
        bufferedMs = frames.reduce((n, f) => n + msOf(f.length), 0);
        preroll = [];
        speechMs = ms;
      } else {
        frames.push(frame);
        bufferedMs += ms;
        if (loud) {
          speechMs += ms;
          silenceRunMs = 0;
        } else {
          silenceRunMs += ms;
        }
      }
      if (silenceRunMs >= opts.silenceMs || bufferedMs >= opts.maxMs) emit();
    },
    flush() {
      if (started) emit();
      else reset();
    },
  };
}

function rms16(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += (frame[i] / 32768) ** 2;
  return Math.sqrt(sum / frame.length);
}

function concat(frames: Int16Array[]): Int16Array {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** Little-endian PCM16 base64 (what startMic delivers) to samples. */
export function pcm16FromBase64(b64: string): Int16Array {
  const bin = atob(b64);
  const out = new Int16Array(Math.floor(bin.length / 2));
  for (let i = 0; i < out.length; i++) {
    const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

/** A mono 16-bit PCM WAV file. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
