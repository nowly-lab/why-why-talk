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

export const LINK_QUIET_MS = 15_000;
export const LINK_VOICED_MS = 6_000;
const VOICE_FLOOR = 0.005;

/**
 * Notices a Live link that died without closing: the person kept talking (mic level), yet no server message
 * (not even their own transcription) came back. Live sends nothing while the person is silent, so silence alone
 * never fires it. Fires once per quiet period.
 */
export function createLinkWatch(opts: { quietMs?: number; voicedMs?: number; chunkMs?: number } = {}) {
  const quietMs = opts.quietMs ?? LINK_QUIET_MS;
  const voicedMs = opts.voicedMs ?? LINK_VOICED_MS;
  const chunkMs = opts.chunkMs ?? 100;
  let lastServer: number | null = null;
  let voiced = 0;
  let fired = false;
  return {
    server(at: number) {
      lastServer = at;
      voiced = 0;
      fired = false;
    },
    voice(level: number, muted: boolean, _at: number) {
      if (lastServer !== null && !muted && level >= VOICE_FLOOR) voiced += chunkMs;
    },
    check(at: number): boolean {
      if (fired || lastServer === null || at - lastServer < quietMs || voiced < voicedMs) return false;
      fired = true;
      return true;
    },
  };
}
