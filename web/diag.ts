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
/** A pause longer than this ends a stretch of speech; the voiced count starts again. */
export const SPEECH_GAP_MS = 1_500;
/** The person must still be talking (last voiced chunk this recent) when the watch fires. */
const RECENT_VOICE_MS = 2_000;
/** Watchdog reconnects in a row with no real reply in between; after this the watch gives up and asks the person. */
export const MAX_LINK_RECOVERIES = 2;
const VOICE_FLOOR = 0.005;

export type LinkVerdict = "reconnect" | "give_up" | null;

/**
 * Notices a Live link that died without closing: the person kept talking (mic level), yet no server message
 * (not even their own transcription) came back. Live sends nothing while the person is silent, so silence alone
 * never fires it. Only one continuous stretch of speech counts (a pause or a mute resets it), and the watch is
 * suspended while Gemini's audio plays or a tool response is pending. Fires once per quiet period; after
 * MAX_LINK_RECOVERIES reconnects with no content message (setup messages do not count) it returns "give_up" once.
 */
export function createLinkWatch(opts: { quietMs?: number; voicedMs?: number; chunkMs?: number } = {}) {
  const quietMs = opts.quietMs ?? LINK_QUIET_MS;
  const voicedMs = opts.voicedMs ?? LINK_VOICED_MS;
  const chunkMs = opts.chunkMs ?? 100;
  let lastServer: number | null = null;
  let voiced = 0;
  let lastVoiced: number | null = null;
  let fired = false;
  let recoveries = 0;
  let gaveUp = false;
  const restart = (at: number) => {
    lastServer = at;
    voiced = 0;
    lastVoiced = null;
    fired = false;
  };
  return {
    /** `content`: the message carried a reply (serverContent or a tool call), not only setup or resumption data. */
    server(at: number, content: boolean) {
      restart(at);
      if (content) {
        recoveries = 0;
        gaveUp = false;
      }
    },
    voice(level: number, muted: boolean, at: number) {
      if (lastServer === null) return;
      if (muted) {
        voiced = 0;
        lastVoiced = null;
        return;
      }
      if (level < VOICE_FLOOR) return;
      if (lastVoiced !== null && at - lastVoiced > SPEECH_GAP_MS) voiced = 0;
      voiced += chunkMs;
      lastVoiced = at;
    },
    /** `busy`: Gemini audio is playing or a tool response is pending; counts as activity. */
    check(at: number, busy: boolean): LinkVerdict {
      if (lastServer === null) return null;
      if (busy) {
        restart(at);
        return null;
      }
      if (fired || gaveUp || at - lastServer < quietMs || voiced < voicedMs) return null;
      if (lastVoiced === null || at - lastVoiced > RECENT_VOICE_MS) return null;
      fired = true;
      if (recoveries >= MAX_LINK_RECOVERIES) {
        gaveUp = true;
        return "give_up";
      }
      recoveries++;
      return "reconnect";
    },
  };
}
