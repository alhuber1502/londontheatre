// Shared cleaners for raw LSDB text fields (Performer, Role, PerformanceTitle,
// CommentP/CommentC). Built to replace the historical pattern of reading the
// pre-stripped `*Clean` siblings, which had a botched HTML stripper that left
// stray lowercase `i` characters at word boundaries ("Aingeli" instead of
// "Aingel" from "<i>Aingel</i>") and also discarded apostrophes and other
// punctuation that turn out to matter for display.
//
// Audit context (data/LondonStageFull.json, 116k performances, 798k cast slots):
//   - non-Clean fields are a strict superset of Clean (0 Clean-only rows)
//   - 3,449 cast slots have Performer but no PerformerClean
//   - Clean dropped apostrophes ("Beggar's Opera" -> "Beggars Opera")
//   - Clean has the stray-i bug on roles wrapped in <i>...</i>
//
// Cleaning rules applied here:
//   1. Strip well-formed <i>...</i> tags around inline italics — keep contents.
//   2. Defensively remove any orphan <i> / </i> half-tags (rare but they exist).
//   3. Strip the `$...=` LSDB sigil (originally meant to flag author tokens).
//   4. Strip the standalone `=` and `$` sigils that occasionally appear on
//      their own at the end of names / titles (e.g. "Cariolo=").
//   5. Performer/role names: drop trailing punctuation `.`, `?`, `?.` (LSDB
//      uses these to mark uncertain attributions — Clean stripped them).
//   6. Role names also drop a leading date-stub prefix like
//      "20010501 but " (carried over from the existing cleanRolePrefix).
//   7. Trim and collapse whitespace.

import { readFileSync } from "node:fs";

const RE_ITALIC_PAIR  = /<i>([\s\S]*?)<\/i>/g;
const RE_ITALIC_ANY   = /<\/?i>/g;
const RE_SIGIL_DOLLAR = /\$(?:[A-Za-z]\$)?([^=\n]+?)=/g;
const RE_TRAIL_SIGIL  = /[=$]+\s*$/;
const RE_TRAIL_DASH   = /-\s*$/;
const RE_TRAIL_UNCERT = /[?.]+\s*$/;
const RE_ROLE_PREFIX  = /^(?:(?:as|see)\s*)?\d{4,8}\s*(?:but\s*|cg\s*)?/i;
const RE_WS_COLLAPSE  = /\s+/g;
// Leading LSDB encoding sigils that drift onto names: $Cartwright, _Norris,
// +Pelling, ,Decorations, ?WhatIsThis. Strip them before validation.
const RE_LEAD_SIGIL   = /^[$_+,?\s]+/;
// Stop-words that mark a candidate as NOT a person's name. Used inside the
// strict per-piece check applied to comma-list splits — accepting "the Widow"
// as a performer would flood the dataset with false positives.
const RE_NAME_STOP    = /^(the|a|an|and|but|with|in|on|at|of|for|from|by|to|is|was|see|edition|prologue|epilogue|no|or|so|pp\.|fl\.|ca\.)\s/i;

function stripItalics(s) {
  return s.replace(RE_ITALIC_PAIR, "$1").replace(RE_ITALIC_ANY, "");
}

function stripSigils(s) {
  return s.replace(RE_SIGIL_DOLLAR, "$1");
}

function squashWS(s) {
  return s.replace(RE_WS_COLLAPSE, " ").trim();
}

// Strip path-dangerous characters (slash, backslash) — these mostly originate
// from LSDB rows where a multi-performer note ("Burton//Charlotte-Miss De Camp")
// or a compound entry ("Brett / Ursula-Mrs Love") leaked into the field.
// Stripping makes the value safe for use as a filesystem shard key.
const RE_PATH_CHARS = /[\\/]+/g;

// Apply the full strip pipeline without any splitting or validation. Useful
// when iterating comma-split pieces inside extractPerformers.
function stripPerformer(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = stripItalics(s);
  s = stripSigils(s);
  s = s.replace(RE_PATH_CHARS, " ");
  s = s.replace(RE_TRAIL_SIGIL, "");
  s = s.replace(RE_TRAIL_UNCERT, "");
  s = s.replace(RE_LEAD_SIGIL, "");
  return squashWS(s);
}

// Strict "really looks like a person's name" — Title-case start, no stop
// word, no embedded year/page number, length within a plausible range, and
// not too many words (real LSDB performer names are 1–4 words: Mrs/Mr +
// surname, occasionally a Jr/Sen modifier, sometimes "Mas." prefixes).
// The `maxLen` parameter lets the single-entry case relax the length cap
// slightly to accommodate compound titles.
const RE_EMBEDDED_VERB = /\b(is|are|was|were|has|have|had|incident|Address|Scene|Edition|Prologue|Epilogue)\b/i;
function looksLikeName(s, maxLen) {
  if (!s) return false;
  const limit = maxLen || 40;
  if (s.length < 2 || s.length > limit) return false;
  if (!/^[A-Z]/.test(s)) return false;
  if (RE_NAME_STOP.test(s)) return false;
  if (/\d{3,}/.test(s)) return false;
  if (s.split(/\s+/).length > 4) return false;
  if (RE_EMBEDDED_VERB.test(s)) return false;
  return true;
}

// Case-canonicalization map: folds performer names that differ only by
// letter-case onto a single dominant spelling (see build-performer-canon.mjs).
// Loaded once at module init; absent file (e.g. before the first build) is
// treated as an empty map so extraction still works.
const NAME_CASE_CANON = (() => {
  try {
    const url = new URL("./performer-name-canon.json", import.meta.url);
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    return {};
  }
})();

// Raw cast extractor — returns cleaned performer names WITHOUT case folding.
// Returns an array: empty if the field carries no recoverable names, one entry
// for the usual single-performer case, multiple entries for a comma-separated
// cast list (e.g. "King, Moody, Parsons").
//
// Comma-list policy: split on `,`, clean each piece, require EVERY piece to
// look like a name. If any piece fails (a year, a citation, a sentence
// fragment), discard the whole row rather than emit a mix of real and fake
// performers — single-entry quality wins over recovered list quantity.
//
// Used by build-performer-canon.mjs to compute the canonical map; everything
// else should call extractPerformers (below), which also folds case-variants.
export function extractPerformersRaw(raw) {
  const cleaned = stripPerformer(raw);
  if (!cleaned) return [];
  if (cleaned.indexOf(",") === -1) {
    // Single-entry: same shape as a comma-split piece, but the length cap is
    // relaxed (60 instead of 40) to accommodate compound titles.
    return looksLikeName(cleaned, 60) ? [cleaned] : [];
  }
  const pieces = cleaned.split(",").map(stripPerformer).filter(Boolean);
  if (pieces.length < 2) return [];
  if (!pieces.every(p => looksLikeName(p))) return [];
  return pieces;
}

// Primary entry-point for cast iteration: raw extraction + case folding, so
// "Dupre"/"DuPre" and friends collapse to one canonical performer everywhere.
export function extractPerformers(raw) {
  const names = extractPerformersRaw(raw);
  for (let i = 0; i < names.length; i++) {
    const canon = NAME_CASE_CANON[names[i]];
    if (canon) names[i] = canon;
  }
  return names;
}

// Backwards-compatible single-string accessor: returns the first valid
// performer name, or "" if none. Kept for occasional consumers that only
// want one value and don't want to walk an array.
export function cleanPerformer(raw) {
  const arr = extractPerformers(raw);
  return arr.length ? arr[0] : "";
}

// Role: like performer but also drops the date-stub prefix used by LSDB to
// flag where a role first appears (e.g. "20010501 but Cassio"). Strips the
// same leading sigils, but does NOT split on commas — role descriptions like
// "a Boy, sings" are legitimate.
export function cleanRole(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = stripItalics(s);
  s = stripSigils(s);
  s = s.replace(RE_ROLE_PREFIX, "");
  s = s.replace(RE_TRAIL_SIGIL, "");
  s = s.replace(RE_TRAIL_UNCERT, "");
  s = s.replace(RE_LEAD_SIGIL, "");
  return squashWS(s);
}

// Performance / work title: preserves apostrophes, commas, semicolons that
// the Clean fields wrongly drop. Strips italics, sigils, trailing dashes,
// and a leading `[` (LSDB encoding artefact — most often unpaired, marking
// an interpolated or interpreted form; e.g. "[The Lying Valet" alongside
// "The Lying Valet" for the same WorkId). Does NOT strip trailing `.` or
// `?` — those can be intentional punctuation in titles ("Who Wants a Guinea?").
const RE_LEAD_BRACKET = /^\[+\s*/;
export function cleanTitle(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = stripItalics(s);
  s = stripSigils(s);
  s = s.replace(RE_LEAD_BRACKET, "");
  s = s.replace(RE_TRAIL_SIGIL, "");
  s = s.replace(RE_TRAIL_DASH, "");
  return squashWS(s);
}

// Comment / free-text fields (CommentP, CommentC): preserves all interior
// punctuation, only strips inline italics and the $...= sigil pattern.
// Whitespace is preserved (not collapsed) because line breaks matter for
// downstream regex extractors like extract-comments.mjs.
export function cleanComment(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = stripItalics(s);
  s = stripSigils(s);
  return s.trim();
}

// Pick the best canonical title from a Map<cleanedTitle, count> of variants
// seen across all performances of a single WorkId. LSDB often carries two
// spellings of the same title — e.g. "The Lover's Opera" (14×) and "The
// Lovers Opera" (81×). A naive "most common wins" picks the apostrophe-less
// version. This helper groups variants by a punctuation-stripped skeleton,
// picks the skeleton with the highest total count, and within that group
// prefers the variant whose presentation is richest: apostrophes first,
// then total non-alphanumeric punctuation, then the longer string, then
// occurrence count as a tiebreak.
export function pickCanonicalTitle(titlesMap) {
  if (!titlesMap || titlesMap.size === 0) return null;
  const groups = new Map(); // skeleton -> { totalCount, variants: Array<{title, count}> }
  for (const [title, count] of titlesMap) {
    if (!title) continue;
    // Strip apostrophes (ASCII + typographic) entirely so "Lover's" matches
    // "Lovers". Then collapse remaining punctuation to a single space.
    const skeleton = title.toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    let g = groups.get(skeleton);
    if (!g) { g = { totalCount: 0, variants: [] }; groups.set(skeleton, g); }
    g.totalCount += count;
    g.variants.push({ title, count });
  }
  if (groups.size === 0) return null;
  // 1. Most-common skeleton wins.
  let bestGroup = null;
  for (const g of groups.values()) {
    if (!bestGroup || g.totalCount > bestGroup.totalCount) bestGroup = g;
  }
  // 2. Within that skeleton, pick the variant with the richest punctuation.
  const variants = bestGroup.variants.slice().sort((a, b) => {
    const apA = (a.title.match(/'/g) || []).length;
    const apB = (b.title.match(/'/g) || []).length;
    if (apB !== apA) return apB - apA;
    const punA = (a.title.match(/[^A-Za-z0-9\s]/g) || []).length;
    const punB = (b.title.match(/[^A-Za-z0-9\s]/g) || []).length;
    if (punB !== punA) return punB - punA;
    if (b.title.length !== a.title.length) return b.title.length - a.title.length;
    return b.count - a.count;
  });
  return variants[0].title;
}
