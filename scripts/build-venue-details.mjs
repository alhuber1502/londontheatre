#!/usr/bin/env node
// Per-venue detail aggregate. One record per TheatreCode with enough
// context to render a venue-detail page: decade timeline, ptype mix,
// top works, top performers and top roles.
//
// Run: node --max-old-space-size=3072 scripts/build-venue-details.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinTxToLsdb } from "./lib/theatronomics-works.mjs";
import { extractPerformers, cleanRole, cleanTitle, pickCanonicalTitle } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "data/LondonStageFull.json");
const OUT_DIR = resolve(ROOT, "build/theatres");
const WEB_DIR = resolve(ROOT, "web/data/theatres");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WEB_DIR, { recursive: true });

// Built once we know the per-work canonical title + total count.
let txMap = new Map();

const PTYPE_LABEL = {
  p: "mainpiece", a: "afterpiece", d: "dance", s: "song",
  m: "music", e: "entertainment", i: "interlude", o: "other",
  b: "ballet", u: "unassigned"
};
const PTYPE_ORDER = ["p", "a", "d", "s", "m", "b", "e", "i", "o", "u"];

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");

function decadeOf(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 4) return null;
  const y = +yyyymmdd.slice(0, 4);
  return y ? Math.floor(y / 10) * 10 : null;
}
function yearOf(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 4) return null;
  return +yyyymmdd.slice(0, 4) || null;
}

// venues[code] = { events, performances, byDecade, ptypes,
//                  works, performers, roles, workTitles }
const venues = new Map();

function getOrMake(code) {
  let v = venues.get(code);
  if (!v) {
    v = {
      events: 0,              // EventDate count (each event is a night)
      performances: 0,        // Performances[] count
      firstYear: null,
      lastYear: null,
      byDecade: new Map(),
      ptypes: new Map(),
      works: new Map(),            // workId -> { id, ptype, count }
      workTitles: new Map(),       // workId -> Map(title -> count)
      performers: new Map(),       // name -> count
      roles: new Map(),            // role -> count
      decadePerformers: new Map(), // decade -> Map(name -> count)
      decadeWorks: new Map()       // decade -> Map(workId -> {id, count, titles: Map})
    };
    venues.set(code, v);
  }
  return v;
}

for (const ev of events) {
  const date = ev.EventDate;
  const decade = decadeOf(date);
  const year = yearOf(date);
  const code = (ev.TheatreCode || "").toLowerCase();
  if (!code) continue;

  const v = getOrMake(code);
  v.events++;
  if (year != null) {
    if (v.firstYear == null || year < v.firstYear) v.firstYear = year;
    if (v.lastYear  == null || year > v.lastYear)  v.lastYear  = year;
  }
  if (decade != null) v.byDecade.set(decade, (v.byDecade.get(decade) || 0) + 1);

  const perfs = ev.Performances || [];
  for (const p of perfs) {
    v.performances++;

    const pt = p.PType || "o";
    v.ptypes.set(pt, (v.ptypes.get(pt) || 0) + 1);

    const workId = p.WorkId;
    if (workId) {
      let w = v.works.get(workId);
      if (!w) { w = { id: workId, ptype: pt, count: 0 }; v.works.set(workId, w); }
      w.count++;
      const title = cleanTitle(p.PerformanceTitle);
      if (title) {
        let tm = v.workTitles.get(workId);
        if (!tm) { tm = new Map(); v.workTitles.set(workId, tm); }
        tm.set(title, (tm.get(title) || 0) + 1);
      }
      if (decade != null) {
        let dw = v.decadeWorks.get(decade);
        if (!dw) { dw = new Map(); v.decadeWorks.set(decade, dw); }
        let wr = dw.get(workId);
        if (!wr) { wr = { id: workId, count: 0, titles: new Map() }; dw.set(workId, wr); }
        wr.count++;
        if (title) wr.titles.set(title, (wr.titles.get(title) || 0) + 1);
      }
    }

    const cast = p.cast || [];
    for (const c of cast) {
      for (const name of extractPerformers(c.Performer)) {
        v.performers.set(name, (v.performers.get(name) || 0) + 1);
        if (decade != null) {
          let dp = v.decadePerformers.get(decade);
          if (!dp) { dp = new Map(); v.decadePerformers.set(decade, dp); }
          dp.set(name, (dp.get(name) || 0) + 1);
        }
      }
      const role = cleanRole(c.Role);
      if (role) v.roles.set(role, (v.roles.get(role) || 0) + 1);
    }
  }
}

// ---- Flatten ---------------------------------------------------------------
function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
// Delegate to the shared chooser — prefers apostrophe-bearing variants over
// punctuation-stripped duplicates of the same skeleton (see lsdb-text.mjs).
function topTitle(m) {
  return pickCanonicalTitle(m);
}

const DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];

// Build the global LSDB index used by the TX joiner: for each unique workId
// across all venues, take the most-common title and the cross-venue perf
// total. (This roughly mirrors what build-works.mjs computes.)
const globalWorkTitles = new Map(); // workId -> Map(title -> count)
const globalWorkCount  = new Map(); // workId -> total count
for (const v of venues.values()) {
  for (const [wid, info] of v.works) {
    globalWorkCount.set(wid, (globalWorkCount.get(wid) || 0) + info.count);
  }
  for (const [wid, titlesMap] of v.workTitles) {
    let gtm = globalWorkTitles.get(wid);
    if (!gtm) { gtm = new Map(); globalWorkTitles.set(wid, gtm); }
    for (const [title, n] of titlesMap) gtm.set(title, (gtm.get(title) || 0) + n);
  }
}
txMap = joinTxToLsdb(
  [...globalWorkCount.keys()].map(wid => [wid, topTitle(globalWorkTitles.get(wid)) || "", globalWorkCount.get(wid)])
);

const details = {};
for (const [code, v] of venues) {
  const byDecade = {};
  for (const d of DECADES) {
    const n = v.byDecade.get(d) || 0;
    if (n) byDecade[d] = n;
  }

  const ptypeMix = [];
  for (const k of PTYPE_ORDER) {
    const n = v.ptypes.get(k) || 0;
    if (n) ptypeMix.push({ ptype: k, label: PTYPE_LABEL[k] || k, count: n });
  }
  for (const [k, n] of v.ptypes) {
    if (!PTYPE_ORDER.includes(k) && n) ptypeMix.push({ ptype: k, label: PTYPE_LABEL[k] || k, count: n });
  }

  const topWorks = [...v.works.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
    .map(w => {
      const tx = txMap.get(String(w.id));
      const genre = tx?.genre?.label || null;
      return {
        workId: w.id,
        title: topTitle(v.workTitles.get(w.id)) || "(untitled)",
        ptype: w.ptype,
        ptypeLabel: PTYPE_LABEL[w.ptype] || w.ptype,
        count: w.count,
        ...(genre ? { genre } : {})
      };
    });

  const decades = {};
  for (const d of DECADES) {
    const total = v.byDecade.get(d) || 0;
    if (!total) continue;
    const dw = v.decadeWorks.get(d) || new Map();
    const works = [...dw.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map(w => {
        // Carry ptype/genre into every per-decade work so the client-side
        // mergeDecadeRange doesn't need a separate lookup; otherwise works
        // outside the venue's all-eras top-12 lose their tags when the
        // slider narrows.
        const venueWork = v.works.get(w.id);
        const ptype = venueWork ? venueWork.ptype : null;
        const tx = txMap.get(String(w.id));
        const genre = tx?.genre?.label || null;
        return {
          workId: w.id,
          title: topTitle(w.titles) || "(untitled)",
          count: w.count,
          ...(ptype ? { ptype, ptypeLabel: PTYPE_LABEL[ptype] || ptype } : {}),
          ...(genre ? { genre } : {})
        };
      });
    decades[d] = {
      total,
      performers: topEntries(v.decadePerformers.get(d) || new Map(), 10).map(([name, count]) => ({ name, count })),
      works
    };
  }

  details[code] = {
    code,
    events: v.events,
    performances: v.performances,
    firstYear: v.firstYear,
    lastYear: v.lastYear,
    byDecade,
    ptypeMix,
    topWorks,
    topPerformers: topEntries(v.performers, 40).map(([name, count]) => ({ name, count })),
    topRoles:      topEntries(v.roles,      40).map(([role, count]) => ({ role, count })),
    ...(Object.keys(decades).length ? { decades } : {})
  };
}

const doc = {
  _meta: {
    description: "Per-venue detail: decade timeline, ptype mix, top 12 works, top 40 performers, top 40 roles. Keyed by lower-cased TheatreCode. Event count is nights; performances is Performances[] count.",
    generated: new Date().toISOString().slice(0, 10),
    venues: Object.keys(details).length,
    decades: DECADES
  },
  details
};

writeFileSync(resolve(OUT_DIR, "venue-details.json"), JSON.stringify(doc));
writeFileSync(resolve(WEB_DIR, "venue-details.json"), JSON.stringify(doc));

console.log(`venues: ${Object.keys(details).length.toLocaleString()}`);
console.log("done.");
