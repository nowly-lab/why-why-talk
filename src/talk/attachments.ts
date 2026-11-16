import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { WhyError } from "../model.ts";

/** One file at most this big: Gemini takes it inline in one request. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type FileKind = "text" | "pdf" | "image";
export type Attachment = { name: string; mimeType: string; kind: FileKind; data: Buffer };

const BY_EXT: Record<string, { kind: FileKind; mimeType: string }> = {
  ".txt": { kind: "text", mimeType: "text/plain" },
  ".md": { kind: "text", mimeType: "text/markdown" },
  ".markdown": { kind: "text", mimeType: "text/markdown" },
  ".pdf": { kind: "pdf", mimeType: "application/pdf" },
  ".png": { kind: "image", mimeType: "image/png" },
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".gif": { kind: "image", mimeType: "image/gif" },
};
const BY_MIME = new Map(Object.values(BY_EXT).map((v) => [v.mimeType, v]));

/** Text, Markdown, PDF or an image; anything else is null. The extension wins over the browser's type. */
export function fileKind(name: string, mimeType?: string): { kind: FileKind; mimeType: string } | null {
  const ext = extname(name).toLowerCase();
  if (ext) return BY_EXT[ext] ?? null;
  return (mimeType && BY_MIME.get(mimeType.toLowerCase())) || null;
}

export function checkAttachment(name: string, mimeType: string | undefined, size: number): { kind: FileKind; mimeType: string } {
  const kind = fileKind(name, mimeType);
  if (!kind) throw new WhyError("invalid_input", `${name}: 読めるのはテキスト・Markdown・PDF・画像だけです`);
  if (size > MAX_FILE_BYTES) throw new WhyError("invalid_input", `${name}: 1 ファイル 10MB までです`);
  return kind;
}

export async function readAttachment(path: string): Promise<Attachment> {
  const name = basename(path);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (e) {
    throw new WhyError("invalid_input", `${name}: 読めません (${(e as Error).message})`);
  }
  const kind = checkAttachment(name, undefined, size);
  return { name, ...kind, data: await readFile(path) };
}
