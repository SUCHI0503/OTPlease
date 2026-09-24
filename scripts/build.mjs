#!/usr/bin/env node
// Bundles the API server and the worker into plain JavaScript (apps/*/dist/index.js), so they run with
// `node` and no TypeScript step. node_modules stay external; the worker's imports from the server source
// are bundled into the worker's file.  Usage: npm run build:backend
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const app of ["server", "worker"]) {
  const started = Date.now();
  await build({
    entryPoints: [path.join(root, `apps/${app}/src/index.ts`)],
    outfile: path.join(root, `apps/${app}/dist/index.js`),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    packages: "external",
    sourcemap: true,
    logLevel: "warning",
  });
  console.log(`built apps/${app}/dist/index.js in ${Date.now() - started} ms`);
}
