import { createSerialQueue } from "./queue.ts";
import { bytesToBase64, createSegmenter, encodeWav, pcm16FromBase64, SEGMENT_DEFAULTS } from "./recorder.ts";

export type FreeTalkDeps = {
  /** Sends one WAV segment (base64) and returns its transcription. */
  postAudio: (wavBase64: string) => Promise<string>;
  /** `seq` is the segment's place in the talk; a retried segment keeps its original number. */
  onText: (text: string, seq: number) => void;
  /** How many segments failed and wait for 再試行 (or 捨てる). */
  onFailedChange: (count: number) => void;
};

type Segment = { seq: number; wav: string };

/**
 * Free talk: mic chunks → utterance segments → transcribed one at a time, in order. A segment that fails stays in
 * memory (never on disk) until 再試行 sends it again or the person discards it; finish() reports how many are left,
 * so nothing moves on while words are missing.
 */
export function createFreeTalk(deps: FreeTalkDeps) {
  const queue = createSerialQueue();
  let failed: Segment[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  let nextSeq = 0;

  const send = (seg: Segment): Promise<void> => {
    const run = queue(async () => {
      try {
        const text = await deps.postAudio(seg.wav);
        if (text.trim() !== "") deps.onText(text, seg.seq);
      } catch {
        failed.push(seg);
        deps.onFailedChange(failed.length);
      }
    });
    pending = run;
    return run;
  };
  const segmenter = createSegmenter(SEGMENT_DEFAULTS, (pcm) => {
    void send({ seq: nextSeq++, wav: bytesToBase64(encodeWav(pcm, SEGMENT_DEFAULTS.sampleRate)) });
  });
  const settle = () => pending.then(() => undefined, () => undefined);

  return {
    push(chunkBase64: string): void {
      segmenter.push(pcm16FromBase64(chunkBase64));
    },
    /** Resolves when every segment sent so far has been answered. */
    idle: settle,
    async retry(): Promise<void> {
      const again = failed.sort((a, b) => a.seq - b.seq);
      failed = [];
      deps.onFailedChange(0);
      for (const seg of again) void send(seg);
      await settle();
    },
    /** Gives up the failed segments; the person chose to go on without them. */
    discard(): void {
      failed = [];
      deps.onFailedChange(0);
    },
    /** Sends what is still being said, waits, and returns how many segments are still untranscribed. */
    async finish(): Promise<number> {
      segmenter.flush();
      await settle();
      return failed.length;
    },
    failedCount: () => failed.length,
  };
}
