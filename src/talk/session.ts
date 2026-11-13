import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addFact, addWhys, startAnalysis, treeSummary, updateNode, type Clock, type TreeSummary } from "../analysis.ts";
import { WhyError, type Analysis } from "../model.ts";
import { redactSecrets } from "../redact.ts";
import { renderMermaid } from "../render/mermaid.ts";
import { isToolName, ToolArgs } from "./tools.ts";
import { renderResultMarkdown, renderTranscriptMarkdown, resultJson } from "./result.ts";

export type Speaker = "person" | "gemini";
export type TranscriptEntry = { at: string; speaker: Speaker; text: string };
export type Direction = { direction: string; reasons: string; rejected: string; openQuestions: string };
export type SessionStatus = "talking" | "sent" | "cancelled";
export type ToolResult =
  | { ok: true; added: string[]; tree: TreeSummary; note?: string }
  | { ok: false; error: string; tree: TreeSummary };

const MERGE_WINDOW_MS = 4_000;

/** One deep-dive: the tree, the transcript, the draft and how it ended. The result is decided once. */
export class TalkSession {
  readonly id: string;
  readonly nonce: string;
  readonly topic: string;
  readonly context: string;
  readonly outDir: string;
  readonly startedAt: string;
  analysis: Analysis;
  transcript: TranscriptEntry[] = [];
  draft: Direction | null = null;
  sent: Direction | null = null;
  status: SessionStatus = "talking";
  cancelReason: string | null = null;
  private readonly now: Clock;
  private saving: Promise<void> = Promise.resolve();

  constructor(input: { topic: string; context: string; outDir: string; now?: Clock }) {
    this.now = input.now ?? (() => new Date().toISOString());
    this.id = randomBytes(6).toString("hex");
    this.nonce = randomBytes(16).toString("hex");
    this.topic = redactSecrets(input.topic.trim());
    this.context = redactSecrets(input.context);
    this.outDir = input.outDir;
    this.startedAt = this.now();
    this.analysis = startAnalysis({ id: `talk-${this.id}`, title: this.topic, problem: this.topic }, this.now);
  }

  snapshot() {
    return {
      id: this.id,
      topic: this.topic,
      status: this.status,
      tree: this.analysis.nodes,
      transcript: this.transcript,
      draft: this.draft,
      startedAt: this.startedAt,
    };
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
    const fail = (error: string): ToolResult => ({ ok: false, error, tree: treeSummary(this.analysis) });
    if (this.status !== "talking") return fail(`the session is ${this.status}`);
    if (!isToolName(name)) return fail(`unknown function ${name}`);
    const parsed = ToolArgs[name].safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(`bad arguments for ${name}: ${issue?.path.join(".")} ${issue?.message}`);
    }
    try {
      let added: string[] = [];
      let note: string | undefined;
      switch (name) {
        case "add_whys": {
          const a = ToolArgs.add_whys.parse(args);
          const r = addWhys(this.analysis, a.parent_id, a.items, this.now);
          this.analysis = r.analysis;
          added = r.added;
          if (r.skipped.length > 0) note = `already there, skipped: ${r.skipped.join(" / ")}`;
          break;
        }
        case "add_fact": {
          const a = ToolArgs.add_fact.parse(args);
          this.analysis = addFact(this.analysis, a.node_id, { summary: a.summary, supports: a.supports }, this.now);
          break;
        }
        case "update_branch": {
          const a = ToolArgs.update_branch.parse(args);
          this.analysis = updateNode(this.analysis, a.node_id, { state: a.state, reason: a.reason, countermeasure: a.countermeasure }, this.now);
          break;
        }
        case "propose_direction": {
          const a = ToolArgs.propose_direction.parse(args);
          this.setDraft({ direction: a.direction, reasons: a.reasons, rejected: a.rejected, openQuestions: a.open_questions });
          break;
        }
      }
      return { ok: true, added, tree: treeSummary(this.analysis), ...(note ? { note } : {}) };
    } catch (e) {
      if (e instanceof WhyError) return fail(`${e.code}: ${e.message}`);
      throw e;
    }
  }

  setDraft(d: Direction): void {
    this.assertTalking();
    this.draft = redactDirection(d);
  }

  submit(d: Direction): void {
    this.assertTalking();
    if (d.direction.trim() === "") throw new WhyError("invalid_input", "方針が空です");
    this.sent = redactDirection(d);
    this.draft = this.sent;
    this.status = "sent";
  }

  cancel(reason: string): void {
    if (this.status === "cancelled") return;
    this.assertTalking();
    this.status = "cancelled";
    this.cancelReason = reason;
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
      await writeFile(tmp, redactSecrets(text), "utf8");
      await rename(tmp, file);
    }
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
