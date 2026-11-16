import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiTextModel, MAX_QUESTIONS, TextModelError, type Generate } from "../src/talk/text-model.ts";

type Req = Parameters<Generate>[0];
function fake(reply: string): { gen: Generate; calls: Req[] } {
  const calls: Req[] = [];
  return { calls, gen: async (req) => { calls.push(req); return { text: reply }; } };
}
const parts = (req: Req) => (req.contents as Array<{ parts: Array<Record<string, any>> }>)[0].parts;

test("transcribe sends the audio inline with a Japanese instruction", async () => {
  const f = fake("  こんにちは。 \n");
  const m = geminiTextModel({ apiKey: "k", model: "gemini-test", generate: f.gen });
  assert.equal(await m.transcribe({ data: "AAAA", mimeType: "audio/wav" }), "こんにちは。");
  assert.equal(f.calls[0].model, "gemini-test");
  const p = parts(f.calls[0]);
  assert.equal(p[0].inlineData.mimeType, "audio/wav");
  assert.match(p[1].text, /文字起こし/);
});

test("splitQuestions caps at 10 and drops blanks and duplicates", async () => {
  const qs = ["  なぜA?", "", "なぜA?", ...Array.from({ length: 10 }, (_, i) => `なぜ${i}?`)];
  const f = fake(JSON.stringify({ questions: qs }));
  const m = geminiTextModel({ apiKey: "k", model: "x", generate: f.gen });
  const out = await m.splitQuestions({ topic: null, context: "", freeTalk: "話した内容", files: [{ name: "a.md", mimeType: "text/markdown", summary: "要点" }] });
  assert.equal(out.length, MAX_QUESTIONS);
  assert.equal(out[0], "なぜA?");
  assert.equal(new Set(out).size, out.length);
  assert.ok(!out.includes(""));
  assert.equal(f.calls[0].config?.responseMimeType, "application/json");
  assert.match(parts(f.calls[0])[0].text, /話した内容/);
  assert.match(parts(f.calls[0])[0].text, /要点/);
});

test("splitQuestions rejects malformed JSON", async () => {
  const m = geminiTextModel({ apiKey: "k", model: "x", generate: fake("not json").gen });
  await assert.rejects(m.splitQuestions({ topic: "論点", context: "", freeTalk: "", files: [] }), TextModelError);
});

test("an upstream failure becomes a TextModelError", async () => {
  const m = geminiTextModel({ apiKey: "k", model: "x", generate: async () => { throw new Error("503 unavailable"); } });
  await assert.rejects(m.transcribe({ data: "AAAA", mimeType: "audio/wav" }), (e: unknown) => e instanceof TextModelError && /503/.test(e.message));
});

test("summarizeFile sends text files as text and PDFs inline", async () => {
  const f = fake("要点です");
  const m = geminiTextModel({ apiKey: "k", model: "x", generate: f.gen });
  assert.equal(await m.summarizeFile({ name: "a.md", mimeType: "text/markdown", data: Buffer.from("# 見出し").toString("base64") }), "要点です");
  assert.match(parts(f.calls[0]).map((p) => p.text ?? "").join("\n"), /# 見出し/);
  assert.ok(parts(f.calls[0]).every((p) => !p.inlineData));
  await m.summarizeFile({ name: "b.pdf", mimeType: "application/pdf", data: "JVBERi0=" });
  assert.equal(parts(f.calls[1])[0].inlineData.mimeType, "application/pdf");
});
