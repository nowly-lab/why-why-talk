import { createSerialQueue } from "./queue.ts";
import { bytesToBase64, createSegmenter, encodeWav, pcm16FromBase64, SEGMENT_DEFAULTS } from "./recorder.ts";

export type FreeTalkDeps = {
  /** Sends one WAV segment (base64) and returns its transcription. */
  postAudio: (wavBase64: string) => Promise<string>;
  onText: (text: string) => void;
  /** How many segments failed and wait for 再試行. */
  onFailedChange: (count: number) => void;
};

/**
 * Free talk: mic chunks → utterance segments → transcribed one at a time, in order. A segment that fails stays in
 * memory (never on disk) until 再試行 sends it again.
 */
export function createFreeTalk(deps: FreeTalkDeps) {
  const queue = createSerialQueue();
  let failed: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();

  const send = (wav: string): Promise<void> => {
    const run = queue(async () => {
      try {
        const text = await deps.postAudio(wav);
        if (text.trim() !== "") deps.onText(text);
      } catch {
        failed.push(wav);
        deps.onFailedChange(failed.length);
      }
    });
    pending = run;
    return run;
  };
  const segmenter = createSegmenter(SEGMENT_DEFAULTS, (pcm) => {
    void send(bytesToBase64(encodeWav(pcm, SEGMENT_DEFAULTS.sampleRate)));
  });

  return {
    push(chunkBase64: string): void {
      segmenter.push(pcm16FromBase64(chunkBase64));
    },
    /** Resolves when every segment sent so far has been answered. */
    idle: () => pending.then(() => undefined, () => undefined),
    async retry(): Promise<void> {
      const again = failed;
      failed = [];
      deps.onFailedChange(0);
      for (const wav of again) void send(wav);
      await pending.catch(() => undefined);
    },
    /** Sends what is still being said, then waits: used before 問いに分ける. */
    async finish(): Promise<void> {
      segmenter.flush();
      await pending.catch(() => undefined);
    },
    failedCount: () => failed.length,
  };
}
