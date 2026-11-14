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
  return new TalkSession({ topic: "決済エラーの再発をどう防ぐか", context, outDir, now: fixedNow });
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
  s.applyTool("add_whys", { parent_id: "n0", items: [{ text: "APIキーが期限切れ", viewpoint: "仕組み・道具" }] });
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
  assert.deepEqual(c.inputAudioTranscription, {});
  assert.deepEqual(c.outputAudioTranscription, {});
  assert.deepEqual(c.contextWindowCompression, { slidingWindow: {} });
  assert.equal(c.sessionResumption, undefined, "the handle is added by the browser per connection");
  assert.equal((c.tools as Array<{ functionDeclarations: unknown[] }>)[0].functionDeclarations.length, 5);
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
});

test("fallback tree lines show depth", async () => {
  const s = await session();
  s.applyTool("add_whys", { parent_id: "n0", items: [{ text: "APIキーが期限切れ", viewpoint: "仕組み・道具" }] });
  s.applyTool("add_whys", { parent_id: "n1", items: [{ text: "期限を誰も見ていない", viewpoint: "人・体制" }] });
  const text = systemInstruction(s, { fallback: true });
  assert.match(text, /n2 \(親 n1, 2段/);
});

// --- role (plan v1 Task 4) ---
test("liveConfig includes googleSearch", async () => {
  const c = liveConfig(await session(), { fallback: false, voice: "Kore" });
  const tools = c.tools as Array<Record<string, unknown>>;
  assert.ok(tools.some((t) => "googleSearch" in t));
  assert.equal((tools[0] as { functionDeclarations: unknown[] }).functionDeclarations.length, 5);
});

test("interviewer brief says not to search", async () => {
  const text = systemInstruction(await session(), { fallback: false });
  assert.match(text, /今の役割: 聞き手/);
  assert.match(text, /Google 検索は使わない/);
  assert.match(text, /switch_role/);
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
