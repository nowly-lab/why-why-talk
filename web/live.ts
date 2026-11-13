import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";
import type { TokenInfo } from "./api.ts";
import { nextConnection, type Connection, type LinkEvent, type LinkState } from "./reconnect.ts";

export type LiveHandlers = {
  onAudio(base64: string): void;
  onInterrupted(): void;
  onTranscript(speaker: "person" | "gemini", text: string): void;
  onToolCall(calls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>): Promise<Array<{ id?: string; name?: string; response: Record<string, unknown> }>>;
  onStatus(status: "connecting" | "connected" | "reconnecting" | "closed" | "error", detail?: string): void;
};

/**
 * One talk with Gemini Live, across several WebSocket connections. Each connection uses a fresh
 * single-use token from the local server; the session-resumption handle carries the conversation over.
 */
export function connectLive(getToken: (fallback: boolean) => Promise<TokenInfo>, h: LiveHandlers) {
  const state: LinkState = { handle: null, connectedAt: null };
  let session: Session | null = null;
  let closedByUs = false;
  let generation = 0;
  let resumedWith: string | null = null;

  async function open(conn: Connection): Promise<void> {
    const gen = ++generation;
    h.onStatus(state.connectedAt === null ? "connecting" : "reconnecting");
    const token = await getToken(conn.fallback);
    const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: "v1beta" } });
    resumedWith = conn.handle;
    const config = { ...token.config, sessionResumption: { handle: conn.handle ?? undefined } };
    const next = await ai.live.connect({
      model: token.model,
      config,
      callbacks: {
        onopen: () => undefined,
        onmessage: (m: LiveServerMessage) => {
          if (gen === generation) void onMessage(m);
        },
        onerror: (e: ErrorEvent) => {
          if (gen === generation) h.onStatus("error", e.message);
        },
        onclose: (e: CloseEvent) => {
          if (gen !== generation || closedByUs) return;
          // A refused resumption handle closes right away; anything else resumes with the handle.
          const refused = resumedWith !== null && state.connectedAt !== null && Date.now() - state.connectedAt < 3_000;
          void event(refused ? { kind: "handleRejected" } : { kind: "closed" }, e.reason);
        },
      },
    });
    const previous = session;
    session = next;
    state.connectedAt = Date.now();
    previous?.close();
    h.onStatus("connected");
    if (conn.fallback) {
      next.sendClientContent({ turns: [{ role: "user", parts: [{ text: "接続が切れました。直前の話の続きから、短く確かめて再開してください。" }] }], turnComplete: true });
    } else if (conn.handle === null) {
      next.sendClientContent({ turns: [{ role: "user", parts: [{ text: "始めてください。" }] }], turnComplete: true });
    }
  }

  async function onMessage(m: LiveServerMessage): Promise<void> {
    const sc = m.serverContent;
    if (sc?.interrupted) h.onInterrupted();
    for (const part of sc?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) h.onAudio(part.inlineData.data);
    }
    if (sc?.inputTranscription?.text) h.onTranscript("person", sc.inputTranscription.text);
    if (sc?.outputTranscription?.text) h.onTranscript("gemini", sc.outputTranscription.text);
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      state.handle = m.sessionResumptionUpdate.newHandle;
    }
    if (m.toolCall?.functionCalls?.length) {
      const functionResponses = await h.onToolCall(m.toolCall.functionCalls);
      session?.sendToolResponse({ functionResponses });
    }
    if (m.goAway) void event({ kind: "goAway" });
  }

  async function event(e: LinkEvent, detail?: string): Promise<void> {
    if (e.kind === "handleRejected") state.handle = null;
    const conn = nextConnection(state, e);
    if (!conn) return;
    if (detail) h.onStatus("reconnecting", detail);
    try {
      await open(conn);
    } catch (err) {
      h.onStatus("error", (err as Error).message);
    }
  }

  const timer = setInterval(() => void event({ kind: "tick", now: Date.now() }), 30_000);

  return {
    start: () => event({ kind: "start" }),
    sendAudio(base64: string) {
      session?.sendRealtimeInput({ audio: { data: base64, mimeType: "audio/pcm;rate=16000" } });
    },
    sendText(text: string) {
      session?.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
    },
    close() {
      closedByUs = true;
      clearInterval(timer);
      session?.close();
      h.onStatus("closed");
    },
  };
}
