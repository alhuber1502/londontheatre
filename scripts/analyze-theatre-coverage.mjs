#!/usr/bin/env node
// Report: how well does the Vol 1 abbreviations key cover the 239 observed
// TheatreCodes, by event count? Helps decide whether fetching Vols 2-5
// front matter is worth the effort.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abbrs = JSON.parse(readFileSync(resolve(ROOT, "data/theatre-abbreviations.json"), "utf8"));
const theatres = JSON.parse(readFileSync(resolve(ROOT, "build/theatres.json"), "utf8"));

const entries = abbrs.entries;
const compound = abbrs.compound || {};
const sentinels = abbrs.sentinels || {};
const totalEvents = theatres.reduce((s, t) => s + t.eventCount, 0);

let matched = 0, matchedCompound = 0, matchedSentinel = 0, unmatched = 0;
const matchedRows = [], matchedCompoundRows = [], matchedSentinelRows = [], unmatchedRows = [];
for (const t of theatres) {
  const key = t.code.toLowerCase();
  if (entries[key]) {
    matched += t.eventCount;
    matchedRows.push({ code: t.code, n: t.eventCount });
  } else if (compound[key]) {
    matchedCompound += t.eventCount;
    matchedCompoundRows.push({ code: t.code, n: t.eventCount });
  } else if (sentinels[t.code] || sentinels[key]) {
    matchedSentinel += t.eventCount;
    matchedSentinelRows.push({ code: t.code, n: t.eventCount });
  } else {
    unmatched += t.eventCount;
    unmatchedRows.push({ code: t.code, n: t.eventCount });
  }
}

console.log(`total theatre codes: ${theatres.length}`);
console.log(`matched by entries:   ${matchedRows.length} codes / ${matched.toLocaleString()} events (${(matched / totalEvents * 100).toFixed(1)}%)`);
console.log(`matched by compound:  ${matchedCompoundRows.length} codes / ${matchedCompound.toLocaleString()} events (${(matchedCompound / totalEvents * 100).toFixed(1)}%)`);
console.log(`sentinels (non-venue):${matchedSentinelRows.length} codes / ${matchedSentinel.toLocaleString()} events (${(matchedSentinel / totalEvents * 100).toFixed(1)}%)`);
console.log(`unmatched:            ${unmatchedRows.length} codes / ${unmatched.toLocaleString()} events (${(unmatched / totalEvents * 100).toFixed(1)}%)`);
console.log();
console.log("top 25 UNMATCHED codes (by event count):");
unmatchedRows.slice(0, 25).forEach((r, i) => {
  console.log(`  ${String(i + 1).padStart(3)}. ${r.code.padEnd(14)} ${r.n.toLocaleString().padStart(8)}`);
});
console.log();
console.log(`unmatched codes with fewer than 10 events: ${unmatchedRows.filter(r => r.n < 10).length}`);
console.log(`unmatched codes with single-event occurrence: ${unmatchedRows.filter(r => r.n === 1).length}`);
