#!/usr/bin/env node
// Layer C — Box-office receipts aggregator. Walks LondonStageFull.json,
// joins each event to the regex-extracted receipts in
// web/data/comments-extracted.json, and writes:
//
//   web/data/receipts/index.json   — summary + per-venue × per-season
//                                    counts/sum/median (drives charts)
//   web/data/receipts/entries.json — flat list of every receipted night
//                                    (drives the receipts.html table
//                                    + filters)
//
// Run: node --max-old-space-size=2048 scripts/build-receipts.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanPerformance } from "./lib/title-normalize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT_EVENTS = resolve(ROOT, "data/LondonStageFull.json");
const INPUT_EXTRACT = resolve(ROOT, "web/data/comments-extracted.json");
const INPUT_ABBREV = resolve(ROOT, "data/theatre-abbreviations.json");
const OUT_DIR = resolve(ROOT, "build/receipts");
const WEB_DIR = resolve(ROOT, "web/data/receipts");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WEB_DIR, { recursive: true });

console.time("load");
const events = JSON.parse(readFileSync(INPUT_EVENTS, "utf8"));
const extract = JSON.parse(readFileSync(INPUT_EXTRACT, "utf8"));
const abbrev = JSON.parse(readFileSync(INPUT_ABBREV, "utf8"));
console.timeEnd("load");

// Merge entries + compound + sentinels so hybrid codes ("dlking's") and
// non-venue placeholders ("none") resolve to readable names in the
// shipped index.
const abbrevLookup = Object.assign(
  {},
  abbrev.sentinels || {},
  abbrev.compound  || {},
  abbrev.entries   || {}
);
function venueName(code) {
  if (!code) return "Unknown";
  const e = abbrevLookup[code];
  if (e && e.canonical) return e.canonical;
  return code.toUpperCase();
}

function yearOf(d) { return d && d.length >= 4 ? +d.slice(0, 4) : null; }
function seasonKey(ev) { return ev.Season || null; }
function prettyDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || "";
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return `${y}-${m}-${d}`;
}

function median(sorted) {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length & 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]));
}

// Pick a headline work for the night: first mainpiece (PType=p), else first
// performance with a title. Uses the shared title-normalize helper so the
// displaced "At King's …" prefix is stripped and the host venue code is
// carried separately on `displacedTo`.
function headlineWork(ev) {
  const perfs = ev.Performances || [];
  let main = null;
  for (const p of perfs) {
    if ((p.PType || "").toLowerCase() === "p") {
      main = p;
      break;
    }
  }
  if (!main) main = perfs.find(p => p.PerformanceTitle);
  if (!main) return null;
  const { title, displacedTo } = cleanPerformance(main);
  return {
    workId: main.WorkId || null,
    title: title || "",
    displacedTo: displacedTo || null
  };
}

// ---- Pass 1: collect raw entries ------------------------------------------
console.time("pass1");

/** @type {Array<{eventId:string,date:string,year:number,season:string,venue:string,pence:number,benefit:boolean,halfPrice:boolean,multi:boolean,work:{workId:string|null,title:string}|null}>} */
const entries = [];

for (const ev of events) {
  const rowX = extract.events?.[ev.EventId];
  if (!rowX || !rowX.receipts) continue;
  const pence = rowX.receipts.total?.totalPence ?? 0;
  if (!pence) continue; // skip zero/invalid receipts
  const venue = (ev.TheatreCode || "").toLowerCase() || "unknown";
  const season = seasonKey(ev) || "";
  const year = yearOf(ev.EventDate);
  entries.push({
    eventId: String(ev.EventId),
    date: ev.EventDate || "",
    year,
    season,
    venue,
    pence,
    benefit: !!rowX.benefit?.flagged,
    halfPrice: !!rowX.halfPrice,
    multi: (rowX.receipts.components || []).length > 1,
    work: headlineWork(ev)
  });
}
console.timeEnd("pass1");
console.log(`entries: ${entries.length.toLocaleString()}`);

// ---- Pass 2: aggregate -----------------------------------------------------
console.time("aggregate");

const venueMap = new Map();       // code -> { ... totals, seasons: Map<season, pence[]> }
const seasonSet = new Set();

function getOrMakeVenue(code) {
  let v = venueMap.get(code);
  if (!v) {
    v = {
      code,
      name: venueName(code),
      count: 0,
      sumPence: 0,
      allPence: [],
      minPence: Infinity,
      maxPence: 0,
      maxEventId: null,
      firstYear: null,
      lastYear: null,
      benefits: 0,
      seasons: new Map()
    };
    venueMap.set(code, v);
  }
  return v;
}

// global season aggregation (across all venues, for the overview chart)
const globalSeasons = new Map(); // season -> { count, sumPence, allPence[] }
function getOrMakeSeason(season) {
  let s = globalSeasons.get(season);
  if (!s) {
    s = { count: 0, sumPence: 0, allPence: [] };
    globalSeasons.set(season, s);
  }
  return s;
}

for (const e of entries) {
  const v = getOrMakeVenue(e.venue);
  v.count++;
  v.sumPence += e.pence;
  v.allPence.push(e.pence);
  if (e.pence < v.minPence) v.minPence = e.pence;
  if (e.pence > v.maxPence) { v.maxPence = e.pence; v.maxEventId = e.eventId; }
  if (e.year != null) {
    if (v.firstYear == null || e.year < v.firstYear) v.firstYear = e.year;
    if (v.lastYear  == null || e.year > v.lastYear)  v.lastYear  = e.year;
  }
  if (e.benefit) v.benefits++;

  if (e.season) {
    seasonSet.add(e.season);
    let s = v.seasons.get(e.season);
    if (!s) { s = { count: 0, sumPence: 0, allPence: [] }; v.seasons.set(e.season, s); }
    s.count++;
    s.sumPence += e.pence;
    s.allPence.push(e.pence);

    const g = getOrMakeSeason(e.season);
    g.count++;
    g.sumPence += e.pence;
    g.allPence.push(e.pence);
  }
}

// finalise venues
const venues = [];
for (const v of venueMap.values()) {
  v.allPence.sort((a, b) => a - b);
  const medianPence = median(v.allPence);
  const bySeason = {};
  for (const [season, s] of v.seasons) {
    s.allPence.sort((a, b) => a - b);
    bySeason[season] = {
      count: s.count,
      sumPence: s.sumPence,
      medianPence: median(s.allPence),
      p25Pence: percentile(s.allPence, 25),
      p75Pence: percentile(s.allPence, 75)
    };
  }
  venues.push({
    code: v.code,
    name: v.name,
    count: v.count,
    sumPence: v.sumPence,
    medianPence,
    minPence: v.minPence === Infinity ? 0 : v.minPence,
    maxPence: v.maxPence,
    maxEventId: v.maxEventId,
    firstYear: v.firstYear,
    lastYear: v.lastYear,
    benefits: v.benefits,
    bySeason
  });
}
venues.sort((a, b) => b.count - a.count);

// finalise global seasons
const seasonsOut = {};
for (const [season, s] of globalSeasons) {
  s.allPence.sort((a, b) => a - b);
  seasonsOut[season] = {
    count: s.count,
    sumPence: s.sumPence,
    medianPence: median(s.allPence)
  };
}

const allSortedPence = entries.map(e => e.pence).sort((a, b) => a - b);

// top 25 single-night earners + bottom 10 (lowest receipts, excl. zeros)
const entriesByPenceDesc = [...entries].sort((a, b) => b.pence - a.pence);
const topEarners = entriesByPenceDesc.slice(0, 25);
const lowEarners = entriesByPenceDesc.slice(-10).reverse();

// top 25 by Theatronomics door receipts (CG/DL, 1732-1809)
let txTopEarners = [];
try {
  const txByDate = JSON.parse(readFileSync(resolve(WEB_DIR, "theatronomics-by-date.json"), "utf8"));
  const lsByVenueDate = new Map();
  for (const e of entries) lsByVenueDate.set(e.venue + ":" + e.date, e);
  const evByVenueDate = new Map();
  for (const ev of events) {
    const vcode = (ev.TheatreCode || "").toLowerCase();
    if (vcode && ev.EventDate) evByVenueDate.set(vcode + ":" + ev.EventDate, ev);
  }
  txTopEarners = Object.entries(txByDate)
    .map(([k, v]) => {
      const sep = k.indexOf(":");
      return { date: k.slice(sep + 1), venue: k.slice(0, sep), drPence: v.dr || 0 };
    })
    .filter(e => e.drPence > 0 && e.date < '18010101')
    .sort((a, b) => b.drPence - a.drPence)
    .slice(0, 25)
    .map(({ date, venue, drPence }) => {
      const txKey   = venue + ":" + date;
      const lsEntry = lsByVenueDate.get(txKey);
      const work    = lsEntry ? lsEntry.work
                              : (evByVenueDate.has(txKey) ? headlineWork(evByVenueDate.get(txKey)) : null);
      return {
        date,
        venue,
        pence:   drPence,
        lsPence: lsEntry ? lsEntry.pence : null,
        benefit: lsEntry ? lsEntry.benefit : false,
        work
      };
    });
  console.log(`txTopEarners:              ${txTopEarners.length}`);
} catch (_) {
  console.warn("theatronomics-by-date.json not found — txTopEarners skipped");
}

console.timeEnd("aggregate");

// ---- Write -----------------------------------------------------------------
const indexDoc = {
  _meta: {
    description:
      "Box-office receipts aggregate. Source: regex extraction over CommentC " +
      "in web/data/comments-extracted.json. 'pence' fields are total pence " +
      "(12d. = 1 shilling; 20s. = £1). Median is the night-level median, " +
      "which is a better centre than mean for skewed benefit-inflated seasons.",
    generated: new Date().toISOString().slice(0, 10),
    totalEntries: entries.length,
    venues: venues.length,
    seasons: seasonSet.size,
    earliestYear: Math.min(...entries.map(e => e.year).filter(y => y != null)),
    latestYear: Math.max(...entries.map(e => e.year).filter(y => y != null)),
    grandSumPence: entries.reduce((s, e) => s + e.pence, 0),
    grandMedianPence: median(allSortedPence)
  },
  venues,
  seasons: seasonsOut,
  topEarners: topEarners.map(e => ({
    eventId: e.eventId,
    date: e.date,
    venue: e.venue,
    pence: e.pence,
    benefit: e.benefit,
    work: e.work
  })),
  txTopEarners: txTopEarners,
  lowEarners: lowEarners.map(e => ({
    eventId: e.eventId,
    date: e.date,
    venue: e.venue,
    pence: e.pence,
    benefit: e.benefit,
    work: e.work
  }))
};

// Lean entries file: one object per receipted night. Keep keys short to
// trim transfer size; the client re-expands via known aliases.
const entriesDoc = {
  _meta: {
    description:
      "Lean per-event receipts rows. Field aliases: i=eventId, d=date, " +
      "s=season, v=venue, p=totalPence, f=flagBits (1=benefit, 2=halfPrice, " +
      "4=multiComponent), t=headline work title, w=headline workId.",
    generated: new Date().toISOString().slice(0, 10),
    count: entries.length
  },
  rows: entries.map(e => ({
    i: e.eventId,
    d: e.date,
    s: e.season,
    v: e.venue,
    p: e.pence,
    f: (e.benefit ? 1 : 0) | (e.halfPrice ? 2 : 0) | (e.multi ? 4 : 0),
    t: e.work?.title || "",
    w: e.work?.workId || ""
  }))
};

writeFileSync(resolve(OUT_DIR, "index.json"), JSON.stringify(indexDoc));
writeFileSync(resolve(OUT_DIR, "entries.json"), JSON.stringify(entriesDoc));
writeFileSync(resolve(WEB_DIR, "index.json"), JSON.stringify(indexDoc));
writeFileSync(resolve(WEB_DIR, "entries.json"), JSON.stringify(entriesDoc));

const indexSize = readFileSync(resolve(WEB_DIR, "index.json")).byteLength;
const entrySize = readFileSync(resolve(WEB_DIR, "entries.json")).byteLength;
console.log("");
console.log(`venues reporting receipts: ${venues.length}`);
console.log(`seasons covered:           ${seasonSet.size}`);
console.log(`grand sum:                 £${Math.round(indexDoc._meta.grandSumPence / 240).toLocaleString()}`);
console.log(`median per night:          ${(indexDoc._meta.grandMedianPence / 240).toFixed(2)} £`);
console.log("");
console.log(`index.json   ${(indexSize / 1024).toFixed(1)} KB`);
console.log(`entries.json ${(entrySize / 1024).toFixed(1)} KB`);
console.log("done.");

function prettyPound(pence) {
  const p = Math.floor(pence / 240);
  const rest = pence - p * 240;
  const s = Math.floor(rest / 12);
  const d = rest - s * 12;
  return `£${p}.${String(s).padStart(2, "0")}.${String(d).padStart(2, "0")}`;
}
// silence lint — helpers below are used by downstream scripts only
void prettyDate; void prettyPound;
