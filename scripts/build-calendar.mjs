#!/usr/bin/env node
// Calendar data: per-year heatmap counts + per-day shards for the
// "this day in the London theatre" view.
//
// Inputs:  build/events-index.json (52,617 records)
// Outputs:
//   web/data/calendar/calendar-counts.json       — year x mmdd grid for heatmap
//   build/calendar/mmdd-summary.json          — totals per mmdd (picker nav)
//   web/data/calendar/by-mmdd/<MMDD>.json × 366  — events across years for a day
//   web/data/calendar/by-date/<YYYYMMDD>.json     — omitted; the client falls back to
//                                                    by-mmdd[MMDD] filtered by year
//
// Run: node scripts/build-calendar.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "build/events-index.json");
const OUT_DIR = resolve(ROOT, "web/data/calendar");
const SHARD_DIR = resolve(OUT_DIR, "by-mmdd");
// Build-only sink for debug artefacts that nothing in web/ consumes.
const BUILD_DIR = resolve(ROOT, "build/calendar");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHARD_DIR, { recursive: true });
mkdirSync(BUILD_DIR, { recursive: true });

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");

function pad2(n) { return n < 10 ? "0" + n : String(n); }

// years[year][mmdd] = event-nights (count of rows; each row is one (theatre, date))
// totals[mmdd]      = rows across all years
const years = new Map();
const totals = new Map();
const byMmdd = new Map();          // mmdd -> array of events (raw rows, enriched below)
let yearMin = Infinity, yearMax = -Infinity;
let maxCount = 0;

for (const ev of events) {
  const y = ev.y;
  const m = ev.m;
  const d = ev.d;
  if (!y || !m || !d) continue;                  // skip partial-date rows for the grid
  if (ev.p && ev.p !== "day") continue;           // only day-precision events appear on the heatmap

  const mmdd = pad2(m) + pad2(d);
  yearMin = Math.min(yearMin, y);
  yearMax = Math.max(yearMax, y);

  let ymap = years.get(y);
  if (!ymap) { ymap = new Map(); years.set(y, ymap); }
  const next = (ymap.get(mmdd) || 0) + 1;
  ymap.set(mmdd, next);
  if (next > maxCount) maxCount = next;

  totals.set(mmdd, (totals.get(mmdd) || 0) + 1);

  let bucket = byMmdd.get(mmdd);
  if (!bucket) { bucket = []; byMmdd.set(mmdd, bucket); }
  const row = {
    id: ev.id,
    date: ev.date,
    y: y,
    th: ev.th || null,
    t: ev.t || null,
    w: ev.w || null,
    n: ev.n || 0,
    s: ev.s || null,
    v: ev.v || null
  };
  if (ev.dt) row.dt = ev.dt;
  bucket.push(row);
}

// Emit heatmap grid. Sparse within years, so years missing a day simply
// lack that mmdd key. Client is responsible for zero-filling empty cells.
const yearsObj = {};
for (const [y, map] of years) {
  const obj = {};
  for (const [k, v] of map) obj[k] = v;
  yearsObj[y] = obj;
}
const totalsObj = {};
for (const [k, v] of totals) totalsObj[k] = v;

const countsDoc = {
  _meta: {
    description: "Per-year heatmap counts. years[yyyy][mmdd] = number of day-precision event rows on that date. totals[mmdd] = sum across years.",
    generated: new Date().toISOString().slice(0, 10),
    yearMin, yearMax,
    maxCount
  },
  yearMin, yearMax, maxCount,
  years: yearsObj,
  totals: totalsObj
};
writeFileSync(resolve(OUT_DIR, "calendar-counts.json"), JSON.stringify(countsDoc));

// Emit mmdd summary: totals plus sample metadata for picker. Nothing in web/
// consumes this; it lives only under build/.
const summary = {
  _meta: {
    description: "Totals per mmdd (MMDD) across 1659-1800. Used for the this-day-in-the-theatre picker.",
    generated: new Date().toISOString().slice(0, 10)
  },
  totals: totalsObj
};
writeFileSync(resolve(BUILD_DIR, "mmdd-summary.json"), JSON.stringify(summary));

// Emit one shard per mmdd. Sort events within by date asc, so the client
// can render years in order.
let shardCount = 0;
for (const [mmdd, rows] of byMmdd) {
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const shard = {
    mmdd,
    total: rows.length,
    years: rows.length ? { first: rows[0].y, last: rows[rows.length - 1].y } : null,
    events: rows
  };
  writeFileSync(resolve(SHARD_DIR, `${mmdd}.json`), JSON.stringify(shard));
  shardCount++;
}

console.log(`years ${yearMin}\u2013${yearMax}`);
console.log(`max daily count: ${maxCount}`);
console.log(`shards written: ${shardCount}`);
console.log("done.");
