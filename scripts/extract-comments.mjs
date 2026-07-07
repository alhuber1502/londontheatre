#!/usr/bin/env node
// Layer C — Comment-mining regex pass over CommentC (event-level) and
// CommentP (performance-level). Emits build/comments-extracted.json with
// structured receipts, ticket prices, curtain times, benefit/half-price
// flags, authorship credits, and per-performance debut/farewell/revival
// signals.
//
// Run: node --max-old-space-size=2048 scripts/extract-comments.mjs

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const INPUT = resolve(ROOT, "data/LondonStageFull.json");
const OUT = resolve(ROOT, "build");
const WEB_DATA = resolve(ROOT, "web/data");
mkdirSync(OUT, { recursive: true });
mkdirSync(WEB_DATA, { recursive: true });

console.time("load");
const events = JSON.parse(readFileSync(INPUT, "utf8"));
console.timeEnd("load");
console.log(`events: ${events.length}`);

// ---- Helpers ----------------------------------------------------------------
// In CommentC the pound sign is ASCII `#` (legacy encoding). Pence is `d.`,
// shillings is `s.`. Amounts of the form `#X Ys. Zd.` are £X, Y shillings,
// Z pence. Some Vol 5 entries add parenthetical itemisations like
// `(217.3.0; 0.9.6)` which we ignore for now (they duplicate the headline).

function poundsToPence(p, s, d) {
  // 20 shillings to a pound, 12 pence to a shilling.
  return (p | 0) * 240 + (s | 0) * 12 + (d | 0);
}

function moneyObj(p, s, d) {
  // Strip thousands-separator commas (e.g. "#1,526") before coercing.
  const P = +(String(p || 0).replace(/,/g, '')) | 0;
  const S = s | 0, D = d | 0;
  return { pounds: P, shillings: S, pence: D, totalPence: poundsToPence(P, S, D) };
}

// ---- Receipt extraction -----------------------------------------------------
// Supports:
//   Receipts: #X Ys. Zd.
//   Receipts: #X Ys.
//   Receipts: #X.
//   Receipts: money #X Ys. Zd.; tickets #A Bs. Cd.
//   Receipts: money #X Ys. Zd. and tickets #A Bs. Cd.
// The label-ful multi-component form is mostly Vol 2/3 era.
// RECEIPTS_BLOCK stop condition: only stop at "." when NOT followed by a
// digit (continuing pence, e.g. "19s. 6d.") or "and " (the alternative
// money+tickets separator). This lets the full multi-component block
// "money #X Ys. Zd.; tickets #A Bs." be captured in one match.
// Also stop at "@" which is the line-break encoding in CommentC — amounts
// on subsequent lines (charges, renter payments, etc.) are not part of the
// headline receipt and must not be summed in.
const RECEIPTS_BLOCK = /Receipts:\s*([^\[\n\r@]{0,400}?)(?:\.(?!\s*(?:\d|and\s))(?:\s|$)|$|\r|\n|\[|@)/;
// AMOUNT: allow commas in pound figures (#1,526) and make the shillings
// period optional (s\.?) because RECEIPTS_BLOCK sometimes consumes it.
// The separator after the label is (?::\s+|\s+) to handle "charge: #N"
// as well as the plain "money #N" form. "charges?" covers singular
// "charge:" which marks expense deductions (excluded from income sum).
const AMOUNT = /(?:(money|tickets|charges?|profit|paid|profits?)(?::\s+|\s+))?#([\d,]+)(?:\s+(\d+)s\.?)?(?:\s+(\d+)d\.?)?/gi;

// Known single-event transcription errors in CommentC that cannot be fixed
// by the general regex preprocessor. Key = EventId string.
const COMMENTC_PATCHES = {
  // Rylands MS "#1000" is clearly £100: all surrounding DL nights in Sep 1741
  // agree exactly with Theatronomics (£120, £105, £103, £80, £69 …), and the
  // account book records exactly £100 for this date.
  "20714": text => text.replace("Receipts: #1000", "Receipts: #100"),
  // Dropped leading "1": "#002 3s" should be "#102 3s". Account-book
  // arithmetic confirms: charges £65 10s 6d + 2×profit £18 6s 3d = £102 3s.
  "37037": text => text.replace("Receipts: #002 3s", "Receipts: #102 3s"),
  // Spurious first "Receipts: #9 6s." (same figure as the preceding Printer's
  // Bill entry) before the authoritative "Receipts: #175 8s. (Treasurer's Book)".
  "36289": text => text.replace("Receipts: #9 6s.  Receipts: #175 8s.", "Receipts: #175 8s.")
};

// Fix space-drop encoding artefact: "#4314s." → "#43 14s."
// The digitised source occasionally dropped the space between the pound
// digits and the shilling digits. E.g. "£43 14s. 6d." became "#4314s. 6d."
// Rule: when 3+ digits immediately precede "s" (no space), treat the last
// 1–2 digits as shillings (last 2 if ≤ 19, otherwise last 1).
function fixConcatenatedShillings(body) {
  return body.replace(/#(\d{3,})(s\.?)/gi, (_, digits, suffix) => {
    const s2 = +digits.slice(-2);
    const sh = s2 <= 19 ? s2 : +digits.slice(-1);
    const pounds = digits.slice(0, s2 <= 19 ? -2 : -1);
    return "#" + pounds + " " + sh + suffix;
  });
}

// Fix OCR zero-substitution artefact: "#7O" → "#70", "#15O" → "#150".
// The Treasurer's marginal notes (Cross at DL, and others) are sometimes
// scanned such that the digit '0' is read as 'V' or 'O'.
// Only matches V/O immediately following digits and before whitespace or a
// shillings suffix, so ordinary uppercase letters are not disturbed.
function fixZeroSubstitute(body) {
  return body.replace(/#(\d+)([VO])(?=\s|s\.?|$)/gi, (_, digits, _ch) => '#' + digits + '0');
}

function extractReceipts(text, eventId) {
  if (!text || !text.includes("Receipts:")) return null;
  // Apply any known manual patch for this event.
  if (eventId && COMMENTC_PATCHES[eventId]) text = COMMENTC_PATCHES[eventId](text);
  const block = RECEIPTS_BLOCK.exec(text);
  if (!block) return null;
  // Normalise encoding artefacts before running the amount regex.
  // Strip ", as follows: …" narrative that itemises an already-stated total
  // (e.g. "Receipts: #386 7s., as follows: money #256 …").
  const body = fixZeroSubstitute(fixConcatenatedShillings(block[1]))
    .replace(/,\s*as\s+follows\b.*/i, "");
  const components = [];
  for (const m of body.matchAll(AMOUNT)) {
    const label = (m[1] || "").toLowerCase();
    components.push({
      label: label || "total",
      ...moneyObj(m[2], m[3], m[4])
    });
  }
  if (!components.length) return null;
  // If there's a single unlabelled component, treat it as the headline total.
  // If there are multiple labelled components, sum them for a total.
  let total;
  if (components.length === 1) {
    total = { pounds: components[0].pounds, shillings: components[0].shillings, pence: components[0].pence, totalPence: components[0].totalPence };
  } else {
    // sum only the income-side components — if BOTH money AND tickets are explicitly
    // labelled, an extra unlabelled amount is an alternative-source annotation (e.g.
    // "(Rylands MS.)"), not additional income, so exclude it; otherwise include unlabelled
    const hasExplicitMoney   = components.some(c => c.label === "money");
    const hasExplicitTickets = components.some(c => c.label === "tickets");
    const income = (hasExplicitMoney && hasExplicitTickets)
      ? components.filter(c => c.label === "money" || c.label === "tickets")
      : components.filter(c => ["money", "tickets", "total", ""].includes(c.label));
    const sumPence = income.reduce((s, c) => s + c.totalPence, 0);
    const P = Math.floor(sumPence / 240);
    const r1 = sumPence - P * 240;
    const S = Math.floor(r1 / 12);
    const D = r1 - S * 12;
    total = { pounds: P, shillings: S, pence: D, totalPence: sumPence };
  }
  return { total, components };
}

// ---- Ticket prices ----------------------------------------------------------
// Typical Vol 5 advert: `Boxes 5s. Pit 3s. 1st Gallery 2s. Upper Gallery 1s.`
// Sometimes `Slips 1s. 6d.`, sometimes with pence in pit like `Pit 2s. 6d.`.
const PRICE_PATTERNS = {
  boxes:         /Boxes\s+(\d+)s\.(?:\s+(\d+)d\.?)?/i,
  pit:           /Pit\s+(\d+)s\.(?:\s+(\d+)d\.?)?/i,
  firstGallery:  /(?:1st|First)\s+Gallery\s+(\d+)s\.(?:\s+(\d+)d\.?)?/i,
  upperGallery:  /Upper(?:\s+Gall(?:ery|\.))\s+(\d+)s\.(?:\s+(\d+)d\.?)?/i,
  slips:         /Slips?\s+(\d+)s\.(?:\s+(\d+)d\.?)?/i,
  secondGallery: /(?:2nd|Second)\s+Gallery\s+(\d+)s\.(?:\s+(\d+)d\.?)?/i
};

function extractPrices(text) {
  if (!text) return null;
  const prices = {};
  for (const [key, re] of Object.entries(PRICE_PATTERNS)) {
    const m = re.exec(text);
    if (m) prices[key] = moneyObj(0, m[1], m[2] || 0);
  }
  return Object.keys(prices).length ? prices : null;
}

// ---- Curtain times ----------------------------------------------------------
// `Doors opened at 5:30. To begin at 6:30.`
// `The Doors to be open'd at 5 a Clock, and the Play to begin at half an Hour after Six`
// `Begin exactly at Half Hour past Six.`
const DOORS = /Doors?\s+(?:to\s+be\s+)?(?:will\s+)?(?:be\s+)?(?:open(?:ed|'d)?)\s*(?:at)?\s*([A-Za-z0-9:\s]{0,24})/i;
const BEGIN = /(?:to\s+)?(?:Play\s+)?(?:begin|commence)s?\s+(?:exactly\s+)?(?:at\s+)?([A-Za-z0-9:\s]{0,24})/i;

function normaliseTime(raw) {
  if (!raw) return null;
  raw = raw.trim().replace(/\s+/g, " ");
  // Numeric forms: 5:30, 6:15, 5 30, 5, 6:3O (O for 0)
  const numeric = raw.replace(/O/g, "0").match(/^(\d{1,2})(?::(\d{2}))?/);
  if (numeric) {
    const h = +numeric[1];
    const m = numeric[2] ? +numeric[2] : 0;
    if (h >= 1 && h <= 12) return { h, m };
  }
  // Word forms: "Six", "half past Six", "half an Hour after Six", "a quarter past Six"
  const WORDS = {
    one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12
  };
  const low = raw.toLowerCase();
  const hourMatch = low.match(/(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/);
  if (!hourMatch) return null;
  const h = WORDS[hourMatch[1]];
  let m = 0;
  if (/half\s+(?:an\s+hour\s+)?(?:past|after)/.test(low)) m = 30;
  else if (/(a\s+)?quarter\s+past/.test(low)) m = 15;
  else if (/(a\s+)?quarter\s+(?:before|to)/.test(low)) m = -15;
  if (m < 0) return { h: h - 1, m: 45 };
  return { h, m };
}

function extractCurtain(text) {
  if (!text) return null;
  const out = {};
  const dm = DOORS.exec(text);
  if (dm) {
    const t = normaliseTime(dm[1]);
    if (t) out.doorsOpen = t;
  }
  const bm = BEGIN.exec(text);
  if (bm) {
    const t = normaliseTime(bm[1]);
    if (t) out.performanceStart = t;
  }
  return Object.keys(out).length ? out : null;
}

// ---- Benefit flag + beneficiary --------------------------------------------
// `for the benefit of Mr Garrick` / `Benefit of Mrs Clive and Mrs Pritchard`.
// Beneficiary is the stretch after "benefit of" up to `.`, `;`, ` and `, or ~60 chars.
const BENEFIT = /\b([Bb]enefit)\s+of\s+([^.;\[\n]{0,80})/;
const BENEFIT_FLAG = /\b[Bb]enefit\b/;

function extractBenefit(text) {
  if (!text || !BENEFIT_FLAG.test(text)) return null;
  const m = BENEFIT.exec(text);
  if (!m) return { flagged: true, beneficiary: null };
  // strip author-tag markers like $Name= and dollar-name encoding
  let bn = m[2].replace(/\$/g, "").replace(/=/g, "").trim();
  // cut at common trailing clauses
  bn = bn.replace(/\s+(?:and|with|at|on)\s+.*/i, "").trim();
  if (!bn || bn.length > 80) bn = null;
  return { flagged: true, beneficiary: bn };
}

// ---- Half-price notice -----------------------------------------------------
const HALF_PRICE = /\bhalf[-\s]?price\b/i;
function extractHalfPrice(text) {
  return text && HALF_PRICE.test(text) ? true : false;
}

// ---- Authorship credits -----------------------------------------------------
// Author tags in the corpus are wrapped in `$Name Name=` (dollar/equals).
// Look for "written by", "by Mr X", "Author", etc., then capture the
// nearest `$...=` tag on the right.
const AUTHOR_LEADIN = /\b(?:[Ww]ritten\s+by|[Bb]y\s+(?:Mr|Mrs|Miss|Dr)|[Aa]uthor(?:ed|:)?)\s*:?\s*\$([^=]+)=/;

function extractAuthors(text) {
  if (!text) return null;
  const names = [];
  // scan all occurrences
  const re = /(?:\bwritten\s+by|\bby\s+(?:Mr|Mrs|Miss|Dr\.?)\s*)\s*\$([^=]+)=/gi;
  for (const m of text.matchAll(re)) {
    const name = m[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names : null;
}

// ---- Performance-level flags: debut, farewell, revival gap -----------------
const DEBUT = /\b(?:first|1st)\s+appearance\b/i;
const DEBUT_ON_STAGE = /\b(?:first|1st)\s+appearance\s+(?:on|upon)\s+(?:this|the|any)?\s*stage\b/i;
const FAREWELL = /\blast\s+time\b/i;
const NOT_ACTED = /\bnot\s+acted\s+these\s+(\d+|\w+)\s+years?\b/i;
const FIRST_TIME_YEARS = /\bfirst\s+time\s+these\s+(\d+|\w+)\s+years?\b/i;

const WORD_NUM = {
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,
  seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50
};

function parseGapYears(raw) {
  if (!raw) return null;
  const n = +raw;
  if (!Number.isNaN(n)) return n;
  const w = WORD_NUM[raw.toLowerCase()];
  return w || null;
}

function extractPerformanceFlags(text) {
  if (!text) return null;
  const flags = {};
  if (DEBUT_ON_STAGE.test(text)) flags.debut = "stage";
  else if (DEBUT.test(text)) flags.debut = "role";
  if (FAREWELL.test(text)) flags.farewell = true;
  const m1 = NOT_ACTED.exec(text);
  if (m1) {
    const y = parseGapYears(m1[1]);
    if (y) flags.revivalGap = y;
  } else {
    const m2 = FIRST_TIME_YEARS.exec(text);
    if (m2) {
      const y = parseGapYears(m2[1]);
      if (y) flags.revivalGap = y;
    }
  }
  return Object.keys(flags).length ? flags : null;
}

// ---- Extract across the whole dataset --------------------------------------

console.time("extract");

const eventsOut = {};
const perfsOut = {};

let stats = {
  events: events.length,
  performances: 0,
  receipts: 0,
  receiptsMultiComponent: 0,
  prices: 0,
  curtain: 0,
  benefits: 0,
  benefitsWithName: 0,
  halfPrice: 0,
  authors: 0,
  debuts: 0,
  farewells: 0,
  revivalGaps: 0
};

for (const ev of events) {
  const comment = ev.CommentC || "";
  const rec = extractReceipts(comment, ev.EventId);
  const prices = extractPrices(comment);
  const curtain = extractCurtain(comment);
  const benefit = extractBenefit(comment);
  const halfPrice = extractHalfPrice(comment);
  const authors = extractAuthors(comment);

  const evRow = {};
  if (rec) { evRow.receipts = rec; stats.receipts++; if (rec.components.length > 1) stats.receiptsMultiComponent++; }
  if (prices) { evRow.prices = prices; stats.prices++; }
  if (curtain) { evRow.curtain = curtain; stats.curtain++; }
  if (benefit) {
    evRow.benefit = benefit;
    stats.benefits++;
    if (benefit.beneficiary) stats.benefitsWithName++;
  }
  if (halfPrice) { evRow.halfPrice = true; stats.halfPrice++; }
  if (authors) { evRow.authors = authors; stats.authors++; }

  if (Object.keys(evRow).length) eventsOut[ev.EventId] = evRow;

  const perfs = ev.Performances || [];
  stats.performances += perfs.length;
  for (const p of perfs) {
    const flags = extractPerformanceFlags(p.CommentP || "");
    if (flags) {
      perfsOut[p.PerformanceId] = flags;
      if (flags.debut) stats.debuts++;
      if (flags.farewell) stats.farewells++;
      if (flags.revivalGap) stats.revivalGaps++;
    }
  }
}
console.timeEnd("extract");

const out = {
  _meta: {
    description: "Comment-mining extraction over CommentC (event-level) and CommentP (performance-level). Regex-based; hit rates are lower bounds — grammar variants may slip through. The # glyph is the ASCII-legacy pound sign in the source.",
    generated: new Date().toISOString().slice(0, 10),
    stats
  },
  events: eventsOut,
  performances: perfsOut
};

writeFileSync(resolve(OUT, "comments-extracted.json"), JSON.stringify(out));
copyFileSync(
  resolve(OUT, "comments-extracted.json"),
  resolve(WEB_DATA, "comments-extracted.json")
);

console.log("");
console.log("Layer C extraction — coverage by event (of 52,617):");
console.log(`  receipts            ${stats.receipts.toLocaleString().padStart(8)}  (${(stats.receipts/events.length*100).toFixed(1)}%)`);
console.log(`    multi-component   ${stats.receiptsMultiComponent.toLocaleString().padStart(8)}`);
console.log(`  prices              ${stats.prices.toLocaleString().padStart(8)}  (${(stats.prices/events.length*100).toFixed(1)}%)`);
console.log(`  curtain times       ${stats.curtain.toLocaleString().padStart(8)}  (${(stats.curtain/events.length*100).toFixed(1)}%)`);
console.log(`  benefits            ${stats.benefits.toLocaleString().padStart(8)}  (${(stats.benefits/events.length*100).toFixed(1)}%)`);
console.log(`    w/ beneficiary    ${stats.benefitsWithName.toLocaleString().padStart(8)}`);
console.log(`  half-price          ${stats.halfPrice.toLocaleString().padStart(8)}  (${(stats.halfPrice/events.length*100).toFixed(1)}%)`);
console.log(`  author credits      ${stats.authors.toLocaleString().padStart(8)}  (${(stats.authors/events.length*100).toFixed(1)}%)`);
console.log("");
console.log(`Layer C — performance-level flags (of ${stats.performances.toLocaleString()}):`);
console.log(`  debuts              ${stats.debuts.toLocaleString().padStart(8)}  (${(stats.debuts/stats.performances*100).toFixed(2)}%)`);
console.log(`  farewells           ${stats.farewells.toLocaleString().padStart(8)}  (${(stats.farewells/stats.performances*100).toFixed(2)}%)`);
console.log(`  revival gaps        ${stats.revivalGaps.toLocaleString().padStart(8)}  (${(stats.revivalGaps/stats.performances*100).toFixed(2)}%)`);

const bytes = readFileSync(resolve(OUT, "comments-extracted.json")).byteLength;
console.log("");
console.log(`output: comments-extracted.json  ${(bytes/1024).toFixed(1)} KB`);
console.log("done.");
