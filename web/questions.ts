/** The question list and the per-question dives as the page sees them. Pure helpers are tested in Node. */
export type Question = { text: string; checked: boolean };
export type DiveStatus = "pending" | "digging" | "done" | "partial";
export type Dive = { questionId: string; text: string; status: DiveStatus; draft: { direction: string; reasons: string; rejected: string; openQuestions: string } | null };
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
