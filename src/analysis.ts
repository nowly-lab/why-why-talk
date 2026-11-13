import { WhyError, type Analysis, type Fact, type NodeState, type Viewpoint, type WhyNode } from "./model.ts";
import { redactSecrets } from "./redact.ts";

export type Clock = () => string;
export type TreeSummary = Array<{ id: string; parentId: string | null; text: string; state: NodeState; viewpoint: Viewpoint | null }>;

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
    nodes: [{ id: "n0", parentId: null, text: problem, viewpoint: null, state: "digging", facts: [] }],
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
    nodes.push({ id, parentId, text, viewpoint: item.viewpoint, state: "candidate", facts: [] });
    added.push(id);
  }
  return { analysis: { ...a, nodes, updatedAt: now() }, added, skipped };
}

export function addFact(a: Analysis, nodeId: string, fact: Fact, now: Clock): Analysis {
  assertOpen(a);
  const node = findNode(a, nodeId);
  const summary = redactSecrets(fact.summary.trim());
  if (summary === "") throw new WhyError("invalid_input", "a fact needs a summary");
  return replaceNode(a, { ...node, facts: [...node.facts, { summary, supports: fact.supports }] }, now);
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
  if (change.state === "digging" || change.state === "candidate") {
    const stopped = stoppedAncestor(a, node);
    if (stopped) {
      throw new WhyError("invalid_state", `node ${nodeId} is under ${stopped.id}, which is ${stopped.state}; set ${stopped.id} back first`);
    }
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
  return node.facts.some((f) => f.supports);
}

export function treeSummary(a: Analysis): TreeSummary {
  return a.nodes.map((n) => ({ id: n.id, parentId: n.parentId, text: n.text, state: n.state, viewpoint: n.viewpoint }));
}

/** The nearest ancestor whose branch was stopped (leaf, rejected or hypothesis), if any. */
export function stoppedAncestor(a: Analysis, node: WhyNode): WhyNode | null {
  let cur = node.parentId === null ? undefined : a.nodes.find((n) => n.id === node.parentId);
  while (cur && cur.parentId !== null) {
    if (cur.state === "leaf" || cur.state === "rejected" || cur.state === "hypothesis") return cur;
    const parentId: string = cur.parentId;
    cur = a.nodes.find((n) => n.id === parentId);
  }
  return null;
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
