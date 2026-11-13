import { downsample, floatToPcm16Base64, pcm16Base64ToFloat } from "./pcm.ts";

/** Microphone at 16 kHz, delivered as base64 PCM16 chunks (~100 ms). */
export async function startMic(onChunk: (base64: string) => void): Promise<{ stop(): void; setMuted(m: boolean): void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // Open the mic at the device rate (Firefox refuses a 16 kHz context for a 48 kHz device) and downsample.
  const ctx = new AudioContext();
  await ctx.resume();
  await ctx.audioWorklet.addModule("/audio-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "mic-chunker");
  let muted = false;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (!muted) onChunk(floatToPcm16Base64(downsample(e.data, ctx.sampleRate, 16_000)));
  };
  source.connect(node);
  return {
    stop() {
      node.disconnect();
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
    setMuted(m: boolean) {
      muted = m;
    },
  };
}

/** Plays Gemini's 24 kHz PCM16 audio back to back; `interrupt` stops what is queued (the person spoke over it). */
export function createPlayer(): { play(base64: string): void; interrupt(): void; resume(): Promise<void>; close(): void } {
  const ctx = new AudioContext({ sampleRate: 24_000 });
  let playhead = 0;
  const playing = new Set<AudioBufferSourceNode>();
  return {
    play(base64: string) {
      const samples = pcm16Base64ToFloat(base64);
      if (samples.length === 0) return;
      const buffer = ctx.createBuffer(1, samples.length, 24_000);
      buffer.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      playhead = Math.max(playhead, ctx.currentTime);
      src.start(playhead);
      playhead += buffer.duration;
      playing.add(src);
      src.onended = () => playing.delete(src);
    },
    interrupt() {
      for (const s of playing) s.stop();
      playing.clear();
      playhead = ctx.currentTime;
    },
    // Safari keeps a context made before a click suspended; call this from the click that starts the talk.
    resume: () => ctx.resume(),
    close() {
      void ctx.close();
    },
  };
}
