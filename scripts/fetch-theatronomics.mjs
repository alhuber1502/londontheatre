#!/usr/bin/env node
// One-time fetch of the Theatronomics public API (University of Galway).
// Saves two cache files under data/theatronomics/ that downstream build
// scripts can join against without making any further network calls.
//
// Considerate defaults:
//   - 500 items per page  → 59 events pages + 7 works pages = 66 requests
//   - 1 000 ms pause between every request
//   - Idempotent: skips endpoints whose cache file already exists
//
// Run:   node scripts/fetch-theatronomics.mjs
// Force: node scripts/fetch-theatronomics.mjs --force

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const OUT_DIR   = resolve(ROOT, "data/theatronomics");
const FORCE     = process.argv.includes("--force");

const BASE_URL  = "https://data-theatronomics.universityofgalway.ie/api/data/v1";
const PER_PAGE  = 500;
const DELAY_MS  = 1000;

mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPage(path, page) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE_URL}${path}${sep}per_page=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "LondonStage-research-bot/1.0" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchAll(path, label, itemsKey) {
  const outFile = resolve(OUT_DIR, `${label}.json`);
  if (!FORCE && existsSync(outFile)) {
    console.log(`  ${label}: cache exists, skipping (--force to re-fetch)`);
    return;
  }

  process.stdout.write(`  ${label}: fetching page 1…`);
  const first = await fetchPage(path, 1);
  const pagination = first.pagination ?? {};
  const lastPage   = pagination.last_page ?? 1;
  const total      = pagination.total ?? "?";

  const items = [...(first.itemListElement ?? first[itemsKey] ?? first.data ?? [])];
  process.stdout.write(` ${total} records, ${lastPage} pages\n`);

  for (let page = 2; page <= lastPage; page++) {
    await sleep(DELAY_MS);
    process.stdout.write(`  ${label}: page ${page}/${lastPage}\r`);
    const body = await fetchPage(path, page);
    const batch = body.itemListElement ?? body[itemsKey] ?? body.data ?? [];
    items.push(...batch);
  }

  process.stdout.write(`  ${label}: done — ${items.length} records          \n`);
  writeFileSync(outFile, JSON.stringify(items, null, 2));
}

console.log("Theatronomics fetch — 1 s between requests, ~66 total");
console.log(`Output: ${OUT_DIR}`);
console.log();

await fetchAll("/events", "events", "itemListElement");
await fetchAll("/works",  "works",  "itemListElement");

console.log("\nDone.");
