#!/usr/bin/env node
// Layer G — Works aggregate. One row per WorkId with performance count, date
// span, primary type (mainpiece vs afterpiece), theatre and performer breadth,
// and the two most-frequent venue / performer associations. Feeds the
// Repertoire landing page and any work-detail view.
//
// Run: node --max-old-space-size=3072 scripts/build-works.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinTxToLsdb, slimTx } from "./lib/theatronomics-works.mjs";
import { extractPerformers, cleanTitle, pickCanonicalTitle } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "data/LondonStageFull.json");
const OUT_DIR = resolve(ROOT, "build");
const WEB_DIR = resolve(ROOT, "web/data");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WEB_DIR, { recursive: true });

// txMap is built after the canonical-title pass below.
let txMap = new Map();

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");

// PType → human label (mirrors the catalogue's convention)
const PTYPE_LABEL = {
  p: "mainpiece", a: "afterpiece", d: "dance", s: "song",
  m: "music", e: "entertainment", i: "interlude", o: "other"
};

// works[workId] = {
//   titles: Map(title -> count),  -> pick most common as canonical
//   ptypes: Map(ptype -> count),
//   count: 0,
//   firstDate, lastDate,
//   theatres: Map(code -> count),
//   performers: Map(name -> count)
// }
const works = new Map();

for (const ev of events) {
  const date = ev.EventDate;
  const theatre = (ev.TheatreCode || "").toLowerCase();
  const perfs = ev.Performances || [];
  for (const p of perfs) {
    const id = p.WorkId;
    if (!id) continue;

    let w = works.get(id);
    if (!w) {
      w = {
        titles: new Map(), ptypes: new Map(),
        count: 0, firstDate: null, lastDate: null,
        theatres: new Map(), performers: new Map(),
        byDecade: new Map(),  // decade -> performance count
        byDecadeTheatres: new Map()  // decade -> Set<theatreCode>
      };
      works.set(id, w);
    }

    const title = cleanTitle(p.PerformanceTitle);
    if (title) w.titles.set(title, (w.titles.get(title) || 0) + 1);

    const pt = p.PType || "o";
    w.ptypes.set(pt, (w.ptypes.get(pt) || 0) + 1);

    w.count++;
    let dec = null;
    if (date) {
      if (!w.firstDate || date < w.firstDate) w.firstDate = date;
      if (!w.lastDate  || date > w.lastDate)  w.lastDate  = date;
      const y = +date.slice(0, 4);
      if (y) {
        dec = Math.floor(y / 10) * 10;
        w.byDecade.set(dec, (w.byDecade.get(dec) || 0) + 1);
      }
    }
    if (theatre) {
      w.theatres.set(theatre, (w.theatres.get(theatre) || 0) + 1);
      if (dec != null) {
        let s = w.byDecadeTheatres.get(dec);
        if (!s) { s = new Set(); w.byDecadeTheatres.set(dec, s); }
        s.add(theatre);
      }
    }

    const cast = p.cast || [];
    for (const c of cast) {
      for (const name of extractPerformers(c.Performer)) {
        w.performers.set(name, (w.performers.get(name) || 0) + 1);
      }
    }
  }
}

// ---- Flatten ---------------------------------------------------------------
function topKey(m) {
  let best = null, bestN = -1;
  for (const [k, n] of m) if (n > bestN) { best = k; bestN = n; }
  return best == null ? null : { key: best, count: bestN };
}

function year(d) {
  if (!d) return null;
  const s = String(d);
  return s.length >= 4 ? +s.slice(0, 4) : null;
}

// Join Theatronomics attribution using canonical title + total perf count per work.
txMap = joinTxToLsdb(
  [...works.entries()].map(([id, w]) => [id, pickCanonicalTitle(w.titles) || "", w.count])
);

const rows = [];
for (const [workId, w] of works) {
  const title = pickCanonicalTitle(w.titles);
  const ptype = topKey(w.ptypes);
  const topTheatre   = topKey(w.theatres);
  const topPerformer = topKey(w.performers);

  // Decade buckets as plain objects keyed by decade.
  const byDecade = {};
  for (const [dec, n] of w.byDecade) byDecade[dec] = n;
  const byDecadeTheatres = {};
  for (const [dec, set] of w.byDecadeTheatres) {
    byDecadeTheatres[dec] = [...set].sort();
  }

  const slim = slimTx(txMap.get(String(workId)));

  rows.push({
    workId,
    title: title || "(untitled)",
    ptype: ptype ? ptype.key : null,
    ptypeLabel: ptype ? (PTYPE_LABEL[ptype.key] || ptype.key) : null,
    count: w.count,
    firstYear: year(w.firstDate),
    lastYear:  year(w.lastDate),
    theatreCount:   w.theatres.size,
    performerCount: w.performers.size,
    topTheatre:   topTheatre   ? { code: topTheatre.key, count: topTheatre.count } : null,
    topPerformer: topPerformer ? { name: topPerformer.key, count: topPerformer.count } : null,
    byDecade,
    byDecadeTheatres,
    ...(slim.genre   ? { genre:   slim.genre }   : {}),
    ...(slim.authors ? { authors: slim.authors } : {}),
    ...(slim.hasWomanAuthor ? { hasWomanAuthor: true } : {})
  });
}
rows.sort((a, b) => b.count - a.count);

const doc = {
  _meta: {
    description: "One row per WorkId — performance count, date span, primary ptype, theatre and performer breadth plus top associations. Sorted by performance count descending.",
    generated: new Date().toISOString().slice(0, 10),
    totalWorks: rows.length,
    totalPerformancesWithWorkId: rows.reduce((s, r) => s + r.count, 0)
  },
  works: rows
};

writeFileSync(resolve(OUT_DIR, "works.json"), JSON.stringify(doc));
writeFileSync(resolve(WEB_DIR, "works.json"), JSON.stringify(doc));

// ---- Report ----------------------------------------------------------------
console.log(`works:        ${rows.length.toLocaleString()}`);
console.log(`performances: ${doc._meta.totalPerformancesWithWorkId.toLocaleString()}`);
console.log("");
console.log("top 10 by performance count:");
for (const r of rows.slice(0, 10)) {
  const span = r.firstYear && r.lastYear ? `${r.firstYear}\u2013${r.lastYear}` : "?";
  console.log(`  ${String(r.count).padStart(5)}  ${r.ptypeLabel.padEnd(13)}  ${span}  ${r.title}`);
}
console.log("done.");
