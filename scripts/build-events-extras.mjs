#!/usr/bin/env node
// Lightweight events-extras index: prices, curtain times, half-price flags,
// benefit notes, and Hathi Trust scan sequences per EventId.
// Sources: web/data/comments-extracted.json (per-event annotations)
//          data/LondonStageFull.json        (BookPDF field → Hathi seq)
// Used by day.js to annotate the day-view bill with ticket info and a link
// to the scanned original in HathiTrust.
//
// Run: node scripts/build-events-extras.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = pathResolve(__dirname, "..");
const COMMENTS  = pathResolve(ROOT, "web/data/comments-extracted.json");
const RAWDATA   = pathResolve(ROOT, "data/LondonStageFull.json");
const OUT       = pathResolve(ROOT, "web/data/events-extras.json");

// ─── Hathi Trust scan sequences ──────────────────────────────────────────────
// BookPDF format: "vol1/400.pdf" or "vol3-1/515-519.pdf" (page ranges use first page)
// Hathi seq = first_page - 1  (scan sequence is 0-indexed from volume start)

const HATHI_VOLS = new Set([
  'vol1', 'vol2-1', 'vol2-2', 'vol3-1', 'vol3-2',
  'vol4-1', 'vol4-2', 'vol4-3', 'vol5-1', 'vol5-2', 'vol5-3'
]);

console.log('Reading LondonStageFull.json …');
const raw = JSON.parse(readFileSync(RAWDATA, 'utf8'));

// Per-volume offset from BookPDF page number to Hathi scan sequence.
// Default: seq = page - 1.  Two volumes have extra scans inserted mid-volume
// (plates/blank pages in the Hathi digitisation) that shift later pages.
// Calibrated by spot-checking dated events against live Hathi URLs.
function hathiSeq(vol, page) {
  if (vol === 'vol2-2') return page <= 368 ? page + 1 : page + 3;
  if (vol === 'vol5-3') return page <= 356 ? page - 1 : page + 3;
  return page - 1;
}

const hathiMap = {}; // EventId (string) → compact "vol:seq" string
for (const ev of raw) {
  if (!ev.BookPDF) continue;
  const slash = ev.BookPDF.indexOf('/');
  if (slash < 0) continue;
  const vol = ev.BookPDF.slice(0, slash);
  if (!HATHI_VOLS.has(vol)) continue;
  // Strip "vol/", strip ".pdf"; take first page of any range.
  const rest      = ev.BookPDF.slice(slash + 1, ev.BookPDF.length - 4);
  const firstPage = parseInt(rest.split('-')[0], 10);
  if (!firstPage) continue;
  hathiMap[String(ev.EventId)] = vol + ':' + hathiSeq(vol, firstPage);
}
console.log(`Hathi map: ${Object.keys(hathiMap).length} events`);

// ─── Comments-extracted extras ────────────────────────────────────────────────
const { events } = JSON.parse(readFileSync(COMMENTS, 'utf8'));

// ─── Merge ────────────────────────────────────────────────────────────────────
// Seed every event with its Hathi seq, then overlay annotation data.
const out = {};

for (const [id, h] of Object.entries(hathiMap)) {
  out[id] = { h };
}

for (const [id, ev] of Object.entries(events)) {
  if (!out[id]) out[id] = {};
  if (ev.prices)    out[id].prices    = ev.prices;
  if (ev.curtain)   out[id].curtain   = ev.curtain;
  if (ev.halfPrice) out[id].halfPrice = ev.halfPrice;
  if (ev.benefit?.flagged) {
    out[id].benefit = { flagged: true };
    if (ev.benefit.beneficiary) out[id].benefit.beneficiary = ev.benefit.beneficiary;
  }
}

writeFileSync(OUT, JSON.stringify(out));
console.log(`events-extras: ${Object.keys(out).length} entries → web/data/events-extras.json`);
