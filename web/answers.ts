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
