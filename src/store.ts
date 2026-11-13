import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ANALYSIS_ID, AnalysisSchema, WhyError, type Analysis } from "./model.ts";

export type AnalysisSummary = { id: string; title: string; status: Analysis["status"]; updatedAt: string };

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

export function resolveDir(env: Record<string, string | undefined>, cwd: string): string {
  return env.WHY_WHY_DIR ? resolve(cwd, env.WHY_WHY_DIR) : join(cwd, ".why-why");
}

/** One JSON file per analysis. Writes are atomic and refuse to overwrite a newer version. */
export class FileStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  async load(id: string): Promise<Analysis> {
    const text = await this.readRaw(checkId(id));
    if (text === null) throw new WhyError("not_found", `no analysis ${id} in ${this.dir}`);
    return parse(id, text);
  }

  /** `expectedUpdatedAt` is the version the change was made from; null means the analysis must not exist yet. */
  async save(a: Analysis, expectedUpdatedAt: string | null): Promise<void> {
    checkId(a.id);
    await mkdir(this.dir, { recursive: true });
    const release = await this.lock(a.id);
    try {
      const raw = await this.readRaw(a.id);
      const onDisk = raw === null ? null : parse(a.id, raw).updatedAt;
      if (onDisk !== expectedUpdatedAt) {
        throw new WhyError(
          "conflict",
          onDisk === null
            ? `analysis ${a.id} was not found on disk; it may have been removed`
            : expectedUpdatedAt === null
              ? `analysis ${a.id} already exists`
              : `analysis ${a.id} changed since it was read (now ${onDisk}); read it again and retry`,
        );
      }
      // The version stamp must move forward, or a change made in the same millisecond as the one it was
      // based on would look unchanged and a stale writer could overwrite it.
      const toWrite = expectedUpdatedAt !== null && a.updatedAt <= expectedUpdatedAt
        ? { ...a, updatedAt: new Date(Date.parse(expectedUpdatedAt) + 1).toISOString() }
        : a;
      const file = this.file(a.id);
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    } finally {
      await release();
    }
  }

  async list(): Promise<AnalysisSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if (isNoEnt(e)) return [];
      throw e;
    }
    const out: AnalysisSummary[] = [];
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!ANALYSIS_ID.test(id)) continue;
      try {
        const a = await this.load(id);
        out.push({ id: a.id, title: a.title, status: a.status, updatedAt: a.updatedAt });
      } catch {
        // A file that is not a valid analysis is skipped, not fatal for the listing.
      }
    }
    return out.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  }

  async writeArtifact(id: string, ext: "html" | "mmd", text: string): Promise<string> {
    checkId(id);
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${id}.${ext}`);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
    return file;
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async readRaw(id: string): Promise<string | null> {
    try {
      return await readFile(this.file(id), "utf8");
    } catch (e) {
      if (isNoEnt(e)) return null;
      throw e;
    }
  }

  private async lock(id: string): Promise<() => Promise<void>> {
    const dir = join(this.dir, `${id}.lock`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(dir);
        return () => rm(dir, { recursive: true, force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const age = await stat(dir).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new WhyError("conflict", `analysis ${id} is being written by another process; retry`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
}

function checkId(id: string): string {
  if (!ANALYSIS_ID.test(id)) throw new WhyError("invalid_input", `analysis id must match ${ANALYSIS_ID.source}, got ${JSON.stringify(id)}`);
  return id;
}

function parse(id: string, text: string): Analysis {
  const parsed = AnalysisSchema.safeParse(safeJson(text));
  if (!parsed.success) throw new WhyError("invalid_input", `analysis ${id} on disk is not valid: ${parsed.error.issues[0]?.message ?? "bad JSON"}`);
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isNoEnt(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}
