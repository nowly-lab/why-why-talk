// Bundles the browser page into dist/web. Runs on build and on `prepare` (npx github: installs).
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/web", { recursive: true });
await build({
  entryPoints: ["web/main.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/web/main.js",
  minify: true,
  sourcemap: false,
  logLevel: "warning",
});
await copyFile("web/index.html", "dist/web/index.html");
await copyFile("web/audio-worklet.js", "dist/web/audio-worklet.js");
