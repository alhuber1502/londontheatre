#!/usr/bin/env node
// Per-work detail aggregate. One record per WorkId with enough context to
// render a detail page: decade timeline, top theatres, top cast, role
// breakdown, and mainpiece/afterpiece pairings (works that shared an
// event — usually a play + its afterpiece).
//
// Run: node --max-old-space-size=3072 scripts/build-work-details.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinTxToLsdb } from "./lib/theatronomics-works.mjs";
import { joinTcpToLsdb } from "./lib/tcp-links.mjs";
import { extractPerformers, cleanRole, cleanTitle, pickCanonicalTitle } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT     = resolve(__dirname, "..");
const INPUT    = resolve(ROOT, "data/LondonStageFull.json");
const COMMENTS = resolve(ROOT, "web/data/comments-extracted.json");
const AB_PATH  = resolve(ROOT, "web/data/receipts/theatronomics-by-date.json");
const OUT_DIR  = resolve(ROOT, "build/works");
const WEB_DIR  = resolve(ROOT, "web/data/works");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WEB_DIR, { recursive: true });

// txMap is populated after the canonical-title pass below, since the joiner
// needs LSDB titles + perf counts to fall back on title-based matching.
let txMap = new Map();

const PTYPE_LABEL = {
  p: "mainpiece", a: "afterpiece", d: "dance", s: "song",
  m: "music", e: "entertainment", i: "interlude", o: "other"
};

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");
const abByDate    = JSON.parse(readFileSync(AB_PATH, "utf8"));
const commentsDoc = JSON.parse(readFileSync(COMMENTS, "utf8"));
const perfFlags   = commentsDoc.performances || {};
const eventFlags  = commentsDoc.events       || {};

function decadeOf(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 4) return null;
  const y = +yyyymmdd.slice(0, 4);
  return y ? Math.floor(y / 10) * 10 : null;
}
function yearOf(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 4) return null;
  return +yyyymmdd.slice(0, 4) || null;
}

// works[workId] = { titles, ptypes, total, firstYear, lastYear,
//                   byDecade, byTheatre, cast, roles, pairings }
const works = new Map();

function getOrMake(id) {
  let w = works.get(id);
  if (!w) {
    w = {
      titles: new Map(),
      ptypes: new Map(),
      total: 0,
      firstYear: null,
      lastYear: null,
      firstDate:  null,
      firstVenue: null,
      byDecade: new Map(),
      byTheatre: new Map(),
      cast: new Map(),
      roles: new Map(),
      pairings: new Map(),
      benefitEvents: new Set(), // deduplicated EventIds that were benefit nights
      milestones: [],           // [{type, date, venue, cast}]
      decadeCast:    new Map(), // decade -> Map(name -> count)
      decadeVenues:  new Map(), // decade -> Map(code -> count)
      decadeRoles:   new Map(), // decade -> Map(role -> count)
      decadePairings:new Map(), // decade -> Map(workId -> {count, ptype})
      abNightSet:    new Set(), // dedup key 'cg:YYYYMMDD'
      abNights:      []         // [{d, v, dr}] CG/DL nights with account-book data
    };
    works.set(id, w);
  }
  return w;
}

for (const ev of events) {
  const date = ev.EventDate;
  const decade = decadeOf(date);
  const year = yearOf(date);
  const theatre = (ev.TheatreCode || "").toLowerCase();
  const perfs = ev.Performances || [];

  // Collect WorkIds in this event (for pairings).
  const eventWorkIds = [];
  for (const p of perfs) {
    if (p.WorkId) eventWorkIds.push({ id: p.WorkId, ptype: p.PType || "o" });
  }

  for (const p of perfs) {
    const id = p.WorkId;
    if (!id) continue;

    const w = getOrMake(id);
    const title = cleanTitle(p.PerformanceTitle);
    if (title) w.titles.set(title, (w.titles.get(title) || 0) + 1);

    const pt = p.PType || "o";
    w.ptypes.set(pt, (w.ptypes.get(pt) || 0) + 1);

    w.total++;
    if (year != null) {
      if (w.firstYear == null || year < w.firstYear) w.firstYear = year;
      if (w.lastYear  == null || year > w.lastYear)  w.lastYear  = year;
      if (!w.firstDate || date < w.firstDate) { w.firstDate = date; w.firstVenue = theatre || null; }
    }
    if (decade != null) w.byDecade.set(decade, (w.byDecade.get(decade) || 0) + 1);
    if (theatre)        w.byTheatre.set(theatre, (w.byTheatre.get(theatre) || 0) + 1);
    if (decade != null && theatre) {
      let dv = w.decadeVenues.get(decade);
      if (!dv) { dv = new Map(); w.decadeVenues.set(decade, dv); }
      dv.set(theatre, (dv.get(theatre) || 0) + 1);
    }

    const cast = p.cast || [];
    for (const c of cast) {
      const role = cleanRole(c.Role);
      for (const name of extractPerformers(c.Performer)) {
        w.cast.set(name, (w.cast.get(name) || 0) + 1);
        if (decade != null) {
          let dc = w.decadeCast.get(decade);
          if (!dc) { dc = new Map(); w.decadeCast.set(decade, dc); }
          dc.set(name, (dc.get(name) || 0) + 1);
        }
        if (role) {
          w.roles.set(role, (w.roles.get(role) || 0) + 1);
          if (decade != null) {
            let dr = w.decadeRoles.get(decade);
            if (!dr) { dr = new Map(); w.decadeRoles.set(decade, dr); }
            dr.set(role, (dr.get(role) || 0) + 1);
          }
        }
      }
    }

    // Track benefit nights
    if (eventFlags[String(ev.EventId)]?.benefit?.flagged) {
      w.benefitEvents.add(ev.EventId);
    }

    // Collect debut/farewell flags for this performance
    const flag = perfFlags[String(p.PerformanceId)];
    if (flag && (flag.debut || flag.farewell)) {
      const type = flag.debut ? "debut-" + flag.debut : "farewell";
      w.milestones.push({
        type,
        date:  date   || null,
        venue: theatre || null,
        cast:  (p.cast || []).flatMap(c => extractPerformers(c.Performer))
      });
    }

    // Account-book door receipts for CG/DL nights (Theatronomics)
    if ((theatre === 'cg' || theatre === 'dl') && date) {
      const abKey = `${theatre}:${date}`;
      if (!w.abNightSet.has(abKey)) {
        const ab = abByDate[abKey];
        if (ab && ab.dr > 0) {
          w.abNightSet.add(abKey);
          w.abNights.push({ d: date, v: theatre, dr: ab.dr });
        }
      }
    }

    // Pair this work with every other WorkId that appeared in the same event.
    for (const other of eventWorkIds) {
      if (other.id === id) continue;
      const key = other.id;
      const prev = w.pairings.get(key);
      if (prev) {
        prev.count++;
      } else {
        w.pairings.set(key, { id: other.id, ptype: other.ptype, count: 1 });
      }
      if (decade != null) {
        let dp = w.decadePairings.get(decade);
        if (!dp) { dp = new Map(); w.decadePairings.set(decade, dp); }
        const pp = dp.get(key);
        if (pp) pp.count++;
        else dp.set(key, { count: 1, ptype: other.ptype });
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
function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

const DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];

// First pass: pick canonical title per work (used when emitting pairings too).
// pickCanonicalTitle prefers variants that retain apostrophes / punctuation
// even when a stripped variant is slightly more common in the source.
const canonical = new Map();
for (const [id, w] of works) {
  canonical.set(id, pickCanonicalTitle(w.titles) || "(untitled)");
}

// Join Theatronomics attribution data once we have LSDB titles + perf counts
// for the title-based fallback pass.
txMap = joinTxToLsdb(
  [...works.entries()].map(([id, w]) => [id, canonical.get(id), w.total])
);

// Join EEBO-TCP / ECCO-TCP full-text identifiers. Rows whose WorkId is not in
// the current LSDB dataset are dropped silently (logged below).
const { map: tcpMap, dropped: tcpDropped } = joinTcpToLsdb(works.keys());

const details = {};
for (const [id, w] of works) {
  const title = canonical.get(id);
  const pt = topKey(w.ptypes);
  const ptype = pt ? pt.key : null;

  const byDecade = {};
  for (const d of DECADES) {
    const v = w.byDecade.get(d) || 0;
    if (v) byDecade[d] = v;
  }

  const decades = {};
  for (const d of DECADES) {
    const total = w.byDecade.get(d) || 0;
    if (!total) continue;
    const decPairings = [...(w.decadePairings.get(d) || new Map()).entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([workId, info]) => ({
        workId,
        title: canonical.get(workId) || "(untitled)",
        ptype: info.ptype,
        ptypeLabel: PTYPE_LABEL[info.ptype] || info.ptype,
        count: info.count
      }));
    decades[d] = {
      total,
      cast:     topEntries(w.decadeCast.get(d)    || new Map(), 10).map(([name, count]) => ({ name, count })),
      venues:   topEntries(w.decadeVenues.get(d)  || new Map(),  5).map(([code, count]) => ({ code, count })),
      roles:    topEntries(w.decadeRoles.get(d)   || new Map(), 20).map(([role, count]) => ({ role, count })),
      ...(decPairings.length ? { pairings: decPairings } : {})
    };
  }

  const pairings = [...w.pairings.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
    .map(x => ({
      workId: x.id,
      title: canonical.get(x.id) || "(untitled)",
      ptype: x.ptype,
      ptypeLabel: PTYPE_LABEL[x.ptype] || x.ptype,
      count: x.count
    }));

  // Collate milestone flags: sort each group by date, deduplicate same-date entries
  const wms = {};
  for (const m of w.milestones) {
    if (!wms[m.type]) wms[m.type] = [];
    wms[m.type].push({ date: m.date, venue: m.venue, cast: m.cast });
  }
  for (const arr of Object.values(wms)) arr.sort((a, b) => (a.date || "") < (b.date || "") ? -1 : 1);
  const milestones = {};
  if (wms["debut-stage"]) milestones.stageDebuts = wms["debut-stage"];
  if (wms["debut-role"])  milestones.roleDebuts  = wms["debut-role"];
  if (wms["farewell"])    milestones.farewells   = wms["farewell"];

  const benefitNights = w.benefitEvents.size;

  const tx = txMap.get(String(id));
  const tcp = tcpMap.get(String(id));

  details[id] = {
    workId: id,
    title,
    ptype,
    ptypeLabel: ptype ? (PTYPE_LABEL[ptype] || ptype) : null,
    total: w.total,
    firstYear: w.firstYear,
    lastYear: w.lastYear,
    firstDate:  w.firstDate  || null,
    firstVenue: w.firstVenue || null,
    byDecade,
    byTheatre: topEntries(w.byTheatre, 10).map(([code, count]) => ({ code, count })),
    cast:      topEntries(w.cast,      40).map(([name, count]) => ({ name, count })),
    roles:     topEntries(w.roles,     40).map(([role, count]) => ({ role, count })),
    pairings,
    ...(benefitNights > 0 ? { benefitNights } : {}),
    ...(Object.keys(milestones).length ? { milestones } : {}),
    ...(Object.keys(decades).length ? { decades } : {}),
    ...(w.abNights.length > 0 ? { abNights: w.abNights.slice().sort((a, b) => a.d < b.d ? -1 : 1) } : {}),
    ...(tx ? { tx } : {}),
    ...(tcp && tcp.length ? { tcp } : {})
  };
}

const doc = {
  _meta: {
    description: "Per-work detail: decade timeline, top theatres, top cast (up to 40), top roles (up to 40), and top 12 co-programmed works (mainpiece/afterpiece pairings). Keyed by WorkId.",
    generated: new Date().toISOString().slice(0, 10),
    works: Object.keys(details).length,
    decades: DECADES
  },
  details
};

writeFileSync(resolve(OUT_DIR, "work-details.json"), JSON.stringify(doc));
writeFileSync(resolve(WEB_DIR, "work-details.json"), JSON.stringify(doc));

const tcpAttached = Object.values(details).reduce((n, d) => n + (d.tcp ? 1 : 0), 0);
console.log(`works: ${Object.keys(details).length.toLocaleString()}`);
console.log(`tcp:   ${tcpAttached.toLocaleString()} works with full-text links` +
            ` (dropped ${tcpDropped.rows} TCP rows / ${tcpDropped.distinctWorkIds} distinct WorkIds not in LSDB)`);
console.log("done.");
