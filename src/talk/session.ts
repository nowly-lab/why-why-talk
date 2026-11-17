import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addFact, addRoot, addWhys, openBelowTarget, questionReady, rootOf, startAnalysis, treeSummary, updateNode, type Clock, type TreeSummary } from "../analysis.ts";
import { WhyError, type Analysis, type Role } from "../model.ts";
import { redactSecrets } from "../redact.ts";
import { renderMermaid } from "../render/mermaid.ts";
import { isToolName, ToolArgs } from "./tools.ts";
import { renderResultMarkdown, renderTranscriptMarkdown, resultJson } from "./result.ts";
import { MAX_QUESTIONS, type FileSummary, type SplitInput } from "./text-model.ts";

export type Speaker = "person" | "gemini";
export type TranscriptEntry = { at: string; speaker: Speaker; text: string; order?: number };
export type Direction = { direction: string; reasons: string; rejected: string; openQuestions: string };
export type Source = { title: string; uri: string };
export type AskedEntry = { at: string; question: string; answer: string; queries: string[]; sources: Source[] };
export type SessionStatus = "talking" | "sent" | "cancelled";
/** free_talk: the person talks and Gemini only listens; questions: the person picks; deep_dive: Gemini Live digs. */
export type Phase = "free_talk" | "questions" | "deep_dive";
export type Question = { text: string; checked: boolean; by?: "agent" };
export type DiveStatus = "pending" | "digging" | "done" | "partial";
export type Dive = { questionId: string; text: string; status: DiveStatus; draft: Direction | null; by?: "agent" };
export type CurrentQuestion = { questionId: string; text: string } | null;
export type AdvanceResult = { moved: boolean; finished: Dive | null; current: CurrentQuestion };
export type BelowTarget = Array<{ id: string; depth: number }>;
export type ToolResult =
  | { ok: true; added: string[]; tree: TreeSummary; belowTarget: BelowTarget; current: CurrentQuestion; note?: string; role?: Role }
  | { ok: false; error: string; tree: TreeSummary; belowTarget: BelowTarget; current: CurrentQuestion };

const MERGE_WINDOW_MS = 4_000;
const MAX_EVENTS = 5_000;
/** Questions in all, the person's and those an agent added (the text model's first list stays at MAX_QUESTIONS). */
export const MAX_TOTAL_QUESTIONS = 20;
/** What an agent may call through MCP: Gemini's tree tools, on any question. */
export const AGENT_TOOLS = ["add_whys", "add_fact", "update_branch", "propose_direction"] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

/** One deep-dive: the tree, the transcript, the draft and how it ended. The result is decided once. */
export class TalkSession {
  readonly id: string;
  readonly nonce: string;
  readonly topic: string | null;
  readonly context: string;
  readonly outDir: string;
  readonly startedAt: string;
  analysis: Analysis;
  transcript: TranscriptEntry[] = [];
  status: SessionStatus = "talking";
  phase: Phase;
  /** What the person said in free talk, one entry per transcribed segment. */
  freeTalk: TranscriptEntry[] = [];
  /** Summaries of attached files (the files themselves are never kept). */
  files: FileSummary[] = [];
  questions: Question[] = [];
  /** One per checked question, in list order; their roots in the tree are q1, q2, …. */
  dives: Dive[] = [];
  /** Who Gemini is right now: the interviewer, or (after 交代) the one answering the person's questions. */
  role: Role = "interviewer";
  /** How Gemini became the answerer: the person asked for it (交代して, the button) or a question put to Gemini. */
  roleBy: "request" | "question" | null = null;
  /** What the person asked Gemini while it was the answerer. Not part of the tree; unverified. */
  asked: AskedEntry[] = [];
  cancelReason: string | null = null;
  private readonly now: Clock;
  private saving: Promise<void> = Promise.resolve();
  private eventCount = 0;

  private readonly secrets: string[];

  constructor(input: { topic?: string | null; context: string; outDir: string; files?: FileSummary[]; now?: Clock; secrets?: string[] }) {
    this.secrets = input.secrets ?? [];
    this.now = input.now ?? (() => new Date().toISOString());
    this.id = randomBytes(6).toString("hex");
    this.nonce = randomBytes(16).toString("hex");
    const topic = input.topic?.trim() ?? "";
    this.topic = topic === "" ? null : redactSecrets(topic, { extra: this.secrets });
    this.phase = this.topic === null ? "free_talk" : "questions";
    this.files = (input.files ?? []).map((f) => ({ ...f, name: this.clean(f.name), summary: this.clean(f.summary) }));
    this.context = redactSecrets(input.context, { extra: this.secrets });
    this.outDir = input.outDir;
    this.startedAt = this.now();
    this.analysis = startAnalysis({ id: `talk-${this.id}`, title: this.topic ?? "自由に話す" }, this.now);
  }

  snapshot() {
    return {
      id: this.id,
      topic: this.topic,
      status: this.status,
      phase: this.phase,
      freeTalk: this.freeTalk,
      files: this.files,
      questions: this.questions,
      dives: this.dives,
      current: this.current(),
      tree: this.analysis.nodes,
      transcript: this.transcript,
      role: this.role,
      roleBy: this.roleBy,
      asked: this.asked,
      startedAt: this.startedAt,
    };
  }

  current(): CurrentQuestion {
    const d = this.dives.find((x) => x.status === "digging");
    return d ? { questionId: d.questionId, text: d.text } : null;
  }

  /**
   * One transcribed free-talk segment, placed by `order` (when it was said): a segment retried after a later one
   * succeeded still lands before it. Segments are whole utterances, so they are not merged.
   */
  appendFreeTalk(text: string, order?: number): void {
    this.assertTalking();
    this.assertPhase("free_talk");
    const t = this.clean(text);
    if (t === "") return;
    const entry: TranscriptEntry = { at: this.now(), speaker: "person", text: t, ...(order !== undefined ? { order } : {}) };
    const at = order === undefined ? -1 : this.freeTalk.findIndex((x) => x.order !== undefined && x.order > order);
    if (at < 0) this.freeTalk.push(entry);
    else this.freeTalk.splice(at, 0, entry);
  }

  addFile(f: FileSummary): void {
    this.assertTalking();
    this.assertPhase("free_talk", "questions");
    this.files.push({ name: this.clean(f.name), mimeType: f.mimeType, summary: this.clean(f.summary) });
  }

  /** Checked before a file is summarized, so a late upload costs no model call. */
  canAddFile(): boolean {
    return this.status === "talking" && (this.phase === "free_talk" || this.phase === "questions");
  }

  hasMaterial(): boolean {
    return this.freeTalk.length > 0 || this.files.length > 0 || this.context.trim() !== "" || this.topic !== null;
  }

  splitInput(): SplitInput {
    return { topic: this.topic, context: this.context, freeTalk: this.freeTalk.map((t) => t.text).join("\n"), files: this.files };
  }

  /** A new list from the text model: at most MAX_QUESTIONS, all unchecked. */
  setQuestions(texts: string[]): void {
    this.assertTalking();
    this.assertPhase("free_talk", "questions");
    this.questions = texts.map((t) => this.clean(t)).filter((t) => t !== "").slice(0, MAX_QUESTIONS).map((text) => ({ text, checked: false }));
    this.phase = "questions";
  }

  /** The person's edits: checks, rewording, added, removed or reordered questions. */
  editQuestions(list: Question[]): void {
    this.assertTalking();
    this.assertPhase("questions");
    if (list.length > MAX_TOTAL_QUESTIONS) throw new WhyError("invalid_input", `問いは ${MAX_TOTAL_QUESTIONS} 件までです`);
    const next = list.map((q) => ({ text: this.clean(q.text), checked: q.checked, ...(q.by === "agent" ? { by: q.by } : {}) }));
    if (next.some((q) => q.text === "")) throw new WhyError("invalid_input", "空の問いがあります");
    this.questions = next;
  }

  /**
   * An agent (Claude in a meeting, through MCP) adds a question worth digging. Before the deep dive it joins the list
   * checked; during the deep dive it becomes a new question with its own root, dug after the others.
   */
  addQuestion(text: string, by: "agent"): { questionId: string | null; index: number } {
    this.assertTalking();
    const t = this.clean(text);
    if (t === "") throw new WhyError("invalid_input", "空の問いは足せません");
    const total = this.phase === "deep_dive" ? this.dives.length : this.questions.length;
    if (total >= MAX_TOTAL_QUESTIONS) throw new WhyError("invalid_input", `問いは ${MAX_TOTAL_QUESTIONS} 件までです`);
    if (this.phase !== "deep_dive") {
      this.phase = "questions";
      this.questions.push({ text: t, checked: true, by });
      return { questionId: null, index: this.questions.length - 1 };
    }
    let n = this.dives.length + 1;
    while (this.analysis.nodes.some((x) => x.id === `q${n}`)) n++;
    const questionId = `q${n}`;
    this.analysis = addRoot(this.analysis, { id: questionId, text: t }, this.now);
    // Every question finished: the new one is dug now; otherwise it waits its turn.
    const status: DiveStatus = this.current() ? "pending" : "digging";
    this.dives.push({ questionId, text: t, status, draft: null, by });
    this.questions.push({ text: t, checked: true, by });
    return { questionId, index: this.dives.length - 1 };
  }

  /** An agent's tree tools: Gemini's, on any question (not only the one being dug), marked as the agent's. */
  agentTool(name: AgentToolName, args: unknown): ToolResult {
    return this.applyTool(name, args, "agent");
  }

  backToFreeTalk(): void {
    this.assertTalking();
    this.assertPhase("questions");
    this.phase = "free_talk";
  }

  /** Checked questions become roots q1, q2, … in list order; the first one is dug first. */
  startDeepDive(): void {
    this.assertTalking();
    this.assertPhase("questions");
    const checked = this.questions.filter((q) => q.checked);
    if (checked.length === 0) throw new WhyError("invalid_state", "チェックした問いがありません");
    let a = this.analysis;
    const dives: Dive[] = checked.map((q, i) => ({ questionId: `q${i + 1}`, text: q.text, status: i === 0 ? "digging" : "pending", draft: null, ...(q.by ? { by: q.by } : {}) }));
    for (const d of dives) a = addRoot(a, { id: d.questionId, text: d.text }, this.now);
    this.analysis = a;
    this.dives = dives;
    this.phase = "deep_dive";
  }

  /**
   * Moves to the next question. Gemini may move only when the question is ready (a branch at five whys and no
   * shallow open branch); the person's button moves at once and the question becomes partial.
   */
  advance(by: "gemini" | "person"): AdvanceResult {
    this.assertTalking();
    this.assertPhase("deep_dive");
    const i = this.dives.findIndex((d) => d.status === "digging");
    if (i < 0) return { moved: false, finished: null, current: null };
    const d = this.dives[i];
    if (by === "gemini") {
      const q = questionReady(this.analysis, d.questionId);
      if (!q.ready) {
        const left = q.reached
          ? `shallow branches are still open: ${q.open.map((o) => `${o.id} (${o.depth})`).join(", ")}`
          : `no branch of ${d.questionId} has reached five whys yet${q.open.length > 0 ? `; dig ${q.open.map((o) => `${o.id} (${o.depth})`).join(", ")}` : ""}`;
        throw new WhyError("invalid_state", `${d.questionId} is not finished: ${left}`);
      }
    }
    d.status = by === "gemini" ? "done" : "partial";
    const next = this.dives.slice(i + 1).find((x) => x.status === "pending");
    if (next) next.status = "digging";
    return { moved: true, finished: d, current: this.current() };
  }

  appendTranscript(speaker: Speaker, text: string): void {
    this.assertTalking();
    if (text.trim() === "") return;
    const at = this.now();
    const last = this.transcript.at(-1);
    if (last && last.speaker === speaker && Date.parse(at) - Date.parse(last.at) <= MERGE_WINDOW_MS) {
      last.text += text;
      last.at = at;
      return;
    }
    this.transcript.push({ at, speaker, text });
  }

  /** Never throws for a bad call from Gemini: the error goes back to Gemini so it can try again. */
  applyTool(name: string, args: unknown, by: "gemini" | "agent" = "gemini"): ToolResult {
    const fail = (error: string): ToolResult => ({ ok: false, error, tree: treeSummary(this.analysis), belowTarget: this.belowTarget(), current: this.current() });
    if (this.status !== "talking") return fail(`the session is ${this.status}`);
    if (this.phase !== "deep_dive") return fail("the deep dive has not started");
    if (!isToolName(name)) return fail(`unknown function ${name}`);
    if (by === "agent" && !(AGENT_TOOLS as readonly string[]).includes(name)) return fail(`${name} is Gemini's own; an agent may call ${AGENT_TOOLS.join(", ")}`);
    const agent = by === "agent";
    const parsed = ToolArgs[name].safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(`bad arguments for ${name}: ${issue?.path.join(".")} ${issue?.message}`);
    }
    try {
      let added: string[] = [];
      let note: string | undefined;
      let role: Role | undefined;
      // Live trial 2026-11-16: after answering a question Gemini went back to asking why without switch_role.
      // A tree tool from an answerer that a question swapped in means it is interviewing again; the role changes
      // only once the tool succeeds, so a refused call leaves everything as it was (review R3).
      const backToInterviewing = !agent && this.role === "answerer" && this.roleBy === "question" && (name === "add_whys" || name === "add_fact" || name === "update_branch");
      switch (name) {
        case "add_whys": {
          const a = ToolArgs.add_whys.parse(args);
          if (!agent) this.assertCurrent(a.parent_id);
          const r = addWhys(this.analysis, a.parent_id, a.items, this.now);
          this.analysis = agent ? { ...r.analysis, nodes: r.analysis.nodes.map((n) => (r.added.includes(n.id) ? { ...n, by: "agent" as const } : n)) } : r.analysis;
          added = r.added;
          const notes: string[] = [];
          if (r.skipped.length > 0) notes.push(`already there, skipped: ${r.skipped.join(" / ")}`);
          // The branch being dug should say so: in the 2026-11-14 trial every dug node stayed candidate (未調査).
          const parent = this.analysis.nodes.find((n) => n.id === a.parent_id);
          if (parent && parent.parentId !== null && parent.state === "candidate") {
            notes.push(`${parent.id} is still candidate; you are digging it, so call update_branch(node_id="${parent.id}", state="digging")`);
          }
          if (notes.length > 0) note = notes.join("; ");
          break;
        }
        case "add_fact": {
          const a = ToolArgs.add_fact.parse(args);
          if (!agent) this.assertCurrent(a.node_id);
          this.analysis = addFact(this.analysis, a.node_id, { summary: a.summary, supports: a.supports, ...(agent ? { by: "agent" as const } : {}) }, this.now);
          break;
        }
        case "update_branch": {
          const a = ToolArgs.update_branch.parse(args);
          if (!agent) this.assertCurrent(a.node_id);
          this.analysis = updateNode(this.analysis, a.node_id, { state: a.state, reason: a.reason, countermeasure: a.countermeasure }, this.now);
          break;
        }
        case "propose_direction": {
          const a = ToolArgs.propose_direction.parse(args);
          this.setDraft(a.question_id, { direction: a.direction, reasons: a.reasons, rejected: a.rejected, openQuestions: a.open_questions });
          // Live trial 2026-11-16: Gemini drafted a finished question and then waited; say plainly that it may move on.
          if (!agent && this.current()?.questionId === a.question_id && questionReady(this.analysis, a.question_id).ready) {
            note = `${a.question_id} is ready: call next_question now, without waiting for the person`;
          }
          break;
        }
        case "next_question": {
          const r = this.advance("gemini");
          note = r.current
            ? `moved to ${r.current.questionId}: read it out, then ask the first why`
            : r.moved ? "that was the last question: tell the person all questions are done and they can send" : "there is no question left";
          break;
        }
        case "switch_role": {
          const a = ToolArgs.switch_role.parse(args);
          this.setRole(a.to, a.by ?? "request");
          role = this.role;
          if (a.by === "question") {
            note = a.to === "answerer"
              ? 'answer briefly after checking with Google Search, then call switch_role(to="interviewer", by="question")'
              : "continue the branch you were digging with the next why";
          }
          break;
        }
      }
      if (backToInterviewing) {
        this.setRole("interviewer");
        role = this.role;
      }
      return { ok: true, added, tree: treeSummary(this.analysis), belowTarget: this.belowTarget(), current: this.current(), ...(note ? { note } : {}), ...(role ? { role } : {}) };
    } catch (e) {
      if (e instanceof WhyError) return fail(`${e.code}: ${e.message}`);
      throw e;
    }
  }

  /** Switching to the current role does nothing. */
  setRole(role: Role, by: "request" | "question" = "request"): void {
    this.assertTalking();
    this.role = role;
    this.roleBy = role === "answerer" ? by : null;
  }

  recordAnswer(e: Omit<AskedEntry, "at">): void {
    this.assertTalking();
    const clean = (t: string) => redactSecrets(t.trim(), { extra: this.secrets });
    const answer = clean(e.answer);
    if (answer === "") throw new WhyError("invalid_input", "an answer needs text");
    this.asked.push({
      at: this.now(),
      question: clean(e.question),
      answer,
      queries: e.queries.map(clean).filter((q) => q !== ""),
      // A link that carries a secret is kept as a title only.
      sources: e.sources.map((x) => {
        const uri = x.uri.trim();
        return { title: clean(x.title), uri: redactSecrets(uri, { extra: this.secrets }) === uri ? uri : "" };
      }),
    });
  }

  setDraft(questionId: string, d: Direction): void {
    this.assertTalking();
    this.dive(questionId).draft = redactDirection(d);
  }

  /** Sends from any phase. A question Gemini finished (done) needs a direction; partial and pending ones may be empty. */
  submit(directions: Record<string, Direction>): void {
    this.assertTalking();
    for (const id of Object.keys(directions)) this.dive(id);
    for (const d of this.dives) {
      const given = directions[d.questionId];
      const next = given ? redactDirection(given) : d.draft;
      if (d.status === "done" && (next?.direction ?? "") === "") throw new WhyError("invalid_input", `${d.questionId} の方針が空です`);
      d.draft = next;
    }
    this.status = "sent";
  }

  cancel(reason: string): void {
    if (this.status === "cancelled") return;
    this.assertTalking();
    this.status = "cancelled";
    this.cancelReason = reason;
  }

  /**
   * Appends page diagnostics to <outDir>/events.jsonl, redacted and time-stamped, in order with the other saves.
   * Accepted in any status: a talk that ended oddly is exactly when the events matter. Capped per session.
   */
  appendEvents(events: Array<{ kind: string; detail?: string; ms?: number }>): Promise<void> {
    const room = MAX_EVENTS - this.eventCount;
    if (room <= 0) return Promise.resolve();
    const take = events.slice(0, room);
    this.eventCount += take.length;
    const at = this.now();
    const text = take.map((e) => JSON.stringify({
      at,
      kind: e.kind,
      ...(e.detail ? { detail: redactSecrets(e.detail, { extra: this.secrets }) } : {}),
      ...(e.ms !== undefined ? { ms: e.ms } : {}),
    })).join("\n") + "\n";
    const run = this.saving.then(async () => {
      await mkdir(this.outDir, { recursive: true });
      await appendFile(join(this.outDir, "events.jsonl"), text, "utf8");
    });
    this.saving = run.catch(() => undefined);
    return run;
  }

  /** Writes the record under outDir, redacted, each file atomically. Saves run one at a time. */
  persist(): Promise<void> {
    const run = this.saving.then(() => this.writeRecord());
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async writeRecord(): Promise<void> {
    await mkdir(this.outDir, { recursive: true });
    const files: Array<[string, string]> = [
      ["session.json", JSON.stringify({ ...this.snapshot(), context: this.context, cancelReason: this.cancelReason }, null, 2)],
      ["transcript.md", renderTranscriptMarkdown(this)],
      ["tree.mmd", renderMermaid(this.analysis)],
    ];
    if (this.status === "sent") {
      files.push(["result.md", renderResultMarkdown(this)], ["result.json", JSON.stringify(resultJson(this), null, 2)]);
    }
    for (const [name, text] of files) {
      const file = join(this.outDir, name);
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, redactSecrets(text, { extra: this.secrets }), "utf8");
      await rename(tmp, file);
    }
  }

  private belowTarget(): BelowTarget {
    const c = this.current();
    return c ? openBelowTarget(this.analysis, c.questionId) : [];
  }

  private dive(questionId: string): Dive {
    const d = this.dives.find((x) => x.questionId === questionId);
    if (!d) throw new WhyError("not_found", `no question ${questionId}`);
    return d;
  }

  /** Tree tools act only on the question being dug. */
  private assertCurrent(nodeId: string): void {
    const c = this.current();
    if (!c) throw new WhyError("invalid_state", "every question is finished; nothing to dig");
    const root = rootOf(this.analysis, nodeId);
    if (root !== c.questionId) throw new WhyError("invalid_state", `${nodeId} belongs to ${root}; the current question is ${c.questionId}`);
  }

  private assertPhase(...allowed: Phase[]): void {
    if (!allowed.includes(this.phase)) throw new WhyError("invalid_state", `not allowed in the ${this.phase} phase`);
  }

  private clean(text: string): string {
    return redactSecrets(text.trim(), { extra: this.secrets });
  }

  private assertTalking(): void {
    if (this.status !== "talking") throw new WhyError("conflict", `the session is already ${this.status}`);
  }
}

function redactDirection(d: Direction): Direction {
  return {
    direction: redactSecrets(d.direction.trim()),
    reasons: redactSecrets(d.reasons.trim()),
    rejected: redactSecrets(d.rejected.trim()),
    openQuestions: redactSecrets(d.openQuestions.trim()),
  };
}
