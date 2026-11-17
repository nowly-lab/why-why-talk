import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { RoleSchema, WhyError } from "../model.ts";
import type { Seed, TokenInfo } from "./gemini.ts";
import { renderResultMarkdown } from "./result.ts";
import { AGENT_TOOLS, type TalkSession } from "./session.ts";
import { checkAttachment } from "./attachments.ts";
import { TextModelError, type TextModel } from "./text-model.ts";

export type Outcome = { kind: "sent"; markdown: string } | { kind: "cancelled"; reason: string };
export type TalkServer = { url: string; outcome: Promise<Outcome>; cancel(reason: string): void; close(): Promise<void> };
export type ServerDeps = {
  webRoot: string;
  mint: (opts: Seed) => Promise<TokenInfo>;
  /** Transcribes free-talk segments, summarizes files and splits questions. */
  text: TextModel;
  /** How long the page may be gone (closed tab, reload) before the talk counts as abandoned. */
  leaseGraceMs?: number;
  /** How long to wait for the first page to connect before giving up. */
  firstConnectMs?: number;
  /** 64 hex characters: the bearer token for /api/agent/* (written to the talk registry). Absent: no agent routes. */
  agentToken?: string;
};

const HEARTBEAT_MS = 15_000;
const MAX_BODY = 1_000_000;
// A 30 s segment of 16 kHz mono PCM16 is ~0.96 MB, ~1.3 MB in base64; a 10 MB file is ~13.4 MB in base64.
const BODY_LIMIT: Record<string, number> = { "/api/audio": 2_000_000, "/api/file": 15_000_000 };
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const DirectionBody = z.object({ direction: z.string(), reasons: z.string(), rejected: z.string(), openQuestions: z.string() });
const TranscriptBody = z.object({ speaker: z.enum(["person", "gemini"]), text: z.string().max(20_000) });
const ToolBody = z.object({ name: z.string(), args: z.unknown() });
const RoleBody = z.object({ role: RoleSchema });
// Grounding comes from Gemini, not the person: trim what is too long or not a web link instead of refusing the answer.
const isWebUrl = (u: string) => {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};
const AnswerBody = z.object({
  question: z.string().max(20_000),
  answer: z.string().max(20_000),
  queries: z.array(z.string()).default([]).transform((qs) => qs.slice(0, 20).map((q) => q.slice(0, 500))),
  sources: z
    .array(z.object({ title: z.string(), uri: z.string() }))
    .default([])
    .transform((xs) => xs.filter((x) => x.uri.length <= 2_000 && isWebUrl(x.uri)).slice(0, 20).map((x) => ({ title: x.title.slice(0, 500), uri: x.uri }))),
});
const LogBody = z.object({
  events: z.array(z.object({
    kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/),
    detail: z.string().max(300).optional(),
    ms: z.number().finite().optional(),
  })).min(1).max(50),
});
const TokenBody = z.object({ fallback: z.boolean().default(false), roleSwitch: z.boolean().default(false) });
const AudioBody = z.object({ data: z.string().min(1), mimeType: z.literal("audio/wav"), order: z.number().finite().optional() });
const FileBody = z.object({ name: z.string().min(1).max(300), mimeType: z.string().max(200).default(""), data: z.string().min(1) });
const AgentQuestionBody = z.object({ text: z.string().min(1).max(2_000) });
const AgentToolBody = z.object({ name: z.enum(AGENT_TOOLS), args: z.unknown() });
const QuestionsBody = z.object({ questions: z.array(z.object({ text: z.string().max(2_000), checked: z.boolean(), by: z.literal("agent").optional() })) });
const DraftBody = DirectionBody.extend({ questionId: z.string() });
const SubmitBody = z.object({ directions: z.record(z.string(), DirectionBody) });

/** Local server for one talk, bound to 127.0.0.1. Resolves `outcome` once: sent or cancelled. */
export async function startTalkServer(s: TalkSession, deps: ServerDeps): Promise<TalkServer> {
  const leaseGraceMs = deps.leaseGraceMs ?? 60_000;
  // Fails before anything listens when the record cannot be written (bad --out).
  await s.persist();
  const webRoot = resolve(deps.webRoot);
  let settle!: (o: Outcome) => void;
  const outcome = new Promise<Outcome>((r) => (settle = r));
  let settled = false;
  const finish = async (o: Outcome) => {
    if (settled) return;
    settled = true;
    await s.persist().catch(() => undefined);
    settle(o);
  };

  // Lease: once a page has connected, losing every page for leaseGraceMs abandons the talk.
  const leases = new Set<ServerResponse>();
  let everLeased = false;
  let graceTimer: NodeJS.Timeout | null = null;
  let closed = false;
  const onLeaseGone = () => {
    // After close() the pages' streams end too; that is not a page going away, so no grace timer.
    if (leases.size > 0 || settled || closed || graceTimer) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (leases.size === 0 && s.status === "talking") {
        s.cancel("タブが閉じられた");
        void finish({ kind: "cancelled", reason: "タブが閉じられた" });
      }
    }, leaseGraceMs);
  };
  const heartbeat = setInterval(() => {
    for (const res of leases) res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  let port = 0;
  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: "bad host" });
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/api/session") {
      return json(res, 200, { ...s.snapshot(), nonce: s.nonce });
    }
    if (req.method === "GET" && url.pathname === "/api/lease") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": open\n\n");
      leases.add(res);
      everLeased = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      req.on("close", () => {
        leases.delete(res);
        if (everLeased) onLeaseGone();
      });
      return;
    }
    if (url.pathname.startsWith("/api/agent/")) return handleAgent(req, res, url.pathname);
    if (req.method === "GET") return serveStatic(url.pathname, res);
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (req.headers["x-why-why-session"] !== s.nonce) return json(res, 409, { error: "session_mismatch: this tab belongs to an older talk" });

    try {
      // Inside the try: an oversized or non-JSON body is the caller's error (400), not ours.
      const body = await readJson(req, BODY_LIMIT[url.pathname] ?? MAX_BODY);
      switch (url.pathname) {
        case "/api/token": {
          const seed = TokenBody.parse(body ?? {});
          if (s.status !== "talking") return json(res, 409, { error: `the session is ${s.status}` });
          if (s.phase !== "deep_dive") return json(res, 409, { error: "the deep dive has not started" });
          return json(res, 200, await deps.mint(seed));
        }
        case "/api/tool": {
          const { name, args } = ToolBody.parse(body);
          const r = s.applyTool(name, args);
          await s.persist();
          return json(res, 200, r);
        }
        case "/api/transcript": {
          const t = TranscriptBody.parse(body);
          s.appendTranscript(t.speaker, t.text);
          await s.persist();
          return json(res, 200, { ok: true });
        }
        case "/api/role": {
          s.setRole(RoleBody.parse(body).role);
          await s.persist();
          return json(res, 200, { ok: true, role: s.role });
        }
        case "/api/answer": {
          s.recordAnswer(AnswerBody.parse(body));
          await s.persist();
          return json(res, 200, { ok: true });
        }
        // Diagnostics only: kept next to the record, never part of the result body.
        case "/api/log": {
          await s.appendEvents(LogBody.parse(body).events);
          return json(res, 200, { ok: true });
        }
        case "/api/draft": {
          const { questionId, ...d } = DraftBody.parse(body);
          s.setDraft(questionId, d);
          await s.persist();
          return json(res, 200, { ok: true });
        }
        case "/api/audio": {
          const a = AudioBody.parse(body);
          const text = await deps.text.transcribe({ data: a.data, mimeType: a.mimeType });
          s.appendFreeTalk(text, a.order);
          await s.persist();
          // The redacted text as stored (empty when the segment had no words).
          return json(res, 200, { ok: true, text: text.trim() === "" ? "" : (s.freeTalk.find((t) => t.order === a.order && a.order !== undefined) ?? s.freeTalk.at(-1)!).text });
        }
        case "/api/file": {
          const f = FileBody.parse(body);
          if (!s.canAddFile()) return json(res, 409, { error: "ファイルは深掘りを始める前に渡してください" });
          const kind = checkAttachment(f.name, f.mimeType || undefined, Buffer.byteLength(f.data, "base64"));
          const summary = await deps.text.summarizeFile({ name: f.name, mimeType: kind.mimeType, data: f.data });
          s.addFile({ name: f.name, mimeType: kind.mimeType, summary });
          await s.persist();
          return json(res, 200, { ok: true, file: s.files.at(-1) });
        }
        case "/api/questions/split": {
          if (!s.hasMaterial()) throw new WhyError("invalid_input", "話した内容がありません。話すか、ファイルを渡してください");
          const texts = await deps.text.splitQuestions(s.splitInput());
          s.setQuestions(texts);
          await s.persist();
          return json(res, 200, { questions: s.questions });
        }
        case "/api/questions": {
          s.editQuestions(QuestionsBody.parse(body).questions);
          await s.persist();
          return json(res, 200, { questions: s.questions });
        }
        case "/api/free-talk": {
          s.backToFreeTalk();
          await s.persist();
          return json(res, 200, { ok: true });
        }
        case "/api/dive/start": {
          s.startDeepDive();
          await s.persist();
          return json(res, 200, { dives: s.dives, current: s.current() });
        }
        case "/api/dive/next": {
          s.advance("person");
          await s.persist();
          return json(res, 200, { dives: s.dives, current: s.current() });
        }
        // Answer the page first, then settle: the caller may close the server as soon as the outcome is known.
        case "/api/submit": {
          s.submit(SubmitBody.parse(body).directions);
          await respondThen(res, () => finish({ kind: "sent", markdown: renderResultMarkdown(s) }));
          return;
        }
        case "/api/cancel": {
          s.cancel("取りやめを押した");
          await respondThen(res, () => finish({ kind: "cancelled", reason: "取りやめを押した" }));
          return;
        }
        default:
          return json(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (e instanceof z.ZodError) return json(res, 400, { error: e.issues[0]?.message ?? "bad request" });
      if (e instanceof WhyError) return json(res, e.code === "conflict" ? 409 : 400, { error: `${e.code}: ${e.message}` });
      // The text model failed upstream: the page keeps what it has and offers a retry.
      if (e instanceof TextModelError) return json(res, 502, { error: e.message });
      throw e;
    }
  }

  /** Tells every open page that an agent changed the talk, so it reads the session again. */
  function announce(what: string): void {
    for (const r of leases) r.write(`event: changed\ndata: ${JSON.stringify({ by: "agent", what })}\n\n`);
  }

  /**
   * The agent's way in (the MCP server, for Claude in a meeting): its own bearer token from the talk registry, never
   * the page's nonce. Without a token configured the routes do not exist.
   */
  async function handleAgent(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const token = deps.agentToken;
    const given = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token || !given || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) return json(res, 401, { error: "agent token required" });
    try {
      if (req.method === "GET" && pathname === "/api/agent/state") return json(res, 200, s.snapshot());
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const body = await readJson(req, MAX_BODY);
      switch (pathname) {
        case "/api/agent/question": {
          const r = s.addQuestion(AgentQuestionBody.parse(body).text, "agent");
          await s.persist();
          announce("question");
          return json(res, 200, { ok: true, ...r, phase: s.phase });
        }
        case "/api/agent/start-dive": {
          s.startDeepDive();
          await s.persist();
          announce("start-dive");
          return json(res, 200, { ok: true, dives: s.dives, current: s.current() });
        }
        case "/api/agent/tool": {
          const { name, args } = AgentToolBody.parse(body);
          const r = s.agentTool(name, args);
          await s.persist();
          if (r.ok) announce(name);
          return json(res, 200, r);
        }
        default:
          return json(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (e instanceof z.ZodError) return json(res, 400, { error: e.issues[0]?.message ?? "bad request" });
      if (e instanceof WhyError) return json(res, e.code === "conflict" ? 409 : 400, { error: `${e.code}: ${e.message}` });
      throw e;
    }
  }

  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const file = normalize(join(webRoot, rel));
    if (!file.startsWith(webRoot + sep)) return json(res, 404, { error: "not found" });
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch {
      json(res, 404, { error: "not found" });
    }
  }

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;

  const firstConnect = setTimeout(() => {
    if (!everLeased && s.status === "talking") {
      s.cancel("画面が開かれなかった");
      void finish({ kind: "cancelled", reason: "画面が開かれなかった" });
    }
  }, deps.firstConnectMs ?? 10 * 60_000);

  return {
    url: `http://127.0.0.1:${port}`,
    outcome,
    cancel: (reason: string) => {
      if (s.status !== "talking") return;
      s.cancel(reason);
      void finish({ kind: "cancelled", reason });
    },
    close: async () => {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(firstConnect);
      if (graceTimer) clearTimeout(graceTimer);
      for (const res of leases) res.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function respondThen(res: ServerResponse, after: () => Promise<void>): Promise<void> {
  await new Promise<void>((r) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", connection: "close" });
    res.end(JSON.stringify({ ok: true }), r);
  });
  await after();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new WhyError("invalid_input", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WhyError("invalid_input", "body is not JSON");
  }
}
