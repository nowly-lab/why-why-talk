/** The same kinds and size as src/talk/attachments.ts (that file uses node:fs, so the page keeps its own copy). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXTS = [".txt", ".md", ".markdown", ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
const TYPES = ["text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"];

export function acceptDrop(file: { name: string; type: string; size: number }): { ok: true } | { ok: false; reason: string } {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : "";
  const known = ext ? EXTS.includes(ext) : TYPES.includes(file.type.toLowerCase());
  if (!known) return { ok: false, reason: `${file.name}: 読めるのはテキスト・Markdown・PDF・画像だけです` };
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: `${file.name}: 1 ファイル 10MB までです` };
  return { ok: true };
}
