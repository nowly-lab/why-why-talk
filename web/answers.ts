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
  const reset = () => {
    question = "";
    answer = "";
    queries = [];
    sources = [];
    stale = false;
  };
  return {
    person(text: string) {
      // Speaking after an answer, an interruption or another turn starts a new question.
      if (answer !== "" || stale) reset();
      question += text;
    },
    gemini(text: string) {
      answer += text;
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
      stale = true;
    },
    /** Gemini spoke in a turn that is not recorded (as the interviewer). */
    otherTurn() {
      stale = true;
    },
    /** Forget everything (role changed from the button). */
    reset,
    turnComplete(): AnswerEntry | null {
      if (answer.trim() === "") {
        stale = true;
        return null;
      }
      const entry = { question: question.trim(), answer: answer.trim(), queries, sources };
      reset();
      return entry;
    },
  };
}
