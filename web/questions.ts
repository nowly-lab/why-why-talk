/** The question list and the per-question dives as the page sees them. Pure helpers are tested in Node. */
export type Question = { text: string; checked: boolean; by?: "agent" };
export type DiveStatus = "pending" | "digging" | "done" | "partial";
export type Dive = { questionId: string; text: string; status: DiveStatus; draft: { direction: string; reasons: string; rejected: string; openQuestions: string } | null; by?: "agent" };
export type CurrentQuestion = { questionId: string; text: string } | null;

const LABEL: Record<DiveStatus, string> = { pending: "未着手", digging: "掘っている途中", done: "終わった", partial: "途中" };

export function diveLabel(status: DiveStatus): string {
  return LABEL[status];
}

/** A copy with the item at `from` moved to `to`; out of range returns the list unchanged. */
export function moveQuestion(list: Question[], from: number, to: number): Question[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** At least one checked question and no empty text. */
export function canStart(list: Question[]): boolean {
  return list.some((q) => q.checked) && list.every((q) => q.text.trim() !== "");
}

/** One question's tree: its root and everything under it, in the original order. */
export function treeOf<N extends { id: string; parentId: string | null }>(nodes: N[], rootId: string): N[] {
  const keep = new Set<string>();
  if (!nodes.some((n) => n.id === rootId)) return [];
  keep.add(rootId);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (!keep.has(n.id) && n.parentId !== null && keep.has(n.parentId)) {
        keep.add(n.id);
        grew = true;
      }
    }
  }
  return nodes.filter((n) => keep.has(n.id));
}

export function selectedLabel(list: Question[]): string {
  const n = list.filter((q) => q.checked).length;
  return n === 0 ? "0件を選択中 · 1件以上選ぶと始められます" : `${n}件を選択中 · この順に深掘りします`;
}

/** Questions in all, the person's and those Claude added in a meeting (the server's MAX_TOTAL_QUESTIONS). */
export const MAX_QUESTIONS = 20;

type NoteNode = { id: string; parentId: string | null; text: string; state?: string; reason?: string; countermeasure?: string; facts?: Array<{ summary: string; by?: "agent" }>; by?: "agent" };
type NoteDive = { questionId: string; draft: { direction: string; reasons?: string; rejected?: string; openQuestions?: string } | null };
const NOTE_STATE: Record<string, string> = { candidate: "未調査", digging: "掘っている", leaf: "葉", rejected: "却下", hypothesis: "仮説" };
/**
 * One line for a connected Gemini after Claude (the meeting's agent) changed the talk: the questions, whys and facts
 * it added, so Gemini does not dig the same branch again. null when Claude added nothing.
 */
export function agentChangeNote(before: { tree: NoteNode[]; questions: Question[]; dives?: NoteDive[] }, after: { tree: NoteNode[]; questions: Question[]; dives?: NoteDive[] }): string | null {
  const known = new Set(before.tree.map((n) => n.id));
  const oldNode = new Map(before.tree.map((n) => [n.id, n]));
  const oldDraft = new Map((before.dives ?? []).map((d) => [d.questionId, d.draft]));
  const DRAFT_FIELDS = [["direction", "方針"], ["reasons", "理由"], ["rejected", "見送った案"], ["openQuestions", "残った疑問"]] as const;
  const oldFacts = new Map(before.tree.map((n) => [n.id, n.facts?.length ?? 0]));
  const parts = [
    ...after.questions.slice(before.questions.length).filter((q) => q.by === "agent").map((q) => `問い「${q.text}」`),
    ...after.tree.filter((n) => !known.has(n.id) && n.by === "agent").map((n) => `${n.parentId} の下に ${n.id}「${n.text}」`),
    ...after.tree.flatMap((n) => (n.facts ?? []).slice(oldFacts.get(n.id) ?? 0).filter((f) => f.by === "agent").map((f) => `${n.id} に事実「${f.summary}」`)),
    ...after.tree.filter((n) => known.has(n.id)).flatMap((n) => {
      const o = oldNode.get(n.id)!;
      return [
        ...(n.state && o.state !== n.state ? [`${n.id} を「${NOTE_STATE[n.state] ?? n.state}」に${n.reason ? `（理由: ${n.reason}）` : ""}`] : n.reason && o.reason !== n.reason ? [`${n.id} の理由「${n.reason}」`] : []),
        ...(n.countermeasure && o.countermeasure !== n.countermeasure ? [`${n.id} の対策「${n.countermeasure}」`] : []),
      ];
    }),
    ...(after.dives ?? []).flatMap((d) => DRAFT_FIELDS.filter(([k]) => (d.draft?.[k] ?? "") !== (oldDraft.get(d.questionId)?.[k] ?? "")).map(([k, label]) => (d.draft?.[k] ? `${d.questionId} の${label}「${d.draft[k]}」` : `${d.questionId} の${label}を消しました`))),
  ];
  return parts.length ? `画面から: 会議の Claude が書き足しました（返事は要りません。同じ枝を掘り直さないでください）: ${parts.join("、")}` : null;
}

/** The checklist rows (layout A): check, number, editable text, up, down, delete. Every edit calls `change`. */
export function renderQuestionList(el: HTMLElement, list: Question[], on: { change(list: Question[]): void }, opts: { locked?: boolean } = {}): void {
  const rows = list.map((q, i) => {
    const row = document.createElement("div");
    row.className = "q-row";
    const check = Object.assign(document.createElement("input"), { type: "checkbox", checked: q.checked });
    check.setAttribute("aria-label", `問い ${i + 1} を選ぶ`);
    check.addEventListener("change", () => on.change(list.map((x, j) => (j === i ? { ...x, checked: check.checked } : x))));
    const num = Object.assign(document.createElement("span"), { className: "num", textContent: `${i + 1}.` });
    const by = q.by === "agent" ? [Object.assign(document.createElement("span"), { className: "by-agent", textContent: "Claude" })] : [];
    const text = Object.assign(document.createElement("input"), { type: "text", value: q.text });
    text.setAttribute("aria-label", `問い ${i + 1} の文`);
    text.addEventListener("change", () => on.change(list.map((x, j) => (j === i ? { ...x, text: text.value } : x))));
    const button = (label: string, title: string, cls: string, fn: () => void, disabled = false) => {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title, className: cls, disabled });
      b.setAttribute("aria-label", `問い ${i + 1} を${title}`);
      b.addEventListener("click", fn);
      return b;
    };
    // Locked while 深掘りを始める or 送信 is settling: an edit then could not reach the dive.
    if (opts.locked) for (const c of [check, text]) c.disabled = true;
    row.append(
      check,
      num,
      ...by,
      text,
      button("↑", "上へ", "move", () => on.change(moveQuestion(list, i, i - 1)), i === 0 || !!opts.locked),
      button("↓", "下へ", "move", () => on.change(moveQuestion(list, i, i + 1)), i === list.length - 1 || !!opts.locked),
      button("削除", "削除", "", () => on.change(list.filter((_, j) => j !== i)), !!opts.locked),
    );
    return row;
  });
  el.replaceChildren(...rows);
}

/** The question list beside the talk (layout A): each with its status chip, the current one highlighted. */
export function renderDives(el: HTMLElement, dives: Dive[], current: CurrentQuestion): void {
  el.replaceChildren(...dives.map((d, i) => {
    const card = document.createElement("div");
    card.className = "dive";
    card.dataset.status = d.status;
    card.dataset.question = d.questionId;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.title = "押すとこの問いの木を表示します";
    if (current?.questionId === d.questionId) card.setAttribute("aria-current", "true");
    const text = Object.assign(document.createElement("div"), { textContent: `${i + 1}. ${d.text}` });
    const chip = Object.assign(document.createElement("span"), { className: "chip", textContent: diveLabel(d.status) });
    card.append(text, chip);
    if (d.by === "agent") card.append(Object.assign(document.createElement("span"), { className: "by-agent", textContent: "Claude" }));
    return card;
  }));
}

/**
 * Saves a value through `post`, one request at a time in edit order, so the server never receives an older list
 * after a newer one. A save superseded before its turn is skipped; only the newest answer is applied.
 * settled() waits for the newest save and rejects if it failed.
 */
export function createLatestSaver<T>(post: (value: T) => Promise<T>, apply: (saved: T) => void) {
  let rev = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let latest: Promise<void> = Promise.resolve();
  return {
    save(value: T): Promise<void> {
      const mine = ++rev;
      const run = tail.then(async () => {
        if (mine !== rev) return;
        const saved = await post(value);
        if (mine === rev) apply(saved);
      });
      tail = run.catch(() => undefined);
      latest = run;
      return run;
    },
    settled: () => latest,
    /** Waits until no save is left, including saves started while waiting; rejects if the last one failed. */
    async drain(): Promise<void> {
      let seen: Promise<void>;
      do {
        seen = latest;
        await seen;
      } while (seen !== latest);
    },
  };
}

/** Uploads still running; split, start and send wait for them so no file is left out. */
export function createTaskTracker() {
  const running = new Set<Promise<unknown>>();
  return {
    track<T>(p: Promise<T>): Promise<T> {
      running.add(p);
      void p.finally(() => running.delete(p)).catch(() => undefined);
      return p;
    },
    settled: async (): Promise<void> => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
    pending: () => running.size,
  };
}
