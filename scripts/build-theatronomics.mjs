#!/usr/bin/env node
// Parse Theatronomics XLSX account-book files and emit two enrichment JSONs:
//   web/data/receipts/theatronomics-by-date.json  — per-night receipts, keyed "cg:YYYYMMDD"
//   web/data/receipts/theatronomics-expenses.json — per-season expenses, keyed "cg:1754-1755"
//
// Run: node --max-old-space-size=512 scripts/build-theatronomics.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve }         from "node:path";
import { fileURLToPath }            from "node:url";
import { spawnSync }                from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

const RECEIPTS_XLSX = resolve(ROOT, "data/theatronomics/All-Receipts.xlsx");
const EXPENSES_XLSX = resolve(ROOT, "data/theatronomics/All-Expenses.xlsx");
const BUILD_DIR     = resolve(ROOT, "build/theatronomics");
const WEB_DIR       = resolve(ROOT, "web/data/receipts");

mkdirSync(BUILD_DIR, { recursive: true });
mkdirSync(WEB_DIR,   { recursive: true });

// ---- Embedded Python: reads both XLSX files, aggregates, prints JSON --------
// Uses openpyxl (confirmed available). All heavy lifting done in Python;
// Node only handles file writing and build-pipeline conventions.
// NOTE: JS template literal processes \uXXXX escapes, so £ → £ in Python.

const PY = `
import sys, json, openpyxl

THEATRE = {'Covent Garden': 'cg', 'Drury Lane': 'dl'}

def pence(p, s, d):
    return int(p or 0) * 240 + int(s or 0) * 12 + int(d or 0)

def yyyymmdd(val):
    if not val: return None
    v = str(val)
    if len(v) >= 10 and v[4] == '-':
        return v[:10].replace('-', '')
    return None

# ---- Receipts (All-Receipts.xlsx) -------------------------------------------
print("receipts: loading ...", file=sys.stderr)
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
ws = wb.active
it = ws.iter_rows(values_only=True)
headers = next(it)
idx = {h: i for i, h in enumerate(headers) if h}

def g(row, name):
    i = idx.get(name)
    return row[i] if i is not None else None

by_date = {}

for row in it:
    code = THEATRE.get(str(g(row, 'Theatre') or ''))
    if not code: continue
    date = yyyymmdd(g(row, 'Payment Date'))
    if not date: continue
    key  = code + ':' + date
    cat  = str(g(row, 'Category') or '')
    tot  = pence(g(row,'Total Pounds'), g(row,'Total Shillings'), g(row,'Total Pence'))

    if key not in by_date:
        by_date[key] = {
            'dr': 0, 'tm': 0, 'bd': 0,
            'box':0,'pit':0,'gal1':0,'gal2':0,
            'hbox':0,'hpit':0,'hgal1':0,'hgal2':0,
            'after':0,'supp':0
        }
    e = by_date[key]

    if cat == 'Door Receipts':
        e['dr'] += tot
        e['box']  += pence(g(row,'Total Box Pounds'),       g(row,'Total Box Shillings'),       g(row,'Total Box Pence'))
        e['pit']  += pence(g(row,'Total Pit Pounds'),       g(row,'Total Pit Shillings'),       g(row,'Total Pit Pence'))
        e['gal1'] += pence(g(row,'Total Gallery 1 Pounds'), g(row,'Total Gallery 1 Shillings'), g(row,'Total Gallery 1 Pence'))
        e['gal2'] += pence(g(row,'Total Gallery 2 Pounds'), g(row,'Total Gallery 2 Shillings'), g(row,'Total Gallery 2 Pence'))
        e['hbox']  += pence(g(row,'Half Price Box Pounds'),       g(row,'Half Price Box Shillings'),       g(row,'Half Price Box Pence'))
        e['hpit']  += pence(g(row,'Half Price Pit Pounds'),       g(row,'Half Price Pit Shillings'),       g(row,'Half Price Pit Pence'))
        e['hgal1'] += pence(g(row,'Half Price Gallery 1 Pounds'), g(row,'Half Price Gallery 1 Shillings'), g(row,'Half Price Gallery 1 Pence'))
        e['hgal2'] += pence(g(row,'Half Price Gallery 2 Pounds'), g(row,'Half Price Gallery 2 Shillings'), g(row,'Half Price Gallery 2 Pence'))
        e['after'] += pence(g(row,'Total Aftermoney Pounds'),  g(row,'Total Aftermoney Shillings'),  g(row,'Total Aftermoney Pence'))
        e['supp']  += pence(g(row,'Supplementary Pounds'),    g(row,'Supplementary Shillings'),    g(row,'Supplementary Pence'))
    elif cat == 'Ticket Money':
        e['tm'] += tot
    elif cat == 'Benefit Deficiencies':
        e['bd'] += tot

wb.close()
print("  %d night-keys" % len(by_date), file=sys.stderr)

# ---- Expenses (All-Expenses.xlsx) -------------------------------------------
print("expenses: loading ...", file=sys.stderr)
wb2 = openpyxl.load_workbook(sys.argv[2], read_only=True, data_only=True)
ws2 = wb2.active
it2 = ws2.iter_rows(values_only=True)
headers2 = next(it2)
idx2 = {h: i for i, h in enumerate(headers2) if h}

def g2(row, name):
    i = idx2.get(name)
    return row[i] if i is not None else None

by_season = {}
for row in it2:
    code = THEATRE.get(str(g2(row, 'Theatre') or ''))
    if not code: continue
    season = g2(row, 'Calendar Season')
    if not season: continue
    umbrella = str(g2(row, 'Umbrella Category') or 'Other')
    key = code + ':' + str(season)
    amt = pence(g2(row, '£'), g2(row, 's'), g2(row, 'd'))
    if key not in by_season:
        by_season[key] = {}
    by_season[key][umbrella] = by_season[key].get(umbrella, 0) + amt

wb2.close()
print("  %d season-keys" % len(by_season), file=sys.stderr)

print(json.dumps({'receipts': by_date, 'expenses': by_season}))
`;

// ---- Run Python -------------------------------------------------------------
console.log("Extracting XLSX data via Python/openpyxl…");
console.time("python");
const r = spawnSync("python3", ["-c", PY, RECEIPTS_XLSX, EXPENSES_XLSX], {
  maxBuffer: 300 * 1024 * 1024
});
console.timeEnd("python");

if (r.error || r.status !== 0) {
  process.stderr.write(r.stderr || "");
  console.error(r.error?.message || `Python exited ${r.status}`);
  process.exit(1);
}
if (r.stderr?.length) process.stderr.write(r.stderr);

// ---- Parse + write ----------------------------------------------------------
console.time("write");
const data = JSON.parse(r.stdout.toString());

const receiptsJson = JSON.stringify(data.receipts);
const expensesJson = JSON.stringify(data.expenses);

writeFileSync(resolve(BUILD_DIR, "receipts-by-date.json"),   receiptsJson);
writeFileSync(resolve(BUILD_DIR, "expenses-by-season.json"), expensesJson);
writeFileSync(resolve(WEB_DIR,   "theatronomics-by-date.json"),   receiptsJson);
writeFileSync(resolve(WEB_DIR,   "theatronomics-expenses.json"),  expensesJson);
console.timeEnd("write");

const nightCount  = Object.keys(data.receipts).length;
const seasonCount = Object.keys(data.expenses).length;
const rdKB = Buffer.byteLength(receiptsJson) / 1024;
const esKB = Buffer.byteLength(expensesJson) / 1024;

console.log("");
console.log(`theatronomics-by-date.json    ${rdKB.toFixed(1).padStart(7)} KB  (${nightCount.toLocaleString()} night-keys)`);
console.log(`theatronomics-expenses.json   ${esKB.toFixed(1).padStart(7)} KB  (${seasonCount.toLocaleString()} season-keys)`);
console.log("done.");
