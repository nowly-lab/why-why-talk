import { GoogleGenAI, type LiveCallbacks, type LiveConnectConfig, type LiveServerMessage } from "@google/genai";
import type { TokenInfo } from "./api.ts";
import { createRetryBudget, nextConnection, type Connection, type LinkEvent, type LinkState } from "./reconnect.ts";

export type LiveHandlers = {
  onAudio(base64: string): void;
  onInterrupted(): void;
  onTranscript(speaker: "person" | "gemini", text: string): void;
  onToolCall(calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>): Promise<Array<{ id?: string; name?: string; response: Record<string, unknown> }>>;
  onStatus(status: "connecting" | "connected" | "reconnecting" | "closed" | "error" | "failed", detail?: string): void;
  /** Google Search grounding for the current answer (search words, source pages when Live sends them). */
  onGrounding?(meta: unknown): void;
  onTurnComplete?(): void;
};

const QUICK_CLOSE_MS = 3_000;

/** The part of a Live session this page uses. */
export type LiveSession = {
  sendClientContent(p: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }): void;
  sendRealtimeInput(p: { audio: { data: string; mimeType: string } }): void;
  sendToolResponse(p: { functionResponses: Array<{ id?: string; name?: string; response: Record<string, unknown> }> }): void;
  close(): void;
};
export type LiveConnect = (token: TokenInfo, config: LiveConnectConfig, callbacks: LiveCallbacks) => Promise<LiveSession>;

const sdkConnect: LiveConnect = (token, config, callbacks) =>
  new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: "v1beta" } }).live.connect({ model: token.model, config, callbacks });

/**
 * One talk with Gemini Live, across several WebSocket connections. Each connection uses a fresh
 * single-use token from the local server; the session-resumption handle carries the conversation over.
 * Only one (re)connect runs at a time; each connection answers its own tool calls; failures back off.
 */
export function connectLive(
  getToken: (fallback: boolean) => Promise<TokenInfo>,
  h: LiveHandlers,
  opts: { hasHistory: boolean; connect?: LiveConnect },
) {
  const connect = opts.connect ?? sdkConnect;
  const state: LinkState = { handle: null, connectedAt: null };
  let current: LiveSession | null = null;
  let closedByUs = false;
  let busy = false;
  const budget = createRetryBudget();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  async function open(conn: Connection): Promise<void> {
    h.onStatus(state.connectedAt === null ? "connecting" : "reconnecting");
    const token = await getToken(conn.fallback);
    let mine: LiveSession | null = null;
    let openedAt = 0;
    let alive = true;
    const config = { ...token.config, sessionResumption: { handle: conn.handle ?? undefined } } as LiveConnectConfig;
    mine = await connect(token, config, {
        onmessage: (m: LiveServerMessage) => void onMessage(mine!, m),
        onerror: (e: ErrorEvent) => {
          if (mine === current) h.onStatus("error", e.message);
        },
        onclose: (e: CloseEvent) => {
          alive = false;
          if (mine !== current || closedByUs) return;
          const quick = Date.now() - openedAt < QUICK_CLOSE_MS;
          if (quick && conn.handle !== null) void event({ kind: "handleRejected" }, e.reason);
          else if (quick) scheduleRetry(conn, e.reason || "closed right after connecting");
          else void event({ kind: "closed" }, e.reason);
        },
    });
    openedAt = Date.now();
    const previous = current;
    current = mine;
    state.connectedAt = openedAt;
    previous?.close();
    budget.connected();
    // Only a connection that is still open after QUICK_CLOSE_MS earns back the retry budget.
    setTimeout(() => {
      if (current === mine && alive) budget.stable();
    }, QUICK_CLOSE_MS);
    h.onStatus("connected");
    if (conn.fallback) {
      mine.sendClientContent({ turns: [{ role: "user", parts: [{ text: "接続が切れました。直前の話の続きから、短く確かめて再開してください。" }] }], turnComplete: true });
    } else if (conn.handle === null) {
      mine.sendClientContent({ turns: [{ role: "user", parts: [{ text: "始めてください。" }] }], turnComplete: true });
    }
  }

  // Messages from an older connection that is still draining are handled too (a tool call there must still land).
  async function onMessage(from: LiveSession, m: LiveServerMessage): Promise<void> {
    const sc = m.serverContent;
    if (sc?.interrupted) h.onInterrupted();
    for (const part of sc?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) h.onAudio(part.inlineData.data);
    }
    if (sc?.inputTranscription?.text) h.onTranscript("person", sc.inputTranscription.text);
    if (sc?.outputTranscription?.text) h.onTranscript("gemini", sc.outputTranscription.text);
    if (sc?.groundingMetadata) h.onGrounding?.(sc.groundingMetadata);
    if (sc?.turnComplete) h.onTurnComplete?.();
    if (from === current && m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      state.handle = m.sessionResumptionUpdate.newHandle;
    }
    if (m.toolCall?.functionCalls?.length) {
      // Gemini waits for an answer to every call: a failing handler still answers each one with the error.
      const calls = m.toolCall.functionCalls;
      const functionResponses = await h.onToolCall(calls).catch((e: unknown) =>
        calls.map((c) => ({ id: c.id, name: c.name, response: { error: (e as Error)?.message ?? String(e) } })));
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
