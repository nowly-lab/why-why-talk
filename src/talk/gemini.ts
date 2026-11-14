import { EndSensitivity, GoogleGenAI, Modality, type CreateAuthTokenConfig, type LiveConnectConfig } from "@google/genai";
import { treeSummary } from "../analysis.ts";
import { redactSecrets } from "../redact.ts";
import { STATE_LABEL } from "../render/tree.ts";
import type { TalkSession } from "./session.ts";
import { FUNCTION_DECLARATIONS } from "./tools.ts";

export const DEFAULT_MODEL = "gemini-3.8-live";
export const DEFAULT_VOICE = "Kore";
export const CONTEXT_LIMIT = 60_000;
export const FALLBACK_TAIL = 8_000;
const START_WITHIN_MS = 60_000;
const VALID_FOR_MS = 30 * 60_000;

export type TokenInfo = { token: string; model: string; expiresAt: string; config: LiveConnectConfig };
export type MintDeps = {
  apiKey: string;
  model: string;
  voice: string;
  now?: () => number;
  createToken?: (config: CreateAuthTokenConfig) => Promise<{ name?: string }>;
};

/** The interviewer brief. Built per connection from the session as it is now. */
export function systemInstruction(s: TalkSession, opts: { fallback: boolean }): string {
  const context = s.context.length > CONTEXT_LIMIT
    ? `${s.context.slice(0, CONTEXT_LIMIT)}\n(以下 ${s.context.length - CONTEXT_LIMIT} 文字を省略)`
    : s.context;
  const parts = [
    "あなたは、計画の一点を深掘りするための聞き手です。相手は計画を進めている本人です。",
    "",
    "進め方:",
    "- 一度に1つだけ、短く質問する。答えを急がせない。相手の言葉を言い換えて確かめてから次に進む。",
    "- 1本の枝を、根から数えて5段になるまで「なぜ?」で掘る。5段に届くまでは「他には?」で横に広げない。",
    "- 次の「なぜ?」は、相手の直前の言葉をそのまま引いて「なぜ〇〇が大事なのですか?」「なぜ〇〇が起きるのですか?」と聞く。",
    "- 相手を褒めたり励ましたりしない。「いいですね」「自信を持って」などは言わない。評価せず、次の問いだけを返す。",
    "- 5段に届かないうちにまとめに入らない。関数の結果の belowTarget に残っている枝があれば、そこを掘る。",
    "- 5段より浅いところで葉にするのは、本当にそれ以上掘れないときだけ。そのときは reason に理由を入れる。",
    "- 観点(仕組み・道具/人・体制/手順・プロセス/検知/前提・外部)を、掘り残しを探すチェックリストとして使う。全部を埋める必要はない。",
    "- ときどき「それだけで起きますか?」と聞いて横の見落としを、逆から「だから」でつないで縦の飛躍を確かめる。",
    "- 人を責めず、どの仕組みや手順が誤りを通したかを聞く。対策は「気をつける」ではなく仕組みの変更にする。",
    "",
    "木の扱い(関数):",
    "- 新しい理由が出たら add_whys で木に足す。根 n0 は論点そのもの。",
    "- 事実が出たら add_fact、枝を掘り始める・止めるときは update_branch。",
    "- 関数の結果には木の一覧(各ノードの段数 depth つき)と、まだ5段に届いていない枝の先 belowTarget が返る。ID はそれを見て使う。ID や関数名は声に出さない。",
    "- 関数が失敗したら、理由を読んで正しく呼び直す。",
    "- 相手が「まとめて」と言ったら、propose_direction で方針・理由・見送った案・残った疑問を下書きし、要点を短く声で伝える。",
    "",
    "最初に、論点を一言で確かめてから、最初の「なぜ?」を聞く。",
    "",
    "RESPOND IN JAPANESE. YOU MUST RESPOND UNMISTAKABLY IN JAPANESE.",
    "",
    `論点: ${s.topic}`,
    "",
    "エージェントが調べた内容:",
    context.trim() || "(なし)",
  ];
  if (opts.fallback) {
    const tree = treeSummary(s.analysis)
      .map((n) => `${n.id} (親 ${n.parentId ?? "-"}, ${n.depth}段, ${STATE_LABEL[n.state]}${n.viewpoint ? `, ${n.viewpoint}` : ""}) ${n.text}`)
      .join("\n");
    const all = s.transcript.map((t) => `${t.speaker === "person" ? "相手" : "あなた"}: ${t.text}`).join("\n");
    const tail = redactSecrets(all.length > FALLBACK_TAIL ? all.slice(-FALLBACK_TAIL) : all);
    parts.push(
      "",
      "これまでの会話(接続が切れたので続きから再開する。最初の確かめは不要。直前の話題から続ける):",
      "今の木:",
      tree,
      "",
      "会話の最後の部分:",
      tail || "(なし)",
    );
  }
  return parts.join("\n");
}

export function liveConfig(s: TalkSession, opts: { fallback: boolean; voice: string }): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: systemInstruction(s, { fallback: opts.fallback }),
    tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    // Suspected from the voice trials (2026-11-14): Gemini Live's default end-of-speech detection (high) cuts
    // Japanese speech at short pauses, and the quiet fragments were heard as other languages. Wait for 1 s of
    // silence instead; keep the default (high) start sensitivity so quiet speech is still picked up.
    realtimeInputConfig: {
      automaticActivityDetection: {
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        prefixPaddingMs: 300,
        silenceDurationMs: 1000,
      },
    },
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } },
  };
}

/**
 * A single-use token for one Live connection. The fields we set are locked (lockAdditionalFields: []);
 * the browser adds only its session-resumption handle. The API key never leaves this process.
 */
export async function mintToken(deps: MintDeps, s: TalkSession, opts: { fallback: boolean }): Promise<TokenInfo> {
  const now = deps.now ? deps.now() : Date.now();
  const config = liveConfig(s, { fallback: opts.fallback, voice: deps.voice });
  const expiresAt = new Date(now + VALID_FOR_MS).toISOString();
  const request: CreateAuthTokenConfig = {
    uses: 1,
    expireTime: expiresAt,
    newSessionExpireTime: new Date(now + START_WITHIN_MS).toISOString(),
    liveConnectConstraints: { model: deps.model, config },
    lockAdditionalFields: [],
  };
  const create = deps.createToken ?? ((cfg: CreateAuthTokenConfig) =>
    new GoogleGenAI({ apiKey: deps.apiKey, httpOptions: { apiVersion: "v1beta" } }).authTokens.create({ config: cfg }));
  const token = await create(request);
  if (!token.name) throw new Error("Gemini did not return a token");
  return { token: token.name, model: deps.model, expiresAt, config };
}
