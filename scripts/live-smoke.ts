// Real Gemini Live check (not part of `npm test`; costs a few cents). Needs GEMINI_API_KEY.
//   node scripts/live-smoke.ts
// Mints a token through our code, asks in text, expects an add_whys tool call and Japanese speech
// (output transcription), then reconnects with the session-resumption handle on a fresh token.
import { GoogleGenAI, type LiveServerMessage, type Session } from "@google/genai";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL, DEFAULT_VOICE, mintToken } from "../src/talk/gemini.ts";
import { TalkSession } from "../src/talk/session.ts";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
const model = process.env.WHY_WHY_LIVE_MODEL ?? DEFAULT_MODEL;
const voice = process.env.WHY_WHY_VOICE ?? DEFAULT_VOICE;
const s = new TalkSession({
  topic: "決済エラーの再発をどう防ぐか",
  context: "2026-11-13 10:00 から決済APIが 401 で40分失敗した。応答本文は API key expired。",
  outDir: await mkdtemp(join(tmpdir(), "live-smoke-")),
});

type Run = { session: Session; transcript: string; toolCalls: string[]; handle: string | null; turnDone: Promise<void> };

async function connect(handle: string | null, label: string): Promise<Run> {
  const t = await mintToken({ apiKey: apiKey!, model, voice }, s, { fallback: false });
  const ai = new GoogleGenAI({ apiKey: t.token, httpOptions: { apiVersion: "v1beta" } });
  const run = { transcript: "", toolCalls: [] as string[], handle: null as string | null } as Run;
  let doneTurn!: () => void;
  run.turnDone = new Promise((r) => (doneTurn = r));
  run.session = await ai.live.connect({
    model: t.model,
    config: { ...t.config, sessionResumption: { handle: handle ?? undefined } },
    callbacks: {
      onmessage: (m: LiveServerMessage) => {
        if (m.serverContent?.outputTranscription?.text) run.transcript += m.serverContent.outputTranscription.text;
        if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) run.handle = m.sessionResumptionUpdate.newHandle;
        if (m.toolCall?.functionCalls?.length) {
          const functionResponses = m.toolCall.functionCalls.map((c) => {
            run.toolCalls.push(c.name ?? "?");
            const r = s.applyTool(c.name ?? "", c.args ?? {});
            return { id: c.id, name: c.name, response: r as unknown as Record<string, unknown> };
          });
          run.session.sendToolResponse({ functionResponses });
        }
        if (m.serverContent?.turnComplete) doneTurn();
      },
      onerror: (e: ErrorEvent) => console.error(`[${label}] error`, e.message),
      onclose: (e: CloseEvent) => console.error(`[${label}] closed`, e.code, e.reason),
    },
  });
  return run;
}

const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms`)), ms));

const a = await connect(null, "first");
a.session.sendClientContent({
  turns: [{ role: "user", parts: [{ text: "キーの期限切れが原因だと思います。木に足してから、次の「なぜ?」を1つだけ聞いてください。" }] }],
  turnComplete: true,
});
await Promise.race([a.turnDone, timeout(60_000)]);
// A tool call ends the first turn; wait for the spoken follow-up too.
if (a.toolCalls.length > 0 && a.transcript.length < 5) {
  a.turnDone = new Promise((r) => setTimeout(r, 15_000));
  await a.turnDone;
}
console.log("model:", model, "voice:", voice);
console.log("tool calls:", a.toolCalls.join(", ") || "(none)");
console.log("tree:", JSON.stringify(s.analysis.nodes.map((n) => [n.id, n.text, n.state])));
console.log("gemini said:", a.transcript.slice(0, 300));
console.log("japanese:", /[぀-ヿ一-鿿]/.test(a.transcript));
console.log("resumption handle:", a.handle ? "received" : "none");
a.session.close();

if (a.handle) {
  const b = await connect(a.handle, "resumed");
  b.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "さっき木に足した理由を、一言で言ってください。" }] }], turnComplete: true });
  await Promise.race([b.turnDone, timeout(60_000)]);
  console.log("resumed said:", b.transcript.slice(0, 200));
  b.session.close();
}
