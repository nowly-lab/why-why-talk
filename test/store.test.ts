import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { FileStore, resolveDir } from "../src/store.ts";
import { startAnalysis, addWhys } from "../src/analysis.ts";
import { WhyError } from "../src/model.ts";

const t0 = () => "2026-11-13T00:00:00.000Z";
const t1 = () => "2026-11-13T01:00:00.000Z";

async function store(): Promise<FileStore> {
  return new FileStore(await mkdtemp(join(tmpdir(), "why-why-")));
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof WhyError, String(e));
    return e.code;
  }
  assert.fail("expected WhyError");
}

test("save then load roundtrip", async () => {
  const s = await store();
  const a = startAnalysis({ id: "a1", title: "t", problem: "p" }, t0);
  await s.save(a, null);
  assert.deepEqual(await s.load("a1"), a);
});

test("save refuses stale write", async () => {
  const s = await store();
  const a = startAnalysis({ id: "a1", title: "t", problem: "p" }, t0);
  await s.save(a, null);
  const b = addWhys(a, "n0", [{ text: "x", viewpoint: "検知" }], t1).analysis;
  await s.save(b, a.updatedAt);
  const stale = addWhys(a, "n0", [{ text: "y", viewpoint: "検知" }], t1).analysis;
  assert.equal(await code(s.save(stale, a.updatedAt)), "conflict");
  assert.equal(await code(s.save(a, null)), "conflict");
});

test("rejects path traversal id", async () => {
  const s = await store();
  assert.equal(await code(s.load("../etc/passwd")), "invalid_input");
});

test("load of a missing analysis is not_found", async () => {
  const s = await store();
  assert.equal(await code(s.load("nope")), "not_found");
});

test("list sorts newest first", async () => {
  const s = await store();
  await s.save(startAnalysis({ id: "old", title: "古い", problem: "p" }, t0), null);
  await s.save(startAnalysis({ id: "new", title: "新しい", problem: "p" }, t1), null);
  assert.deepEqual((await s.list()).map((x) => x.id), ["new", "old"]);
});

test("list of an empty or missing dir is empty", async () => {
  const s = new FileStore(join(tmpdir(), `why-why-missing-${process.pid}-${Date.now()}`));
  assert.deepEqual(await s.list(), []);
});

test("writeArtifact returns absolute path", async () => {
  const s = await store();
  const p = await s.writeArtifact("a1", "mmd", "flowchart LR");
  assert.ok(isAbsolute(p) && p.endsWith("a1.mmd"));
  assert.equal(await readFile(p, "utf8"), "flowchart LR");
});

test("resolveDir uses WHY_WHY_DIR or cwd/.why-why", () => {
  assert.equal(resolveDir({}, "/proj"), "/proj/.why-why");
  assert.equal(resolveDir({ WHY_WHY_DIR: "/data/why" }, "/proj"), "/data/why");
  assert.equal(resolveDir({ WHY_WHY_DIR: "rel" }, "/proj"), "/proj/rel");
});

test("save bumps updatedAt so a same-millisecond change cannot hide a conflict", async () => {
  const s = await store();
  const a = startAnalysis({ id: "ms", title: "t", problem: "p" }, t0);
  await s.save(a, null);
  const sameMs = addWhys(a, "n0", [{ text: "x", viewpoint: "検知" }], t0).analysis;
  await s.save(sameMs, a.updatedAt);
  const loaded = await s.load("ms");
  assert.ok(loaded.updatedAt > a.updatedAt, loaded.updatedAt);
  const other = addWhys(a, "n0", [{ text: "y", viewpoint: "検知" }], t0).analysis;
  assert.equal(await code(s.save(other, a.updatedAt)), "conflict");
});
