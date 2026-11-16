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
export type TranscriptEntry = { at: string; speaker: Speaker; text: string };
export type Direction = { direction: string; reasons: string; rejected: string; openQuestions: string };
export type Source = { title: string; uri: string };
export type AskedEntry = { at: string; question: string; answer: string; queries: string[]; sources: Source[] };
export type SessionStatus = "talking" | "sent" | "cancelled";
/** free_talk: the person talks and Gemini only listens; questions: the person picks; deep_dive: Gemini Live digs. */
export type Phase = "free_talk" | "questions" | "deep_dive";
export type Question = { text: string; checked: boolean };
export type DiveStatus = "pending" | "digging" | "done" | "partial";
export type Dive = { questionId: string; text: string; status: DiveStatus; draft: Direction | null };
export type CurrentQuestion = { questionId: string; text: string } | null;
export type AdvanceResult = { moved: boolean; finished: Dive | null; current: CurrentQuestion };
export type BelowTarget = Array<{ id: string; depth: number }>;
export type ToolResult =
  | { ok: true; added: string[]; tree: TreeSummary; belowTarget: BelowTarget; current: CurrentQuestion; note?: string; role?: Role }
  | { ok: false; error: string; tree: TreeSummary; belowTarget: BelowTarget; current: CurrentQuestion };

const MERGE_WINDOW_MS = 4_000;
const MAX_EVENTS = 5_000;

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
    this.files = (input.files ?? []).map((f) => ({ ...f, summary: this.clean(f.summary) }));
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
      asked: this.asked,
      startedAt: this.startedAt,
    };
  }

  current(): CurrentQuestion {
    const d = this.dives.find((x) => x.status === "digging");
    return d ? { questionId: d.questionId, text: d.text } : null;
  }

  /** One transcribed free-talk segment. Segments are already whole utterances, so they are not merged. */
  appendFreeTalk(text: string): void {
    this.assertTalking();
    this.assertPhase("free_talk");
    const t = this.clean(text);
    if (t === "") return;
    this.freeTalk.push({ at: this.now(), speaker: "person", text: t });
  }

  addFile(f: FileSummary): void {
    this.assertTalking();
    this.assertPhase("free_talk", "questions");
    this.files.push({ name: this.clean(f.name), mimeType: f.mimeType, summary: this.clean(f.summary) });
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
    if (list.length > MAX_QUESTIONS) throw new WhyError("invalid_input", `問いは ${MAX_QUESTIONS} 件までです`);
    const next = list.map((q) => ({ text: this.clean(q.text), checked: q.checked }));
    if (next.some((q) => q.text === "")) throw new WhyError("invalid_input", "空の問いがあります");
    this.questions = next;
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
    const dives: Dive[] = checked.map((q, i) => ({ questionId: `q${i + 1}`, text: q.text, status: i === 0 ? "digging" : "pending", draft: null }));
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
  applyTool(name: string, args: unknown): ToolResult {
    const fail = (error: string): ToolResult => ({ ok: false, error, tree: treeSummary(this.analysis), belowTarget: this.belowTarget(), current: this.current() });
    if (this.status !== "talking") return fail(`the session is ${this.status}`);
    if (this.phase !== "deep_dive") return fail("the deep dive has not started");
    if (!isToolName(name)) return fail(`unknown function ${name}`);
    const parsed = ToolArgs[name].safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(`bad arguments for ${name}: ${issue?.path.join(".")} ${issue?.message}`);
    }
    try {
      let added: string[] = [];
      let note: string | undefined;
      let role: Role | undefined;
      switch (name) {
        case "add_whys": {
          const a = ToolArgs.add_whys.parse(args);
          this.assertCurrent(a.parent_id);
          const r = addWhys(this.analysis, a.parent_id, a.items, this.now);
          this.analysis = r.analysis;
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
          this.assertCurrent(a.node_id);
          this.analysis = addFact(this.analysis, a.node_id, { summary: a.summary, supports: a.supports }, this.now);
          break;
        }
        case "update_branch": {
          const a = ToolArgs.update_branch.parse(args);
          this.assertCurrent(a.node_id);
          this.analysis = updateNode(this.analysis, a.node_id, { state: a.state, reason: a.reason, countermeasure: a.countermeasure }, this.now);
          break;
        }
        case "propose_direction": {
          const a = ToolArgs.propose_direction.parse(args);
          this.setDraft(a.question_id, { direction: a.direction, reasons: a.reasons, rejected: a.rejected, openQuestions: a.open_questions });
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
          this.setRole(a.to);
          role = this.role;
          break;
        }
      }
      return { ok: true, added, tree: treeSummary(this.analysis), belowTarget: this.belowTarget(), current: this.current(), ...(note ? { note } : {}), ...(role ? { role } : {}) };
    } catch (e) {
      if (e instanceof WhyError) return fail(`${e.code}: ${e.message}`);
      throw e;
    }
  }

  /** Switching to the current role does nothing. */
  setRole(role: Role): void {
    this.assertTalking();
    this.role = role;
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
