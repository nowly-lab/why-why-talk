import type { TreeNode } from "./tree-rows.ts";
import type { AnswerEntry, Source } from "./answers.ts";
import type { Speaker } from "./transcript.ts";
import type { DiagEvent } from "./diag.ts";
import type { CurrentQuestion, Dive, Question } from "./questions.ts";

export type Direction = { direction: string; reasons: string; rejected: string; openQuestions: string };
export type Phase = "free_talk" | "questions" | "deep_dive";
export type FileView = { name: string; mimeType: string; summary: string };
export type SessionView = {
  id: string;
  nonce: string;
  topic: string | null;
  status: "talking" | "sent" | "cancelled";
  phase: Phase;
  freeTalk: Array<{ at: string; speaker: Speaker; text: string }>;
  files: FileView[];
  questions: Question[];
  dives: Dive[];
  current: CurrentQuestion;
  tree: TreeNode[];
  transcript: Array<{ at: string; speaker: Speaker; text: string }>;
  role: Role;
  roleBy: "request" | "question" | null;
  asked: AskedView[];
};
export type DivesView = { dives: Dive[]; current: CurrentQuestion };
export type Role = "interviewer" | "answerer";
export type AskedView = { at: string; question: string; answer: string; queries: string[]; sources: Source[] };
export type TokenInfo = { token: string; model: string; expiresAt: string; config: Record<string, unknown> };
export type ToolResult = {
  ok: boolean;
  error?: string;
  added?: string[];
  note?: string;
  role?: Role;
  tree: Array<{ id: string; text: string; state: string; depth?: number }>;
  belowTarget?: Array<{ id: string; depth: number }>;
  current?: CurrentQuestion;
};

/** What goes back to Gemini for one function call: the tree with depths and the branches still below 5 whys. */
export function toGeminiResponse(r: ToolResult): Record<string, unknown> {
  const current = r.current ?? null;
  if (!r.ok) return { error: r.error, tree: r.tree, belowTarget: r.belowTarget ?? [], current };
  return { result: "ok", added: r.added ?? [], note: r.note, tree: r.tree, belowTarget: r.belowTarget ?? [], current, ...(r.role ? { role: r.role } : {}) };
}

/** Gemini waits for every tool answer; a local request that hangs must still end so Gemini gets an error back. */
export const TOOL_TIMEOUT_MS = 20_000;

/** The local server's API. Every write carries the session nonce so an old tab cannot change this talk. */
export function createApi(nonce: string, opts: { toolTimeoutMs?: number } = {}) {
  const toolTimeoutMs = opts.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
  const post = async <T>(path: string, body: unknown, timeoutMs?: number): Promise<T> => {
    const abort = timeoutMs ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), timeoutMs) : null;
    const signal = abort?.signal;
    let res: Response;
    let json: T & { error?: string };
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-why-why-session": nonce },
        body: JSON.stringify(body),
        signal,
      });
      json = (await res.json().catch((e: unknown) => {
        if (signal?.aborted) throw e;
        return {};
      })) as T & { error?: string };
    } catch (e) {
      if (signal?.aborted) throw new Error(`ローカルのサーバーから ${Math.round(timeoutMs! / 1000)} 秒応答がありません`);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  };
  return {
    token: (fallback: boolean, roleSwitch = false) => post<TokenInfo>("/api/token", { fallback, roleSwitch }),
    tool: (name: string, args: unknown) => post<ToolResult>("/api/tool", { name, args }, toolTimeoutMs),
    transcript: (speaker: Speaker, text: string) => post<{ ok: true }>("/api/transcript", { speaker, text }),
    draft: (questionId: string, d: Direction) => post<{ ok: true }>("/api/draft", { questionId, ...d }),
    submit: (directions: Record<string, Direction>) => post<{ ok: true }>("/api/submit", { directions }),
    audio: (data: string, order: number) => post<{ ok: true; text: string }>("/api/audio", { data, mimeType: "audio/wav", order }),
    file: (name: string, mimeType: string, data: string) => post<{ ok: true; file: FileView }>("/api/file", { name, mimeType, data }),
    split: () => post<{ questions: Question[] }>("/api/questions/split", {}),
    questions: (questions: Question[]) => post<{ questions: Question[] }>("/api/questions", { questions }),
    freeTalk: () => post<{ ok: true }>("/api/free-talk", {}),
    diveStart: () => post<DivesView>("/api/dive/start", {}),
    diveNext: () => post<DivesView>("/api/dive/next", {}),
    cancel: () => post<{ ok: true }>("/api/cancel", {}),
    role: (role: Role) => post<{ ok: true; role: Role }>("/api/role", { role }),
    answer: (e: AnswerEntry) => post<{ ok: true }>("/api/answer", e),
    log: (events: DiagEvent[]) => post<{ ok: true }>("/api/log", { events }),
  };
}

export async function loadSession(): Promise<SessionView> {
  const res = await fetch("/api/session");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SessionView;
}
