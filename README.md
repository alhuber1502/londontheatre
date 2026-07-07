# London Theatre, 1660–1800

*A public-engagement companion to the London stage: repertoire, receipts, performers, playhouses and the networks between them, drawn from the London Stage Database.*

---

## Overview

**London Theatre, 1660–1800** turns the machine-readable [London Stage Database](https://londonstagedatabase.uoregon.edu/) (LSDB) into an interactive, visual companion to professional theatre in London across roughly a century and a half. It offers a map of the playhouses on period cartography, a day-by-day calendar of performances, a searchable repertoire and *dramatis personae*, box-office analysis, network graphs of people and works, and a set of data-driven games.

The dataset behind it records **52,617 event-days** containing **116,819 individual piece-performances** at some **234 named venues**, staging **2,811 distinct works** performed by **7,929 named performers**, between October 1660 and September 1800.

It is built *on* the London Stage Database rather than being a republication of it, and links back to the LSDB and other scholarly resources throughout.

## Features

| Section | What it shows | Built with |
|---|---|---|
| **Map** | Every geocoded playhouse, booth and pleasure garden on Rocque (1746) / Strype (1720) overlays, with a decade timeline; marker area ∝ activity | Leaflet |
| **Calendar** | A day-by-day activity heatmap across 1660–1800; each cell one date, colour by number of bills | bespoke SVG |
| **Repertoire** | A searchable, filterable catalogue of works with per-decade performance "arcs"; filter by genre, women playwrights, and date range | DataTables + SVG |
| **People** | A browsable *dramatis personae* of performers with role-mix bars, careers and date-range filtering | DataTables + SVG |
| **Receipts** | Box-office analysis: per-season median receipts with inter-quartile bands, account-book vs press comparison, benefit-night deficiencies | bespoke SVG |
| **Networks** | Six force-directed / structured graph views — theatre↔performer, co-casting, mainpiece↔afterpiece, work↔performer, full ecosystem, and venue competition | Sigma 3 + graphology |
| **Games** | Nine data-driven quizzes generated from the corpus | vanilla JS |
| **Detail pages** | Per-work, per-performer, per-venue, per-role and per-day views with decade timelines, top collaborators, milestones and financials | mixed |

## How it works

The project is a **precompute-to-static** design with two cleanly separated halves:

- **`scripts/`** — a Node.js build pipeline (ES modules) reads the LSDB export and auxiliary sources, does all the heavy aggregation and normalisation once, and emits small static JSON artifacts into `web/data/`.
- **`web/`** — a static HTML/CSS/vanilla-JS site that lazy-loads those artifacts per page. There is **no server, no database and no application backend at runtime**: the site deploys as plain files to any static host.

Charts are hand-built inline SVG (no charting library); large tables use [DataTables](https://datatables.net/); the map uses [Leaflet](https://leafletjs.com/); the network views use [Sigma](https://www.sigmajs.org/) with [graphology](https://graphology.github.io/). The frontend modules are framework-free and run in the browser with no build step; the pipeline is modern Node ESM.

## Repository layout

```
scripts/            Node ES-module build pipeline (16 steps; see build-all.mjs)
  lib/              Shared text-cleaning and joins (lsdb-text.mjs, tcp-links.mjs, …)
web/                Static site
  *.html            Page shells
  js/               Per-page modules (vanilla JS)
  css/              Styles (fonts.css references Plantin MT Pro — see Licence)
  data/             Generated JSON artifacts  ← produced by the pipeline (not committed)
data/               Source inputs read by the pipeline
  theatre-*.json    Venue name and geocoding tables (compiled for this project)
  theatronomics/    Theatronomics receipts / expenses (.xlsx) + attributions
  LSDB_TCP_Corpus-1.0/  TCP full-text metadata (CSV only)
```

**Not included in this repository** (obtain separately, see below): the LSDB export itself, the generated `web/data/` and `build/` outputs, the proprietary Plantin MT Pro typeface, and copyrighted reference scans.

## Getting started

### Prerequisites

- **Node.js** ≥ 18
- **Python 3** with **openpyxl** (used by the Theatronomics step to read the `.xlsx` workbooks): `pip install openpyxl`
- Any static file server (Python's built-in `http.server` is fine)
- A few GB of free RAM (the heaviest pipeline step runs with a ~4 GB heap)

### 1. Add the London Stage Database export

The LSDB export is licensed and large, so it is not included here. Download the dataset (v2.1) from the [London Stage Database data repository](https://github.com/LondonStageDB/data) and place it at:

```
data/LondonStageFull.json
```

The pipeline reads that exact path; a symlink to a versioned filename works too, e.g. `ln -s LondonStageFull_v2.1.json data/LondonStageFull.json`.

### 2. Build the derived data

```
node scripts/build-all.mjs
```

This runs the full 16-step pipeline (~5 minutes) and (re)generates everything under `web/data/`. The orchestrator launches each step with an appropriate `--max-old-space-size`.

### 3. Serve the site

```
cd web && python3 -m http.server 8000
# then open http://localhost:8000
```

> The Plantin MT Pro typeface is proprietary and is **not** distributed here; without it the site falls back to a system serif. Everything else renders as intended.

## The pipeline

`scripts/build-all.mjs` runs the steps in dependency order. In brief: canonicalise performer-name spellings → aggregate events / works / performers → mine performance comments for prices, receipts and milestones → build per-role, per-work, per-performer and per-venue detail shards → assemble the calendar and box-office series → build the network-graph slices → generate the games. Shared LSDB-specific text cleaning (XML/sigil stripping, cast-list splitting, name canonicalisation) lives in `scripts/lib/lsdb-text.mjs`.

## Data sources & attribution

| Source | Used for | Licence |
|---|---|---|
| **London Stage Database** (Avery, Scouten, Stone & Hogan; machine-readable ed. B. R. Schneider Jr.; maintained by Mattie Burkert et al., University of Oregon) | The core calendar of performances | CC BY-NC 4.0 |
| **Theatronomics: the Business of Theatre, 1732–1809** (O'Shaughnessy et al.) | Account-book receipts and expenses for Covent Garden & Drury Lane | CC BY-NC 4.0 |
| **EEBO-TCP / ECCO-TCP** | Full-text links for a subset of works | Public domain (metadata) |
| **Yale Center for British Art**, Paul Mellon Collection | Period imagery | Open Access |
| **Historical maps** — John Rocque (1746), John Strype (1720) | Map overlays (not bundled) | See providers |

## Licence

- **Code** — the build pipeline (`scripts/`) and site (`web/`, excluding third-party libraries and the fonts): released under the **MIT Licence** (see [`LICENSE`](LICENSE)).
- **Data** — the datasets above remain under their original licences (the LSDB and Theatronomics under CC BY-NC 4.0). Please cite and attribute them accordingly.
- **Typeface** — Plantin MT Pro is a proprietary Monotype face and is not included or relicensed here.

## Credits

Created by **Alexander Huber**. Built on the London Stage Database and the work of its editors and maintainers. Financial data by the Theatronomics project. Full acknowledgements are on the site's *About* page.
