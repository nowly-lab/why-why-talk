import {
  WhyError,
  type Analysis,
  type Evidence,
  type Evaluation,
  type Field,
  type NodeState,
  type Source,
  type Viewpoint,
  type WhyNode,
} from "./model.ts";
import { redactSecrets } from "./redact.ts";

export type Clock = () => string;
export type FieldInput = Partial<Record<Field, { value: number; lowConfidence: boolean }>>;

export type NextBranch =
  | { kind: "evaluate"; nodeIds: string[] }
  | { kind: "judge"; items: Array<{ nodeId: string; fields: Field[] }> }
  | { kind: "dig"; nodeId: string; priority: number }
  | { kind: "done"; below: string[] };

const ALLOWED: Record<NodeState, NodeState[]> = {
  candidate: ["digging", "rejected", "hypothesis"],
  digging: ["leaf", "rejected", "hypothesis", "candidate"],
  rejected: ["candidate"],
  hypothesis: ["candidate"],
  leaf: ["digging"],
};

export function startAnalysis(input: { id: string; title: string; problem: string }, now: Clock): Analysis {
  const at = now();
  const problem = redactSecrets(input.problem);
  return {
    id: input.id,
    title: redactSecrets(input.title),
    problem,
    status: "open",
    nodes: [{ id: "n0", parentId: null, text: problem, viewpoint: null, state: "digging", evidence: [], evaluation: null }],
    createdAt: at,
    updatedAt: at,
  };
}

export function addWhys(
  a: Analysis,
  parentId: string,
  items: Array<{ text: string; viewpoint: Viewpoint }>,
  now: Clock,
): { analysis: Analysis; added: string[]; skipped: string[] } {
  assertOpen(a);
  const parent = findNode(a, parentId);
  if (parent.state === "rejected" || parent.state === "hypothesis" || parent.state === "leaf") {
    throw new WhyError("invalid_state", `node ${parentId} is ${parent.state}; set it back to candidate or digging before adding whys under it`);
  }
  const nodes = [...a.nodes];
  const added: string[] = [];
  const skipped: string[] = [];
  let seq = nextSeq(a);
  for (const item of items) {
    const text = redactSecrets(item.text.trim());
    if (text === "") throw new WhyError("invalid_input", "a why needs text");
    if (nodes.some((n) => n.parentId === parentId && n.text === text)) {
      skipped.push(text);
      continue;
    }
    const id = `n${seq++}`;
    nodes.push({ id, parentId, text, viewpoint: item.viewpoint, state: "candidate", evidence: [], evaluation: null });
    added.push(id);
  }
  return { analysis: { ...a, nodes, updatedAt: now() }, added, skipped };
}

export function addEvidence(a: Analysis, nodeId: string, ev: Evidence, now: Clock): Analysis {
  assertOpen(a);
  const node = findNode(a, nodeId);
  const ref = redactSecrets(ev.ref, { keepHashes: ev.kind === "git" });
  const evidence = [...node.evidence, { ...ev, ref, summary: redactSecrets(ev.summary) }];
  const ranks = node.state === "candidate" || node.state === "digging";
  const evaluation = node.evaluation && ranks ? { ...node.evaluation, stale: true } : node.evaluation;
  return replaceNode(a, { ...node, evidence, evaluation }, now);
}

export function applyFieldValues(a: Analysis, nodeId: string, values: FieldInput, source: Source, now: Clock): Analysis {
  assertOpen(a);
  const node = findNode(a, nodeId);
  const at = now();
  const prev: Evaluation = node.evaluation ?? { fields: {}, stale: false, history: [] };
  const fields = { ...prev.fields };
  const history = [...prev.history];
  for (const [field, input] of Object.entries(values) as Array<[Field, { value: number; lowConfidence: boolean }]>) {
    if (!Number.isFinite(input.value) || input.value < 0 || input.value > 1) {
      throw new WhyError("invalid_input", `${field} must be between 0 and 1, got ${input.value}`);
    }
    const old = fields[field];
    if (old) history.push({ field, ...old });
    fields[field] = { value: input.value, source, lowConfidence: input.lowConfidence, at };
  }
  return replaceNode(a, { ...node, evaluation: { fields, stale: false, history } }, () => at);
}

export function updateNode(
  a: Analysis,
  nodeId: string,
  change: { state: NodeState; reason?: string; countermeasure?: string },
  now: Clock,
): Analysis {
  assertOpen(a);
  const node = findNode(a, nodeId);
  if (node.parentId === null) throw new WhyError("invalid_input", "the root (the problem itself) has no state to change");
  if (!ALLOWED[node.state].includes(change.state)) {
    throw new WhyError("invalid_state", `node ${nodeId} cannot go from ${node.state} to ${change.state}; allowed: ${ALLOWED[node.state].join(", ")}`);
  }
  const reason = change.reason?.trim() ? redactSecrets(change.reason.trim()) : undefined;
  const countermeasure = change.countermeasure?.trim() ? redactSecrets(change.countermeasure.trim()) : undefined;
  if (change.state === "leaf" && !countermeasure) throw new WhyError("invalid_input", "a leaf needs a countermeasure");
  const needsReason =
    change.state === "rejected" || change.state === "hypothesis" ||
    (change.state === "candidate" && (node.state === "rejected" || node.state === "hypothesis"));
  if (needsReason && !reason) throw new WhyError("invalid_input", `moving ${nodeId} to ${change.state} needs a reason`);
  const next: WhyNode = { ...node, state: change.state };
  if (reason) next.reason = reason;
  if (countermeasure) next.countermeasure = countermeasure;
  return replaceNode(a, next, now);
}

export function closeAnalysis(a: Analysis, now: Clock): Analysis {
  if (a.status === "closed") return a;
  const digging = a.nodes.filter((n) => n.parentId !== null && n.state === "digging").map((n) => n.id);
  if (digging.length > 0) {
    throw new WhyError("invalid_state", `still digging: ${digging.join(", ")}; make each a leaf, hypothesis, rejected or candidate first`);
  }
  return { ...a, status: "closed", updatedAt: now() };
}

export function isBacked(node: WhyNode): boolean {
  return node.evidence.some((e) => e.supports);
}

/** Best-first choice of the next branch to dig. Never removes a node. */
export function nextBranch(a: Analysis, threshold: number): NextBranch {
  const candidates = a.nodes.filter((n) => n.parentId !== null && n.state === "candidate");
  const unevaluated = candidates.filter((n) => !n.evaluation || n.evaluation.stale || !n.evaluation.fields.likelihood || !n.evaluation.fields.impact);
  if (unevaluated.length > 0) return { kind: "evaluate", nodeIds: unevaluated.map((n) => n.id) };
  const judge = candidates
    .map((n) => ({
      nodeId: n.id,
      fields: (["likelihood", "impact"] as const).filter((f) => {
        const v = n.evaluation?.fields[f];
        return v?.lowConfidence === true && v.source === "clef";
      }) as Field[],
    }))
    .filter((j) => j.fields.length > 0);
  if (judge.length > 0) return { kind: "judge", items: judge };
  const ranked = candidates
    .map((n) => ({
      id: n.id,
      priority: n.evaluation!.fields.likelihood!.value * n.evaluation!.fields.impact!.value,
      supported: n.evaluation!.fields.supported?.value ?? 0,
      seq: Number(n.id.slice(1)),
    }))
    .sort((x, y) => y.priority - x.priority || y.supported - x.supported || x.seq - y.seq);
  const best = ranked[0];
  if (best && best.priority >= threshold) return { kind: "dig", nodeId: best.id, priority: best.priority };
  return { kind: "done", below: ranked.map((r) => r.id).sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))) };
}

export function findNode(a: Analysis, nodeId: string): WhyNode {
  const node = a.nodes.find((n) => n.id === nodeId);
  if (!node) throw new WhyError("not_found", `no node ${nodeId} in analysis ${a.id}`);
  return node;
}

function assertOpen(a: Analysis): void {
  if (a.status === "closed") throw new WhyError("invalid_state", `analysis ${a.id} is closed`);
}

function nextSeq(a: Analysis): number {
  return a.nodes.reduce((max, n) => Math.max(max, Number(n.id.slice(1)) || 0), 0) + 1;
}

function replaceNode(a: Analysis, node: WhyNode, now: Clock): Analysis {
  return { ...a, nodes: a.nodes.map((n) => (n.id === node.id ? node : n)), updatedAt: now() };
}
