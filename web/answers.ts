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
 * The page feeds it transcript fragments and grounding, and calls turnComplete at the end of Gemini's turn.
 */
export function createAnswerCollector() {
  let question = "";
  let answer = "";
  let queries: string[] = [];
  let sources: Source[] = [];
  const reset = () => {
    question = "";
    answer = "";
    queries = [];
    sources = [];
  };
  return {
    person(text: string) {
      // The person speaking after an answer starts a new question.
      if (answer !== "") reset();
      question += text;
    },
    gemini(text: string) {
      answer += text;
    },
    grounding(g: Grounding) {
      for (const q of g.queries) if (!queries.includes(q)) queries.push(q);
      for (const s of g.sources) if (!sources.some((x) => x.uri === s.uri)) sources.push(s);
    },
    interrupted() {
      answer = "";
      queries = [];
      sources = [];
    },
    turnComplete(): AnswerEntry | null {
      if (answer.trim() === "") return null;
      const entry = { question: question.trim(), answer: answer.trim(), queries, sources };
      reset();
      return entry;
    },
  };
}
