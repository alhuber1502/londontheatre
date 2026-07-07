#!/usr/bin/env node
// Build the performer-name case-canonicalization map.
//
// LSDB transcriptions carry the same performer under spellings that differ
// only by letter-case ("Dupre"/"DuPre", "O'Brien"/"O'brien", "Mrs LeBrun"/
// "Mrs Lebrun"). Because the client ships one JSON shard per performer name
// (build-performer-details.mjs), case-only variants collide on a
// case-insensitive filesystem — one shard silently overwrites the other, and
// the same person is double-counted in every aggregate. This pass folds each
// case-variant onto a single canonical spelling so all downstream scripts
// agree.
//
// Canonical spelling = the most frequent casing in the corpus (ties broken
// lexicographically), i.e. the dominant historical form. The map is consumed
// by extractPerformers() in lib/lsdb-text.mjs, which applies it to every name
// it emits — so this script MUST run first in the build (before any consumer).
//
// It reads names through extractPerformersRaw() (the pre-canon extractor) so
// that re-running it regenerates the map from scratch rather than from
// already-folded names.
//
// Run: node --max-old-space-size=2048 scripts/build-performer-canon.mjs
// Output: scripts/lib/performer-name-canon.json  { variantName: canonicalName }

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPerformersRaw } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT  = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "data/LondonStageFull.json");
const OUT   = resolve(__dirname, "lib/performer-name-canon.json");

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");

// Count every raw (pre-canon) performer name by exact casing.
const counts = new Map();
for (const ev of events)
  for (const p of ev.Performances ?? [])
    for (const c of p.cast ?? [])
      for (const name of extractPerformersRaw(c.Performer))
        counts.set(name, (counts.get(name) ?? 0) + 1);

// Group by case-folded key; any group with >1 distinct casing is a collision.
const byLc = new Map();
for (const [name, n] of counts) {
  const k = name.toLowerCase();
  if (!byLc.has(k)) byLc.set(k, []);
  byLc.get(k).push([name, n]);
}

const map = {};
let groups = 0;
for (const variants of byLc.values()) {
  if (variants.length < 2) continue;
  groups++;
  // Most frequent casing wins; tie → lexicographically smallest (stable).
  variants.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const canonical = variants[0][0];
  for (const [name] of variants) if (name !== canonical) map[name] = canonical;
}

// Sort keys for a stable, reviewable diff.
const sorted = {};
for (const k of Object.keys(map).sort()) sorted[k] = map[k];

writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
console.log(`distinct raw names: ${counts.size.toLocaleString()}`);
console.log(`case-collision groups: ${groups}`);
console.log(`variants folded: ${Object.keys(sorted).length}`);
console.log(`wrote ${OUT.replace(ROOT + "/", "")}`);
