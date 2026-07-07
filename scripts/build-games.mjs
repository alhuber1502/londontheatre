import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = resolve(__dir, '..');
const webData = resolve(root, 'web/data');

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const abbr = loadJson(resolve(webData, 'theatre-abbreviations.json'));
function theatreName(code) {
  const e = abbr.entries[code];
  if (!e) return code;
  return e.canonical || code;
}

const QUESTION_DECADES = [1710, 1720, 1730, 1740, 1750, 1760, 1770, 1780, 1790];
const ALL_DECADES      = [1660, 1670, 1680, 1690, 1700, ...QUESTION_DECADES];

const graphs = {};
for (const dec of QUESTION_DECADES) {
  graphs[dec] = loadJson(resolve(webData, `graphs/${dec}.json`));
}

// Seeded-ish shuffle — Fisher-Yates using Math.random
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// ─── FILL THE BILL ────────────────────────────────────────────────────────────
// Show a mainpiece; player picks the afterpiece it was most often billed with.
function buildFillTheBill() {
  const questions = [];
  const seenMain  = new Set();

  for (const dec of QUESTION_DECADES) {
    const g          = graphs[dec];
    const works      = g.nodes.works;
    const edges      = g.edges.mainAfterpiece;
    const afterpiece = works.filter(w => w.ptype === 'a').map(w => w.title);

    // Group edges by mainpiece index → list of {aIdx, weight}
    const byMain = {};
    for (const [mIdx, aIdx, weight] of edges) {
      if (!byMain[mIdx]) byMain[mIdx] = [];
      byMain[mIdx].push({ aIdx, weight });
    }

    for (const [mIdxStr, pairings] of Object.entries(byMain)) {
      const mIdx = parseInt(mIdxStr);
      const main = works[mIdx];
      if (!main || main.ptype !== 'p') continue;
      if (seenMain.has(main.title))    continue;

      pairings.sort((a, b) => b.weight - a.weight);
      const topW    = pairings[0].weight;
      const secondW = pairings[1] ? pairings[1].weight : 0;

      // Strong dominant pairing required
      if (topW < 4 || topW < secondW * 2) continue;

      const correct = works[pairings[0].aIdx];
      if (!correct) continue;

      const pool = afterpiece.filter(t => t !== correct.title);
      if (pool.length < 3) continue;
      shuffle(pool);
      const opts = [correct.title, pool[0], pool[1], pool[2]];
      shuffle(opts);

      questions.push({
        decade:    dec,
        mainpiece: main.title,
        options:   opts,
        answer:    opts.indexOf(correct.title)
      });
      seenMain.add(main.title);
    }
  }

  shuffle(questions);
  return questions;
}

// ─── WHOSE CAST? ─────────────────────────────────────────────────────────────
// Show 4 performers who shared a stage; player guesses the play.
function buildWhoseCast() {
  const questions = [];
  const seenWork  = new Set();

  for (const dec of QUESTION_DECADES) {
    const g          = graphs[dec];
    const works      = g.nodes.works;
    const performers = g.nodes.performers;
    const theatres   = g.nodes.theatres;
    const wpEdges    = g.edges.workPerformer;
    const tpEdges    = g.edges.theatrePerformer;

    const mainTitles = works.filter(w => w.ptype === 'p').map(w => w.title);

    // workIdx → [{pIdx, weight}]
    const byWork = {};
    for (const [wIdx, pIdx, weight] of wpEdges) {
      const w = works[wIdx];
      if (!w || w.ptype !== 'p') continue;
      if (!byWork[wIdx]) byWork[wIdx] = [];
      byWork[wIdx].push({ pIdx, weight });
    }

    // performerIdx → dominant theatreIdx
    const perfTheatre = {};
    for (const [tIdx, pIdx, weight] of tpEdges) {
      if (!perfTheatre[pIdx] || perfTheatre[pIdx].w < weight) {
        perfTheatre[pIdx] = { tIdx, w: weight };
      }
    }

    for (const [wIdxStr, perfList] of Object.entries(byWork)) {
      const wIdx = parseInt(wIdxStr);
      const work = works[wIdx];
      if (!work || seenWork.has(work.title)) continue;
      if (perfList.length < 4) continue;

      perfList.sort((a, b) => b.weight - a.weight);
      const top4 = perfList.slice(0, 4)
        .map(e => performers[e.pIdx] && performers[e.pIdx].id)
        .filter(Boolean);
      if (top4.length < 4) continue;

      // Dominant theatre for this work via its top performers
      const tCount = {};
      for (const { pIdx } of perfList.slice(0, 8)) {
        const pt = perfTheatre[pIdx];
        if (pt) tCount[pt.tIdx] = (tCount[pt.tIdx] || 0) + 1;
      }
      const topTIdx = Object.entries(tCount).sort(([,a],[,b]) => b - a)[0];
      const tCode   = topTIdx ? theatres[parseInt(topTIdx[0])]?.id : null;
      const theatre = tCode ? theatreName(tCode) : null;

      const pool = mainTitles.filter(t => t !== work.title);
      if (pool.length < 3) continue;
      shuffle(pool);
      const opts = [work.title, pool[0], pool[1], pool[2]];
      shuffle(opts);

      const q = { decade: dec, performers: top4, options: opts, answer: opts.indexOf(work.title) };
      if (theatre) q.theatre = theatre;

      questions.push(q);
      seenWork.add(work.title);
    }
  }

  shuffle(questions);
  return questions;
}

// ─── NAME THE DECADE ─────────────────────────────────────────────────────────
// Show a mainpiece title; player guesses which decade it was most often staged.
function buildNameTheDecade() {
  // Aggregate per-work counts across all decades
  const workData = {}; // title → { byDecade: {decade: count}, total }

  for (const dec of ALL_DECADES) {
    let g;
    try { g = loadJson(resolve(webData, `graphs/${dec}.json`)); } catch (_) { continue; }
    for (const w of g.nodes.works) {
      if (w.ptype !== 'p') continue;
      if (!workData[w.title]) workData[w.title] = { byDecade: {}, total: 0 };
      workData[w.title].byDecade[dec] = (workData[w.title].byDecade[dec] || 0) + w.count;
      workData[w.title].total += w.count;
    }
  }

  const questions = [];

  for (const [title, data] of Object.entries(workData)) {
    if (data.total < 15) continue;

    const ranked = Object.entries(data.byDecade)
      .map(([d, c]) => [parseInt(d), c])
      .sort(([,a],[,b]) => b - a);

    const [peakDec, peakCount] = ranked[0];
    if (!QUESTION_DECADES.includes(peakDec)) continue;
    if (peakCount / data.total < 0.40) continue;

    // Distractors: prefer decades with non-zero counts (plausible wrong answers)
    const pool = QUESTION_DECADES.filter(d => d !== peakDec);
    const hasCount  = pool.filter(d => data.byDecade[d] > 0);
    const noCount   = pool.filter(d => !data.byDecade[d]);
    shuffle(hasCount); shuffle(noCount);
    const dists = [...hasCount, ...noCount].slice(0, 3);
    if (dists.length < 3) continue;

    const opts = [peakDec, ...dists];
    shuffle(opts);

    questions.push({ work: title, options: opts, answer: opts.indexOf(peakDec) });
  }

  shuffle(questions);
  return questions;
}

// ─── BOX OFFICE OR BUST? ─────────────────────────────────────────────────────
// Show two nights at the same venue; player picks the higher earner.
function buildBoxOffice() {
  const rows = loadJson(resolve(webData, 'receipts/entries.json')).rows;

  // Group by venue + season
  const groups = {};
  for (const r of rows) {
    if (!r.t || !r.p) continue;
    const key = `${r.v}|${r.s}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  const questions = [];

  for (const [key, nights] of Object.entries(groups)) {
    if (nights.length < 4) continue;
    const [venue] = key.split('|');
    const venueName = theatreName(venue);

    const sorted = [...nights].sort((a, b) => b.p - a.p);

    for (let hi = 0; hi < Math.min(3, sorted.length); hi++) {
      const high = sorted[hi];
      let matched = false;
      for (let lo = sorted.length - 1; lo >= sorted.length - 3 && lo > hi; lo--) {
        const low = sorted[lo];
        if (!low.p) continue;
        if (high.t === low.t) continue;
        if (high.p / low.p < 2) continue;

        const [a, b] = Math.random() < 0.5 ? [high, low] : [low, high];
        questions.push({
          venue: venueName,
          a: { date: a.d, title: a.t },
          b: { date: b.d, title: b.t },
          answer: a.p > b.p ? 0 : 1
        });
        matched = true;
        break;
      }
      if (matched) break;
    }
  }

  shuffle(questions);
  return questions;
}

// ─── WHOSE HOUSE? ────────────────────────────────────────────────────────────
// Show a performer + decade; player guesses which theatre they were most active at.
function buildWhoseHouse() {
  const questions    = [];
  const seenPerformer = new Set();

  for (const dec of QUESTION_DECADES) {
    const g          = graphs[dec];
    const performers = g.nodes.performers;
    const theatres   = g.nodes.theatres;
    const tpEdges    = g.edges.theatrePerformer;

    // performerIdx → [{tIdx, weight}]
    const byPerformer = {};
    for (const [tIdx, pIdx, weight] of tpEdges) {
      if (!byPerformer[pIdx]) byPerformer[pIdx] = [];
      byPerformer[pIdx].push({ tIdx, weight });
    }

    // Distractor pool: active theatres in this decade (count > 50), as name strings
    const theatrePool = theatres
      .map((t, i) => ({ code: t.id, name: theatreName(t.id), idx: i, count: t.count }))
      .filter(t => t.count > 50)
      .sort((a, b) => b.count - a.count);

    if (theatrePool.length < 4) continue;

    for (const [pIdxStr, theatreList] of Object.entries(byPerformer)) {
      const pIdx = parseInt(pIdxStr);
      const perf = performers[pIdx];
      if (!perf || seenPerformer.has(perf.id)) continue;

      const totalW = theatreList.reduce((s, e) => s + e.weight, 0);
      if (totalW < 20) continue;

      theatreList.sort((a, b) => b.weight - a.weight);
      const topT = theatreList[0];

      // Require clear affiliation: ≥60% in one theatre
      if (topT.weight / totalW < 0.60) continue;

      const correctTheatre = theatres[topT.tIdx];
      if (!correctTheatre) continue;

      // Skip the decade's dominant house — questions about it are too easy
      if (correctTheatre.id === theatrePool[0].code) continue;

      const correctName = theatreName(correctTheatre.id);

      const dists = theatrePool
        .filter(t => t.code !== correctTheatre.id)
        .slice(0, 3)
        .map(t => t.name);
      if (dists.length < 3) continue;

      const opts = [correctName, ...dists];
      shuffle(opts);

      questions.push({
        decade:    dec,
        performer: perf.id,
        options:   opts,
        answer:    opts.indexOf(correctName)
      });
      seenPerformer.add(perf.id);
    }
  }

  shuffle(questions);
  return questions;
}

// ─── DEBUT DECADE ─────────────────────────────────────────────────────────────
// Show a performer's name; player guesses which decade they first appeared.
function buildDebutDecade() {
  // Collect per-performer data across all decades
  const perfData = {}; // name → { byDecade: {decade: count}, total }

  for (const dec of ALL_DECADES) {
    let g;
    try { g = loadJson(resolve(webData, `graphs/${dec}.json`)); } catch (_) { continue; }
    for (const p of g.nodes.performers) {
      if (!perfData[p.id]) perfData[p.id] = { byDecade: {}, total: 0 };
      perfData[p.id].byDecade[dec] = (perfData[p.id].byDecade[dec] || 0) + p.count;
      perfData[p.id].total += p.count;
    }
  }

  const questions = [];

  for (const [name, data] of Object.entries(perfData)) {
    if (data.total < 20) continue;

    const decades = Object.keys(data.byDecade).map(Number).sort((a, b) => a - b);
    if (decades.length < 3) continue; // must span ≥3 decades

    const debut = decades[0];
    if (!QUESTION_DECADES.includes(debut)) continue;

    // Distractors: prefer decades close to the actual debut (plausibly wrong)
    const pool = QUESTION_DECADES.filter(d => d !== debut);
    const near = pool.filter(d => Math.abs(d - debut) <= 30);
    const far  = pool.filter(d => Math.abs(d - debut) > 30);
    shuffle(near); shuffle(far);
    const dists = [...near, ...far].slice(0, 3);
    if (dists.length < 3) continue;

    const opts = [debut, ...dists];
    shuffle(opts);

    questions.push({ performer: name, options: opts, answer: opts.indexOf(debut) });
  }

  shuffle(questions);
  return questions;
}

// ─── PLAY'S HOME ─────────────────────────────────────────────────────────────
// Show a mainpiece + decade; player guesses its dominant playhouse.
// Never the decade's top house — same bias-fix as Whose House?.
function buildPlaysHome() {
  const questions = [];
  const seenWork  = new Set();

  for (const dec of QUESTION_DECADES) {
    const g        = graphs[dec];
    const works    = g.nodes.works;
    const theatres = g.nodes.theatres;
    const wpEdges  = g.edges.workPerformer;
    const tpEdges  = g.edges.theatrePerformer;

    // performerIdx → dominant theatreIdx
    const perfTheatre = {};
    for (const [tIdx, pIdx, weight] of tpEdges) {
      if (!perfTheatre[pIdx] || perfTheatre[pIdx].w < weight) {
        perfTheatre[pIdx] = { tIdx, w: weight };
      }
    }

    // workIdx → [{pIdx, weight}]
    const byWork = {};
    for (const [wIdx, pIdx, weight] of wpEdges) {
      const w = works[wIdx];
      if (!w || w.ptype !== 'p') continue;
      if (!byWork[wIdx]) byWork[wIdx] = [];
      byWork[wIdx].push({ pIdx, weight });
    }

    const theatrePool = theatres
      .map((t, i) => ({ code: t.id, name: theatreName(t.id), idx: i, count: t.count }))
      .filter(t => t.count > 50)
      .sort((a, b) => b.count - a.count);
    if (theatrePool.length < 4) continue;
    const dominantCode = theatrePool[0].code;

    for (const [wIdxStr, perfList] of Object.entries(byWork)) {
      const wIdx = parseInt(wIdxStr);
      const work = works[wIdx];
      if (!work || seenWork.has(work.title)) continue;
      if (perfList.length < 4) continue;

      perfList.sort((a, b) => b.weight - a.weight);

      // Derive dominant theatre via top performers
      const tCount = {};
      for (const { pIdx } of perfList.slice(0, 8)) {
        const pt = perfTheatre[pIdx];
        if (pt) tCount[pt.tIdx] = (tCount[pt.tIdx] || 0) + 1;
      }
      const topTEntry = Object.entries(tCount).sort(([,a],[,b]) => b - a)[0];
      if (!topTEntry) continue;

      const topTIdx   = parseInt(topTEntry[0]);
      const topTCount = parseInt(topTEntry[1]);
      const totalTC   = Object.values(tCount).reduce((s, v) => s + v, 0);
      if (topTCount / totalTC < 0.60) continue;

      const correctTheatre = theatres[topTIdx];
      if (!correctTheatre) continue;
      if (correctTheatre.id === dominantCode) continue;

      const correctName = theatreName(correctTheatre.id);
      const dists = theatrePool
        .filter(t => t.code !== correctTheatre.id)
        .slice(0, 3)
        .map(t => t.name);
      if (dists.length < 3) continue;

      const opts = [correctName, ...dists];
      shuffle(opts);

      questions.push({ decade: dec, work: work.title, options: opts, answer: opts.indexOf(correctName) });
      seenWork.add(work.title);
    }
  }

  shuffle(questions);
  return questions;
}

// ─── LONG RUNNER OR FLASH? ────────────────────────────────────────────────────
// Two plays that both appeared in a given decade; player picks the one with more
// total performances across all 141 seasons.
function buildLongRunner() {
  // Aggregate lifetime counts across all decades
  const workTotals = {};
  for (const dec of ALL_DECADES) {
    let g;
    try { g = loadJson(resolve(webData, `graphs/${dec}.json`)); } catch (_) { continue; }
    for (const w of g.nodes.works) {
      if (w.ptype !== 'p') continue;
      workTotals[w.title] = (workTotals[w.title] || 0) + w.count;
    }
  }

  const questions   = [];
  const seenWinners = new Set();

  for (const dec of QUESTION_DECADES) {
    const g = graphs[dec];
    const mainWorks = g.nodes.works
      .filter(w => w.ptype === 'p' && (workTotals[w.title] || 0) >= 15)
      .sort((a, b) => (workTotals[b.title] || 0) - (workTotals[a.title] || 0));

    if (mainWorks.length < 6) continue;

    const cut    = Math.floor(mainWorks.length * 0.25);
    const topQ   = mainWorks.slice(0, cut);
    const botQ   = mainWorks.slice(mainWorks.length - cut);

    for (const winner of topQ) {
      if (seenWinners.has(winner.title)) continue;
      for (const loser of botQ) {
        if (winner.title === loser.title) continue;
        if ((workTotals[winner.title] || 0) < (workTotals[loser.title] || 0) * 3) continue;

        const [a, b] = Math.random() < 0.5 ? [winner, loser] : [loser, winner];
        questions.push({
          decade: dec,
          a: a.title,
          b: b.title,
          answer: (workTotals[a.title] || 0) > (workTotals[b.title] || 0) ? 0 : 1
        });
        seenWinners.add(winner.title);
        break;
      }
    }
  }

  shuffle(questions);
  return questions;
}

// ─── OPENING NIGHT ────────────────────────────────────────────────────────────
// Show a play title; player guesses in which decade it first appeared.
function buildOpeningNight() {
  const workData = {};
  for (const dec of ALL_DECADES) {
    let g;
    try { g = loadJson(resolve(webData, `graphs/${dec}.json`)); } catch (_) { continue; }
    for (const w of g.nodes.works) {
      if (w.ptype !== 'p') continue;
      if (!workData[w.title]) workData[w.title] = { byDecade: {}, total: 0 };
      workData[w.title].byDecade[dec] = (workData[w.title].byDecade[dec] || 0) + w.count;
      workData[w.title].total += w.count;
    }
  }

  const questions = [];

  for (const [title, data] of Object.entries(workData)) {
    if (data.total < 15) continue;
    const decades = Object.keys(data.byDecade).map(Number).sort((a, b) => a - b);
    if (decades.length < 2) continue; // must span at least 2 decades

    const debut = decades[0];
    if (!QUESTION_DECADES.includes(debut)) continue;

    const pool = QUESTION_DECADES.filter(d => d !== debut);
    const near = pool.filter(d => Math.abs(d - debut) <= 30);
    const far  = pool.filter(d => Math.abs(d - debut) > 30);
    shuffle(near); shuffle(far);
    const dists = [...near, ...far].slice(0, 3);
    if (dists.length < 3) continue;

    const opts = [debut, ...dists];
    shuffle(opts);
    questions.push({ work: title, options: opts, answer: opts.indexOf(debut) });
  }

  shuffle(questions);
  return questions;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
const fillTheBill    = buildFillTheBill();
const whoseCast      = buildWhoseCast();
const nameTheDecade  = buildNameTheDecade();
const boxOffice      = buildBoxOffice();
const whoseHouse     = buildWhoseHouse();
const debutDecade    = buildDebutDecade();
const playsHome      = buildPlaysHome();
const longRunner     = buildLongRunner();
const openingNight   = buildOpeningNight();

console.log(`Fill the Bill:            ${fillTheBill.length} questions`);
console.log(`Whose Cast?:              ${whoseCast.length} questions`);
console.log(`Name the Decade:          ${nameTheDecade.length} questions`);
console.log(`Box Office or Bust?:      ${boxOffice.length} questions`);
console.log(`Whose House? (fixed):     ${whoseHouse.length} questions`);
console.log(`Debut Decade:             ${debutDecade.length} questions`);
console.log(`Play's Home:              ${playsHome.length} questions`);
console.log(`Long Runner or Flash?:    ${longRunner.length} questions`);
console.log(`Opening Night:            ${openingNight.length} questions`);

mkdirSync(resolve(webData, 'games'), { recursive: true });
writeFileSync(
  resolve(webData, 'games/questions.json'),
  JSON.stringify({
    _meta: {
      description: 'Pre-generated quiz question banks for games.html',
      generated: new Date().toISOString().slice(0, 10),
      counts: {
        fillTheBill:   fillTheBill.length,
        whoseCast:     whoseCast.length,
        nameTheDecade: nameTheDecade.length,
        boxOffice:     boxOffice.length,
        whoseHouse:    whoseHouse.length,
        debutDecade:   debutDecade.length,
        playsHome:     playsHome.length,
        longRunner:    longRunner.length,
        openingNight:  openingNight.length
      }
    },
    fillTheBill,
    whoseCast,
    nameTheDecade,
    boxOffice,
    whoseHouse,
    debutDecade,
    playsHome,
    longRunner,
    openingNight
  })
);
console.log('Written → web/data/games/questions.json');
