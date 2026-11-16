import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_LIMIT, liveConfig, mintToken, systemInstruction } from "../src/talk/gemini.ts";
import { TalkSession } from "../src/talk/session.ts";

const fixedNow = () => "2026-11-13T01:00:00.000Z";

async function session(context = "401 が40分続いた") {
  const outDir = await mkdtemp(join(tmpdir(), "why-why-gem-"));
  const s = new TalkSession({ topic: "決済エラーの再発をどう防ぐか", context, outDir, now: fixedNow });
  s.setQuestions(["決済エラーの再発をどう防ぐか"]);
  s.editQuestions([{ text: "決済エラーの再発をどう防ぐか", checked: true }]);
  s.startDeepDive();
  return s;
}

/** No topic: free talk, a file, then three checked questions. */
async function freeSession(freeTalk = "論点を先に決めるとずれる") {
  const outDir = await mkdtemp(join(tmpdir(), "why-why-gem-"));
  const s = new TalkSession({ context: "", outDir, now: fixedNow });
  s.appendFreeTalk(freeTalk);
  s.addFile({ name: "memo.md", mimeType: "text/markdown", summary: "- 添付の要点" });
  const qs = ["なぜ論点がずれるのか", "なぜ資料が使えないのか", "なぜ時間が足りないのか"];
  s.setQuestions(qs);
  s.editQuestions(qs.map((text) => ({ text, checked: true })));
  s.startDeepDive();
  return s;
}

test("instruction contains topic, context and the Japanese rule", async () => {
  const text = systemInstruction(await session(), { fallback: false });
  assert.match(text, /決済エラーの再発をどう防ぐか/);
  assert.match(text, /401 が40分続いた/);
  assert.match(text, /RESPOND IN JAPANESE\. YOU MUST RESPOND UNMISTAKABLY IN JAPANESE\./);
  assert.match(text, /add_whys/);
  assert.match(text, /propose_direction/);
  assert.doesNotMatch(text, /これまでの会話/);
});

test("context truncated at the limit with a note", async () => {
  const text = systemInstruction(await session("あ".repeat(CONTEXT_LIMIT + 500)), { fallback: false });
  assert.ok(text.includes("あ".repeat(CONTEXT_LIMIT)));
  assert.ok(!text.includes("あ".repeat(CONTEXT_LIMIT + 1)));
  assert.match(text, /以下 500 文字を省略/);
});

test("fallback includes tree summary and transcript tail", async () => {
  const s = await session();
  s.applyTool("add_whys", { parent_id: "q1", items: [{ text: "APIキーが期限切れ", viewpoint: "仕組み・道具" }] });
  s.appendTranscript("person", "い".repeat(9000));
  const text = systemInstruction(s, { fallback: true });
  assert.match(text, /これまでの会話/);
  assert.match(text, /n1 .*APIキーが期限切れ/);
  assert.ok(text.includes("い".repeat(7000)));
  assert.ok(!text.includes("い".repeat(8001)));
});

test("live config has audio, transcription, compression and tools", async () => {
  const c = liveConfig(await session(), { fallback: false, voice: "Kore" });
  assert.deepEqual(c.responseModalities, ["AUDIO"]);
  // Pinned to Japanese: in the 2026-11-14 trial auto-detection heard Japanese as Spanish and English fragments.
  assert.deepEqual(c.inputAudioTranscription, { languageCodes: ["ja-JP"] });
  assert.deepEqual(c.outputAudioTranscription, {});
  assert.deepEqual(c.contextWindowCompression, { slidingWindow: {} });
  assert.equal(c.sessionResumption, undefined, "the handle is added by the browser per connection");
  assert.equal((c.tools as Array<{ functionDeclarations: unknown[] }>)[0].functionDeclarations.length, 6);
  assert.equal(c.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, "Kore");
});

test("token config locks model and set fields, uses=1 with expiry", async () => {
  let seen: Record<string, unknown> | undefined;
  const info = await mintToken(
    {
      apiKey: "AIza-secret-key",
      model: "gemini-3.8-live",
      voice: "Kore",
      now: () => Date.parse(fixedNow()),
      createToken: async (cfg) => {
        seen = cfg as Record<string, unknown>;
        return { name: "auth_tokens/abc" };
      },
    },
    await session(),
    { fallback: false },
  );
  assert.equal(info.token, "auth_tokens/abc");
  assert.equal(info.model, "gemini-3.8-live");
  assert.equal(seen?.uses, 1);
  assert.equal(seen?.newSessionExpireTime, "2026-11-13T01:01:00.000Z");
  assert.equal(seen?.expireTime, "2026-11-13T01:30:00.000Z");
  assert.deepEqual(seen?.lockAdditionalFields, []);
  const constraints = seen?.liveConnectConstraints as { model: string; config: { systemInstruction: string } };
  assert.equal(constraints.model, "gemini-3.8-live");
  assert.match(constraints.config.systemInstruction, /決済エラー/);
  assert.equal(info.expiresAt, "2026-11-13T01:30:00.000Z");
});

test("minted payload never contains the api key", async () => {
  const info = await mintToken(
    { apiKey: "AIza-secret-key", model: "gemini-3.8-live", voice: "Kore", createToken: async () => ({ name: "auth_tokens/x" }) },
    await session(),
    { fallback: false },
  );
  assert.ok(!JSON.stringify(info).includes("AIza-secret-key"));
});

test("fallback seed is redacted", async () => {
  const s = await session();
  s.appendTranscript("person", "トークンは ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 です");
  const text = systemInstruction(s, { fallback: true });
  assert.ok(!text.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"));
});

test("speech detection waits through Japanese pauses but still hears quiet speech start", async () => {
  const c = liveConfig(await session(), { fallback: false, voice: "Kore" });
  assert.deepEqual(c.realtimeInputConfig?.automaticActivityDetection, {
    endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
    prefixPaddingMs: 300,
    silenceDurationMs: 1000,
  });
});

// --- five whys (plan v1 Task 2) ---
test("instruction asks for five whys before widening", async () => {
  const text = systemInstruction(await session(), { fallback: false });
  assert.match(text, /5段/);
  assert.match(text, /なぜ〇〇が大事なのですか/);
  assert.match(text, /褒め/);
  assert.match(text, /belowTarget/);
  assert.match(text, /自分で理由を作らない/);
});

test("fallback tree lines show depth", async () => {
  const s = await session();
  s.applyTool("add_whys", { parent_id: "q1", items: [{ text: "APIキーが期限切れ", viewpoint: "仕組み・道具" }] });
  s.applyTool("add_whys", { parent_id: "n1", items: [{ text: "期限を誰も見ていない", viewpoint: "人・体制" }] });
  const text = systemInstruction(s, { fallback: true });
  assert.match(text, /n2 \(親 n1, 2段/);
});

// --- role (plan v1 Task 4) ---
test("liveConfig includes googleSearch", async () => {
  const c = liveConfig(await session(), { fallback: false, voice: "Kore" });
  const tools = c.tools as Array<Record<string, unknown>>;
  assert.ok(tools.some((t) => "googleSearch" in t));
  assert.equal((tools[0] as { functionDeclarations: unknown[] }).functionDeclarations.length, 6);
});

test("interviewer brief answers a question put to Gemini and then comes back", async () => {
  const text = systemInstruction(await session(), { fallback: false });
  assert.match(text, /今の役割: 聞き手/);
  assert.ok(text.includes("相手があなたに向けて疑問形で聞いたとき"));
  assert.ok(text.includes('switch_role(to="answerer", by="question")'));
  assert.ok(text.includes('switch_role(to="interviewer", by="question")'));
  assert.ok(text.includes("独り言"), "a question the person asks themselves is not answered");
  assert.match(text, /それ以外では Google 検索は使わない/);
});

test("an answerer swapped in by a question goes back after answering; one asked for stays", async () => {
  const s = await session();
  s.setRole("answerer", "question");
  assert.ok(systemInstruction(s, { fallback: true }).includes('答えたら switch_role(to="interviewer", by="question")'));
  s.setRole("answerer", "request");
  const asked = systemInstruction(s, { fallback: true });
  assert.ok(asked.includes("戻すときは『戻して』と言ってください"));
  assert.ok(!asked.includes('答えたら switch_role(to="interviewer", by="question")'));
});

test("token minted after role swap carries answerer brief", async () => {
  const s = await session();
  s.setRole("answerer");
  let seen: { liveConnectConstraints?: { config?: { systemInstruction?: unknown } } } | undefined;
  await mintToken({ apiKey: "k", model: "m", voice: "Kore", now: () => 0, createToken: async (cfg) => { seen = cfg as never; return { name: "auth_tokens/x" }; } }, s, { fallback: true });
  const brief = String(seen?.liveConnectConstraints?.config?.systemInstruction);
  assert.match(brief, /今の役割: 答える係/);
  assert.match(brief, /Google 検索で確かめて/);
});

// --- question list (2026-11-16) ---
test("instruction lists questions with their status and the current one", async () => {
  const s = await freeSession();
  s.advance("person");
  const text = systemInstruction(s, { fallback: false });
  assert.match(text, /q1 \[途中\] なぜ論点がずれるのか/);
  assert.match(text, /q2 \[掘っている途中\] なぜ資料が使えないのか/);
  assert.match(text, /q3 \[未着手\] なぜ時間が足りないのか/);
  assert.match(text, /今の問い: q2 なぜ資料が使えないのか/);
  assert.match(text, /論点を先に決めるとずれる/);
  assert.match(text, /添付の要点/);
});

test("instruction tells Gemini to advance without waiting", async () => {
  const text = systemInstruction(await freeSession(), { fallback: false });
  assert.ok(text.includes("今の問いに5段に届いた枝が一本以上あり、掘りかけの浅い枝が残っていなければ、propose_direction(question_id=今の問い)で方針を下書きし、要点を一言伝えてから next_question を呼ぶ。相手の確認は待たない。"));
  assert.ok(text.includes("今の問いだけを掘る。ほかの問いの木には関数を呼ばない。"));
  assert.ok(text.includes("画面から「次の問いへ進みます」と届いたら、関数は呼ばずに次の問いを読み上げて続ける。"));
  assert.ok(text.includes("最初に、今の問い(q1)を読み上げてから、最初の「なぜ?」を聞く。"));
});

test("instruction omits the topic line when there is none", async () => {
  assert.doesNotMatch(systemInstruction(await freeSession(), { fallback: false }), /^論点: /m);
  assert.match(systemInstruction(await session(), { fallback: false }), /^論点: 決済エラーの再発をどう防ぐか/m);
});

test("fallback resumes on the current question", async () => {
  const s = await freeSession();
  s.advance("person");
  const text = systemInstruction(s, { fallback: true });
  assert.match(text, /今の問い: q2/);
  assert.match(text, /q1 \[途中\]/);
  assert.ok(!text.includes("最初に、今の問い(q1)を読み上げて"));
  assert.match(text, /今の問い\(q2\)から続ける/);
});

test("free talk is cut to its tail", async () => {
  const s = await freeSession("古".repeat(40_000) + "新しい話");
  const text = systemInstruction(s, { fallback: false });
  assert.ok(text.includes("新しい話"));
  assert.ok(!text.includes("古".repeat(31_000)));
});
