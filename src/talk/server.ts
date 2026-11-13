import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { WhyError } from "../model.ts";
import type { TokenInfo } from "./gemini.ts";
import { renderResultMarkdown } from "./result.ts";
import type { TalkSession } from "./session.ts";

export type Outcome = { kind: "sent"; markdown: string } | { kind: "cancelled"; reason: string };
export type TalkServer = { url: string; outcome: Promise<Outcome>; cancel(reason: string): void; close(): Promise<void> };
export type ServerDeps = {
  webRoot: string;
  mint: (opts: { fallback: boolean }) => Promise<TokenInfo>;
  /** How long the page may be gone (closed tab, reload) before the talk counts as abandoned. */
  leaseGraceMs?: number;
  /** How long to wait for the first page to connect before giving up. */
  firstConnectMs?: number;
};

const HEARTBEAT_MS = 15_000;
const MAX_BODY = 1_000_000;
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
const TokenBody = z.object({ fallback: z.boolean().default(false) });

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
  const onLeaseGone = () => {
    if (leases.size > 0 || settled || graceTimer) return;
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
    if (req.method === "GET") return serveStatic(url.pathname, res);
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (req.headers["x-why-why-session"] !== s.nonce) return json(res, 409, { error: "session_mismatch: this tab belongs to an older talk" });

    const body = await readJson(req);
    try {
      switch (url.pathname) {
        case "/api/token": {
          const { fallback } = TokenBody.parse(body ?? {});
          if (s.status !== "talking") return json(res, 409, { error: `the session is ${s.status}` });
          return json(res, 200, await deps.mint({ fallback }));
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
        case "/api/draft": {
          s.setDraft(DirectionBody.parse(body));
          await s.persist();
          return json(res, 200, { ok: true });
        }
        // Answer the page first, then settle: the caller may close the server as soon as the outcome is known.
        case "/api/submit": {
          s.submit(DirectionBody.parse(body));
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new WhyError("invalid_input", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WhyError("invalid_input", "body is not JSON");
  }
}
