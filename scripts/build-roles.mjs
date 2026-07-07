#!/usr/bin/env node
// Layer E — Role taxonomy. Classifies every Role string into a small
// category set and every performer into a likely gender, then emits summary
// counts and per-performer profiles suitable for client-side filtering.
//
// Categories (roles):
//   paratext  — Prologue, Epilogue, Chorus, Induction, Speaker
//   ensemble  — Parts, Principal Characters, unassigned, Dancers, Singers, &c
//   generic   — anonymous functional parts (Servant, Maid, Soldier, Ghost...)
//   titled    — bare rank/title with no given name (King, Queen, Duke, Sir...)
//   named     — any other proper character name
//   empty     — blank
//
// Genders (performers):
//   female         — Mrs/Miss/Mme/Mlle/Signora/Madame/Lady prefix
//   male-child     — Master prefix
//   male-explicit  — Mr/Signor/Mons prefix
//   male-inferred  — bare surname (period convention)
//   company        — rows like "The Company", "Gentlemen", "Dancers"
//   unknown        — empty / unparseable
//
// Run: node --max-old-space-size=3072 scripts/build-roles.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPerformers, cleanRole } from "./lib/lsdb-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "data/LondonStageFull.json");
const OUT_DIR = resolve(ROOT, "build/roles");
const WEB_DIR = resolve(ROOT, "web/data/roles");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(WEB_DIR, { recursive: true });

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");

// ---- Role classifier -------------------------------------------------------
const PARATEXT = new Set([
  "prologue", "epilogue", "chorus", "induction", "speaker",
  "occasional prologue", "occasional epilogue", "new prologue", "new epilogue"
]);

// Bare anonymous functional parts — the role IS the function, no proper name.
const GENERIC_WORDS = new Set([
  "servant", "servants", "maid", "maids", "footman", "cook", "gardener",
  "soldier", "soldiers", "officer", "officers", "messenger", "page", "pages",
  "nurse", "waiter", "porter", "sailor", "sailors", "peasant", "peasants",
  "shepherd", "shepherds", "shepherdess", "nymph", "nymphs", "witch", "witches",
  "ghost", "ghosts", "spirit", "spirits", "fairy", "fairies", "robber", "robbers",
  "watchman", "watch", "guard", "guards", "slave", "slaves", "beggar", "beggars",
  "soldier's wife", "gentleman", "gentlemen", "lady", "ladies", "boy", "boys",
  "girl", "girls", "child", "children", "priest", "priests", "friar", "friars",
  "monk", "nun", "drawer", "huntsman", "tavern keeper", "landlord", "landlady",
  "constable", "jailer", "executioner", "doctor", "apothecary", "lawyer",
  "notary", "merchant", "farmer", "butler", "coachman", "footmen"
]);

// Bare titles with no following given name. "King" alone = titled; "King Lear"
// or "King Henry" = named.
const TITLE_WORDS = new Set([
  "king", "queen", "prince", "princess", "duke", "duchess", "earl", "count",
  "countess", "baron", "baroness", "sir", "lord", "lady", "dame", "marquis",
  "marchioness", "emperor", "empress", "sultan", "sultana", "bishop", "pope",
  "cardinal", "general", "captain", "colonel", "lieutenant", "sergeant",
  "major", "admiral", "master"
]);

const ENSEMBLE_PATTERNS = [
  /^parts?$/i,
  /^principal characters$/i,
  /^(other )?characters$/i,
  /^unassigned$/i,
  /^dancers?$/i,
  /^singers?$/i,
  /^actors?$/i,
  /^&c\.?$/i,
  /^with the rest/i,
  /^the rest/i,
  /^others?$/i
];

function classifyRole(raw) {
  const s = (raw || "").trim();
  if (!s) return "empty";
  const lc = s.toLowerCase();
  if (PARATEXT.has(lc)) return "paratext";
  for (const re of ENSEMBLE_PATTERNS) if (re.test(s)) return "ensemble";
  if (GENERIC_WORDS.has(lc)) return "generic";
  // Bare title (one word, in the title list)
  if (TITLE_WORDS.has(lc)) return "titled";
  // "King"/"Lord"/"Sir" plus nothing else is titled; with a name it's named.
  return "named";
}

// ---- Performer gender classifier -------------------------------------------
const FEMALE_PREFIX = /^(Mrs|Miss|Madame|Mme|Mlle|Mademoiselle|Signora|Lady|Dame)\b/i;
const MALE_CHILD_PREFIX = /^(Master)\b/i;
const MALE_EXPLICIT_PREFIX = /^(Mr|Monsieur|Mons|Signor|Herr|Don)\b/i;
const COMPANY_PATTERNS = [
  /^(the\s+)?company\b/i,
  /^gentlemen\b/i,
  /^ladies\b/i,
  /^dancers?\b/i,
  /^singers?\b/i,
  /^chorus\b/i,
  /^actors?\b/i,
  /^unassigned\b/i
];

function classifyPerformer(raw) {
  const s = (raw || "").trim();
  if (!s) return "unknown";
  for (const re of COMPANY_PATTERNS) if (re.test(s)) return "company";
  if (FEMALE_PREFIX.test(s)) return "female";
  if (MALE_CHILD_PREFIX.test(s)) return "male-child";
  if (MALE_EXPLICIT_PREFIX.test(s)) return "male-explicit";
  return "male-inferred";
}

// ---- Walk cast -------------------------------------------------------------
// roleCounts[category] = total rows
// roleTop[category]    = Map(roleString -> count) — trimmed to top N at end
// performers[name]     = { gender, total, byCat: {...}, topRoles: Map }
const roleCounts = { paratext: 0, ensemble: 0, generic: 0, titled: 0, named: 0, empty: 0 };
const roleTop    = { paratext: new Map(), ensemble: new Map(), generic: new Map(), titled: new Map(), named: new Map() };
const performers = new Map();
const genderCounts = { female: 0, "male-child": 0, "male-explicit": 0, "male-inferred": 0, company: 0, unknown: 0 };

let castRows = 0;

// Collision detector: a performer name that appears at ≥2 different theatres
// on the same date is definitionally not one person. We record how many
// such nights each name has so the UI can flag a record as a probable
// conflation and the caveat banner can cite a concrete number.
const perfNightTheatres = new Map(); // `${date}::${name}` -> Set(theatreCode)

for (const ev of events) {
  const perfs = ev.Performances || [];
  const date = ev.EventDate || "";
  const theatreCode = (ev.TheatreCode || "").toLowerCase();
  const year = date.length >= 4 ? +date.slice(0, 4) : null;
  const decade = year ? Math.floor(year / 10) * 10 : null;

  for (const p of perfs) {
    const cast = p.cast || [];
    for (const c of cast) {
      castRows++;
      const role = cleanRole(c.Role);
      const cat = classifyRole(role);
      roleCounts[cat]++;
      if (role && cat !== "empty") {
        roleTop[cat].set(role, (roleTop[cat].get(role) || 0) + 1);
      }

      // A comma-list Performer ("King, Moody, Parsons") credits each name
      // for this performance independently. The role is per cast slot, so
      // all credited names share it.
      for (const name of extractPerformers(c.Performer)) {
        let prof = performers.get(name);
        if (!prof) {
          const gender = classifyPerformer(name);
          prof = {
            gender,
            total: 0,
            byCat: { paratext: 0, ensemble: 0, generic: 0, titled: 0, named: 0, empty: 0 },
            roleHits: new Map(),
            byDecade: new Map(),      // decade -> count
            firstYear: null,
            lastYear: null,
            collisionNights: 0        // counted in pass-2 below
          };
          performers.set(name, prof);
          genderCounts[gender]++;
        }
        prof.total++;
        prof.byCat[cat]++;
        if (role) prof.roleHits.set(role, (prof.roleHits.get(role) || 0) + 1);

        if (decade != null) prof.byDecade.set(decade, (prof.byDecade.get(decade) || 0) + 1);
        if (year != null) {
          if (prof.firstYear == null || year < prof.firstYear) prof.firstYear = year;
          if (prof.lastYear  == null || year > prof.lastYear)  prof.lastYear  = year;
        }

        if (date && theatreCode) {
          const k = date + "::" + name;
          let s = perfNightTheatres.get(k);
          if (!s) { s = new Set(); perfNightTheatres.set(k, s); }
          s.add(theatreCode);
        }
      }
    }
  }
}

// Tally collision nights per performer.
for (const [k, theatres] of perfNightTheatres) {
  if (theatres.size < 2) continue;
  const name = k.slice(k.indexOf("::") + 2);
  const prof = performers.get(name);
  if (prof) prof.collisionNights++;
}

// ---- Flatten top-roles maps -----------------------------------------------
function topEntries(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([role, count]) => ({ role, count }));
}

const taxonomy = {
  _meta: {
    description: "Role taxonomy: every cast row classified as paratext/ensemble/generic/titled/named/empty, plus performer-gender inference from honorific. Read alongside graphs and performers files.",
    generated: new Date().toISOString().slice(0, 10),
    castRows,
    uniquePerformers: performers.size,
    categories: {
      paratext: "Prologue, Epilogue, Chorus, Induction, Speaker",
      ensemble: "Parts / Principal Characters / Dancers / Singers / &c",
      generic:  "Anonymous functional roles (Servant, Soldier, Ghost...)",
      titled:   "Bare rank or title with no given name (King, Duke, Sir...)",
      named:    "Proper character name",
      empty:    "Blank Role"
    },
    genderNote: "male-inferred = bare surname, consistent with period naming. Treat as likely-but-not-certain."
  },
  roleCategoryTotals: roleCounts,
  genderTotals: genderCounts,
  top: {
    paratext: topEntries(roleTop.paratext, 20),
    ensemble: topEntries(roleTop.ensemble, 20),
    generic:  topEntries(roleTop.generic, 40),
    titled:   topEntries(roleTop.titled, 20),
    named:    topEntries(roleTop.named, 60)
  }
};

// ---- Per-performer profiles ------------------------------------------------
// Keep only performers with >=2 appearances to keep file tractable; single-hit
// performers are preserved in the graph layer anyway.
const profiles = [];
for (const [name, p] of performers) {
  if (p.total < 2) continue;
  const topRoles = topEntries(p.roleHits, 8);
  const byDecade = {};
  for (const [dec, n] of p.byDecade) byDecade[dec] = n;
  profiles.push({
    name,
    gender: p.gender,
    total: p.total,
    byCat: p.byCat,
    topRoles,
    firstYear: p.firstYear,
    lastYear:  p.lastYear,
    byDecade,
    collisionNights: p.collisionNights
  });
}
profiles.sort((a, b) => b.total - a.total);

const performerDoc = {
  _meta: {
    description: "Per-performer aggregate over the full 1660-1800 corpus. Filters to performers with >=2 cast appearances. byCat sums role-category hits; topRoles lists their 8 most-frequent role strings.",
    generated: new Date().toISOString().slice(0, 10),
    totalProfiles: profiles.length
  },
  profiles
};

// ---- Write -----------------------------------------------------------------
// taxonomy.json is a build-time debug artefact; nothing in web/ consumes it,
// so it lives only under build/.
writeFileSync(resolve(OUT_DIR, "taxonomy.json"), JSON.stringify(taxonomy, null, 2));
writeFileSync(resolve(OUT_DIR, "performers.json"), JSON.stringify(performerDoc));
writeFileSync(resolve(WEB_DIR, "performers.json"), JSON.stringify(performerDoc));

// ---- Report ----------------------------------------------------------------
console.log(`cast rows:         ${castRows.toLocaleString()}`);
console.log(`unique performers: ${performers.size.toLocaleString()}`);
console.log(`profiles emitted:  ${profiles.length.toLocaleString()} (>=2 appearances)`);
console.log("");
console.log("role categories:");
for (const [k, v] of Object.entries(roleCounts)) {
  const pct = (v * 100 / castRows).toFixed(1);
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(7).replace(/\d(?=(\d{3})+$)/g, "$&,")}  (${pct}%)`);
}
console.log("");
console.log("performer genders:");
for (const [k, v] of Object.entries(genderCounts)) {
  const pct = (v * 100 / performers.size).toFixed(1);
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}  (${pct}%)`);
}
console.log("");
console.log("done.");
