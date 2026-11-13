import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";
import type { TokenInfo } from "./api.ts";
import { createRetryBudget, nextConnection, type Connection, type LinkEvent, type LinkState } from "./reconnect.ts";

export type LiveHandlers = {
  onAudio(base64: string): void;
  onInterrupted(): void;
  onTranscript(speaker: "person" | "gemini", text: string): void;
  onToolCall(calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>): Promise<Array<{ id?: string; name?: string; response: Record<string, unknown> }>>;
  onStatus(status: "connecting" | "connected" | "reconnecting" | "closed" | "error" | "failed", detail?: string): void;
};

const QUICK_CLOSE_MS = 3_000;

/**
 * One talk with Gemini Live, across several WebSocket connections. Each connection uses a fresh
 * single-use token from the local server; the session-resumption handle carries the conversation over.
 * Only one (re)connect runs at a time; each connection answers its own tool calls; failures back off.
 */
export function connectLive(getToken: (fallback: boolean) => Promise<TokenInfo>, h: LiveHandlers, opts: { hasHistory: boolean }) {
  const state: LinkState = { handle: null, connectedAt: null };
  let current: Session | null = null;
  let closedByUs = false;
  let busy = false;
  const budget = createRetryBudget();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  async function open(conn: Connection): Promise<void> {
    h.onStatus(state.connectedAt === null ? "connecting" : "reconnecting");
    const token = await getToken(conn.fallback);
    const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: "v1beta" } });
    let mine: Session | null = null;
    let openedAt = 0;
    const config = { ...token.config, sessionResumption: { handle: conn.handle ?? undefined } };
    mine = await ai.live.connect({
      model: token.model,
      config,
      callbacks: {
        onmessage: (m: LiveServerMessage) => void onMessage(mine!, m),
        onerror: (e: ErrorEvent) => {
          if (mine === current) h.onStatus("error", e.message);
        },
        onclose: (e: CloseEvent) => {
          if (mine !== current || closedByUs) return;
          const quick = Date.now() - openedAt < QUICK_CLOSE_MS;
          if (quick && conn.handle !== null) void event({ kind: "handleRejected" }, e.reason);
          else if (quick) scheduleRetry(conn, e.reason || "closed right after connecting");
          else void event({ kind: "closed" }, e.reason);
        },
      },
    });
    openedAt = Date.now();
    const previous = current;
    current = mine;
    state.connectedAt = openedAt;
    previous?.close();
    budget.connected();
    setTimeout(() => {
      if (current === mine) budget.stable();
    }, QUICK_CLOSE_MS);
    h.onStatus("connected");
    if (conn.fallback) {
      mine.sendClientContent({ turns: [{ role: "user", parts: [{ text: "接続が切れました。直前の話の続きから、短く確かめて再開してください。" }] }], turnComplete: true });
    } else if (conn.handle === null) {
      mine.sendClientContent({ turns: [{ role: "user", parts: [{ text: "始めてください。" }] }], turnComplete: true });
    }
  }

  // Messages from an older connection that is still draining are handled too (a tool call there must still land).
  async function onMessage(from: Session, m: LiveServerMessage): Promise<void> {
    const sc = m.serverContent;
    if (sc?.interrupted) h.onInterrupted();
    for (const part of sc?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) h.onAudio(part.inlineData.data);
    }
    if (sc?.inputTranscription?.text) h.onTranscript("person", sc.inputTranscription.text);
    if (sc?.outputTranscription?.text) h.onTranscript("gemini", sc.outputTranscription.text);
    if (from === current && m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      state.handle = m.sessionResumptionUpdate.newHandle;
    }
    if (m.toolCall?.functionCalls?.length) {
      const functionResponses = await h.onToolCall(m.toolCall.functionCalls);
      try {
        from.sendToolResponse({ functionResponses });
      } catch {
        // The connection that asked is gone; the tree change itself is already saved.
      }
    }
    if (m.goAway && from === current) void event({ kind: "goAway" });
  }

  async function event(e: LinkEvent, detail?: string): Promise<void> {
    if (closedByUs || busy || retryTimer) return;
    if (e.kind === "handleRejected") state.handle = null;
    const conn = nextConnection(state, e);
    if (!conn) return;
    if (detail) h.onStatus("reconnecting", detail);
    await attemptOpen(conn);
  }

  async function attemptOpen(conn: Connection): Promise<void> {
    busy = true;
    try {
      await open(conn);
    } catch (err) {
      busy = false;
      scheduleRetry(conn, (err as Error).message);
      return;
    }
    busy = false;
  }

  function scheduleRetry(conn: Connection, why: string): void {
    const delay = budget.failed();
    if (delay === null) {
      h.onStatus("failed", why);
      return;
    }
    h.onStatus("reconnecting", `${why}(${Math.round(delay / 1000)} 秒後にやり直します)`);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptOpen(state.handle ? { handle: state.handle, fallback: false } : { handle: null, fallback: conn.fallback || state.connectedAt !== null });
    }, delay);
  }

  const ticker = setInterval(() => void event({ kind: "tick", now: Date.now() }), 30_000);

  return {
    start: () => event({ kind: "start", hasHistory: opts.hasHistory }),
    /** After "failed": try again from the start of the backoff. */
    retry() {
      budget.reset();
      void attemptOpen(state.handle ? { handle: state.handle, fallback: false } : { handle: null, fallback: true });
    },
    sendAudio(base64: string) {
      current?.sendRealtimeInput({ audio: { data: base64, mimeType: "audio/pcm;rate=16000" } });
    },
    sendText(text: string) {
      current?.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
    },
    close() {
      closedByUs = true;
      clearInterval(ticker);
      if (retryTimer) clearTimeout(retryTimer);
      current?.close();
      h.onStatus("closed");
    },
  };
}
