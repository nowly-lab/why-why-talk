export type Speaker = "person" | "gemini";
export type Line = { speaker: Speaker; text: string; at: number };

const MERGE_WINDOW_MS = 4_000;

/** Live transcription arrives in fragments; join a speaker's fragments into one line while they keep coming. */
export function appendFragment(lines: Line[], speaker: Speaker, text: string, at: number): Line[] {
  if (text.trim() === "") return lines;
  const last = lines.at(-1);
  if (last && last.speaker === speaker && at - last.at <= MERGE_WINDOW_MS) {
    return [...lines.slice(0, -1), { speaker, text: last.text + text, at }];
  }
  return [...lines, { speaker, text, at }];
}
