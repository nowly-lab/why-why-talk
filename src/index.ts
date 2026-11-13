#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clefConfigFromEnv } from "./clef.ts";
import { createWhyWhyServer } from "./server.ts";
import { FileStore, resolveDir } from "./store.ts";

async function main(): Promise<void> {
  const env = process.env;
  const threshold = env.WHY_WHY_THRESHOLD ? Number(env.WHY_WHY_THRESHOLD) : undefined;
  if (threshold !== undefined && !(threshold >= 0 && threshold <= 1)) {
    throw new Error(`WHY_WHY_THRESHOLD must be between 0 and 1, got ${env.WHY_WHY_THRESHOLD}`);
  }
  const server = createWhyWhyServer({
    store: new FileStore(resolveDir(env, process.cwd())),
    clef: clefConfigFromEnv(env),
    threshold,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  console.error(`why-why-mcp: ${(e as Error).message}`);
  process.exit(1);
});
