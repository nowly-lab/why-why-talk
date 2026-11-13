import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addEvidence,
  addWhys,
  applyFieldValues,
  closeAnalysis,
  findNode,
  nextBranch,
  startAnalysis,
  updateNode,
  type Clock,
  type FieldInput,
} from "./analysis.ts";
import { evaluateWithClef, QUESTIONS, type ClefConfig } from "./clef.ts";
import {
  ANALYSIS_ID,
  EvidenceKindSchema,
  FIELDS,
  FieldSchema,
  NodeStateSchema,
  ViewpointSchema,
  WhyError,
  type Analysis,
  type Field,
} from "./model.ts";
import { renderHtml } from "./render/html.ts";
import { renderMermaid } from "./render/mermaid.ts";
import type { FileStore } from "./store.ts";
import { VERSION } from "./version.ts";

export type ServerDeps = {
  store: FileStore;
  clef: ClefConfig | null;
  fetchFn?: typeof fetch;
  now?: Clock;
  threshold?: number;
};

export const INSTRUCTIONS = `why-why keeps a why-why (5 Whys) root-cause analysis as a tree, so the whys branch in several directions instead of one line.

Loop:
1. start_analysis with the problem written as facts (when, where, what happened).
2. For the node you dig, add_whys: several candidate causes at once, each with a viewpoint (仕組み・道具, 人・体制, 手順・プロセス, 検知, 前提・外部). Use every viewpoint as a checklist, not a quota.
3. Check facts (logs, code, git, metrics, docs) and add_evidence, supports true or false.
4. evaluate the candidates. With Clef configured it answers; otherwise, or where it is unsure, judge yourself and call record_judgment.
5. next_branch picks the best candidate (likelihood x impact). Mark it digging with update_node and go back to 2 for it. Stop a branch as leaf (with a countermeasure: a change to a mechanism, not "be careful"), hypothesis or rejected (with a reason). Branches are never deleted.
6. At each milestone call render and send the result to the person through the Plannotator Inbox: the mermaid text in the body, the .mmd and .html files as attachments. A comment on a node in the .mmd viewer comes back with its node id.
7. Apply the person's reply, then continue from 5. When next_branch says done, close_analysis and send the countermeasures.

Never record secrets (tokens, passwords, keys) in text or evidence; common shapes are masked, but do not rely on it.`;

export function createWhyWhyServer(deps: ServerDeps): McpServer {
  const now = deps.now ?? (() => new Date().toISOString());
  const threshold = deps.threshold ?? 0.2;
  const { store } = deps;
  const server = new McpServer({ name: "why-why", version: VERSION }, { instructions: INSTRUCTIONS });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
  ) => {
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await run(args), null, 2) }] };
      } catch (e) {
        if (e instanceof WhyError) return { isError: true, content: [{ type: "text", text: `${e.code}: ${e.message}` }] };
        throw e;
      }
    }) as never);
  };

  /** Load, change, save against the loaded version (a concurrent write becomes a conflict, never a silent loss). */
  type Changed = { analysis: Analysis; result: unknown };
  const change = async (id: string, fn: (a: Analysis) => Promise<Changed> | Changed): Promise<unknown> => {
    const a = await store.load(id);
    const { analysis, result } = await fn(a);
    if (analysis !== a) await store.save(analysis, a.updatedAt);
    return result;
  };

  const analysisId = z.string().describe("The analysis id from start_analysis or list_analyses.");
  const nodeId = z.string().describe('A node id such as "n3"; the problem itself is "n0".');

  tool(
    "start_analysis",
    "Start a why-why analysis. Write the problem as observed facts (when, where, what happened), not a guess at the cause. Returns the analysis id; the problem is node n0.",
    {
      title: z.string().min(1).describe("Short name of the problem."),
      problem: z.string().min(1).describe("The problem as facts."),
      id: z.string().regex(ANALYSIS_ID).optional().describe("Optional id (lowercase letters, digits, dashes). Derived from the title when omitted."),
    },
    async ({ title, problem, id }) => {
      const finalId = id ?? (await freeId(store, title, now));
      const a = startAnalysis({ id: finalId, title, problem }, now);
      await store.save(a, null);
      return { analysis_id: a.id, root: "n0", next: "add_whys under n0" };
    },
  );

  tool(
    "add_whys",
    "Add candidate causes (whys) under a node, several directions at once. Each needs a viewpoint. An item with the same text as an existing sibling is skipped. Not allowed under a leaf, rejected or hypothesis node.",
    {
      analysis_id: analysisId,
      parent_id: nodeId,
      items: z.array(z.object({ text: z.string().min(1), viewpoint: ViewpointSchema })).min(1).max(20),
    },
    async ({ analysis_id, parent_id, items }) =>
      change(analysis_id, (a) => {
        const r = addWhys(a, parent_id, items, now);
        return { analysis: r.analysis, result: { added: r.added, skipped: r.skipped } };
      }),
  );

  tool(
    "add_evidence",
    "Record a fact about a node: a log line, code, a git change, a metric or a document, and whether it supports the cause. Adding evidence to an evaluated candidate marks its evaluation stale.",
    {
      analysis_id: analysisId,
      node_id: nodeId,
      kind: EvidenceKindSchema,
      ref: z.string().describe("Where the fact is: a path, URL, commit, query."),
      summary: z.string().min(1).describe("What the fact shows, in one or two sentences."),
      supports: z.boolean().describe("true when it supports this cause, false when it argues against it."),
    },
    async ({ analysis_id, node_id, kind, ref, summary, supports }) =>
      change(analysis_id, (a) => {
        const analysis = addEvidence(a, node_id, { kind, ref, summary, supports }, now);
        return { analysis, result: { node_id, evidence_count: findNode(analysis, node_id).evidence.length } };
      }),
  );

  tool(
    "evaluate",
    "Evaluate candidate nodes on five questions (supported, sufficient, likelihood, impact, preventable). With Clef configured it asks Clef and stores its answers; questions Clef is unsure about, or every question when Clef is not configured, come back in needs_judgment for you to answer with record_judgment. Defaults to candidates that are unevaluated or stale.",
    {
      analysis_id: analysisId,
      node_ids: z.array(z.string()).optional().describe("Candidate node ids. Other states are ignored."),
    },
    async ({ analysis_id, node_ids }) =>
      change(analysis_id, async (a) => {
        if (a.status === "closed") throw new WhyError("invalid_state", `analysis ${a.id} is closed`);
        const requested = node_ids ?? defaultTargets(a);
        for (const id of requested) findNode(a, id);
        const targets = requested.filter((id) => findNode(a, id).state === "candidate");
        const ignored = requested.filter((id) => !targets.includes(id));
        if (!deps.clef) {
          return {
            analysis: a,
            result: {
              clef: "not_configured",
              needs_judgment: targets.map((id) => ({ node_id: id, text: findNode(a, id).text, fields: [...FIELDS] })),
              questions: QUESTIONS,
              ignored,
              next: "record_judgment for each node (values 0..1; score questions map their levels onto 0..1)",
            },
          };
        }
        const r = await evaluateWithClef(deps.clef, a, targets, deps.fetchFn);
        let analysis = a;
        const needs = new Map<string, Set<Field>>();
        const why = new Map<string, string>();
        for (const [id, values] of Object.entries(r.values)) {
          analysis = applyFieldValues(analysis, id, values, "clef", now);
          for (const [f, v] of Object.entries(values) as Array<[Field, { lowConfidence: boolean }]>) {
            if (v.lowConfidence) addNeed(needs, id, f);
          }
        }
        for (const n of r.needsJudgment) {
          for (const f of n.fields) addNeed(needs, n.nodeId, f);
          why.set(n.nodeId, n.why);
        }
        return {
          analysis,
          result: {
            clef: "used",
            model: deps.clef.model,
            evaluated: Object.keys(r.values),
            needs_judgment: [...needs].map(([id, fields]) => ({
              node_id: id,
              text: findNode(analysis, id).text,
              fields: FIELDS.filter((f) => fields.has(f)),
              why: why.get(id) ?? "Clef is unsure (probability near 0.5 or low confidence)",
            })),
            questions: needs.size > 0 ? QUESTIONS : undefined,
            ignored,
          },
        };
      }),
  );

  tool(
    "record_judgment",
    "Record your own judgment for some of a candidate's evaluation questions (each 0..1). Only the given questions are overwritten; the old values stay in history.",
    {
      analysis_id: analysisId,
      node_id: nodeId,
      values: z.record(FieldSchema, z.number().min(0).max(1)).describe("For example {\"likelihood\": 0.7, \"impact\": 0.5}."),
    },
    async ({ analysis_id, node_id, values }) =>
      change(analysis_id, (a) => {
        if (findNode(a, node_id).state !== "candidate") {
          return { analysis: a, result: { node_id, ignored: true, why: "evaluations only rank candidates" } };
        }
        const input: FieldInput = {};
        for (const [f, v] of Object.entries(values) as Array<[Field, number]>) input[f] = { value: v, lowConfidence: false };
        const analysis = applyFieldValues(a, node_id, input, "agent", now);
        return { analysis, result: { node_id, evaluation: findNode(analysis, node_id).evaluation } };
      }),
  );

  tool(
    "next_branch",
    "Propose the next branch to dig, best first (likelihood x impact, ties by supported). It may instead ask you to evaluate or judge first, or say done when every remaining candidate is below the threshold. It does not change any state.",
    { analysis_id: analysisId },
    async ({ analysis_id }) => {
      const a = await store.load(analysis_id);
      const r = nextBranch(a, threshold);
      switch (r.kind) {
        case "evaluate":
          return { kind: r.kind, node_ids: r.nodeIds, next: "evaluate these candidates" };
        case "judge":
          return { kind: r.kind, items: r.items.map((i) => ({ node_id: i.nodeId, fields: i.fields })), next: "record_judgment for these questions" };
        case "dig": {
          const n = findNode(a, r.nodeId);
          return { kind: r.kind, node_id: n.id, text: n.text, viewpoint: n.viewpoint, priority: Number(r.priority.toFixed(4)), next: "update_node state=digging, then add_whys under it" };
        }
        case "done":
          return { kind: r.kind, below_threshold: r.below, threshold, next: "close_analysis and send the countermeasures, or add more whys if the person asks" };
      }
    },
  );

  tool(
    "update_node",
    "Change a node's state: digging (dig it), leaf (needs countermeasure), hypothesis or rejected (need reason), or candidate (back from rejected/hypothesis needs a reason). Allowed moves: candidate->digging|rejected|hypothesis, digging->leaf|rejected|hypothesis|candidate, rejected|hypothesis->candidate, leaf->digging.",
    {
      analysis_id: analysisId,
      node_id: nodeId,
      state: NodeStateSchema,
      reason: z.string().optional(),
      countermeasure: z.string().optional(),
    },
    async ({ analysis_id, node_id, state, reason, countermeasure }) =>
      change(analysis_id, (a) => {
        const analysis = updateNode(a, node_id, { state, reason, countermeasure }, now);
        return { analysis, result: findNode(analysis, node_id) };
      }),
  );

  tool(
    "close_analysis",
    "Close the analysis when no branch is still digging. A closed analysis can still be read and rendered but not changed.",
    { analysis_id: analysisId },
    async ({ analysis_id }) =>
      change(analysis_id, (a) => {
        const analysis = closeAnalysis(a, now);
        const leaves = analysis.nodes.filter((n) => n.state === "leaf").map((n) => ({ node_id: n.id, text: n.text, countermeasure: n.countermeasure }));
        return { analysis, result: { status: analysis.status, countermeasures: leaves } };
      }),
  );

  tool(
    "render",
    "Draw the tree as Mermaid (.mmd) and HTML files next to the analysis and return their paths and the Mermaid text. Send them to the person through the Plannotator Inbox.",
    { analysis_id: analysisId },
    async ({ analysis_id }) => {
      const a = await store.load(analysis_id);
      const mermaid = renderMermaid(a);
      const mermaidPath = await store.writeArtifact(a.id, "mmd", mermaid);
      const htmlPath = await store.writeArtifact(a.id, "html", renderHtml(a));
      return {
        mermaid_path: mermaidPath,
        html_path: htmlPath,
        mermaid,
        inbox_hint: "plannotator_inbox send_message: put the mermaid text in a ```mermaid block in body, and pass mermaid_path and html_path in attachments. Comments on .mmd nodes come back with node ids.",
      };
    },
  );

  tool("get_analysis", "Read a whole analysis: problem, every node with its evidence, evaluation, reason and countermeasure.", { analysis_id: analysisId }, async ({ analysis_id }) =>
    store.load(analysis_id),
  );

  tool("list_analyses", "List the analyses in this project, newest first.", {}, async () => ({ dir: store.dir, analyses: await store.list() }));

  return server;
}

function defaultTargets(a: Analysis): string[] {
  const candidates = a.nodes.filter((n) => n.parentId !== null && n.state === "candidate");
  const pending = candidates.filter((n) => !n.evaluation || n.evaluation.stale || !n.evaluation.fields.likelihood || !n.evaluation.fields.impact);
  return (pending.length > 0 ? pending : candidates).map((n) => n.id);
}

function addNeed(map: Map<string, Set<Field>>, id: string, f: Field): void {
  if (!map.has(id)) map.set(id, new Set());
  map.get(id)!.add(f);
}

async function freeId(store: FileStore, title: string, now: Clock): Promise<string> {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const base = slug || `a-${now().replace(/\D/g, "").slice(0, 14)}`;
  for (let i = 1; i < 1000; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    try {
      await store.load(id);
    } catch (e) {
      if (e instanceof WhyError && e.code === "not_found") return id;
      throw e;
    }
  }
  throw new WhyError("conflict", `could not find a free id for ${title}`);
}
