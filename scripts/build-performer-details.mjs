#!/usr/bin/env node
// Performer detail aggregate. One record per performer with enough context
// to render a detail page: decade timeline, top theatres, all roles (not
// just the top 8 kept in performers.json), and top co-stars.
//
// Run: node --max-old-space-size=3072 scripts/build-performer-details.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPerformers, cleanRole, cleanTitle } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT    = resolve(ROOT, "data/LondonStageFull.json");
const COMMENTS = resolve(ROOT, "web/data/comments-extracted.json");
const AB_PATH  = resolve(ROOT, "web/data/receipts/theatronomics-by-date.json");
const OUT_DIR         = resolve(ROOT, "build/roles");
const WEB_DIR         = resolve(ROOT, "web/data/roles");
const SHARD_DIR_BUILD = resolve(ROOT, "build/performers/by-name");
const SHARD_DIR_WEB   = resolve(ROOT, "web/data/performers/by-name");
mkdirSync(OUT_DIR,         { recursive: true });
mkdirSync(WEB_DIR,         { recursive: true });
// Purge any per-name shards from previous builds before rewriting. Without
// this, renames and below-threshold drops leave orphan shards (e.g. legacy
// "Aingeli.json" lingering after the *Clean → Performer migration).
rmSync(SHARD_DIR_BUILD, { recursive: true, force: true });
rmSync(SHARD_DIR_WEB,   { recursive: true, force: true });
mkdirSync(SHARD_DIR_BUILD, { recursive: true });
mkdirSync(SHARD_DIR_WEB,   { recursive: true });

let abByDate = {};
try {
  abByDate = JSON.parse(readFileSync(AB_PATH, "utf8"));
  console.log("theatronomics-by-date.json loaded:", Object.keys(abByDate).length, "keys");
} catch (e) {
  console.warn("theatronomics-by-date.json not found — benefit financial data will be omitted");
}

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");
const commentsDoc  = JSON.parse(readFileSync(COMMENTS, "utf8"));
const perfFlags    = commentsDoc.performances || {};
const eventFlags   = commentsDoc.events       || {};

const FEMALE_PREFIX   = /^(Mrs|Miss|Madame|Mme|Mlle|Mademoiselle|Signora|Lady|Dame)\b/i;
const MALE_CHILD_PFX  = /^(Master)\b/i;
const MALE_EXPLICIT   = /^(Mr|Monsieur|Mons|Signor|Herr|Don)\b/i;
const COMPANY_RE      = /^(the\s+)?(company|gentlemen|ladies|dancers?|singers?|chorus|actors?|unassigned)\b/i;

function classifyPerformer(raw) {
  const s = (raw || "").trim();
  if (!s) return "unknown";
  if (COMPANY_RE.test(s)) return "company";
  if (FEMALE_PREFIX.test(s)) return "female";
  if (MALE_CHILD_PFX.test(s)) return "male-child";
  if (MALE_EXPLICIT.test(s)) return "male-explicit";
  return "male-inferred";
}

// Role classifier — mirrors build-roles.mjs so performer-details can carry
// a byCat distribution for the role-mix bar on performer.html.
const PARATEXT = new Set([
  "prologue", "epilogue", "chorus", "induction", "speaker",
  "occasional prologue", "occasional epilogue", "new prologue", "new epilogue"
]);
const GENERIC_WORDS = new Set([
  "servant","servants","maid","maids","footman","cook","gardener","soldier","soldiers",
  "officer","officers","messenger","page","pages","nurse","waiter","porter","sailor",
  "sailors","peasant","peasants","shepherd","shepherds","shepherdess","nymph","nymphs",
  "witch","witches","ghost","ghosts","spirit","spirits","fairy","fairies","robber",
  "robbers","watchman","watch","guard","guards","slave","slaves","beggar","beggars",
  "soldier's wife","gentleman","gentlemen","lady","ladies","boy","boys","girl","girls",
  "child","children","priest","priests","friar","friars","monk","nun","drawer",
  "huntsman","tavern keeper","landlord","landlady","constable","jailer","executioner",
  "doctor","apothecary","lawyer","notary","merchant","farmer","butler","coachman","footmen"
]);
const TITLE_WORDS = new Set([
  "king","queen","prince","princess","duke","duchess","earl","count","countess",
  "baron","baroness","sir","lord","lady","dame","marquis","marchioness","emperor",
  "empress","sultan","sultana","bishop","pope","cardinal","general","captain",
  "colonel","lieutenant","sergeant","major","admiral","master"
]);
const ENSEMBLE_PATTERNS = [
  /^parts?$/i, /^principal characters$/i, /^(other )?characters$/i,
  /^unassigned$/i, /^dancers?$/i, /^singers?$/i, /^actors?$/i,
  /^&c\.?$/i, /^with the rest/i, /^the rest/i, /^others?$/i
];
function classifyRole(raw) {
  const s = (raw || "").trim();
  if (!s) return "empty";
  const lc = s.toLowerCase();
  if (PARATEXT.has(lc)) return "paratext";
  for (const re of ENSEMBLE_PATTERNS) if (re.test(s)) return "ensemble";
  if (GENERIC_WORDS.has(lc)) return "generic";
  if (TITLE_WORDS.has(lc)) return "titled";
  return "named";
}
function decadeOf(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 4) return null;
  const y = +yyyymmdd.slice(0, 4);
  return y ? Math.floor(y / 10) * 10 : null;
}
function yearOf(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 4) return null;
  return +yyyymmdd.slice(0, 4) || null;
}

// perf[name] = {
//   gender, total,
//   byCat: ..., byDecade: Map, byTheatre: Map, roles: Map, costars: Map,
//   firstYear, lastYear
// }
const perf = new Map();

function getOrMake(name) {
  let p = perf.get(name);
  if (!p) {
    p = {
      gender: classifyPerformer(name),
      total: 0,
      byDecade: new Map(),
      byTheatre: new Map(),
      roles: new Map(),
      costars: new Map(),
      firstYear: null,
      lastYear: null,
      collisionNights: 0,   // filled in pass-2
      byCat: { paratext: 0, ensemble: 0, generic: 0, titled: 0, named: 0, empty: 0 },
      flaggedPerfs: [],     // interim: debut/farewell-flagged performances
      decadeRoles:   new Map(),  // decade -> Map(role -> count)
      decadeCostars: new Map(),  // decade -> Map(costarName -> count)
      decadeVenues:  new Map()   // decade -> Map(code -> count)
    };
    perf.set(name, p);
  }
  return p;
}

// Same-night-different-theatre detector (for identity caveats).
const perfNightTheatres = new Map();
// Benefit-night tracker: eventId -> {date, venue} for each performer.
// Map<name, Map<eventId, {date, venue}>>
const perfBenefitEvents = new Map();

for (const ev of events) {
  const date = ev.EventDate;
  const decade = decadeOf(date);
  const year   = yearOf(date);
  const theatre = (ev.TheatreCode || "").toLowerCase();
  const perfs = ev.Performances || [];

  for (const p of perfs) {
    const cast = p.cast || [];
    // Collect unique names in this performance for costar pairing
    const names = [];
    for (const c of cast) {
      const role = cleanRole(c.Role);
      // A comma-list Performer credits each split name; share the per-slot
      // role across them.
      for (const name of extractPerformers(c.Performer)) {
        const rec = getOrMake(name);
        rec.total++;
        rec.byCat[classifyRole(role)]++;
        if (decade != null) rec.byDecade.set(decade, (rec.byDecade.get(decade) || 0) + 1);
        if (theatre)        rec.byTheatre.set(theatre, (rec.byTheatre.get(theatre) || 0) + 1);
        if (role)           rec.roles.set(role, (rec.roles.get(role) || 0) + 1);
        if (decade != null) {
          if (role) {
            let dr = rec.decadeRoles.get(decade);
            if (!dr) { dr = new Map(); rec.decadeRoles.set(decade, dr); }
            dr.set(role, (dr.get(role) || 0) + 1);
          }
          if (theatre) {
            let dv = rec.decadeVenues.get(decade);
            if (!dv) { dv = new Map(); rec.decadeVenues.set(decade, dv); }
            dv.set(theatre, (dv.get(theatre) || 0) + 1);
          }
        }
        if (year != null) {
          if (rec.firstYear == null || year < rec.firstYear) rec.firstYear = year;
          if (rec.lastYear  == null || year > rec.lastYear)  rec.lastYear  = year;
        }
        if (date && theatre) {
          const k = date + "::" + name;
          let s = perfNightTheatres.get(k);
          if (!s) { s = new Set(); perfNightTheatres.set(k, s); }
          s.add(theatre);
        }
        // Track benefit nights (deduplicated by EventId, store date+venue for join)
        if (eventFlags[String(ev.EventId)]?.benefit?.flagged) {
          let bm = perfBenefitEvents.get(name);
          if (!bm) { bm = new Map(); perfBenefitEvents.set(name, bm); }
          if (!bm.has(ev.EventId)) bm.set(ev.EventId, { date, venue: theatre });
        }
        // Collect debut/farewell flags for milestone attribution
        const flag = perfFlags[String(p.PerformanceId)];
        if (flag && (flag.debut || flag.farewell)) {
          rec.flaggedPerfs.push({
            debut:    flag.debut   || null,
            farewell: !!flag.farewell,
            date,
            year,
            venue:    theatre,
            workId:   p.WorkId || null,
            title:    cleanTitle(p.PerformanceTitle)
          });
        }
        names.push(name);
      }
    }
    // Co-star counts: pair every name with every other unique name once
    const uniq = [...new Set(names)];
    for (let i = 0; i < uniq.length; i++) {
      const a = perf.get(uniq[i]);
      for (let j = 0; j < uniq.length; j++) {
        if (i === j) continue;
        const b = uniq[j];
        a.costars.set(b, (a.costars.get(b) || 0) + 1);
        if (decade != null) {
          let dc = a.decadeCostars.get(decade);
          if (!dc) { dc = new Map(); a.decadeCostars.set(decade, dc); }
          dc.set(b, (dc.get(b) || 0) + 1);
        }
      }
    }
  }
}

// Tally collision nights per performer.
for (const [k, theatres] of perfNightTheatres) {
  if (theatres.size < 2) continue;
  const name = k.slice(k.indexOf("::") + 2);
  const rec = perf.get(name);
  if (rec) rec.collisionNights++;
}

// ---- Flatten ---------------------------------------------------------------
function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

const details = {};
let kept = 0, skipped = 0;
const DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];

for (const [name, p] of perf) {
  if (p.total < 2) { skipped++; continue; }
  const byDecade = {};
  for (const d of DECADES) {
    const v = p.byDecade.get(d) || 0;
    if (v) byDecade[d] = v;
  }

  const decades = {};
  for (const d of DECADES) {
    const total = p.byDecade.get(d) || 0;
    if (!total) continue;
    decades[d] = {
      total,
      roles:   topEntries(p.decadeRoles.get(d)   || new Map(),  8).map(([role, count]) => ({ role,  count })),
      costars: topEntries(p.decadeCostars.get(d) || new Map(), 12).map(([name, count]) => ({ name,  count })),
      venues:  topEntries(p.decadeVenues.get(d)  || new Map(),  5).map(([code, count]) => ({ code,  count }))
    };
  }
  // Milestone attribution via year-match heuristic:
  // a debut-stage flag on a performance where this performer's firstYear matches
  // the event year is strong evidence they are the debutant.
  const milestones = {};
  const fp = p.flaggedPerfs;
  if (fp.length) {
    const stageDebuts = fp
      .filter(f => f.debut === "stage" && f.year === p.firstYear && f.date)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    if (stageDebuts.length) {
      const s = stageDebuts[0];
      milestones.stageDebut = { date: s.date, venue: s.venue, workId: s.workId, title: s.title };
    }
    const farewells = fp
      .filter(f => f.farewell && f.year === p.lastYear && f.date)
      .sort((a, b) => b.date < a.date ? -1 : 1);
    if (farewells.length) {
      const f = farewells[0];
      milestones.farewell = { date: f.date, venue: f.venue, workId: f.workId, title: f.title };
    }
  }

  const benefitMap = perfBenefitEvents.get(name) || new Map();
  const benefitNights = benefitMap.size;

  // Build the CG/DL benefit nights list joined to Theatronomics door receipts.
  let benefitNightsList = null;
  if (benefitMap.size > 0) {
    const list = [];
    for (const [, info] of benefitMap) {
      const { date, venue } = info;
      if (!date || (venue !== 'cg' && venue !== 'dl') || date < '17320101') continue;
      const ab = abByDate[venue + ':' + date];
      const entry = { date, venue };
      if (ab) {
        if (ab.dr) entry.dr = ab.dr;
        if (ab.bd) entry.bd = ab.bd;
      }
      list.push(entry);
    }
    if (list.length) {
      list.sort((a, b) => (a.date < b.date ? -1 : 1));
      benefitNightsList = list;
    }
  }

  details[name] = {
    gender: p.gender,
    total: p.total,
    firstYear: p.firstYear,
    lastYear: p.lastYear,
    collisionNights: p.collisionNights,
    byCat: p.byCat,
    byDecade,
    byTheatre: topEntries(p.byTheatre, 10).map(([code, count]) => ({ code, count })),
    roles:     topEntries(p.roles,     40).map(([role, count]) => ({ role, count })),
    costars:   topEntries(p.costars,   12).map(([name, count]) => ({ name, count })),
    ...(benefitNights > 0 ? { benefitNights } : {}),
    ...(benefitNightsList ? { benefitNightsList } : {}),
    ...(Object.keys(milestones).length ? { milestones } : {}),
    ...(Object.keys(decades).length ? { decades } : {})
  };
  kept++;
}

const doc = {
  _meta: {
    description: "Per-performer detail: decade timeline, top 10 theatres, top 40 roles, top 12 co-stars. Keyed by cleaned Performer name. Performers with <2 appearances excluded.",
    generated: new Date().toISOString().slice(0, 10),
    profiles: kept,
    decades: DECADES
  },
  details
};

// Monolithic doc kept under build/ only — the client uses per-name shards in
// SHARD_DIR_WEB instead. (Previously also written to web/data/roles/.)
writeFileSync(resolve(OUT_DIR, "performer-details.json"), JSON.stringify(doc));

let shards = 0;
for (const [name, rec] of Object.entries(details)) {
  // Use the raw name as the filename so that a normal HTTP fetch with
  // encodeURIComponent(name) in the URL resolves to the correct file.
  // encodeURIComponent creates literal '%XX' in filenames which servers
  // then fail to match when they decode the URL path before stat().
  const safeName = name.replace(/\\/g, "");
  const json = JSON.stringify(rec);
  writeFileSync(resolve(SHARD_DIR_BUILD, safeName + ".json"), json);
  writeFileSync(resolve(SHARD_DIR_WEB,   safeName + ".json"), json);
  shards++;
}

console.log(`kept:    ${kept.toLocaleString()}`);
console.log(`skipped: ${skipped.toLocaleString()} (fewer than 2 appearances)`);
console.log(`shards:  ${shards.toLocaleString()}`);
console.log("done.");
