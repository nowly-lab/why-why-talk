// Real Gemini text-model check (not part of `npm test`; costs a cent or two). Needs GEMINI_API_KEY and macOS `say`.
//   node scripts/text-smoke.ts
// Transcribes a Japanese WAV made with `say`, summarizes a one-page PDF and a Markdown file, and splits them
// into questions, all through src/talk/text-model.ts.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEXT_MODEL, geminiTextModel, MAX_QUESTIONS } from "../src/talk/text-model.ts";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
const model = process.env.WHY_WHY_TEXT_MODEL ?? DEFAULT_TEXT_MODEL;
const m = geminiTextModel({ apiKey, model });
const dir = await mkdtemp(join(tmpdir(), "text-smoke-"));
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
};

// 1. Transcription of a Japanese WAV (16 kHz mono PCM16, the format the page sends).
const said = "計画を立てるときに論点を先に決めると、話したいことからずれてしまいます。添付した資料もうまく使えていません。";
execFileSync("say", ["-v", "Kyoko", "-o", join(dir, "speech.aiff"), said]);
execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", join(dir, "speech.aiff"), join(dir, "speech.wav")]);
let t0 = Date.now();
const text = await m.transcribe({ data: (await readFile(join(dir, "speech.wav"))).toString("base64"), mimeType: "audio/wav" });
check("transcribe", text.includes("論点") && text.includes("資料"), `${Date.now() - t0} ms: ${text}`);

// 2. A one-page PDF (built by hand) and a Markdown file.
const pdf = minimalPdf("Release checklist: the API key expired on 2026-11-13 and payments failed for 40 minutes.");
t0 = Date.now();
const pdfSummary = await m.summarizeFile({ name: "incident.pdf", mimeType: "application/pdf", data: pdf.toString("base64") });
check("summarize pdf", /40|API|キー/.test(pdfSummary), `${Date.now() - t0} ms: ${pdfSummary.replace(/\n/g, " / ")}`);
const mdSummary = await m.summarizeFile({ name: "memo.md", mimeType: "text/markdown", data: Buffer.from("# メモ\n- 締め切りは金曜\n- 担当が決まっていない").toString("base64") });
check("summarize markdown", /金曜|担当/.test(mdSummary), mdSummary.replace(/\n/g, " / "));

// 3. Questions from the talk and the files.
t0 = Date.now();
const qs = await m.splitQuestions({
  topic: null,
  context: "",
  freeTalk: text,
  files: [{ name: "incident.pdf", mimeType: "application/pdf", summary: pdfSummary }, { name: "memo.md", mimeType: "text/markdown", summary: mdSummary }],
});
check("split questions", qs.length >= 1 && qs.length <= MAX_QUESTIONS && qs.every((q) => /[ぁ-んァ-ン一-龠]/.test(q)), `${Date.now() - t0} ms, ${qs.length} 件:\n  ${qs.join("\n  ")}`);

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? `\nall ${results.length} checks ok (${model})` : `\n${failed.length} of ${results.length} checks failed`);
process.exitCode = failed.length === 0 ? 0 : 1;

/** A valid one-page PDF with one line of Helvetica text. */
function minimalPdf(line: string): Buffer {
  const stream = `BT /F1 12 Tf 40 760 Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
