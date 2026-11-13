import { findNode, type FieldInput } from "./analysis.ts";
import { FIELDS, type Analysis, type Field, type WhyNode } from "./model.ts";

/*
 * Cloudflare Workers AI decision model "Clef".
 * Request (schema-input.json): { model: "clef" | "clef-flash", state, questions: { [id]: Question } }, 1-64 questions.
 * Response (schema-output.json), wrapped by the REST API as { result, success, errors }:
 *   noul:  { type: "noul", noul: number }                       probability of yes
 *   score: { type: "score", score, legend, probabilities, confidence }   score is the probability-weighted level index
 * https://developers.cloudflare.com/workers-ai/models/clef/
 */

export type ClefModel = "clef" | "clef-flash";
export type ClefConfig = { accountId: string; token: string; model: ClefModel };

type Question =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export type ClefRequest = { nodeIds: string[]; body: { model: ClefModel; state: unknown; questions: Record<string, Question> } };

export type ClefEvaluation = {
  values: Record<string, FieldInput>;
  needsJudgment: Array<{ nodeId: string; fields: Field[]; why: string }>;
};

const NODES_PER_REQUEST = 12; // 5 questions each, 60 of the 64 allowed
const LOW_NOUL: [number, number] = [0.35, 0.65];
const LOW_SCORE_CONFIDENCE = 0.5;
const LIKELIHOOD_LEVELS = ["低い", "中くらい", "高い", "ほぼ確実"];
const IMPACT_LEVELS = ["小さい", "中くらい", "大きい", "重大"];

/** The questions asked for each node; the agent sees the same wording when it judges by itself. */
export const QUESTIONS: Record<Field, Question> = {
  supported: { type: "noul", instructions: "記録された事実から見て、この原因は裏付けられていますか?" },
  sufficient: { type: "noul", instructions: "この原因だけで、親の現象は起きますか?" },
  likelihood: { type: "score", instructions: "この原因が本当の原因である可能性はどのくらいですか?", criteria: LIKELIHOOD_LEVELS },
  impact: { type: "score", instructions: "この原因が問題に与えた影響はどのくらい大きいですか?", criteria: IMPACT_LEVELS },
  preventable: { type: "noul", instructions: "仕組み(道具・手順・検知など)を変えれば、この原因を防げますか?" },
};

export function clefConfigFromEnv(env: Record<string, string | undefined>): ClefConfig | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) return null;
  const model: ClefModel = env.WHY_WHY_CLEF_MODEL === "clef" ? "clef" : "clef-flash";
  return { accountId, token, model };
}

export function buildClefRequest(a: Analysis, nodeIds: string[], model: ClefModel): ClefRequest[] {
  const out: ClefRequest[] = [];
  for (let i = 0; i < nodeIds.length; i += NODES_PER_REQUEST) {
    const chunk = nodeIds.slice(i, i + NODES_PER_REQUEST);
    const questions: Record<string, Question> = {};
    for (const id of chunk) for (const f of FIELDS) questions[`${id}.${f}`] = QUESTIONS[f];
    out.push({ nodeIds: chunk, body: { model, state: stateFor(a, chunk), questions } });
  }
  return out;
}

/** Never throws for a model failure: failed nodes come back in `needsJudgment` and nothing is written. */
export async function evaluateWithClef(
  cfg: ClefConfig,
  a: Analysis,
  nodeIds: string[],
  fetchFn: typeof fetch = fetch,
): Promise<ClefEvaluation> {
  const result: ClefEvaluation = { values: {}, needsJudgment: [] };
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/ai/run/@cf/cloudflare/${cfg.model}`;
  for (const req of buildClefRequest(a, nodeIds, cfg.model)) {
    const fail = (why: string) => {
      for (const nodeId of req.nodeIds) result.needsJudgment.push({ nodeId, fields: [...FIELDS], why });
    };
    let answers: Record<string, unknown>;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) {
        fail(`Clef HTTP ${res.status}: ${errorText(text)}`);
        continue;
      }
      const json = parseJson(text) as { success?: boolean; result?: { answers?: Record<string, unknown> } } | null;
      if (!json || json.success === false || !json.result?.answers) {
        fail(`Clef returned an unexpected body: ${text.slice(0, 120)}`);
        continue;
      }
      answers = json.result.answers;
    } catch (e) {
      fail(`Clef request failed: ${(e as Error).message}`);
      continue;
    }
    for (const nodeId of req.nodeIds) {
      const values: FieldInput = {};
      const missing: Field[] = [];
      for (const f of FIELDS) {
        const v = readAnswer(answers[`${nodeId}.${f}`], f);
        if (v) values[f] = v;
        else missing.push(f);
      }
      if (missing.length === FIELDS.length) {
        result.needsJudgment.push({ nodeId, fields: missing, why: "Clef gave no answers for this node" });
        continue;
      }
      result.values[nodeId] = values;
      if (missing.length > 0) result.needsJudgment.push({ nodeId, fields: missing, why: "Clef gave no answer for these questions" });
    }
  }
  return result;
}

function readAnswer(raw: unknown, f: Field): { value: number; lowConfidence: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const q = QUESTIONS[f];
  const ans = raw as { type?: string; noul?: unknown; score?: unknown; confidence?: unknown };
  if (q.type === "noul") {
    if (typeof ans.noul !== "number" || ans.noul < 0 || ans.noul > 1) return null;
    return { value: ans.noul, lowConfidence: ans.noul >= LOW_NOUL[0] && ans.noul <= LOW_NOUL[1] };
  }
  if (typeof ans.score !== "number") return null;
  const max = q.criteria.length - 1;
  const value = Math.min(1, Math.max(0, ans.score / max));
  const upper = upperHalf((raw as { probabilities?: unknown }).probabilities, q.criteria.length);
  if (upper !== null) return { value, lowConfidence: upper >= LOW_NOUL[0] && upper <= LOW_NOUL[1] };
  const confidence = typeof ans.confidence === "number" ? ans.confidence : 1;
  return { value, lowConfidence: confidence < LOW_SCORE_CONFIDENCE };
}

/**
 * Probability that the level is in the upper half of the scale. Clef's own `confidence` is low whenever the
 * mass is split between two neighbouring levels (高い vs ほぼ確実), which still ranks a branch clearly; what makes a
 * score unsure for ranking is a split between the lower and the upper half, judged like a yes/no question.
 */
function upperHalf(probabilities: unknown, levels: number): number | null {
  if (!probabilities || typeof probabilities !== "object") return null;
  let upper = 0;
  let total = 0;
  for (const [k, p] of Object.entries(probabilities as Record<string, unknown>)) {
    const level = Number(k);
    if (!Number.isInteger(level) || typeof p !== "number") continue;
    total += p;
    if (level >= levels / 2) upper += p;
  }
  return total > 0 ? upper / total : null;
}

function stateFor(a: Analysis, nodeIds: string[]): unknown {
  return {
    problem: a.problem,
    note: "なぜなぜ分析の木の一部です。各ノードは親の現象が起きた理由の候補です。質問の id は <ノードid>.<問い> です。",
    nodes: nodeIds.map((id) => {
      const node = findNode(a, id);
      return {
        id,
        why: node.text,
        viewpoint: node.viewpoint,
        path: pathTo(a, node).map((n) => n.text),
        evidence: node.evidence.map((e) => ({ kind: e.kind, summary: e.summary, supports: e.supports })),
      };
    }),
  };
}

function pathTo(a: Analysis, node: WhyNode): WhyNode[] {
  const path: WhyNode[] = [];
  let cur = node.parentId === null ? undefined : a.nodes.find((n) => n.id === node.parentId);
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId === null ? undefined : a.nodes.find((n) => n.id === cur!.parentId);
  }
  return path;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorText(text: string): string {
  const json = parseJson(text) as { errors?: Array<{ message?: string }> } | null;
  return json?.errors?.[0]?.message ?? text.slice(0, 120);
}
