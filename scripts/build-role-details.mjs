#!/usr/bin/env node
// Per-role detail aggregate for the biography-of-a-role view.
//
// Strategy
// --------
// Emit one compact per-role record containing ledger totals, decade
// sparkline, top performers/works/theatres and a slim "appearances" list
// small enough to ship in a single document.
//
// Scope
// -----
// Only roles in category named OR titled and with appearanceCount >= 5.
// Everything else (generic "Servant", paratext "Prologue", &c.) collapses
// to noise at this grain and is not interesting as a biography.
//
// Output shape
// ------------
// {
//   _meta: { ... },
//   roles: {
//     <slug>: {
//       name, slug, category, total,
//       firstYear, lastYear,
//       byDecade: { 1700: n, ... },
//       performerCount, workCount, theatreCount,
//       topPerformers: [{ name, count, firstYear, lastYear }, ...],
//       topWorks:      [{ workId, title, count }, ...],
//       topTheatres:   [{ code, count }, ...]
//     }
//   }
// }
//
// Also emits a role-index.json of every distinct role (including those
// below the detail threshold) so the browse page can search/filter.
//
// Run: node --max-old-space-size=3072 scripts/build-role-details.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPerformers, cleanRole, cleanTitle } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "data/LondonStageFull.json");
const OUT_DIR = resolve(ROOT, "build/roles");
const WEB_DIR = resolve(ROOT, "web/data/roles");
const SHARD_DIR_BUILD = resolve(OUT_DIR, "by-slug");
const SHARD_DIR_WEB   = resolve(WEB_DIR, "by-slug");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WEB_DIR, { recursive: true });
// Purge per-slug shards from previous builds. Without this, retired slugs
// (renamed or now below the emit threshold) linger as orphans.
rmSync(SHARD_DIR_BUILD, { recursive: true, force: true });
rmSync(SHARD_DIR_WEB,   { recursive: true, force: true });
mkdirSync(SHARD_DIR_BUILD, { recursive: true });
mkdirSync(SHARD_DIR_WEB,   { recursive: true });

// ---- Role classifier (subset of build-roles.mjs) --------------------------
// We re-classify here rather than carry every cast row through the taxonomy
// file because we need the full event/work/theatre context.
const PARATEXT = new Set([
  "prologue","epilogue","chorus","induction","speaker",
  "occasional prologue","occasional epilogue","new prologue","new epilogue"
]);
const GENERIC_WORDS = new Set([
  "servant","servants","maid","maids","footman","cook","gardener","soldier",
  "soldiers","officer","officers","messenger","page","pages","nurse","waiter",
  "porter","sailor","sailors","peasant","peasants","shepherd","shepherds",
  "shepherdess","nymph","nymphs","witch","witches","ghost","ghosts","spirit",
  "spirits","fairy","fairies","robber","robbers","watchman","watch","guard",
  "guards","slave","slaves","beggar","beggars","gentleman","gentlemen","lady",
  "ladies","boy","boys","girl","girls","child","children","priest","priests",
  "friar","friars","monk","nun","drawer","huntsman","tavern keeper","landlord",
  "landlady","constable","jailer","executioner","doctor","apothecary","lawyer",
  "notary","merchant","farmer","butler","coachman","footmen"
]);
const TITLE_WORDS = new Set([
  "king","queen","prince","princess","duke","duchess","earl","count","countess",
  "baron","baroness","sir","lord","lady","dame","marquis","marchioness",
  "emperor","empress","sultan","sultana","bishop","pope","cardinal","general",
  "captain","colonel","lieutenant","sergeant","major","admiral","master"
]);
const ENSEMBLE_RX = [
  /^parts?$/i,/^principal characters$/i,/^(other )?characters$/i,/^unassigned$/i,
  /^dancers?$/i,/^singers?$/i,/^actors?$/i,/^&c\.?$/i,/^with the rest/i,
  /^the characters$/i
];

function classifyRole(role) {
  if (!role) return "empty";
  const low = role.toLowerCase().trim();
  if (!low) return "empty";
  if (PARATEXT.has(low)) return "paratext";
  for (const rx of ENSEMBLE_RX) if (rx.test(low)) return "ensemble";
  if (GENERIC_WORDS.has(low)) return "generic";
  if (TITLE_WORDS.has(low)) return "titled";
  return "named";
}

// ---- Slugifier -------------------------------------------------------------
// Produces a URL-safe, roughly human-readable slug, deterministic per role.
// Appends a short hash so distinct roles that collapse to the same slug stay
// distinct (e.g. "Marcellus" and "Marcelluş").
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}
function slugifyRole(role) {
  const base = role
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "role";
  return base + "-" + fnv1a(role);
}

// ---- Load ------------------------------------------------------------------
console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");

function yearOf(date) {
  if (!date || date.length < 4) return null;
  const y = +date.slice(0, 4);
  return y || null;
}
function decadeOf(y) { return y ? Math.floor(y / 10) * 10 : null; }

// roles.get(roleName) = aggregate
const roles = new Map();

function getOrMake(name) {
  let r = roles.get(name);
  if (!r) {
    r = {
      name,
      category: classifyRole(name),
      total: 0,
      firstYear: null,
      lastYear: null,
      byDecade: new Map(),             // decade -> count
      performers: new Map(),           // name -> { count, firstYear, lastYear }
      works: new Map(),                // workId -> { count }
      workTitles: new Map(),           // workId -> Map(title -> count) (for best title)
      theatres: new Map()              // code -> count
    };
    roles.set(name, r);
  }
  return r;
}

for (const ev of events) {
  const year = yearOf(ev.EventDate);
  const decade = decadeOf(year);
  const code = (ev.TheatreCode || "").toLowerCase();

  for (const perf of (ev.Performances || [])) {
    const workId = perf.WorkId || null;
    const title = cleanTitle(perf.PerformanceTitle);
    for (const c of (perf.cast || [])) {
      const role = cleanRole(c.Role);
      if (!role) continue;
      // Comma-list Performer credits multiple names for the same role
      // assignment in this performance.
      const names = extractPerformers(c.Performer);

      const r = getOrMake(role);
      r.total++;
      if (year != null) {
        if (r.firstYear == null || year < r.firstYear) r.firstYear = year;
        if (r.lastYear  == null || year > r.lastYear)  r.lastYear  = year;
      }
      if (decade != null) r.byDecade.set(decade, (r.byDecade.get(decade) || 0) + 1);

      for (const name of names) {
        let p = r.performers.get(name);
        if (!p) { p = { count: 0, firstYear: null, lastYear: null }; r.performers.set(name, p); }
        p.count++;
        if (year != null) {
          if (p.firstYear == null || year < p.firstYear) p.firstYear = year;
          if (p.lastYear  == null || year > p.lastYear)  p.lastYear  = year;
        }
      }

      if (workId) {
        let w = r.works.get(workId);
        if (!w) { w = { count: 0 }; r.works.set(workId, w); }
        w.count++;
        if (title) {
          let tm = r.workTitles.get(workId);
          if (!tm) { tm = new Map(); r.workTitles.set(workId, tm); }
          tm.set(title, (tm.get(title) || 0) + 1);
        }
      }

      if (code) r.theatres.set(code, (r.theatres.get(code) || 0) + 1);
    }
  }
}

// ---- Flatten ---------------------------------------------------------------
function topEntries(map, n, keyField) {
  const arr = [...map.entries()].map(([k, v]) => ({ key: k, val: v }));
  arr.sort((a, b) => (b.val.count || b.val) - (a.val.count || a.val));
  return arr.slice(0, n).map(e => {
    if (typeof e.val === "number") {
      const out = { count: e.val }; out[keyField] = e.key; return out;
    }
    const out = { count: e.val.count };
    if (e.val.firstYear != null) out.firstYear = e.val.firstYear;
    if (e.val.lastYear  != null) out.lastYear  = e.val.lastYear;
    out[keyField] = e.key;
    return out;
  });
}
function topTitle(m) {
  if (!m) return null;
  let best = null, bestN = -1;
  for (const [k, n] of m) if (n > bestN) { best = k; bestN = n; }
  return best;
}

const DETAIL_MIN = 5;
const ACCEPT_CATS = new Set(["named", "titled"]);

const index = [];
let kept = 0, skipped = 0;

const slugSeen = new Set();

for (const [name, r] of roles) {
  const cat = r.category;

  // Index line for every classified-enough role — used by the list page
  // and for search autocomplete.
  if (cat !== "empty") {
    const slug = slugifyRole(name);
    index.push({
      name,
      slug,
      category: cat,
      count: r.total,
      firstYear: r.firstYear,
      lastYear:  r.lastYear,
      detail: ACCEPT_CATS.has(cat) && r.total >= DETAIL_MIN
    });
  }

  if (!ACCEPT_CATS.has(cat) || r.total < DETAIL_MIN) { skipped++; continue; }

  const slug = slugifyRole(name);
  if (slugSeen.has(slug)) {
    // Should be rare thanks to fnv suffix, but log if it ever fires.
    console.warn("[role-details] slug collision:", slug, name);
  }
  slugSeen.add(slug);

  const byDecade = {};
  for (const [d, n] of r.byDecade) byDecade[d] = n;

  const topPerformers = topEntries(r.performers, 40, "name");
  const topTheatres   = topEntries(r.theatres,   10, "code");

  const topWorksRaw = [...r.works.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12);
  const topWorks = topWorksRaw.map(([id, v]) => ({
    workId: id,
    title: topTitle(r.workTitles.get(id)) || "(untitled)",
    count: v.count
  }));

  const record = {
    name,
    slug,
    category: cat,
    total: r.total,
    firstYear: r.firstYear,
    lastYear:  r.lastYear,
    performerCount: r.performers.size,
    workCount:      r.works.size,
    theatreCount:   r.theatres.size,
    byDecade,
    topPerformers,
    topWorks,
    topTheatres
  };
  const json = JSON.stringify(record);
  writeFileSync(resolve(SHARD_DIR_BUILD, slug + ".json"), json);
  writeFileSync(resolve(SHARD_DIR_WEB,   slug + ".json"), json);
  kept++;
}

// Sort index by count desc so the browse page can slice the top freely.
index.sort((a, b) => b.count - a.count);

const indexDoc = {
  _meta: {
    description: "Every role classified as named/titled/generic/paratext/ensemble. `detail: true` means a biography shard exists at data/roles/by-slug/<slug>.json. Sorted by count desc.",
    generated: new Date().toISOString().slice(0, 10),
    total: index.length,
    rolesInDetail: kept,
    rolesBelowThreshold: skipped,
    detailMin: DETAIL_MIN,
    categories: [...ACCEPT_CATS]
  },
  roles: index
};

writeFileSync(resolve(OUT_DIR, "role-index.json"), JSON.stringify(indexDoc));
writeFileSync(resolve(WEB_DIR, "role-index.json"), JSON.stringify(indexDoc));

console.log(`roles kept (detail pages): ${kept.toLocaleString()}`);
console.log(`roles skipped (low count / wrong cat): ${skipped.toLocaleString()}`);
console.log(`index entries: ${index.length.toLocaleString()}`);
console.log("done.");
