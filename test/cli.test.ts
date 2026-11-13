import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

type Run = { url: Promise<string>; done: Promise<{ code: number | null; stdout: string; stderr: string }> };

function run(args: string[], env: Record<string, string | undefined>, cwd: string): Run {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH, ...env } });
  let stdout = "";
  let stderr = "";
  let resolveUrl!: (u: string) => void;
  const url = new Promise<string>((r) => (resolveUrl = r));
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => {
    stderr += d;
    const m = /open (http:\/\/127\.0\.0\.1:\d+)\n/.exec(stderr);
    if (m) resolveUrl(m[1]);
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) =>
    child.on("close", (code) => r({ code, stdout, stderr })),
  );
  return { url, done };
}

async function session(url: string): Promise<string> {
  try {
    return (await (await fetch(`${url}/api/session`)).json()).nonce;
  } catch (e) {
    throw new Error(`session fetch failed: ${String((e as { cause?: unknown }).cause)}`);
  }
}

const post = (url: string, path: string, nonce: string, body: unknown) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-why-why-session": nonce }, body: JSON.stringify(body) });

test("missing key exits 2", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const r = await run(["--topic", "論点", "--no-open"], {}, cwd).done;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /GEMINI_API_KEY/);
});

test("missing topic exits 2 with usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const r = await run(["--no-open"], { GEMINI_API_KEY: "k" }, cwd).done;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--topic/);
});

test("help exits 0", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const r = await run(["--help"], {}, cwd).done;
  assert.equal(r.code, 0);
  assert.match(r.stdout, /why-why-talk --topic/);
});

test("submit prints result and exits 0; out dir has result files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const ctx = join(cwd, "ctx.md");
  await writeFile(ctx, "401 が40分続いた");
  const out = join(cwd, "out");
  const r = run(["--topic", "決済エラーの再発をどう防ぐか", "--context", ctx, "--out", out, "--no-open"], { GEMINI_API_KEY: "k" }, cwd);
  const url = await r.url;
  const nonce = await session(url);
  await post(url, "/api/tool", nonce, { name: "add_whys", args: { parent_id: "n0", items: [{ text: "期限切れ", viewpoint: "検知" }] } });
  assert.equal((await post(url, "/api/submit", nonce, { direction: "監視する", reasons: "r", rejected: "x", openQuestions: "q" })).status, 200);
  const done = await r.done;
  assert.equal(done.code, 0);
  assert.match(done.stdout, /^# 深掘りの結果: 決済エラーの再発をどう防ぐか/);
  assert.match(done.stdout, /期限切れ/);
  assert.ok(!done.stdout.includes("GEMINI_API_KEY"));
  const files = await readdir(out);
  for (const f of ["result.md", "result.json", "tree.mmd", "transcript.md", "session.json"]) assert.ok(files.includes(f), f);
});

test("cancel exits 1 and names the record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const r = run(["--topic", "論点", "--no-open"], { GEMINI_API_KEY: "k" }, cwd);
  const url = await r.url;
  await post(url, "/api/cancel", await session(url), {});
  const done = await r.done;
  assert.equal(done.code, 1);
  assert.match(done.stdout, /^取りやめ \(取りやめを押した\) record: .*\.why-why\/\d{8}-\d{6}-/);
});

test("default out dir is under .why-why with a timestamp", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const r = run(["--topic", "Payment errors", "--no-open"], { GEMINI_API_KEY: "k" }, cwd);
  const url = await r.url;
  await post(url, "/api/cancel", await session(url), {});
  await r.done;
  const dirs = await readdir(join(cwd, ".why-why"));
  assert.match(dirs[0], /^\d{8}-\d{6}-payment-errors$/);
});

test("SIGTERM cancels and exits 1", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const child = spawn(process.execPath, [CLI, "--topic", "論点", "--no-open"], { cwd, env: { PATH: process.env.PATH, GEMINI_API_KEY: "k" } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  await new Promise<void>((r) => child.stderr.on("data", (d) => { stderr += d; if (/open http/.test(stderr)) r(); }));
  child.kill("SIGTERM");
  const code = await new Promise<number | null>((r) => child.on("close", r));
  assert.equal(code, 1);
  assert.match(stdout, /^取りやめ \(コマンドが止められた\)/);
});

test("runs when started through a symlink (npm bin)", async () => {
  const { symlink } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const link = join(cwd, "why-why-talk");
  await symlink(CLI, link);
  const child = spawn(process.execPath, [link, "--help"], { cwd, env: { PATH: process.env.PATH } });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  assert.equal(code, 0);
  assert.match(stdout, /why-why-talk --topic/);
});

test("unwritable out dir exits 2 instead of hanging", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const file = join(cwd, "not-a-dir");
  await writeFile(file, "x");
  const r = await run(["--topic", "論点", "--no-open", "--out", join(file, "sub")], { GEMINI_API_KEY: "k" }, cwd).done;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /out/);
});

test("no page within the first-connect limit cancels with exit 1", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-cli-"));
  const r = await run(["--topic", "論点", "--no-open"], { GEMINI_API_KEY: "k", WHY_WHY_FIRST_CONNECT_MS: "300" }, cwd).done;
  assert.equal(r.code, 1);
  assert.match(r.stdout, /画面が開かれなかった/);
});
