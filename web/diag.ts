// Diagnostics for a talk that goes quiet: compact events posted to the local server (<out>/events.jsonl),
// and a watch that notices when the person spoke but Gemini never answered.

export type DiagEvent = { kind: string; detail?: string; ms?: number };

export const STALL_MS = 15_000;
export const NUDGE_TEXT = "聞こえていますか? 直前の答えに続けて質問してください。";
const MAX_DETAIL = 300;
const BATCH = 20;
const FLUSH_MS = 2_000;
const MAX_BUFFER = 200;

/** Buffers events and posts them in batches. Losing diagnostics never breaks the talk. */
export function createDiagLog(post: (events: DiagEvent[]) => Promise<unknown>) {
  let buffer: DiagEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, BATCH);
    void post(batch).catch(() => undefined);
    if (buffer.length > 0) flush();
  };
  return {
    log(kind: string, detail?: string, ms?: number) {
      const e: DiagEvent = { kind };
      if (detail) e.detail = detail.slice(0, MAX_DETAIL);
      if (ms !== undefined) e.ms = Math.round(ms);
      buffer.push(e);
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      if (buffer.length >= BATCH) flush();
      else if (!timer) timer = setTimeout(flush, FLUSH_MS);
    },
    flush,
  };
}

/** Fires once when the person's last words are STALL_MS old and Gemini has not spoken, called a tool or ended a turn since. */
export function createStallWatch(timeoutMs = STALL_MS) {
  let personAt: number | null = null;
  return {
    person(at: number) {
      personAt = at;
    },
    gemini(_at: number) {
      personAt = null;
    },
    check(at: number): boolean {
      if (personAt === null || at - personAt < timeoutMs) return false;
      personAt = null;
      return true;
    },
  };
}
