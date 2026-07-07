// Shared loader for the LSDB TCP corpus, which maps LSDB WorkIds to EEBO-TCP
// and ECCO-TCP identifiers. Used to surface a "Full text" link on each work
// page, pointing to the Prisms Digital workbench
// (https://www.prisms.digital/workbench/<TCPId>).
//
// Inputs:
//   data/LSDB_TCP_Corpus-1.0/WorksTCP.csv               — TCPId, WorkId, MatchType
//   data/LSDB_TCP_Corpus-1.0/Plays/plays-tcp-metadata.csv
//   data/LSDB_TCP_Corpus-1.0/Collections/collections-tcp-metadata.csv
//
// Exports:
//   joinTcpToLsdb(lsdbWorkIds) → { map, dropped }
//     map     : Map<lsdbWorkId, Array<TcpLink>>  — only WorkIds present in lsdbWorkIds
//     dropped : { rows, distinctWorkIds }        — counts skipped at the join
//
// A TcpLink = { id, title, date, author, estc, match }

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = resolve(__dirname, "..", "..", "data/LSDB_TCP_Corpus-1.0");
const WORKS_TCP   = resolve(CORPUS_ROOT, "WorksTCP.csv");
const PLAYS_META  = resolve(CORPUS_ROOT, "Plays/plays-tcp-metadata.csv");
const COLLS_META  = resolve(CORPUS_ROOT, "Collections/collections-tcp-metadata.csv");

// Quote-aware CSV parser. The metadata files contain quoted publisher names
// with embedded commas and author lists with semicolons-inside-quotes, so the
// naive split(",") used elsewhere is not safe here.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuote = false;
      else field += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { row.push(field); field = ""; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === '\r') { /* swallow */ }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function nullIfBlank(v) { return v && v.trim() ? v : null; }

// Load one of the metadata CSVs into a Map<TCPId, { title, date, author, estc, phase }>.
function loadMeta(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const head = rows[0];
  const ix = (col) => head.indexOf(col);
  const iId = ix("TCPId"), iTitle = ix("ShortTitleClean"), iFull = ix("Title");
  const iDate = ix("CleanDate"), iAuthor = ix("Author"), iEstc = ix("ESTC"), iPhase = ix("Phase");
  const out = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length || !row[iId]) continue;
    out.set(row[iId], {
      title:  nullIfBlank(row[iTitle]) || nullIfBlank(row[iFull]) || null,
      date:   parseInt(row[iDate], 10) || null,
      author: nullIfBlank(row[iAuthor]),
      estc:   nullIfBlank(row[iEstc]),
      phase:  nullIfBlank(row[iPhase]),
    });
  }
  return out;
}

export function joinTcpToLsdb(lsdbWorkIds) {
  const lsdbSet = new Set([...lsdbWorkIds].map(String));

  const meta = new Map();
  for (const [id, m] of loadMeta(PLAYS_META)) meta.set(id, m);
  for (const [id, m] of loadMeta(COLLS_META)) meta.set(id, m);

  // WorksTCP.csv has no quoted fields, so split(",") is safe and cheap.
  const text = readFileSync(WORKS_TCP, "utf8").trim();
  const lines = text.split("\n").slice(1); // drop header
  const map = new Map();
  const droppedWorkIds = new Set();
  let droppedRows = 0;

  for (const line of lines) {
    const [tcpId, workId, matchType] = line.split(",").map(s => s.trim());
    if (!tcpId || !workId) continue;
    if (!lsdbSet.has(workId)) {
      droppedWorkIds.add(workId);
      droppedRows++;
      continue;
    }
    const m = meta.get(tcpId) || {};
    let arr = map.get(workId);
    if (!arr) { arr = []; map.set(workId, arr); }
    arr.push({
      id:     tcpId,
      title:  m.title  || null,
      date:   m.date   || null,
      author: m.author || null,
      estc:   m.estc   || null,
      match:  matchType || null,
    });
  }

  // Sort each work's TCP entries: matches before collections, then by date asc.
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      if (a.match !== b.match) return a.match === "match" ? -1 : 1;
      return (a.date || 0) - (b.date || 0);
    });
  }

  return {
    map,
    dropped: { rows: droppedRows, distinctWorkIds: droppedWorkIds.size },
  };
}
