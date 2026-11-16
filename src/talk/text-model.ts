import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";

export const DEFAULT_TEXT_MODEL = "gemini-3.8-flash";
export const MAX_QUESTIONS = 10;

export type FileSummary = { name: string; mimeType: string; summary: string };
export type SplitInput = { topic: string | null; context: string; freeTalk: string; files: FileSummary[] };

/** The non-live Gemini calls: transcription of free-talk segments, file summaries and the question list. */
export interface TextModel {
  transcribe(audio: { data: string; mimeType: string }): Promise<string>;
  summarizeFile(file: { name: string; mimeType: string; data: string }): Promise<string>;
  splitQuestions(input: SplitInput): Promise<string[]>;
}

export type Generate = (req: { model: string; contents: unknown; config?: Record<string, unknown> }) => Promise<{ text?: string }>;

/** The text model failed or answered in a shape we cannot use. The HTTP adapter turns it into 502 so the page retries. */
export class TextModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextModelError";
  }
}

const QuestionsReply = z.object({ questions: z.array(z.string()) });
const SPLIT_INPUT_LIMIT = 60_000;

const TRANSCRIBE = "この日本語の音声を、話された通りに文字起こししてください。言い直しや「えー」などのつなぎ言葉は省いてよい。文字起こしだけを返す。聞き取れる言葉がなければ何も返さない。";
const SUMMARIZE = "このファイルの要点を、日本語で箇条書きにまとめてください(多くて15行)。数字・固有名詞・決まったこと・困っていることを残す。要点だけを返す。";

export function geminiTextModel(deps: { apiKey: string; model: string; generate?: Generate }): TextModel {
  const generate: Generate = deps.generate ?? ((req) => new GoogleGenAI({ apiKey: deps.apiKey }).models.generateContent(req as Parameters<GoogleGenAI["models"]["generateContent"]>[0]));
  const call = async (parts: unknown[], config?: Record<string, unknown>): Promise<string> => {
    let reply: { text?: string };
    try {
      reply = await generate({ model: deps.model, contents: [{ role: "user", parts }], ...(config ? { config } : {}) });
    } catch (e) {
      throw new TextModelError(`Gemini (${deps.model}): ${(e as Error).message}`);
    }
    return (reply.text ?? "").trim();
  };
  return {
    transcribe: (audio) => call([{ inlineData: { mimeType: audio.mimeType, data: audio.data } }, { text: TRANSCRIBE }]),
    summarizeFile: (file) => {
      const body = file.mimeType.startsWith("text/")
        ? { text: `ファイル ${file.name}:\n${Buffer.from(file.data, "base64").toString("utf8")}` }
        : { inlineData: { mimeType: file.mimeType, data: file.data } };
      return call([body, { text: SUMMARIZE }]);
    },
    splitQuestions: async (input) => {
      const text = await call([{ text: splitPrompt(input) }], {
        responseMimeType: "application/json",
        responseSchema: { type: Type.OBJECT, properties: { questions: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ["questions"] },
      });
      let parsed: z.infer<typeof QuestionsReply>;
      try {
        parsed = QuestionsReply.parse(JSON.parse(text));
      } catch {
        throw new TextModelError("Gemini returned a question list we could not read");
      }
      const seen = new Set<string>();
      const out: string[] = [];
      for (const q of parsed.questions.map((s) => s.trim())) {
        if (q === "" || seen.has(q)) continue;
        seen.add(q);
        out.push(q);
        if (out.length === MAX_QUESTIONS) break;
      }
      return out;
    },
  };
}

function splitPrompt(input: SplitInput): string {
  const cut = (s: string) => (s.length > SPLIT_INPUT_LIMIT ? s.slice(-SPLIT_INPUT_LIMIT) : s);
  return [
    "あなたは、計画を進めている人の話を、深掘りする問いのリストに分ける係です。",
    `下の材料から、なぜなぜで深掘りする価値のある問いを最大 ${MAX_QUESTIONS} 件作ってください。`,
    "- 各問いは日本語の一文。話した人の言葉をできるだけそのまま使う。",
    "- 一つの問いには一つのことだけ。似た問いはまとめる。",
    "- 深掘りする価値の高い順に並べる。",
    "- 材料にないことを作らない。",
    "",
    `論点: ${input.topic ?? "(なし)"}`,
    "",
    "自由に話した内容:",
    cut(input.freeTalk).trim() || "(なし)",
    "",
    "添付ファイルの要点:",
    input.files.map((f) => `- ${f.name}:\n${f.summary}`).join("\n") || "(なし)",
    "",
    "エージェントが調べた内容:",
    cut(input.context).trim() || "(なし)",
  ].join("\n");
}
