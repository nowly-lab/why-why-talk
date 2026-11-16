import { EndSensitivity, GoogleGenAI, Modality, type CreateAuthTokenConfig, type LiveConnectConfig } from "@google/genai";
import { rootOf, treeSummary } from "../analysis.ts";
import { redactSecrets } from "../redact.ts";
import { STATE_LABEL } from "../render/tree.ts";
import { DIVE_LABEL } from "./result.ts";
import type { TalkSession } from "./session.ts";
import { FUNCTION_DECLARATIONS } from "./tools.ts";

export const DEFAULT_MODEL = "gemini-3.8-live";
export const DEFAULT_VOICE = "Kore";
export const CONTEXT_LIMIT = 60_000;
export const HISTORY_LIMIT = 100_000;
export const FREE_TALK_LIMIT = 30_000;
const START_WITHIN_MS = 60_000;
const VALID_FOR_MS = 30 * 60_000;

/** How a new Live session starts: fresh, seeded with the talk so far (fallback), or seeded after a role switch. */
export type Seed = { fallback: boolean; roleSwitch?: boolean };
export type TokenInfo = { token: string; model: string; expiresAt: string; config: LiveConnectConfig };
export type MintDeps = {
  apiKey: string;
  model: string;
  voice: string;
  now?: () => number;
  createToken?: (config: CreateAuthTokenConfig) => Promise<{ name?: string }>;
};

/** The interviewer brief. Built per connection from the session as it is now. */
export function systemInstruction(s: TalkSession, opts: Seed): string {
  const seeded = opts.fallback || opts.roleSwitch === true;
  const context = s.context.length > CONTEXT_LIMIT
    ? `${s.context.slice(0, CONTEXT_LIMIT)}\n(以下 ${s.context.length - CONTEXT_LIMIT} 文字を省略)`
    : s.context;
  const parts = [
    "あなたは、計画を進めている本人が選んだ問いを、一つずつ深掘りするための聞き手です。",
    "",
    "進め方:",
    "- 一度に1つだけ、短く質問する。答えを急がせない。相手の言葉を言い換えて確かめてから次に進む。",
    "- 今の問いだけを掘る。ほかの問いの木には関数を呼ばない。",
    "- 1本の枝を、根から数えて5段になるまで「なぜ?」で掘る。5段に届くまでは「他には?」で横に広げない。",
    "- 次の「なぜ?」は、相手の直前の言葉をそのまま引いて「なぜ〇〇が大事なのですか?」「なぜ〇〇が起きるのですか?」と聞く。",
    "- 相手を褒めたり励ましたりしない。「いいですね」「自信を持って」などは言わない。評価せず、次の問いだけを返す。",
    "- 5段に届かないうちにまとめに入らない。関数の結果の belowTarget に残っている枝があれば、そこを掘る。",
    "- 5段より浅いところで葉にするのは、相手がそれ以上掘れない理由を言ったときだけ。reason には相手が言った理由をそのまま入れる。自分で理由を作らない。相手が理由を言わずに終わりにしたがったら、葉にせず「なぜそこで止めてよいのですか?」と聞く。",
    "- 観点(仕組み・道具/人・体制/手順・プロセス/検知/前提・外部)を、掘り残しを探すチェックリストとして使う。全部を埋める必要はない。",
    "- ときどき「それだけで起きますか?」と聞いて横の見落としを、逆から「だから」でつないで縦の飛躍を確かめる。",
    "- 人を責めず、どの仕組みや手順が誤りを通したかを聞く。対策は「気をつける」ではなく仕組みの変更にする。",
    "",
    "木の扱い(関数):",
    "- 新しい理由が出たら add_whys で木に足す。問いごとに木があり、根の ID は問いの ID(q1, q2, …)。",
    "- ある枝の下になぜを足したら、その枝を update_branch で digging(掘っている)にする。掘っている枝を未調査のまま残さない。",
    "- 事実が出たら add_fact、枝を掘り始める・止めるときは update_branch。",
    "- 関数の結果には木の一覧(各ノードの段数 depth つき)と、まだ5段に届いていない枝の先 belowTarget が返る。ID はそれを見て使う。ID や関数名は声に出さない。",
    "- 関数が失敗したら、理由を読んで正しく呼び直す。",
    "- 相手が「まとめて」と言ったら、propose_direction(question_id=今の問い)で方針・理由・見送った案・残った疑問を下書きし、要点を短く声で伝える。",
    "",
    "問いの進め方:",
    "- 今の問いに5段に届いた枝が一本以上あり、掘りかけの浅い枝が残っていなければ、propose_direction(question_id=今の問い)で方針を下書きし、要点を一言伝えてから next_question を呼ぶ。相手の確認は待たない。",
    "- next_question が断られたら、返ってきた枝を掘る。",
    "- 次の問いに移ったら、その問いを読み上げてから最初の「なぜ?」を聞く。",
    "- 最後の問いが終わったら(current が空)、「全部終わりました。送信してください」と伝える。",
    "- 画面から「次の問いへ進みます」と届いたら、関数は呼ばずに次の問いを読み上げて続ける。",
    "",
    "役割の交代:",
    "- 相手が「交代して」と言ったら switch_role(to=\"answerer\")、「戻して」と言ったら switch_role(to=\"interviewer\") を呼ぶ。",
    "- 画面から「役割を交代しました」と届いたら、その役割で続ける(関数は呼ばない)。",
    ...roleBrief(s.role, s.roleBy),
    "",
    ...(seeded ? [] : [`最初に、今の問い(${s.current()?.questionId ?? "q1"})を読み上げてから、最初の「なぜ?」を聞く。`, ""]),
    "RESPOND IN JAPANESE. YOU MUST RESPOND UNMISTAKABLY IN JAPANESE.",
    "",
    ...(s.topic ? [`論点: ${s.topic}`, ""] : []),
    "問いのリスト(この順に掘る):",
    s.dives.map((d) => `${d.questionId} [${DIVE_LABEL[d.status]}] ${d.text}`).join("\n") || "(なし)",
    "",
    s.current() ? `今の問い: ${s.current()!.questionId} ${s.current()!.text}` : "今の問い: なし(全部終わった)",
    "",
    "相手が最初に自由に話した内容:",
    freeTalk(s) || "(なし)",
    "",
    "添付ファイルの要点:",
    s.files.map((f) => `- ${f.name}:\n${f.summary}`).join("\n") || "(なし)",
    "",
    "エージェントが調べた内容:",
    context.trim() || "(なし)",
  ];
  if (seeded) {
    const tree = treeSummary(s.analysis)
      .sort((a, b) => rootOf(s.analysis, a.id).localeCompare(rootOf(s.analysis, b.id), "en", { numeric: true }))
      .map((n) => `${n.id} (親 ${n.parentId ?? "-"}, ${n.depth}段, ${STATE_LABEL[n.state]}${n.viewpoint ? `, ${n.viewpoint}` : ""}) ${n.text}`)
      .join("\n");
    const current = s.current()?.questionId ?? "なし";
    parts.push(
      "",
      opts.roleSwitch
        ? `これまでの会話(役割を交代したので、新しい会話として続ける。最初の読み上げは不要。今の役割で、今の問い(${current})から続ける):`
        : `これまでの会話(接続が切れたので続きから再開する。最初の読み上げは不要。今の問い(${current})から続ける):`,
      "今の木:",
      tree,
      "",
      "会話の全文:",
      conversationSoFar(s) || "(なし)",
    );
  }
  return parts.join("\n");
}

/** The whole deep-dive conversation, redacted. Past HISTORY_LIMIT the oldest part is dropped with a note. */
export function conversationSoFar(s: TalkSession): string {
  const all = redactSecrets(s.transcript.map((t) => `${t.speaker === "person" ? "相手" : "あなた"}: ${t.text}`).join("\n"));
  if (all.length <= HISTORY_LIMIT) return all;
  return `(前半 ${all.length - HISTORY_LIMIT} 文字を省略)\n${all.slice(-HISTORY_LIMIT)}`;
}

function freeTalk(s: TalkSession): string {
  const all = s.freeTalk.map((t) => t.text).join("\n");
  return all.length > FREE_TALK_LIMIT ? `(前略)${all.slice(-FREE_TALK_LIMIT)}` : all;
}

function roleBrief(role: TalkSession["role"], by: TalkSession["roleBy"]): string[] {
  if (role === "interviewer") {
    return [
      "今の役割: 聞き手",
      // The person asked for this (2026-11-16): a question put to Gemini is answered without saying 「交代して」.
      "- 相手があなたに向けて疑問形で聞いたとき(「〜って何?」「〜はどうなっている?」など、あなたに答えを求める問い)は、switch_role(to=\"answerer\", by=\"question\") を呼び、Google 検索で確かめて短く答える。答えたら switch_role(to=\"interviewer\", by=\"question\") を呼び、直前に掘っていた枝の続きから「なぜ?」を聞く。",
      "- 相手が自分に向けて考えている問い(「なんでだろう…」などの独り言)や、なぜへの答えの中に出てきた疑問には答えず、そのまま深掘りを続ける。",
      "- それ以外では Google 検索は使わない。",
    ];
  }
  return [
    "今の役割: 答える係",
    "- 相手の質問に、Google 検索で確かめてから日本語で短く答える。確かでないことは「確かではありません」と言う。",
    "- 木の関数(add_whys / add_fact / update_branch)は呼ばない。",
    by === "question"
      ? "- 相手の質問に答えて交代した。答えたら switch_role(to=\"interviewer\", by=\"question\") を呼び、直前に掘っていた枝の続きから「なぜ?」を聞く。"
      : "- 答えたら「他に聞きたいことはありますか? 戻すときは『戻して』と言ってください」と聞く。",
  ];
}

export function liveConfig(s: TalkSession, opts: Seed & { voice: string }): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: systemInstruction(s, { fallback: opts.fallback, roleSwitch: opts.roleSwitch }),
    // Search is on in both roles (the token locks the config); the interviewer brief forbids it.
    tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }, { googleSearch: {} }],
    // Japanese only: auto-detection turned quiet Japanese into Spanish/English fragments (voice trial 2026-11-14).
    inputAudioTranscription: { languageCodes: ["ja-JP"] },
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
export async function mintToken(deps: MintDeps, s: TalkSession, opts: Seed): Promise<TokenInfo> {
  const now = deps.now ? deps.now() : Date.now();
  const config = liveConfig(s, { ...opts, voice: deps.voice });
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
