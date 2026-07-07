#!/usr/bin/env node
// Layer D — Graph infrastructure. Builds per-decade edge tables for
// four relation kinds, ready to feed sigma.js/graphology views.
//
//   theatrePerformer:   who acted where, how often
//   workPerformer:      who played what
//   performerPerformer: co-casting (same performance, same night)
//   mainAfterpiece:     which mainpiece paired with which afterpiece
//
// Outputs:
//   build/graphs/index.json      per-decade summary + node lists
//   build/graphs/{decade}.json   edge tables for that decade
//
// Run: node --max-old-space-size=3072 scripts/build-graphs.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPerformers, cleanTitle } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "data/LondonStageFull.json");
const OUT_DIR = resolve(ROOT, "build/graphs");
const WEB_DIR = resolve(ROOT, "web/data/graphs");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WEB_DIR, { recursive: true });

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");

// Canonical title per WorkId from build-works output. This ensures the same
// work node carries the same label across every decade graph, even when LSDB
// has multiple title spellings (e.g. "The Lover's Opera" vs "The Lovers
// Opera"). build-works must run before build-graphs (it does, in build-all).
const canonicalTitles = new Map();
try {
  const worksDoc = JSON.parse(readFileSync(resolve(ROOT, "web/data/works.json"), "utf8"));
  for (const r of (worksDoc.works || [])) {
    if (r.workId != null && r.title) canonicalTitles.set(String(r.workId), r.title);
  }
} catch (_) {
  console.warn("works.json not found — graph titles will fall back to per-decade first-seen");
}
function canonicalTitleFor(workId, fallback) {
  return canonicalTitles.get(String(workId)) || fallback || "";
}

// Decade bucket from YYYYMMDD.
function decadeOf(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 4) return null;
  const y = +yyyymmdd.slice(0, 4);
  if (!y) return null;
  return Math.floor(y / 10) * 10;
}

// ---- Pass 1: partition events by decade -----------------------------------
const byDecade = new Map();
for (const ev of events) {
  const d = decadeOf(ev.EventDate);
  if (d == null) continue;
  if (!byDecade.has(d)) byDecade.set(d, []);
  byDecade.get(d).push(ev);
}
const decades = [...byDecade.keys()].sort((a, b) => a - b);
console.log(`decades: ${decades.join(", ")}`);

// ---- Helpers ---------------------------------------------------------------
function addEdge(map, a, b, w = 1) {
  const key = a + "\t" + b;
  map.set(key, (map.get(key) || 0) + w);
}

function symKey(a, b) {
  return a < b ? a + "\t" + b : b + "\t" + a;
}

// ---- Per-decade build ------------------------------------------------------
const indexRows = [];
let grandTotals = { perfCasts: 0, tpEdges: 0, wpEdges: 0, ppEdges: 0, paEdges: 0 };

// Per-theatre per-decade event counts — drives the map timeline slider.
// theatreTimeline[code] = { total, byDecade: { 1660: N, 1670: N, ... } }
const theatreTimeline = new Map();

// Run the same node+edge build over an arbitrary event set. When called per
// decade, the `decadeLabel` is the decade integer and `updateTimeline` is
// true. The "all" pass passes string "all" + false (the timeline is already
// fully populated from the decade passes).
function buildGraphFor(evs, decadeLabel, updateTimeline) {
  // Node collections — build nodes first so edge rows can be indices.
  const performers = new Map(); // cleaned Performer name -> { idx, count }
  const theatres   = new Map(); // TheatreCode    -> { idx, count }
  const works      = new Map(); // WorkId         -> { idx, count, title, ptype }

  function internPerformer(name) {
    if (!performers.has(name)) performers.set(name, { idx: performers.size, count: 0 });
    const r = performers.get(name); r.count++; return r.idx;
  }
  function internTheatre(code) {
    if (!theatres.has(code)) theatres.set(code, { idx: theatres.size, count: 0 });
    const r = theatres.get(code); r.count++; return r.idx;
  }
  function internWork(workId, title, ptype) {
    if (!workId) return -1;
    if (!works.has(workId)) works.set(workId, { idx: works.size, count: 0, title, ptype });
    const r = works.get(workId); r.count++; return r.idx;
  }

  const tpEdges = new Map(); // theatre-performer
  const wpEdges = new Map(); // work-performer
  const ppEdges = new Map(); // performer-performer (symmetric)
  const paEdges = new Map(); // mainpiece-afterpiece (WorkId→WorkId)

  let perfCasts = 0;

  for (const ev of evs) {
    const theatre = (ev.TheatreCode || "").toLowerCase();
    if (!theatre) continue;
    const theatreIdx = internTheatre(theatre);

    // Timeline: one event = one night at this theatre in this decade. Only
    // accumulated during the per-decade passes (the "all" pass would
    // double-count).
    if (updateTimeline) {
      let tl = theatreTimeline.get(theatre);
      if (!tl) { tl = { total: 0, byDecade: {} }; theatreTimeline.set(theatre, tl); }
      tl.total++;
      tl.byDecade[decadeLabel] = (tl.byDecade[decadeLabel] || 0) + 1;
    }

    const perfs = ev.Performances || [];

    // Track main/afterpiece pair at event level.
    const mainpieces  = perfs.filter(p => p.PType === "p" && p.WorkId);
    const afterpieces = perfs.filter(p => p.PType === "a" && p.WorkId);

    for (const m of mainpieces) {
      const mIdx = internWork(m.WorkId, canonicalTitleFor(m.WorkId, cleanTitle(m.PerformanceTitle)), "p");
      for (const a of afterpieces) {
        const aIdx = internWork(a.WorkId, canonicalTitleFor(a.WorkId, cleanTitle(a.PerformanceTitle)), "a");
        addEdge(paEdges, mIdx, aIdx);
      }
    }

    // Cast-level edges.
    for (const p of perfs) {
      const cast = p.cast || [];
      if (!cast.length) continue;
      perfCasts++;

      const workId = p.WorkId || null;
      const workIdx = workId
        ? internWork(workId, canonicalTitleFor(workId, cleanTitle(p.PerformanceTitle)), p.PType)
        : -1;

      const perfIdxs = [];
      for (const c of cast) {
        for (const name of extractPerformers(c.Performer)) {
          const pIdx = internPerformer(name);
          perfIdxs.push(pIdx);

          addEdge(tpEdges, theatreIdx, pIdx);
          if (workIdx !== -1) addEdge(wpEdges, workIdx, pIdx);
        }
      }

      // Co-casting: all unordered pairs within this performance.
      for (let i = 0; i < perfIdxs.length; i++) {
        for (let j = i + 1; j < perfIdxs.length; j++) {
          const k = symKey(perfIdxs[i], perfIdxs[j]);
          ppEdges.set(k, (ppEdges.get(k) || 0) + 1);
        }
      }
    }
  }

  // Flatten maps to compact arrays. Drop weight-1 performer-performer edges
  // to keep per-decade files tractable (this loses fleeting pairings but
  // keeps substantive collaboration signals).
  function flatten(map, minWeight = 1) {
    const out = [];
    for (const [key, w] of map) {
      if (w < minWeight) continue;
      const [a, b] = key.split("\t");
      out.push([+a, +b, w]);
    }
    return out;
  }

  const tpFlat = flatten(tpEdges);
  const wpFlat = flatten(wpEdges);
  const ppFlat = flatten(ppEdges, 2); // prune ephemeral pairings
  const paFlat = flatten(paEdges);

  // Sort node arrays by index so output is deterministic.
  function nodeArray(map, extraFields = []) {
    const rows = [...map.entries()].sort((a, b) => a[1].idx - b[1].idx);
    return rows.map(([key, v]) => {
      const row = { id: key, count: v.count };
      for (const f of extraFields) if (v[f] !== undefined) row[f] = v[f];
      return row;
    });
  }

  const decadeDoc = {
    decade: decadeLabel,
    nodes: {
      performers: nodeArray(performers),
      theatres:   nodeArray(theatres),
      works:      nodeArray(works, ["title", "ptype"])
    },
    edges: {
      theatrePerformer:  tpFlat,
      workPerformer:     wpFlat,
      performerPerformer: ppFlat,
      mainAfterpiece:    paFlat
    }
  };

  const outPath = resolve(OUT_DIR, `${decadeLabel}.json`);
  writeFileSync(outPath, JSON.stringify(decadeDoc));
  writeFileSync(resolve(WEB_DIR, `${decadeLabel}.json`), JSON.stringify(decadeDoc));

  const bytes = readFileSync(outPath).byteLength;
  console.log(
    `  ${String(decadeLabel).padEnd(4)}  ev=${String(evs.length).padStart(5)}  ` +
    `perf=${String(performers.size).padStart(4)}  ` +
    `thr=${String(theatres.size).padStart(3)}  ` +
    `wrk=${String(works.size).padStart(4)}  ` +
    `tp=${String(tpFlat.length).padStart(5)}  ` +
    `wp=${String(wpFlat.length).padStart(5)}  ` +
    `pp=${String(ppFlat.length).padStart(6)}  ` +
    `pa=${String(paFlat.length).padStart(4)}  ` +
    `${(bytes / 1024).toFixed(0)}KB`
  );

  return {
    summary: {
      events: evs.length,
      performers: performers.size,
      theatres: theatres.size,
      works: works.size,
      perfCasts,
      edges: {
        theatrePerformer:   tpFlat.length,
        workPerformer:      wpFlat.length,
        performerPerformer: ppFlat.length,
        mainAfterpiece:     paFlat.length
      }
    }
  };
}

for (const decade of decades) {
  const result = buildGraphFor(byDecade.get(decade), decade, true);
  indexRows.push({ decade, ...result.summary });
  grandTotals.perfCasts += result.summary.perfCasts;
  grandTotals.tpEdges   += result.summary.edges.theatrePerformer;
  grandTotals.wpEdges   += result.summary.edges.workPerformer;
  grandTotals.ppEdges   += result.summary.edges.performerPerformer;
  grandTotals.paEdges   += result.summary.edges.mainAfterpiece;
}

// ---- All-eras aggregate ----------------------------------------------------
// Used by graphs.html when the slider is on "All". Same node+edge logic
// applied across every event, not just one decade. Writes web/data/graphs/all.json.
const allResult = buildGraphFor(events, "all", false);

// ---- Index file ------------------------------------------------------------
const index = {
  _meta: {
    description: "Per-decade graph edges for theatre↔performer, work↔performer, performer↔performer co-casting, and mainpiece↔afterpiece pairings. Node arrays are indexed; edge rows are [idxA, idxB, weight]. Performer-performer edges with weight<2 are pruned to drop one-off pairings.",
    generated: new Date().toISOString().slice(0, 10),
    edgeKinds: [
      { id: "theatrePerformer",  about: "Cast appearance: edge(theatre, performer) = times cast there in this decade" },
      { id: "workPerformer",     about: "Role assignment: edge(work, performer) = performances of this work featuring this performer" },
      { id: "performerPerformer",about: "Co-casting: edge(performer, performer) = shared-stage performances (weight ≥ 2 only)" },
      { id: "mainAfterpiece",    about: "Programming pair: edge(mainpiece workId, afterpiece workId) = times billed together" }
    ],
    totals: grandTotals
  },
  decades: indexRows
};
// Internal summary for debugging; nothing in web/ consumes this, so it lives
// only under build/. (Previously also written to web/data/graphs/index.json.)
writeFileSync(resolve(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));

// ---- Theatre timeline (for map slider) -------------------------------------
const timelineDoc = {
  _meta: {
    description: "Per-theatre event counts bucketed by decade. Used by the map's decade slider to filter and scale markers.",
    generated: new Date().toISOString().slice(0, 10),
    decades
  },
  theatres: Object.fromEntries([...theatreTimeline.entries()].sort())
};
writeFileSync(resolve(OUT_DIR, "theatre-timeline.json"), JSON.stringify(timelineDoc));
writeFileSync(resolve(ROOT, "web/data/theatre-timeline.json"), JSON.stringify(timelineDoc));

console.log("");
console.log("grand totals:");
console.log(`  performances with cast (covered): ${grandTotals.perfCasts.toLocaleString()}`);
console.log(`  theatre-performer edges:          ${grandTotals.tpEdges.toLocaleString()}`);
console.log(`  work-performer edges:             ${grandTotals.wpEdges.toLocaleString()}`);
console.log(`  performer-performer edges (≥2):   ${grandTotals.ppEdges.toLocaleString()}`);
console.log(`  mainpiece-afterpiece edges:       ${grandTotals.paEdges.toLocaleString()}`);
console.log("done.");
