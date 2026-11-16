export type Source = { title: string; uri: string };
export type Grounding = { queries: string[]; sources: Source[] };
export type AnswerEntry = { question: string; answer: string; queries: string[]; sources: Source[] };

/** Search words and source pages from a Live groundingMetadata, whatever parts of it arrived. */
export function readGrounding(meta: unknown): Grounding {
  const m = (meta ?? {}) as { webSearchQueries?: unknown; groundingChunks?: unknown };
  const queries = Array.isArray(m.webSearchQueries) ? m.webSearchQueries.filter((q): q is string => typeof q === "string" && q.trim() !== "") : [];
  const chunks = Array.isArray(m.groundingChunks) ? m.groundingChunks : [];
  const sources: Source[] = [];
  for (const c of chunks) {
    const web = (c as { web?: { uri?: unknown; title?: unknown } } | null)?.web;
    if (web && typeof web.uri === "string" && web.uri !== "") {
      sources.push({ title: typeof web.title === "string" && web.title !== "" ? web.title : web.uri, uri: web.uri });
    }
  }
  return { queries, sources };
}

/**
 * Pairs one question from the person with Gemini's answer while Gemini is the answerer.
 * The page feeds it the person's words in every role (so a question said together with 「交代して」 is kept),
 * Gemini's words and grounding only as the answerer, and calls turnComplete at the end of Gemini's turn.
 */
export function createAnswerCollector() {
  let question = "";
  let answer = "";
  let queries: string[] = [];
  let sources: Source[] = [];
  // The person's current words belong to a turn that already ended (answered, interrupted or not recorded).
  let stale = false;
  // The person started a new question after Gemini's last words (an interruption must not drop it).
  let fresh = false;
  const reset = () => {
    question = "";
    answer = "";
    queries = [];
    sources = [];
    stale = false;
    fresh = false;
  };
  return {
    person(text: string) {
      // Speaking after an answer, an interruption or another turn starts a new question.
      if (answer !== "" || stale) reset();
      question += text;
      fresh = true;
    },
    gemini(text: string) {
      answer += text;
      fresh = false;
    },
    grounding(g: Grounding) {
      for (const q of g.queries) if (!queries.includes(q)) queries.push(q);
      for (const s of g.sources) if (!sources.some((x) => x.uri === s.uri)) sources.push(s);
    },
    /** Gemini was cut off: drop its partial answer; the next words from the person start a new question. */
    interrupted() {
      answer = "";
      queries = [];
      sources = [];
      // Words the person already said after Gemini's last words are the next question; keep them.
      stale = !fresh;
    },
    /** Gemini spoke in a turn that is not recorded (as the interviewer). */
    otherTurn() {
      stale = true;
    },
    /** Forget everything (role changed from the button). */
    reset,
    turnComplete(): AnswerEntry | null {
      if (answer.trim() === "") {
        stale = !fresh;
        return null;
      }
      const entry = { question: question.trim(), answer: answer.trim(), queries, sources };
      reset();
      return entry;
    },
  };
}

type Collector = ReturnType<typeof createAnswerCollector>;

/**
 * Gemini stops being the answerer (its own switch, the page's fallback, or a role seen on refresh): record the
 * answer collected so far before the role changes. Returns whether an answer was queued.
 */
export function leaveAnswerer(collector: Pick<Collector, "turnComplete">, pending: Pick<ReturnType<typeof createPendingAnswers>, "add">): boolean {
  const entry = collector.turnComplete();
  if (!entry) return false;
  pending.add(entry);
  return true;
}

/** After answering a question put to it, Gemini goes back to interviewing; the page switches back if Gemini forgot. */
export function returnsAfterAnswer(state: { role: "interviewer" | "answerer"; byQuestion: boolean }, entry: AnswerEntry | null): boolean {
  return state.role === "answerer" && state.byQuestion && entry !== null;
}

type Role = "interviewer" | "answerer";

/**
 * A role change the person asked for (button, or 交代して / 戻して) starts a new Live session that carries the new
 * role's instruction and the whole conversation. The quick answer to a question put to Gemini (by=question) and the
 * fallback back to interviewing stay on the current connection.
 */
export function restartsOnSwitch(call: { name?: string; args?: Record<string, unknown> }, response: Record<string, unknown>, before: Role): boolean {
  return call.name === "switch_role" && response.error === undefined && call.args?.by !== "question"
    && typeof response.role === "string" && response.role !== before;
}

/** After a voice switch, the new session starts when Gemini's reply ends, or after this long if it never does. */
export const ROLE_RESTART_WAIT_MS = 10_000;

/** The first words a new session gets after a role switch. */
export const ROLE_KICK: Record<Role, string> = {
  answerer: "役割を交代しました。ここからあなたは答える係です。私の質問に、Google 検索で確かめてから短く答えてください。会話の最後にまだ答えていない私の質問があればそれに答え、なければ『何について聞きたいですか?』とだけ聞いてください。",
  interviewer: "役割を交代しました。聞き手に戻ってください。直前に掘っていた枝の続きから、なぜを聞いてください。",
};

/** Answers waiting to be saved. An entry stays until the server has it, so a failed write is retried. */
export function createPendingAnswers(record: (e: AnswerEntry) => Promise<unknown>) {
  const queue: AnswerEntry[] = [];
  return {
    add(e: AnswerEntry) {
      queue.push(e);
    },
    size: () => queue.length,
    /** Saves in order; stops at the first failure and throws it, keeping that entry and the rest. */
    async flush(): Promise<void> {
      while (queue.length > 0) {
        try {
          await record(queue[0]!);
        } catch (e) {
          throw new Error(`Gemini の答えを記録できませんでした: ${(e as Error).message}`);
        }
        queue.shift();
      }
    },
  };
}

/**
 * Ends the talk without losing an answer: stop collecting, keep the answer heard so far (answerer only),
 * save every pending answer behind the queued writes, then submit. If an answer cannot be saved, the
 * submission does not happen and the error is thrown so the person can press 送信 again.
 */
export async function submitAfterAnswers(o: {
  queue: <T>(task: () => Promise<T>) => Promise<T>;
  collector: Pick<Collector, "turnComplete">;
  answering: boolean;
  freeze(): void;
  pending: ReturnType<typeof createPendingAnswers>;
  submit(): Promise<unknown>;
}): Promise<void> {
  o.freeze();
  const entry = o.answering ? o.collector.turnComplete() : null;
  if (entry) o.pending.add(entry);
  await o.queue(() => o.pending.flush());
  await o.queue(() => o.submit());
}
