import { rms } from "./mic.ts";
import { downsample, floatToPcm16Base64, pcm16Base64ToFloat } from "./pcm.ts";

/** Microphone at 16 kHz, delivered as base64 PCM16 chunks (~100 ms). `deviceId` "" is the system default. */
export type Mic = { stop(): void; setMuted(m: boolean): void; switchDevice(deviceId: string): Promise<void>; deviceLabel(): string };

function micConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
}

export async function startMic(
  onChunk: (base64: string) => void,
  opts: { deviceId?: string; onLevel?: (rms: number) => void } = {},
): Promise<Mic> {
  // Create the context before the first await so it is still inside the click (Safari), at the device rate
  // (Firefox refuses a 16 kHz context for a 48 kHz mic), and downsample to 16 kHz.
  const ctx = new AudioContext();
  const resumed = ctx.resume();
  let stream = await navigator.mediaDevices.getUserMedia(micConstraints(opts.deviceId ?? ""));
  await resumed;
  await ctx.audioWorklet.addModule("/audio-worklet.js");
  let source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "mic-chunker");
  let muted = false;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    opts.onLevel?.(rms(e.data));
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
    // Same audio context and Gemini connection; only the input changes. If the new mic fails, the old one stays.
    async switchDevice(deviceId: string) {
      const next = await navigator.mediaDevices.getUserMedia(micConstraints(deviceId));
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      stream = next;
      source = ctx.createMediaStreamSource(stream);
      source.connect(node);
    },
    deviceLabel: () => stream.getAudioTracks()[0]?.label ?? "",
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
