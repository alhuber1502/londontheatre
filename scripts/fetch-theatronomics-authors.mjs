#!/usr/bin/env node
// Fetch all Theatronomics works that have author/composer/adapter attribution.
//
// Strategy:
//   1. Page through GET /works to collect all work IDs (3,492 works, ~7 pages)
//   2. For each work, fetch GET /work/{id} and keep any with activity_person
//   3. For works with activity_person, also fetch GET /person/{id} for each
//      linked person to retrieve the activity label (Author, Composer, etc.)
//      from person.activity_work
//   4. Write data/theatronomics/works-with-authors.json
//
// Polite defaults: 2000ms between every request.
// Run:          node scripts/fetch-theatronomics-authors.mjs
// Resume:       node scripts/fetch-theatronomics-authors.mjs --resume
//   (skips re-fetching work IDs and person details already cached)
// Retry failed: node scripts/fetch-theatronomics-authors.mjs --retry-failed
//   (only re-fetches IDs listed in _failed-work-ids.json, merges into output)

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT     = resolve(__dirname, "..");
const OUT_DIR  = resolve(ROOT, "data/theatronomics");
const RESUME        = process.argv.includes("--resume");
const RETRY_FAILED  = process.argv.includes("--retry-failed");

const BASE     = "https://data-theatronomics.universityofgalway.ie/api/data/v1";
const HEADERS  = { "Accept": "application/json", "User-Agent": "LondonStage-research-bot/1.0" };
const DELAY_MS = 2000;

mkdirSync(OUT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function get(path, retries = 4) {
  const url = BASE + path;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const wait = attempt * 5000;
      process.stdout.write(`\n  ${res.status} on ${path} — waiting ${wait/1000}s (attempt ${attempt}/${retries})…\r`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  throw new Error(`Gave up after ${retries} retries: ${url}`);
}

// ── Step 1: collect all work IDs from paginated list ──────────────────────────

const workIdsFile = resolve(OUT_DIR, "_work-ids.json");
let workIds;

if (RESUME && existsSync(workIdsFile)) {
  workIds = JSON.parse(readFileSync(workIdsFile, "utf8"));
  console.log(`Resume: loaded ${workIds.length} work IDs from cache.`);
} else {
  console.log("Step 1: fetching work list pages…");
  workIds = [];
  let page = 1;
  while (true) {
    process.stdout.write(`  page ${page}…\r`);
    const body = await get(`/works?per_page=500&page=${page}`);
    const items = body.itemListElement || body.data || [];
    if (!items.length) break;
    for (const w of items) {
      if (w.id != null) workIds.push(w.id);
    }
    const lastPage = body.meta?.last_page ?? body.pagination?.last_page ?? 1;
    if (page >= lastPage) break;
    page++;
    await sleep(DELAY_MS);
  }
  writeFileSync(workIdsFile, JSON.stringify(workIds));
  console.log(`  found ${workIds.length} works across ${page} pages.`);
}

// ── Step 2: fetch each work detail, keep those with activity_person ────────────

const worksFile    = resolve(OUT_DIR, "_works-progress.json");
const progressFile = resolve(OUT_DIR, "_work-progress-idx.json");
const failedFile   = resolve(OUT_DIR, "_failed-work-ids.json");

let worksWithAuthors = [];
let startIdx = 0;
const failedIds = new Set();

// Load existing failures (may have been seeded from a previous run)
if (existsSync(failedFile)) {
  const existing = JSON.parse(readFileSync(failedFile, "utf8"));
  (existing.ids || []).forEach(id => failedIds.add(id));
}

if (RETRY_FAILED) {
  // Retry mode: load the final output and re-fetch only known-failed IDs
  const outFile = resolve(OUT_DIR, "works-with-authors.json");
  if (existsSync(outFile)) {
    worksWithAuthors = JSON.parse(readFileSync(outFile, "utf8"));
    console.log(`Retry-failed mode: loaded ${worksWithAuthors.length} existing attributed works.`);
  }
  const retryIds = [...failedIds];
  console.log(`Re-fetching ${retryIds.length} previously failed work IDs…`);
  const newlyResolved = [];
  for (let i = 0; i < retryIds.length; i++) {
    const id = retryIds[i];
    process.stdout.write(`  ${i + 1}/${retryIds.length}\r`);
    let body;
    try {
      body = await get(`/work/${id}`);
      failedIds.delete(id); // cleared on success
    } catch (err) {
      console.warn(`\n  WARN: /work/${id} still failing — ${err.message}`);
      await sleep(DELAY_MS);
      continue;
    }
    await sleep(DELAY_MS);
    const w = body.data || body;
    const persons = w.activity_person;
    if (persons && persons.length) newlyResolved.push({ id, w, persons });
  }
  console.log(`\n  ${newlyResolved.length} newly resolved.`);
  // merge into main list and fall through to step 3
  for (const { id, w, persons } of newlyResolved) {
    worksWithAuthors.push(buildWorkRecord(id, w, persons));
  }
  saveFailed();
  process.exit(0); // step 3 not re-run in retry mode; run --resume for that
}

if (RESUME && existsSync(worksFile) && existsSync(progressFile)) {
  worksWithAuthors = JSON.parse(readFileSync(worksFile, "utf8"));
  startIdx = JSON.parse(readFileSync(progressFile, "utf8"));
  console.log(`Resume: continuing from work index ${startIdx}, ${worksWithAuthors.length} attributed works so far.`);
}

const personIds = new Set(worksWithAuthors.flatMap(w => w.persons.map(p => p.person_id)));

function saveFailed() {
  writeFileSync(failedFile, JSON.stringify({
    note: "Work IDs that failed after all retries. Re-fetch with: node scripts/fetch-theatronomics-authors.mjs --retry-failed",
    count: failedIds.size,
    ids: [...failedIds].sort((a, b) => a - b),
  }, null, 2));
}

function buildWorkRecord(id, w, persons) {
  return {
    id,
    title:                w.title               ?? null,
    title_variant:        w.title_variant        ?? null,
    type_1:               w.type_1               ?? null,
    type_2:               w.type_2               ?? null,
    source_1:             w.source_1             ?? null,
    source_2:             w.source_2             ?? null,
    first_performed_date: w.first_performed_date  ?? null,
    publication_date:     w.publication_date     ?? null,
    performance_medium:   w.performance_medium   ?? null,
    date_type:            w.date_type            ?? null,
    notes:                w.notes                ?? null,
    genre: w.genre ? {
      id:          w.genre.id          ?? null,
      label:       w.genre.label       ?? null,
      description: w.genre.description ?? null,
    } : null,
    persons: persons.map(p => ({
      person_id:              p.person_id              ?? null,
      name:                   p.name                   ?? null,
      slug:                   p.slug                   ?? null,
      start_date:             p.start_date             ?? null,
      end_date:               p.end_date               ?? null,
      start_type:             p.start_type             ?? null,
      end_type:               p.end_type               ?? null,
      gender:                 p.gender                 ?? null,
      place_of_birth_country: p.place_of_birth_country ?? null,
      place_of_birth_locality: p.place_of_birth_locality ?? null,
      geo: p.geo ? { latitude: p.geo.latitude ?? null, longitude: p.geo.longitude ?? null } : null,
      links: p.SameAs ? {
        viaf:      p.SameAs.link_viaf      ?? null,
        wikipedia: p.SameAs.link_wikipedia ?? null,
        odnb:      p.SameAs.link_odnb      ?? null,
      } : null,
      activity_label: null,
    })),
  };
}

console.log(`\nStep 2: fetching ${workIds.length} work detail pages (starting at ${startIdx})…`);

for (let i = startIdx; i < workIds.length; i++) {
  const id = workIds[i];
  if ((i + 1) % 25 === 0 || i === workIds.length - 1) {
    process.stdout.write(`  ${i + 1}/${workIds.length} — ${worksWithAuthors.length} attributed works found\r`);
    writeFileSync(worksFile,    JSON.stringify(worksWithAuthors));
    writeFileSync(progressFile, JSON.stringify(i + 1));
    saveFailed();
  }

  let body;
  try {
    body = await get(`/work/${id}`);
  } catch (err) {
    console.warn(`\n  WARN: /work/${id} failed — ${err.message}`);
    failedIds.add(id);
    await sleep(DELAY_MS);
    continue;
  }
  await sleep(DELAY_MS);

  const w = body.data || body;
  const persons = w.activity_person;
  if (!persons || !persons.length) continue;

  // Collect person IDs for step 3
  for (const p of persons) {
    if (p.person_id != null) personIds.add(p.person_id);
  }

  worksWithAuthors.push(buildWorkRecord(id, w, persons));
}

console.log(`\n  done — ${worksWithAuthors.length} works with attribution out of ${workIds.length}.`);

// ── Step 3: fetch each linked person to get activity labels ───────────────────

console.log(`\nStep 3: fetching ${personIds.size} person detail pages for activity labels…`);

// Build a lookup: personId → Map(workId → activityLabel)
const personActivityMap = new Map(); // personId → { workId → label }
const pidList = [...personIds];

for (let i = 0; i < pidList.length; i++) {
  const pid = pidList[i];
  if ((i + 1) % 10 === 0 || i === pidList.length - 1) {
    process.stdout.write(`  ${i + 1}/${pidList.length}\r`);
  }

  let body;
  try {
    body = await get(`/person/${pid}`);
  } catch (err) {
    console.warn(`\n  WARN: /person/${pid} failed — ${err.message}`);
    await sleep(DELAY_MS);
    continue;
  }
  await sleep(DELAY_MS);

  const person = body.data || body;
  const workActivities = person.activity_work;
  if (!workActivities || !workActivities.length) continue;

  const workMap = {};
  for (const aw of workActivities) {
    const wid = aw.work_id ?? aw.work?.id;
    const label = aw.activity?.label ?? null;
    if (wid != null) workMap[wid] = label;
  }
  personActivityMap.set(pid, workMap);
}

console.log(`\n  done.`);

// ── Step 4: merge activity labels into works ──────────────────────────────────

for (const work of worksWithAuthors) {
  for (const person of work.persons) {
    const workMap = personActivityMap.get(person.person_id);
    if (workMap) {
      person.activity_label = workMap[work.id] ?? null;
    }
  }
}

// ── Step 5: write output ──────────────────────────────────────────────────────

const outFile = resolve(OUT_DIR, "works-with-authors.json");
writeFileSync(outFile, JSON.stringify(worksWithAuthors, null, 2));

const kb = (Buffer.byteLength(JSON.stringify(worksWithAuthors)) / 1024).toFixed(1);
console.log(`\nOutput: ${outFile}`);
console.log(`  ${worksWithAuthors.length} attributed works`);
console.log(`  ${[...personIds].length} unique persons`);
console.log(`  ${kb} KB`);

// Summary of activity labels found
const labelCounts = {};
for (const w of worksWithAuthors) {
  for (const p of w.persons) {
    const l = p.activity_label || "(unlabelled)";
    labelCounts[l] = (labelCounts[l] || 0) + 1;
  }
}
console.log("\nActivity labels:");
for (const [label, count] of Object.entries(labelCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${count.toString().padStart(4)}  ${label}`);
}
