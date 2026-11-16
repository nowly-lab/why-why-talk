import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAttachment, fileKind, MAX_FILE_BYTES, readAttachment } from "../src/talk/attachments.ts";
import { WhyError } from "../src/model.ts";

test("fileKind maps accepted extensions", () => {
  assert.deepEqual(fileKind("a.md"), { kind: "text", mimeType: "text/markdown" });
  assert.deepEqual(fileKind("notes.txt"), { kind: "text", mimeType: "text/plain" });
  assert.deepEqual(fileKind("b.PDF"), { kind: "pdf", mimeType: "application/pdf" });
  assert.deepEqual(fileKind("c.jpeg"), { kind: "image", mimeType: "image/jpeg" });
  assert.deepEqual(fileKind("shot.png"), { kind: "image", mimeType: "image/png" });
  assert.equal(fileKind("d.docx"), null);
  assert.equal(fileKind("e.mp3"), null);
  assert.deepEqual(fileKind("noext", "image/webp"), { kind: "image", mimeType: "image/webp" });
});

test("checkAttachment refuses large and unsupported files", () => {
  assert.throws(() => checkAttachment("big.pdf", "application/pdf", MAX_FILE_BYTES + 1), (e: unknown) => e instanceof WhyError && e.code === "invalid_input" && /10MB/.test(e.message));
  assert.throws(() => checkAttachment("x.docx", undefined, 10), (e: unknown) => e instanceof WhyError && /テキスト・Markdown・PDF・画像/.test(e.message));
  assert.deepEqual(checkAttachment("ok.md", undefined, 10), { kind: "text", mimeType: "text/markdown" });
});

test("readAttachment reads a file and refuses a missing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "why-att-"));
  await writeFile(join(dir, "memo.md"), "# メモ");
  const a = await readAttachment(join(dir, "memo.md"));
  assert.equal(a.name, "memo.md");
  assert.equal(a.kind, "text");
  assert.equal(a.data.toString("utf8"), "# メモ");
  await assert.rejects(readAttachment(join(dir, "none.md")), WhyError);
});
