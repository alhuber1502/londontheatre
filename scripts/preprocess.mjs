#!/usr/bin/env node
// Preprocess LondonStageFull.json into derived artifacts for the client.
// Run: node --max-old-space-size=2048 scripts/preprocess.mjs
//
// Inputs:  data/LondonStageFull.json
// Outputs: build/stats.json, theatres.json, works.json, performers.json, events-index.json

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanPerformance } from "./lib/title-normalize.mjs";
import { extractPerformers, cleanRole, cleanTitle } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "data/LondonStageFull.json");
const OUT = resolve(ROOT, "build");
const WEB_DATA = resolve(ROOT, "web/data");

mkdirSync(OUT, { recursive: true });
mkdirSync(WEB_DATA, { recursive: true });

console.time("load");
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");
console.log(`events: ${raw.length}`);

// ---- Date parsing -----------------------------------------------------------
// EventDate is YYYYMMDD. ~378 entries have month or day = "00" (partial dates).
// We keep the raw string and add parsed components; downstream can decide
// whether to bucket partials by month/year or drop them.
function parseDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const precision = d > 0 ? "day" : m > 0 ? "month" : "year";
  // Only build ISO if fully known — partial dates get null iso.
  const iso = precision === "day"
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : null;
  return { y, m, d, precision, iso };
}

// ---- Aggregators ------------------------------------------------------------
const theatres = new Map();   // key: TheatreCode
const works = new Map();      // key: WorkId
const performers = new Map(); // key: cleaned Performer name
const eventsIndex = [];
const ptypeCounts = new Map();
const seasonCounts = new Map();
const decadeCounts = new Map();

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function trimOrNull(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

function ensure(map, key, factory) {
  let v = map.get(key);
  if (!v) { v = factory(); map.set(key, v); }
  return v;
}

for (const ev of raw) {
  const date = parseDate(ev.EventDate);
  const year = date?.y ?? null;
  const decade = year != null ? Math.floor(year / 10) * 10 : null;
  const theatreCode = ev.TheatreCode || "unknown";
  const theatreId = ev.TheatreId || null;

  if (ev.Season) bump(seasonCounts, ev.Season);
  if (decade != null) bump(decadeCounts, decade);

  // Theatre aggregate
  const th = ensure(theatres, theatreCode, () => ({
    code: theatreCode,
    ids: new Set(),
    eventCount: 0,
    firstDate: null,
    lastDate: null,
    byDecade: {},
    seasons: new Set(),
  }));
  if (theatreId) th.ids.add(theatreId);
  th.eventCount++;
  if (!th.firstDate || ev.EventDate < th.firstDate) th.firstDate = ev.EventDate;
  if (!th.lastDate || ev.EventDate > th.lastDate) th.lastDate = ev.EventDate;
  if (decade != null) th.byDecade[decade] = (th.byDecade[decade] ?? 0) + 1;
  if (ev.Season) th.seasons.add(ev.Season);

  // Index entry (compact event list for timeline/heatmap)
  const primaryPerf = (ev.Performances ?? []).find(p => p.PType === "p")
    ?? ev.Performances?.[0]
    ?? null;
  // Strip "At King's …" / "At Hay …" location prefixes from the title.
  // The resident TheatreCode (th) still records the company's home house;
  // `dt` (displacedTo) flags the night as having been performed elsewhere,
  // so UI can show an "at King's" badge and the title stays matchable.
  const { title: cleanTitleStr, displacedTo } = cleanPerformance(primaryPerf);
  const row = {
    id: ev.EventId,
    date: ev.EventDate,
    y: year,
    m: date?.m ?? null,
    d: date?.d ?? null,
    p: date?.precision ?? null,
    th: theatreCode,
    s: ev.Season ?? null,
    v: ev.Volume ?? null,
    t: cleanTitleStr,
    w: primaryPerf?.WorkId ?? null,
    n: ev.Performances?.length ?? 0,
  };
  if (displacedTo) row.dt = displacedTo;
  eventsIndex.push(row);

  for (const perf of ev.Performances ?? []) {
    const ptype = perf.PType || "?";
    bump(ptypeCounts, ptype);

    if (perf.WorkId) {
      const w = ensure(works, perf.WorkId, () => ({
        id: perf.WorkId,
        title: cleanTitle(perf.PerformanceTitle) || null,
        titles: new Set(),
        count: 0,
        ptypes: {},
        theatres: {},
        firstDate: null,
        lastDate: null,
        performers: new Set(),
        performerCount: 0, // filled at end
      }));
      const title = cleanTitle(perf.PerformanceTitle);
      if (title) w.titles.add(title);
      w.count++;
      w.ptypes[ptype] = (w.ptypes[ptype] ?? 0) + 1;
      w.theatres[theatreCode] = (w.theatres[theatreCode] ?? 0) + 1;
      if (!w.firstDate || ev.EventDate < w.firstDate) w.firstDate = ev.EventDate;
      if (!w.lastDate || ev.EventDate > w.lastDate) w.lastDate = ev.EventDate;
    }

    for (const c of perf.cast ?? []) {
      const role = cleanRole(c.Role);
      for (const name of extractPerformers(c.Performer)) {
        const p = ensure(performers, name, () => ({
          name,
          count: 0,
          roleSet: new Set(),
          workSet: new Set(),
          theatreSet: new Set(),
          firstDate: null,
          lastDate: null,
        }));
        p.count++;
        if (role) p.roleSet.add(role);
        if (perf.WorkId) {
          p.workSet.add(perf.WorkId);
          works.get(perf.WorkId)?.performers.add(name);
        }
        p.theatreSet.add(theatreCode);
        if (!p.firstDate || ev.EventDate < p.firstDate) p.firstDate = ev.EventDate;
        if (!p.lastDate || ev.EventDate > p.lastDate) p.lastDate = ev.EventDate;
      }
    }
  }
}

// ---- Related-performances index --------------------------------------------
// For each (WorkId, TheatreCode, Season) triple, collect every performance
// ordered by date, tagged with whether it has a listed cast. This lets the
// UI show, for any empty-cast performance, sibling performances that DO list
// a cast — without us silently inventing data. The LSD editors explicitly
// chose not to backfill where "as [date]" syntax is absent
// (https://londonstagedatabase.uoregon.edu/cast-list.php); we respect that.
//
// Only populated for PType in {p, a} with a WorkId — other types (dances,
// songs, music, entertainments) have no named cast by design.
const RECONSTRUCTIBLE_PTYPES = new Set(["p", "a"]);
const relatedGroups = new Map(); // key: `${WorkId}|${TheatreCode}|${Season}`

for (const ev of raw) {
  for (const perf of ev.Performances ?? []) {
    if (!RECONSTRUCTIBLE_PTYPES.has(perf.PType)) continue;
    if (!perf.WorkId) continue;
    const key = `${perf.WorkId}|${ev.TheatreCode || "unknown"}|${ev.Season || ""}`;
    const bucket = ensure(relatedGroups, key, () => []);
    bucket.push({
      eventId: ev.EventId,
      performanceId: perf.PerformanceId,
      date: ev.EventDate,
      hasCast: (perf.cast?.length ?? 0) > 0,
      ptype: perf.PType,
    });
  }
}

// Sort each bucket chronologically; flatten into a per-performance lookup
// that only records siblings when the current perf has an empty cast.
const relatedByPerfId = {};
let reconstructibleCount = 0;
let reconstructibleWithSiblings = 0;
for (const bucket of relatedGroups.values()) {
  bucket.sort((a, b) => a.date.localeCompare(b.date));
  const siblingsWithCast = bucket.filter(p => p.hasCast);
  for (const p of bucket) {
    if (p.hasCast) continue;
    reconstructibleCount++;
    if (siblingsWithCast.length === 0) continue;
    reconstructibleWithSiblings++;
    // Keep the three nearest prior + three nearest following casted siblings.
    const prior = siblingsWithCast.filter(s => s.date < p.date).slice(-3);
    const after = siblingsWithCast.filter(s => s.date > p.date).slice(0, 3);
    relatedByPerfId[p.performanceId] = {
      prior: prior.map(s => ({ e: s.eventId, d: s.date })),
      after: after.map(s => ({ e: s.eventId, d: s.date })),
      totalWithCast: siblingsWithCast.length,
    };
  }
}

const relatedStats = {
  reconstructiblePerformances: reconstructibleCount,
  withAtLeastOneSiblingCast: reconstructibleWithSiblings,
  coveragePct: reconstructibleCount === 0 ? 0
    : Math.round((reconstructibleWithSiblings / reconstructibleCount) * 1000) / 10,
};
console.log(`related-performances: ${reconstructibleWithSiblings} / ${reconstructibleCount} empty-cast (p|a) performances have at least one sibling with a listed cast (${relatedStats.coveragePct}%)`);

// ---- Materialize ------------------------------------------------------------
const theatresOut = [...theatres.values()]
  .map(t => ({
    code: t.code,
    ids: [...t.ids],
    eventCount: t.eventCount,
    firstDate: t.firstDate,
    lastDate: t.lastDate,
    byDecade: t.byDecade,
    seasonCount: t.seasons.size,
  }))
  .sort((a, b) => b.eventCount - a.eventCount);

const worksOut = [...works.values()]
  .map(w => ({
    id: w.id,
    title: w.title,
    altTitles: [...w.titles].filter(t => t !== w.title),
    count: w.count,
    ptypes: w.ptypes,
    theatres: w.theatres,
    firstDate: w.firstDate,
    lastDate: w.lastDate,
    performerCount: w.performers.size,
  }))
  .sort((a, b) => b.count - a.count);

const performersOut = [...performers.values()]
  .map(p => ({
    name: p.name,
    count: p.count,
    roleCount: p.roleSet.size,
    workCount: p.workSet.size,
    theatres: [...p.theatreSet],
    firstDate: p.firstDate,
    lastDate: p.lastDate,
  }))
  .sort((a, b) => b.count - a.count);

const stats = {
  generatedAt: new Date().toISOString(),
  events: raw.length,
  performances: [...ptypeCounts.values()].reduce((a, b) => a + b, 0),
  theatres: theatresOut.length,
  works: worksOut.length,
  performers: performersOut.length,
  ptypeCounts: Object.fromEntries(ptypeCounts),
  decadeCounts: Object.fromEntries([...decadeCounts.entries()].sort()),
  seasonCount: seasonCounts.size,
  dateRange: {
    min: raw.reduce((m, e) => e.EventDate < m ? e.EventDate : m, "99999999"),
    max: raw.reduce((m, e) => e.EventDate > m ? e.EventDate : m, "00000000"),
  },
  relatedPerformances: relatedStats,
};

// ---- Write ------------------------------------------------------------------
function writeJSON(name, data, { pretty = false } = {}) {
  const path = resolve(OUT, name);
  writeFileSync(path, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  const kb = (readFileSync(path).byteLength / 1024).toFixed(1);
  console.log(`  ${name.padEnd(22)} ${kb.padStart(10)} KB`);
}

console.log("outputs:");
writeJSON("stats.json", stats, { pretty: true });
writeJSON("theatres.json", theatresOut);
writeJSON("works.json", worksOut);
writeJSON("performers.json", performersOut);
writeJSON("events-index.json", eventsIndex);
writeJSON("related-performances.json", relatedByPerfId);

// Mirror the files the static site actually loads into web/data/, so the
// deployed web/ tree is self-contained. Keep the list narrow — big artifacts
// like events-index.json and performers.json stay out until a page needs them.
const WEB_FILES = [
  { from: resolve(OUT, "stats.json"),                    to: "stats.json" },
  { from: resolve(OUT, "theatres.json"),                 to: "theatres.json" },
  { from: resolve(ROOT, "data/theatre-abbreviations.json"), to: "theatre-abbreviations.json" },
  { from: resolve(ROOT, "data/theatre-locations.json"),     to: "theatre-locations.json" }
];
console.log("web/data mirror:");
for (const f of WEB_FILES) {
  copyFileSync(f.from, resolve(WEB_DATA, f.to));
  console.log(`  ${f.to}`);
}

console.log("done.");

// ---- TODO (next pass) -------------------------------------------------------
// - Theatre lookup (Layer F): join TheatreCode / TheatreId to canonical names
//   (from the knowledge doc's 247-name list + any TheatreId dictionary we can
//   scrape from the uoregon DB). Add lat/lng once the geocoding research is
//   done.
// - Comment-mining pass (Layer C): single regex sweep over CommentC/CommentP
//   producing events-financial.json with receipts (£/s/d), prices (boxes/pit/
//   galleries), doors-open time, start time, and flags for "1st appearance",
//   "last time", "not acted these N years", "by command", "benefit".
// - Network edge lists (Layer D): emit per-decade slices for
//     theatre<->work, work<->performer, performer<->performer (co-appearance).
//   Apply degree/count thresholds so sigma.js stays responsive.
// - Event-index sharding: 7.2 MB raw is too big for naive client load;
//   shard by decade or switch to a columnar encoding (parallel arrays).
