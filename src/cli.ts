#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL, DEFAULT_VOICE, mintToken } from "./talk/gemini.ts";
import { startTalkServer } from "./talk/server.ts";
import { TalkSession } from "./talk/session.ts";
import { removeTalkEntry, talksDir, writeTalkEntry } from "./talk/registry.ts";
import { readAttachment } from "./talk/attachments.ts";
import { DEFAULT_TEXT_MODEL, geminiTextModel, type FileSummary, type TextModel } from "./talk/text-model.ts";
import { VERSION } from "./version.ts";

export const USAGE = `why-why-talk ${VERSION}
Talk freely, split the talk and attached files into questions, then deep-dive the checked questions by voice
with Gemini Live. Blocks until the person sends the result.

Usage:
  why-why-talk [--topic "<point>"] [--context <file>] [--attach <file>]... [--out <dir>] [--no-open]
  why-why-talk mcp     MCP server (stdio) for agents: find running talks, add questions, start the dive without
                       voice, grow any question's tree, draft directions

  Without --topic the page starts with free talk; with it, the question list is made from the topic,
  --context and the attached files at once. --attach takes text, Markdown, PDF or images (10MB each).

Exit codes: 0 sent (result Markdown on stdout), 1 cancelled or tab closed, 2 failure.
Env: GEMINI_API_KEY (required), WHY_WHY_LIVE_MODEL (default ${DEFAULT_MODEL}), WHY_WHY_TEXT_MODEL (default ${DEFAULT_TEXT_MODEL}),
     WHY_WHY_VOICE (default ${DEFAULT_VOICE}), WHY_WHY_BROWSER=none,
     WHY_WHY_FIRST_CONNECT_MS (default 600000: give up when no page connects),
     WHY_WHY_HOME (default ~/.why-why-talk: where running talks are listed for agents).
`;

type IO = { out: (s: string) => void; err: (s: string) => void };

/** `text` replaces the Gemini text model (tests). */
export type MainDeps = { text?: (opts: { apiKey: string; model: string }) => TextModel };

export async function main(argv: string[], env: Record<string, string | undefined>, cwd: string, io: IO, deps: MainDeps = {}): Promise<number> {
  if (argv[0] === "mcp") {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { createWhyWhyMcp } = await import("./mcp/server.ts");
    const transport = new StdioServerTransport();
    const closed = new Promise<number>((r) => (transport.onclose = () => r(0)));
    await createWhyWhyMcp({ dir: talksDir(env) }).connect(transport);
    return closed;
  }
  let values: { topic?: string; context?: string; attach?: string[]; out?: string; "no-open"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        topic: { type: "string" },
        context: { type: "string" },
        attach: { type: "string", multiple: true },
        out: { type: "string" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    io.err(`why-why-talk: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const topic = values.topic?.trim() || null;
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    io.err("why-why-talk: GEMINI_API_KEY is not set\n");
    return 2;
  }
  let context = "";
  if (values.context) {
    try {
      context = await readFile(resolve(cwd, values.context), "utf8");
    } catch (e) {
      io.err(`why-why-talk: cannot read --context: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const textModelName = env.WHY_WHY_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;
  const text = (deps.text ?? geminiTextModel)({ apiKey, model: textModelName });
  // Files the agent attached are read and summarized before the page opens; a bad one stops the command.
  const files: FileSummary[] = [];
  for (const path of values.attach ?? []) {
    try {
      const a = await readAttachment(resolve(cwd, path));
      io.err(`why-why-talk: 読み込み中: ${a.name}\n`);
      files.push({ name: a.name, mimeType: a.mimeType, summary: await text.summarizeFile({ name: a.name, mimeType: a.mimeType, data: a.data.toString("base64") }) });
    } catch (e) {
      io.err(`why-why-talk: cannot use --attach ${path}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const outDir = values.out ? resolve(cwd, values.out) : join(cwd, ".why-why", `${stamp(new Date())}-${topic ? slug(topic) : "free-talk"}`);
  const session = new TalkSession({ topic, context, outDir, files, secrets: [apiKey] });
  const model = env.WHY_WHY_LIVE_MODEL?.trim() || DEFAULT_MODEL;
  const voice = env.WHY_WHY_VOICE?.trim() || DEFAULT_VOICE;

  const firstConnectMs = env.WHY_WHY_FIRST_CONNECT_MS ? Number(env.WHY_WHY_FIRST_CONNECT_MS) : undefined;
  if (firstConnectMs !== undefined && !(Number.isFinite(firstConnectMs) && firstConnectMs > 0)) {
    io.err(`why-why-talk: WHY_WHY_FIRST_CONNECT_MS must be a positive number of milliseconds, got ${env.WHY_WHY_FIRST_CONNECT_MS}\n`);
    return 2;
  }
  // Agents (Claude in a meeting, through `why-why-talk mcp`) find this talk in the registry and use this token.
  const agentToken = randomBytes(32).toString("hex");
  const registry = talksDir(env);
  let server: Awaited<ReturnType<typeof startTalkServer>>;
  try {
    server = await startTalkServer(session, {
      webRoot: webRoot(),
      mint: (opts) => mintToken({ apiKey, model, voice }, session, opts),
      text,
      firstConnectMs,
      agentToken,
    });
  } catch (e) {
    io.err(`why-why-talk: cannot start (out dir ${outDir}): ${(e as Error).message}\n`);
    return 2;
  }
  await writeTalkEntry(registry, { id: session.id, url: server.url, token: agentToken, topic, outDir, startedAt: session.startedAt, pid: process.pid }).catch((e: unknown) =>
    io.err(`why-why-talk: agents cannot find this talk (${(e as Error).message})\n`),
  );
  io.err(`why-why-talk: open ${server.url}\n`);
  if (!values["no-open"] && env.WHY_WHY_BROWSER !== "none") openBrowser(server.url);

  const stop = () => server.cancel("コマンドが止められた");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const outcome = await server.outcome;
  await removeTalkEntry(registry, session.id).catch(() => undefined);
  await server.close();
  if (outcome.kind === "sent") {
    io.out(outcome.markdown);
    return 0;
  }
  io.out(`取りやめ (${outcome.reason}) record: ${outDir}\n`);
  return 1;
}

function webRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "web"), join(here, "..", "dist", "web")];
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? candidates[0];
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slug(topic: string): string {
  const s = topic.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "talk";
}

// npm runs bins through a symlink (node_modules/.bin), so compare real paths.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main(process.argv.slice(2), process.env, process.cwd(), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`why-why-talk: ${(e as Error).message}\n`);
      process.exitCode = 2;
    },
  );
}
