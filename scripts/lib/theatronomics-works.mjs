// Shared loader / joiner for data/theatronomics/works-with-authors.json.
//
// Background: the Theatronomics Galway API (data-theatronomics.universityofgalway.ie)
// returns works with their own internal IDs, which only partially overlap with
// LSDB WorkIds. About 1,033 works match by ID and title; another ~98 only
// match if we fall back to title-based comparison (Hamlet, Richard III,
// King Lear and many other major plays sit in this bucket because LSDB has
// duplicate WorkIds for them and TX mapped to the less-performed variant).
//
// The business-API URL pattern (data.theatronomics.com/plays/N) DOES use
// LSDB WorkIds, but we don't have an API key for that endpoint.
//
// Exports:
//   loadTxWorks()                  → Map<txId, txBlock>           — raw, keyed by TX id
//   joinTxToLsdb(lsdbTitleMap)     → Map<lsdbWorkId, txBlock>     — joined, ready to attach
//   slimTx(txBlock)                → { genre, authors }           — for list contexts
//
// About 1,973 fields in the API response come back as the string "NULL"
// instead of JSON null; this module strips them.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TX_PATH = resolve(__dirname, "..", "..", "data/theatronomics/works-with-authors.json");

function clean(v) {
  return (v == null || v === "NULL" || v === "") ? null : v;
}

// Aggressive normaliser used for the title-based fallback. Drops articles,
// "; or, ..." subtitles, regnal prefixes ("King", "Queen", "Prince"), and
// all non-alphanumerics so e.g. "The Rover; or, The Banished Cavaliers"
// matches LSDB's "The Rover" and "Richard III" matches "King Richard Iii".
function normTitle(t) {
  if (!t) return "";
  return t.toLowerCase()
    .replace(/;\s*or,?.*$/, "")
    .replace(/^(the|a|an)\s+/, "")
    .replace(/^(king|queen|prince|princess)\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function buildTxBlock(w) {
  const genreLabel       = clean(w.genre?.label);
  const genreDescription = clean(w.genre?.description);
  const genre = (w.genre && (genreLabel || genreDescription))
    ? { id: w.genre.id ?? null, label: genreLabel, description: genreDescription }
    : null;

  const persons = (w.persons || []).map(p => {
    const lat = clean(p.geo?.latitude);
    const lon = clean(p.geo?.longitude);
    return {
      id:       p.person_id ?? null,
      name:     clean(p.name),
      slug:     clean(p.slug),
      label:    clean(p.activity_label),
      gender:   clean(p.gender),
      bornDate: clean(p.start_date),
      bornType: clean(p.start_type),
      diedDate: clean(p.end_date),
      diedType: clean(p.end_type),
      country:  clean(p.place_of_birth_country),
      locality: clean(p.place_of_birth_locality),
      lat: lat != null ? Number(lat) : null,
      lon: lon != null ? Number(lon) : null,
      viaf: clean(p.links?.viaf),
      wiki: clean(p.links?.wikipedia),
      odnb: clean(p.links?.odnb),
    };
  }).filter(p => p.name);

  return {
    genre,
    medium:       clean(w.performance_medium),
    type1:        clean(w.type_1),
    type2:        clean(w.type_2),
    source1:      clean(w.source_1),
    source2:      clean(w.source_2),
    notes:        clean(w.notes),
    pubDate:      clean(w.publication_date),
    firstPerf:    clean(w.first_performed_date),
    titleVariant: clean(w.title_variant),
    dateType:     clean(w.date_type),
    persons,
  };
}

// Lazy cache of the raw TX file: load once even if multiple build scripts
// call loadTxWorks / joinTxToLsdb in the same process.
let _txRaw = null;
function loadTxRaw() {
  if (!_txRaw) _txRaw = JSON.parse(readFileSync(TX_PATH, "utf8"));
  return _txRaw;
}

// Map<txId, txBlock> — keyed by Theatronomics internal ID. Useful only if
// you already know you're working in TX-id space.
export function loadTxWorks() {
  const raw = loadTxRaw();
  const map = new Map();
  for (const w of raw) {
    if (w.id == null) continue;
    map.set(String(w.id), buildTxBlock(w));
  }
  return map;
}

// Join TX → LSDB. Pass in an iterable of [lsdbWorkId, lsdbTitle, lsdbTotal]
// triples (the third element is the LSDB performance count, used to pick
// the best candidate when one TX work matches multiple LSDB ids by title).
//
// Returns Map<lsdbWorkId, txBlock>. Workflow:
//   1. Primary pass: TX id == LSDB workId (covers ~1,033 works)
//   2. Fallback pass: normalised title match (covers ~98 more, including
//      Hamlet, Richard III, King Lear). For LSDB ids that already received
//      a primary match, the fallback skips them — we don't overwrite.
export function joinTxToLsdb(lsdbWorks) {
  const raw = loadTxRaw();

  // Build LSDB indexes.
  const lsdbById = new Map();
  const lsdbByTitle = new Map();   // normalisedTitle -> [{ id, total }]
  for (const [id, title, total] of lsdbWorks) {
    const sid = String(id);
    lsdbById.set(sid, { title: title || "", total: total || 0 });
    const k = normTitle(title || "");
    if (!k) continue;
    if (!lsdbByTitle.has(k)) lsdbByTitle.set(k, []);
    lsdbByTitle.get(k).push({ id: sid, total: total || 0 });
  }

  const joined = new Map();

  // Pass 1: direct id match.
  for (const w of raw) {
    if (w.id == null) continue;
    const sid = String(w.id);
    if (lsdbById.has(sid)) {
      joined.set(sid, buildTxBlock(w));
    }
  }

  // Pass 2: title fallback for TX works whose id didn't hit LSDB, or whose
  // id DID hit LSDB but landed on a different play (catches the duplicate-
  // workId case: Hamlet at LSDB 460 vs LSDB 634 — TX mapped to 634, but
  // 460 is the more-performed entry and deserves the attribution too).
  for (const w of raw) {
    if (w.id == null) continue;
    const k = normTitle(w.title || "");
    if (!k) continue;
    const candidates = lsdbByTitle.get(k);
    if (!candidates || !candidates.length) continue;
    // Sort by total perfs desc — when ambiguous, attach to the more-performed
    // LSDB workId (the famous variant), skipping any that already received a
    // primary id-match block.
    const sorted = candidates.slice().sort((a, b) => b.total - a.total);
    for (const c of sorted) {
      if (joined.has(c.id)) continue;
      joined.set(c.id, buildTxBlock(w));
      break; // only the highest-perf LSDB id gets the fallback attachment
    }
  }

  return joined;
}

// List-context summary: genre + comma-separated author names + a flag for
// "any woman author" (used by the Repertoire page's women-playwrights filter).
export function slimTx(tx) {
  if (!tx) return { genre: null, authors: null, hasWomanAuthor: false };
  const authorPersons = tx.persons.filter(p => p.label === "Author");
  const authors = authorPersons.map(p => p.name).join(", ") || null;
  const hasWomanAuthor = authorPersons.some(p => p.gender === "Woman");
  return {
    genre: tx.genre?.label || null,
    authors,
    hasWomanAuthor,
  };
}
