// Running talks for agents to find: one file per talk under ~/.why-why-talk/talks (WHY_WHY_HOME moves it), readable by
// this user only, removed when the talk ends. It holds the talk's agent token, so never print or copy it.
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const TalkEntrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  topic: z.string().nullable(),
  outDir: z.string(),
  startedAt: z.string(),
  pid: z.number().int().positive(),
});
export type TalkEntry = z.infer<typeof TalkEntrySchema>;

export function talksDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.WHY_WHY_HOME ?? join(homedir(), ".why-why-talk"), "talks");
}

export async function writeTalkEntry(dir: string, e: TalkEntry): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = join(dir, `${TalkEntrySchema.parse(e).id}.json`);
  await writeFile(file, JSON.stringify(e), { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function removeTalkEntry(dir: string, id: string): Promise<void> {
  await rm(join(dir, `${id}.json`), { force: true });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Talks whose process is still running, newest first. A file left by a talk that died is removed. */
export async function listTalks(dir: string): Promise<TalkEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: TalkEntry[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    const parsed = TalkEntrySchema.safeParse(await readFile(join(dir, n), "utf8").then(JSON.parse).catch(() => null));
    if (!parsed.success || !alive(parsed.data.pid)) {
      await rm(join(dir, n), { force: true });
      continue;
    }
    out.push(parsed.data);
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
