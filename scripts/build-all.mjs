#!/usr/bin/env node
// Build orchestrator. Runs all pipeline scripts in dependency order,
// each as a child process with its own --max-old-space-size flag.
//
// Run: node scripts/build-all.mjs

import { spawn }              from "node:child_process";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath }      from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = pathResolve(__dirname, "..");

// Dependency order:
//   1. preprocess           → build/events-index.json
//   2. extract-comments     → web/data/comments-extracted.json
//   3-11. the rest (several depend on events-index or comments-extracted)
//   build-theatronomics must run before build-performer-details so that
//   performer shards can embed Theatronomics door-receipts for benefit nights.
//   12. analyze-theatre-coverage (audit, no outputs consumed downstream)
const SCRIPTS = [
  // Must run first: writes lib/performer-name-canon.json, consumed by
  // extractPerformers() in every downstream script that reads cast names.
  { name: "build-performer-canon",    mem: 2048 },
  { name: "preprocess",               mem: 2048 },
  { name: "extract-comments",         mem: 2048 },
  { name: "build-events-extras",      mem: 512  },
  { name: "build-roles",              mem: 3072 },
  { name: "build-works",              mem: 3072 },
  { name: "build-theatronomics",      mem: 512  },
  { name: "build-performer-details",  mem: 3072 },
  { name: "build-work-details",       mem: 3072 },
  { name: "build-venue-details",      mem: 2048 },
  { name: "build-role-details",       mem: 2048 },
  { name: "build-calendar",           mem: 2048 },
  { name: "build-receipts",           mem: 2048 },
  { name: "build-graphs",             mem: 4096 },
  // build-games consumes the rebuilt graph files + receipts/entries.json, so
  // it must run last among the data-producing scripts.
  { name: "build-games",              mem: 1024 },
  { name: "analyze-theatre-coverage", mem: 1024 },
];

function runScript(name, mem) {
  return new Promise((resolve, reject) => {
    const scriptPath = pathResolve(ROOT, "scripts", name + ".mjs");
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${mem}`, scriptPath],
      { cwd: ROOT, stdio: "inherit" }
    );
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with code ${code}`));
    });
    child.on("error", err => reject(new Error(`${name}: ${err.message}`)));
  });
}

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

async function main() {
  const total = SCRIPTS.length;
  const t0All = Date.now();

  for (let i = 0; i < total; i++) {
    const { name, mem } = SCRIPTS[i];
    const ts = timestamp();
    console.log(`\n[${ts}] [${i + 1}/${total}] ${name}  (--max-old-space-size=${mem})`);
    const t0 = Date.now();
    await runScript(name, mem);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${timestamp()}] ${name} done  (${dt}s)`);
  }

  const totalSec = ((Date.now() - t0All) / 1000).toFixed(0);
  console.log(`\nAll ${total} scripts complete in ${totalSec}s.\n`);
}

main().catch(err => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
