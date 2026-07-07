/* London Stage, 1660-1800 — receipts view (box-office takings)
   Reads data/receipts/index.json for aggregates and data/receipts/entries.json
   for the top-earners table. Draws a multi-line median-per-season chart in
   inline SVG; the venue pills above the chart toggle lines on and off. */

(function () {
  'use strict';

  // Top venues to surface. Others are rolled into "Other" in the chart so
  // single-night reporters (GF, Chapel) don't dominate the legend.
  var MAIN_VENUES = ["dl", "cg", "lif", "dlking's", "king's", "queen's"];

  // Palette borrowed from the programming-mix swatches so the chart rhymes
  // with the rest of the site.
  var PALETTE = {
    "dl":        "var(--brick)",
    "cg":        "var(--burgundy)",
    "lif":       "var(--teal)",
    "dlking's":  "var(--gold)",
    "king's":    "var(--brick-deep)",
    "queen's":   "var(--ink-soft)",
    "other":     "#8b6e5c"
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(n) { return (Number(n) || 0).toLocaleString('en-GB'); }

  // Render pence as "£12 10s. 6d." — drop the trailing components when zero.
  function fmtMoney(pence) {
    pence = Number(pence) || 0;
    var p = Math.floor(pence / 240);
    var rest = pence - p * 240;
    var s = Math.floor(rest / 12);
    var d = rest - s * 12;
    var out = '£' + fmtNum(p);
    if (s || d) out += ' ' + s + 's.';
    if (d) out += ' ' + d + 'd.';
    return out;
  }

  function fmtMoneyShort(pence) {
    var p = (Number(pence) || 0) / 240;
    if (p >= 100) return '£' + Math.round(p).toLocaleString('en-GB');
    if (p >= 10) return '£' + p.toFixed(0);
    return '£' + p.toFixed(1);
  }

  // Season label "1749-1750" -> left year (1749) for axis ordering.
  function seasonStartYear(s) {
    var m = String(s || '').match(/^(\d{4})/);
    return m ? +m[1] : null;
  }

  function prettyDate(yyyymmdd) {
    if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || '';
    var months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var y = yyyymmdd.slice(0, 4);
    var m = +yyyymmdd.slice(4, 6) - 1;
    var d = +yyyymmdd.slice(6, 8);
    if (m < 0 || m > 11) return yyyymmdd;
    return d + ' ' + months[m] + ' ' + y;
  }

  // ------------ Load -----------------------------------------------------

  function loadIndex() {
    return fetch('data/receipts/index.json').then(function (r) {
      if (!r.ok) throw new Error('receipts/index.json ' + r.status);
      return r.json();
    });
  }

  function loadTheatronomics() {
    return fetch('data/receipts/theatronomics-by-date.json').then(function (r) {
      if (!r.ok) throw new Error('theatronomics-by-date.json ' + r.status);
      return r.json();
    }).catch(function () { return null; });
  }

  // ------------ Head / ledger -------------------------------------------

  function renderHead(meta) {
    var sub = document.getElementById('receipts-subtitle');
    if (!sub) return;
    var first = meta.earliestYear || '';
    var last = meta.latestYear || '';
    var span = (first && last) ? (first === last ? first : first + '\u2013' + last) : '';
    var parts = [];
    parts.push(fmtNum(meta.totalEntries) + ' nights reporting a take');
    parts.push(meta.venues + ' playhouses');
    if (span) parts.push(span);
    sub.innerHTML = parts.join(' \u00b7 ');
  }

  function renderLedger(meta) {
    var wrap = document.getElementById('receipts-ledger');
    var section = document.getElementById('receipts-stats');
    if (!wrap || !section) return;

    var grand = meta.grandSumPence || 0;
    var grandPounds = Math.round(grand / 240);
    var seasons = meta.seasons || 0;

    var entries = [
      { fig: fmtNum(meta.totalEntries), label: 'Nights reporting receipts' },
      { fig: '£' + fmtNum(grandPounds), label: 'Aggregate take on record' },
      { fig: fmtMoneyShort(meta.grandMedianPence), label: 'Median night' },
      { fig: fmtNum(seasons), label: 'Seasons covered' },
      { fig: fmtNum(meta.venues), label: 'Playhouses' }
    ];

    wrap.innerHTML = entries.map(function (e) {
      return (
        '<div class="ledger-entry" role="listitem">' +
          '<span class="ledger-figure">' + e.fig + '</span>' +
          '<span class="ledger-label">' + escapeHtml(e.label) + '</span>' +
        '</div>'
      );
    }).join('');

    section.hidden = false;
  }

  // ------------ Venue filter pills --------------------------------------

  function renderVenueFilter(venues, state) {
    var host = document.getElementById('receipts-venue-filter');
    if (!host) return;

    var html = venues.map(function (v) {
      var active = state.active[v.code] !== false;
      var colour = PALETTE[v.code] || PALETTE.other;
      return (
        '<button type="button" class="receipts-pill' + (active ? ' is-active' : '') +
          '" data-code="' + escapeHtml(v.code) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
          '<span class="receipts-pill-swatch" style="background:' + colour + '"></span>' +
          '<span class="receipts-pill-label">' + escapeHtml(v.name) + '</span>' +
          '<span class="receipts-pill-count metadata-label">' + fmtNum(v.count) + '</span>' +
        '</button>'
      );
    }).join('');

    host.innerHTML = html;

    Array.prototype.forEach.call(host.querySelectorAll('.receipts-pill'), function (btn) {
      btn.addEventListener('click', function () {
        var code = btn.getAttribute('data-code');
        state.active[code] = !(state.active[code] !== false);
        btn.classList.toggle('is-active', state.active[code]);
        btn.setAttribute('aria-pressed', state.active[code] ? 'true' : 'false');
        drawChart(state);
      });
    });
  }

  // ------------ Chart ----------------------------------------------------

  function drawChart(state) {
    var host = document.getElementById('receipts-chart');
    var legend = document.getElementById('receipts-chart-legend');
    var section = document.getElementById('receipts-chart-section');
    if (!host || !section) return;

    var venues = state.venues;
    var years = state.years; // sorted start-years array
    if (!venues.length || !years.length) { section.hidden = true; return; }

    // y max across currently-active venues so the chart re-scales nicely.
    var yMaxPence = 0;
    venues.forEach(function (v) {
      if (state.active[v.code] === false) return;
      Object.keys(v.bySeason).forEach(function (s) {
        var m = v.bySeason[s].p75Pence || v.bySeason[s].medianPence || 0;
        if (m > yMaxPence) yMaxPence = m;
      });
    });
    if (yMaxPence <= 0) yMaxPence = 24000; // £100 fallback

    // round y max up to nearest £25
    var yMaxPounds = Math.ceil((yMaxPence / 240) / 25) * 25;
    var yMax = yMaxPounds * 240;

    var W = 960, H = 360;
    var M = { t: 14, r: 16, b: 32, l: 56 };
    var plotW = W - M.l - M.r;
    var plotH = H - M.t - M.b;

    var xMin = years[0];
    var xMax = years[years.length - 1];
    var xSpan = xMax - xMin || 1;

    function xOf(y) { return M.l + ((y - xMin) / xSpan) * plotW; }
    function yOf(p) { return M.t + plotH - (p / yMax) * plotH; }

    // y gridlines every £25 (if yMaxPounds small) or £50 / £100 step
    var yStep = yMaxPounds <= 100 ? 25 : (yMaxPounds <= 400 ? 50 : 100);
    var yTicks = [];
    for (var y = 0; y <= yMaxPounds; y += yStep) yTicks.push(y);

    // x gridlines — every 10 years, starting on a decade
    var xTicks = [];
    var startDec = Math.ceil(xMin / 10) * 10;
    for (var d = startDec; d <= xMax; d += 10) xTicks.push(d);

    var svgParts = [];

    // Axes
    yTicks.forEach(function (t) {
      var yy = yOf(t * 240);
      svgParts.push(
        '<line class="receipts-grid" x1="' + M.l + '" y1="' + yy +
        '" x2="' + (M.l + plotW) + '" y2="' + yy + '"></line>' +
        '<text class="receipts-axis-label" x="' + (M.l - 8) + '" y="' + (yy + 3) +
        '" text-anchor="end">£' + t + '</text>'
      );
    });

    xTicks.forEach(function (t) {
      var xx = xOf(t);
      svgParts.push(
        '<line class="receipts-grid is-vertical" x1="' + xx + '" y1="' + M.t +
        '" x2="' + xx + '" y2="' + (M.t + plotH) + '"></line>' +
        '<text class="receipts-axis-label" x="' + xx + '" y="' + (H - 10) +
        '" text-anchor="middle">' + t + '</text>'
      );
    });

    // Axis baselines
    svgParts.push(
      '<line class="receipts-axis" x1="' + M.l + '" y1="' + (M.t + plotH) +
      '" x2="' + (M.l + plotW) + '" y2="' + (M.t + plotH) + '"></line>' +
      '<line class="receipts-axis" x1="' + M.l + '" y1="' + M.t +
      '" x2="' + M.l + '" y2="' + (M.t + plotH) + '"></line>'
    );

    // Lines for each active venue
    var legendBits = [];
    venues.forEach(function (v) {
      if (state.active[v.code] === false) return;
      var colour = PALETTE[v.code] || PALETTE.other;
      var points = [];
      years.forEach(function (yr) {
        var s = v.seasonIndex[yr];
        if (!s) return;
        var bs = v.bySeason[s];
        if (!bs || !bs.medianPence) return;
        points.push({
          x: xOf(yr), y: yOf(bs.medianPence),
          yP25: bs.p25Pence ? yOf(bs.p25Pence) : null,
          yP75: bs.p75Pence ? yOf(bs.p75Pence) : null,
          year: yr, season: s,
          pence: bs.medianPence,
          p25: bs.p25Pence || 0,
          p75: bs.p75Pence || 0,
          sum: bs.sumPence || 0,
          count: bs.count || 0
        });
      });
      if (!points.length) return;

      // IQR band (p25–p75) drawn first so the median line sits on top.
      // Only draw if at least 4 seasons have spread data.
      var bandPts = points.filter(function (pt) { return pt.yP25 !== null && pt.yP75 !== null && pt.count >= 4; });
      if (bandPts.length >= 2) {
        var topPath = bandPts.map(function (pt, i) {
          return (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.yP75.toFixed(1);
        }).join(' ');
        var botPath = bandPts.slice().reverse().map(function (pt) {
          return 'L' + pt.x.toFixed(1) + ',' + pt.yP25.toFixed(1);
        }).join(' ');
        svgParts.push(
          '<path class="receipts-band" d="' + topPath + ' ' + botPath + ' Z" fill="' + colour + '" />'
        );
      }

      var path = points.map(function (pt, i) {
        return (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.y.toFixed(1);
      }).join(' ');
      svgParts.push(
        '<path class="receipts-line" d="' + path + '" stroke="' + colour + '" />'
      );
      // Carry the data needed by the floating tooltip in `data-*`
      // attributes so a single delegated mousemove handler on the
      // figure can read them without a per-dot listener. Also include
      // a fatter invisible hit target so hovering is forgiving at the
      // dot scale.
      points.forEach(function (pt) {
        var dataAttrs =
          ' data-venue="' + escapeHtml(v.code) + '"' +
          ' data-venue-name="' + escapeHtml(v.name) + '"' +
          ' data-season="' + escapeHtml(pt.season) + '"' +
          ' data-median="' + pt.pence + '"' +
          ' data-p25="' + pt.p25 + '"' +
          ' data-p75="' + pt.p75 + '"' +
          ' data-sum="' + pt.sum + '"' +
          ' data-count="' + pt.count + '"';
        svgParts.push(
          '<circle class="receipts-hit" cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) +
          '" r="9" fill="transparent"' + dataAttrs + '></circle>' +
          '<circle class="receipts-dot" cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) +
          '" r="2.5" fill="' + colour + '" pointer-events="none"></circle>'
        );
      });
      // pills above the chart serve as the legend; keep legendBits empty
      void legendBits;
    });

    // Dashed account-book lines for CG and DL (Theatronomics door receipts).
    // Drawn after the LSD lines so they sit on top and the visual comparison
    // is legible — same colour, dashed, hollow dots.
    var abLinesDrawn = false;
    if (state.abSeasons) {
      ['cg', 'dl'].forEach(function (venue) {
        if (state.active[venue] === false) return;
        var abVenueSns = state.abSeasons[venue];
        if (!abVenueSns) return;
        var colour = PALETTE[venue];
        var points = [];
        years.forEach(function (yr) {
          var season = yr + '-' + (yr + 1);
          var bs = abVenueSns[season];
          if (!bs || !bs.medianPence) return;
          points.push({
            x: xOf(yr), y: yOf(bs.medianPence),
            yr: yr, season: season,
            pence: bs.medianPence, count: bs.count, sum: bs.sumPence
          });
        });
        if (!points.length) return;
        abLinesDrawn = true;
        var path = points.map(function (pt, i) {
          return (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ',' + pt.y.toFixed(1);
        }).join(' ');
        svgParts.push('<path class="receipts-line-ab" d="' + path + '" stroke="' + colour + '" />');
        points.forEach(function (pt) {
          var vName = escapeHtml(state.lookup[venue] || venue.toUpperCase());
          svgParts.push(
            '<circle class="receipts-hit" cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) +
            '" r="9" fill="transparent"' +
            ' data-venue="' + venue + '"' +
            ' data-venue-name="' + vName + '"' +
            ' data-season="' + escapeHtml(pt.season) + '"' +
            ' data-median="' + pt.pence + '"' +
            ' data-sum="' + pt.sum + '"' +
            ' data-count="' + pt.count + '"' +
            ' data-is-ab="true"></circle>' +
            '<circle class="receipts-dot-ab" cx="' + pt.x.toFixed(1) + '" cy="' + pt.y.toFixed(1) +
            '" r="2.5" stroke="' + colour + '" fill="var(--paper)" pointer-events="none"></circle>'
          );
        });
      });
    }

    var svg = '<svg role="img" aria-label="Median nightly receipts by season" ' +
              'viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
              svgParts.join('') + '</svg>';

    host.innerHTML = svg;
    if (legend) {
      var legendParts = ['Shaded band: middle 50% of nightly takes (p25–p75)'];
      if (abLinesDrawn) legendParts.push('Dashed line: account-book door receipts (Theatronomics, CG and DL only)');
      legend.innerHTML = legendParts.join(' — ');
      legend.hidden = false;
    }
    wireChartTooltip(host, state);
    section.hidden = false;
  }

  // ---- Floating chart tooltip -------------------------------------------
  // One delegated mousemove/mouseleave on the chart figure reads the
  // hovered circle's data-* attributes and positions a parchment
  // tooltip just above the dot. Richer than the plain SVG <title>
  // attribute and keeps the season / venue / median / total context
  // grouped in one readable card.

  function wireChartTooltip(host, state) {
    if (!host) return;

    // Always refresh state so show() sees the current active venues.
    host._chartState = state;

    if (host._chartTooltipWired) {
      // host.innerHTML = svg removes the tip on every redraw — re-attach it.
      if (host._chartTip && !host.contains(host._chartTip)) {
        host.appendChild(host._chartTip);
      }
      return;
    }
    host._chartTooltipWired = true;

    var tip = document.createElement('div');
    tip.className = 'receipts-tooltip metadata-label';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    host._chartTip = tip;
    host.appendChild(tip);

    function fmt(pence) {
      return fmtMoney(pence);
    }

    function show(ev, circle) {
      var currentState = host._chartState;
      var ds = circle.dataset;
      var median = +ds.median || 0;
      var p25 = +ds.p25 || 0;
      var p75 = +ds.p75 || 0;
      var sum = +ds.sum || 0;
      var count = +ds.count || 0;
      var venueHref = 'venue.html?code=' + encodeURIComponent(ds.venue);

      if (ds.isAb === 'true') {
        tip.innerHTML =
          '<p class="receipts-tip-venue"><a href="' + escapeHtml(venueHref) + '">' +
            escapeHtml(ds.venueName) + '</a></p>' +
          '<p class="receipts-tip-season">Season ' + escapeHtml(ds.season) + '</p>' +
          '<p class="receipts-tip-primary"><strong>' + fmt(median) + '</strong> median &middot; account-book door receipts</p>' +
          '<p class="receipts-tip-secondary">' +
            'across ' + count + ' night' + (count === 1 ? '' : 's') +
            ' · £' + Math.round(sum / 240).toLocaleString('en-GB') + ' total' +
          '</p>';
      } else {
        var benefitShare = '';
        // Situate the selected season against the venue's lifetime median.
        var v = null;
        for (var i = 0; i < currentState.venues.length; i++) {
          if (currentState.venues[i].code === ds.venue) { v = currentState.venues[i]; break; }
        }
        var relation = '';
        if (v && v.medianPence) {
          var diff = median - v.medianPence;
          var pct = v.medianPence ? Math.round((diff / v.medianPence) * 100) : 0;
          if (Math.abs(pct) >= 5) {
            relation = '<span class="receipts-tip-relation">' +
              (pct > 0 ? '+' : '') + pct + '% vs venue median</span>';
          }
        }
        tip.innerHTML =
          '<p class="receipts-tip-venue"><a href="' + escapeHtml(venueHref) + '">' +
            escapeHtml(ds.venueName) + '</a></p>' +
          '<p class="receipts-tip-season">Season ' + escapeHtml(ds.season) + '</p>' +
          '<p class="receipts-tip-primary"><strong>' + fmt(median) + '</strong> median nightly ' +
            (relation ? ' ' + relation : '') + '</p>' +
          (p25 && p75 && count >= 4
            ? '<p class="receipts-tip-iqr">Middle 50%: ' + fmt(p25) + ' – ' + fmt(p75) + '</p>'
            : '') +
          '<p class="receipts-tip-secondary">' +
            'across ' + count + ' night' + (count === 1 ? '' : 's') +
            ' · £' + Math.round(sum / 240).toLocaleString('en-GB') + ' total' +
          '</p>' +
          benefitShare;
      }

      tip.hidden = false;
      var hostRect = host.getBoundingClientRect();
      var cx = ev.clientX - hostRect.left;
      var cy = ev.clientY - hostRect.top;
      var tipW = tip.offsetWidth || 220;
      var tipH = tip.offsetHeight || 80;
      var x = cx - tipW / 2;
      var y = cy - tipH - 14;
      if (x < 4) x = 4;
      if (x + tipW > hostRect.width - 4) x = hostRect.width - tipW - 4;
      if (y < 4) y = cy + 14;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }

    function hide() { tip.hidden = true; }

    host.addEventListener('mousemove', function (ev) {
      var t = ev.target;
      if (!t || !t.classList || !t.classList.contains('receipts-hit')) { hide(); return; }
      show(ev, t);
    });
    host.addEventListener('mouseleave', hide);
  }

  // ------------ Top earners / low earners -------------------------------

  // Roman-numeral rank prefix for the top earners — the rows read like a
  // ledger entry rather than a search-result list.
  var ROMAN = ['\u2160','\u2161','\u2162','\u2163','\u2164','\u2165','\u2166','\u2167',
               '\u2168','\u2169','\u216A','\u216B','XIII','XIV','XV','XVI',
               'XVII','XVIII','XIX','XX','XXI','XXII','XXIII','XXIV','XXV'];

  function renderEarnings(items, listId, sectionId, venueLookup, showRank, abData, mode) {
    var list = document.getElementById(listId);
    var section = document.getElementById(sectionId);
    if (!list || !section) return;
    if (!items || !items.length) { section.hidden = true; return; }

    var html = items.map(function (e, i) {
      var venueName = venueLookup[e.venue] || e.venue.toUpperCase();
      var workTitle = e.work && e.work.title ? e.work.title : '\u2014';
      var workLink = (e.work && e.work.workId)
        ? '<a href="work.html?id=' + encodeURIComponent(e.work.workId) + '">' + escapeHtml(workTitle) + '</a>'
        : escapeHtml(workTitle);
      var dayLink = e.date
        ? '<a href="day.html?date=' + encodeURIComponent(e.date) + '">' + escapeHtml(prettyDate(e.date)) + '</a>'
        : '';
      var venueLink = '<a href="venue.html?code=' + encodeURIComponent(e.venue) + '">' + escapeHtml(venueName) + '</a>';
      var flag = e.benefit
        ? '<span class="receipts-flag metadata-label" title="Benefit night \u2014 profits went to a named player or manager">benefit</span>'
        : '';
      // "at King's" tag when a resident company played elsewhere that night.
      var displaced = '';
      if (e.work && e.work.displacedTo) {
        var host = venueLookup[e.work.displacedTo] || e.work.displacedTo.toUpperCase();
        displaced = '<span class="receipts-flag metadata-label" title="' +
          escapeHtml(venueName + ' company played this night at ' + host) +
          '">at ' + escapeHtml(host) + '</span>';
      }
      var abLine = '';
      if (mode === 'ab') {
        if (e.lsPence) {
          abLine = '<span class="receipts-row-ab">press\u00a0' + fmtMoney(e.lsPence) + '</span>';
        }
      } else if (abData && (e.venue === 'cg' || e.venue === 'dl') && e.date) {
        var abEntry = abData[e.venue + ':' + e.date];
        if (abEntry && abEntry.dr) {
          abLine = '<span class="receipts-row-ab">ledger\u00a0' + fmtMoney(abEntry.dr) + '</span>';
        }
      }
      var rank = showRank
        ? '<span class="receipts-row-rank" aria-hidden="true">' + (ROMAN[i] || String(i + 1)) + '</span>'
        : '<span class="receipts-row-rank" aria-hidden="true"></span>';
      return (
        '<li class="receipts-row">' +
          rank +
          '<span class="receipts-row-main">' +
            '<span class="receipts-row-title">' + workLink + flag + displaced + '</span>' +
            '<span class="receipts-row-meta metadata-label">' + dayLink + ' \u00b7 ' + venueLink + '</span>' +
          '</span>' +
          '<span class="receipts-row-leader" aria-hidden="true"></span>' +
          '<span class="receipts-row-amount">' + fmtMoney(e.pence) + abLine + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    section.hidden = false;
  }

  // ------------ Missing state -------------------------------------------

  function renderMissing() {
    var m = document.getElementById('receipts-missing');
    if (m) m.hidden = false;
  }

  // ------------ Boot ----------------------------------------------------

  function buildVenueState(index, abData) {
    // Partition venues into "main" (dedicated colour) and "other" (rolled up).
    var mainVenues = [];
    var otherBySeason = {};
    var otherMeta = { code: 'other', name: 'Other houses', count: 0, sumPence: 0 };

    var lookup = {};
    (index.venues || []).forEach(function (v) { lookup[v.code] = v.name; });

    (index.venues || []).forEach(function (v) {
      if (MAIN_VENUES.indexOf(v.code) !== -1) {
        // season lookup by startYear
        var si = {};
        Object.keys(v.bySeason || {}).forEach(function (s) {
          var y = seasonStartYear(s);
          if (y != null) si[y] = s;
        });
        mainVenues.push(Object.assign({}, v, { seasonIndex: si }));
      } else {
        otherMeta.count += v.count || 0;
        otherMeta.sumPence += v.sumPence || 0;
        Object.keys(v.bySeason || {}).forEach(function (s) {
          var bs = otherBySeason[s] || { count: 0, sumPence: 0, medianPences: [] };
          bs.count += v.bySeason[s].count || 0;
          bs.sumPence += v.bySeason[s].sumPence || 0;
          bs.medianPences.push(v.bySeason[s].medianPence || 0);
          otherBySeason[s] = bs;
        });
      }
    });

    if (otherMeta.count > 0) {
      // Synthesise a simple mean-of-medians per season for the rolled-up
      // "other" bucket (we don't have raw pence arrays here). Good enough
      // for the chart — these are low-volume houses anyway.
      var finalOther = {};
      Object.keys(otherBySeason).forEach(function (s) {
        var bs = otherBySeason[s];
        var m = bs.medianPences.reduce(function (a, b) { return a + b; }, 0) /
                (bs.medianPences.length || 1);
        finalOther[s] = { count: bs.count, sumPence: bs.sumPence, medianPence: Math.round(m) };
      });
      var si = {};
      Object.keys(finalOther).forEach(function (s) {
        var y = seasonStartYear(s);
        if (y != null) si[y] = s;
      });
      mainVenues.push(Object.assign({}, otherMeta, { bySeason: finalOther, seasonIndex: si }));
    }

    // Collect the sorted year axis from everywhere.
    var yrs = {};
    mainVenues.forEach(function (v) {
      Object.keys(v.bySeason || {}).forEach(function (s) {
        var y = seasonStartYear(s);
        if (y != null) yrs[y] = true;
      });
    });
    var years = Object.keys(yrs).map(Number).sort(function (a, b) { return a - b; });

    var active = {};
    // Default: big three on, others on but muted. We'll just set all active.
    mainVenues.forEach(function (v) { active[v.code] = true; });

    return { venues: mainVenues, years: years, active: active, lookup: lookup, abSeasons: computeAbSeasons(abData) };
  }

  // ------------ Benefit deficiency analysis ----------------------------

  function computeDeficiencyStats(abData) {
    if (!abData) return null;
    var defPences = [];
    var byDecade  = {};
    Object.keys(abData).forEach(function (k) {
      var m = k.match(/^(cg|dl):(\d{8})$/);
      if (!m) return;
      var bd = (abData[k] && abData[k].bd) || 0;
      if (!bd) return;
      var yr  = parseInt(m[2].slice(0, 4), 10);
      var dec = Math.floor(yr / 10) * 10;
      if (!byDecade[dec]) byDecade[dec] = { cg: 0, dl: 0 };
      byDecade[dec][m[1]]++;
      defPences.push(bd);
    });
    if (!defPences.length) return null;
    defPences.sort(function (a, b) { return a - b; });
    var mid    = Math.floor(defPences.length / 2);
    var median = defPences.length % 2 === 0
      ? Math.round((defPences[mid - 1] + defPences[mid]) / 2)
      : defPences[mid];
    var total  = defPences.reduce(function (s, v) { return s + v; }, 0);
    return { count: defPences.length, medianPence: median, totalPence: total, byDecade: byDecade };
  }

  function renderDeficiencies(defStats) {
    var section = document.getElementById('receipts-deficiency-section');
    if (!section || !defStats) return;

    var intro = document.getElementById('receipts-deficiency-intro');
    if (intro) {
      intro.textContent =
        'When a benefit night’s door receipts fell short of the house charges, ' +
        'the Covent Garden and Drury Lane account books record the gap. ' +
        fmtNum(defStats.count) + ' such deficiency nights survive on record ' +
        'across the two houses, 1732–1809 — a handful each season, ' +
        'though the pattern shifts markedly between theatres and decades.';
    }

    var ledger = document.getElementById('receipts-deficiency-ledger');
    if (ledger) {
      var entries = [
        { fig: fmtNum(defStats.count),                          label: 'Deficiency nights on record' },
        { fig: fmtMoney(defStats.medianPence),                  label: 'Median shortfall' },
        { fig: '£' + fmtNum(Math.round(defStats.totalPence / 240)), label: 'Aggregate shortfall' }
      ];
      ledger.innerHTML = entries.map(function (e) {
        return (
          '<div class="ledger-entry" role="listitem">' +
            '<span class="ledger-figure">' + e.fig + '</span>' +
            '<span class="ledger-label">' + escapeHtml(e.label) + '</span>' +
          '</div>'
        );
      }).join('');
    }

    var host = document.getElementById('receipts-deficiency-chart');
    if (host) {
      var decades = Object.keys(defStats.byDecade).map(Number).sort(function (a, b) { return a - b; });
      var maxCount = 0;
      decades.forEach(function (d) {
        var n = (defStats.byDecade[d].cg || 0) + (defStats.byDecade[d].dl || 0);
        if (n > maxCount) maxCount = n;
      });
      if (!maxCount) maxCount = 1;

      var W = 720, H = 180;
      var M = { t: 24, r: 12, b: 28, l: 44 };
      var plotW = W - M.l - M.r;
      var plotH = H - M.t - M.b;
      var colW  = plotW / decades.length;
      var groupW = colW * 0.72;
      var barW   = (groupW - 2) / 2;

      var parts = [];

      // y-axis
      var yStep = maxCount <= 20 ? 5 : (maxCount <= 60 ? 20 : 40);
      for (var y = 0; y <= maxCount; y += yStep) {
        var yp = M.t + plotH - (y / maxCount) * plotH;
        parts.push(
          '<line class="receipts-grid" x1="' + M.l + '" y1="' + yp.toFixed(1) +
          '" x2="' + (M.l + plotW) + '" y2="' + yp.toFixed(1) + '"></line>' +
          '<text class="receipts-axis-label" x="' + (M.l - 6) + '" y="' + (yp + 3).toFixed(1) +
          '" text-anchor="end">' + y + '</text>'
        );
      }
      parts.push(
        '<line class="receipts-axis" x1="' + M.l + '" y1="' + (M.t + plotH) +
        '" x2="' + (M.l + plotW) + '" y2="' + (M.t + plotH) + '"></line>'
      );

      // Bars
      decades.forEach(function (dec, i) {
        var groupX = M.l + i * colW + (colW - groupW) / 2;
        var cg = defStats.byDecade[dec].cg || 0;
        var dl = defStats.byDecade[dec].dl || 0;

        if (cg > 0) {
          var hCg = (cg / maxCount) * plotH;
          parts.push(
            '<rect x="' + groupX.toFixed(1) + '" y="' + (M.t + plotH - hCg).toFixed(1) +
            '" width="' + barW.toFixed(1) + '" height="' + hCg.toFixed(1) +
            '" fill="var(--burgundy)">' +
            '<title>Covent Garden · ' + dec + 's · ' + cg +
            ' deficiency night' + (cg === 1 ? '' : 's') + '</title></rect>'
          );
        }
        if (dl > 0) {
          var hDl = (dl / maxCount) * plotH;
          var xDl = groupX + barW + 2;
          parts.push(
            '<rect x="' + xDl.toFixed(1) + '" y="' + (M.t + plotH - hDl).toFixed(1) +
            '" width="' + barW.toFixed(1) + '" height="' + hDl.toFixed(1) +
            '" fill="var(--brick)">' +
            '<title>Drury Lane · ' + dec + 's · ' + dl +
            ' deficiency night' + (dl === 1 ? '' : 's') + '</title></rect>'
          );
        }
        parts.push(
          '<text class="receipts-axis-label" x="' + (groupX + groupW / 2).toFixed(1) +
          '" y="' + (H - 8) + '" text-anchor="middle">' + dec + 's</text>'
        );
      });

      // Inline legend (top-left of plot)
      [
        { color: 'var(--burgundy)', label: 'CG' },
        { color: 'var(--brick)',    label: 'DL' }
      ].forEach(function (item, i) {
        var lx = M.l + 4 + i * 44;
        parts.push(
          '<rect x="' + lx + '" y="' + (M.t - 16) + '" width="10" height="10" fill="' + item.color + '"></rect>' +
          '<text class="receipts-axis-label" x="' + (lx + 13) + '" y="' + (M.t - 6) + '">' + item.label + '</text>'
        );
      });

      host.innerHTML =
        '<svg role="img" aria-label="Benefit deficiencies by decade" ' +
        'viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
        parts.join('') + '</svg>';
    }

    section.hidden = false;
  }

  // Compute account-book season medians from the by-date lookup. Returns
  // { cg: { '1749-1750': {count, medianPence, sumPence}, … }, dl: {…} }.
  function computeAbSeasons(abData) {
    if (!abData) return null;
    var acc = { cg: {}, dl: {} };
    Object.keys(abData).forEach(function (k) {
      var m = k.match(/^(cg|dl):(\d{8})$/);
      if (!m) return;
      var venue = m[1];
      var date  = m[2];
      var dr    = (abData[k] && abData[k].dr) || 0;
      if (!dr) return;
      var yr     = parseInt(date.slice(0, 4), 10);
      var mo     = parseInt(date.slice(4, 6), 10);
      var season = mo >= 9 ? (yr + '-' + (yr + 1)) : ((yr - 1) + '-' + yr);
      if (!acc[venue][season]) acc[venue][season] = [];
      acc[venue][season].push(dr);
    });
    var result = { cg: {}, dl: {} };
    ['cg', 'dl'].forEach(function (venue) {
      Object.keys(acc[venue]).forEach(function (season) {
        var vals = acc[venue][season].slice().sort(function (a, b) { return a - b; });
        var mid  = Math.floor(vals.length / 2);
        var med  = vals.length % 2 === 0
          ? Math.round((vals[mid - 1] + vals[mid]) / 2)
          : vals[mid];
        var sum  = vals.reduce(function (s, v) { return s + v; }, 0);
        result[venue][season] = { count: vals.length, medianPence: med, sumPence: sum };
      });
    });
    return result;
  }

  function boot() {
    Promise.all([loadIndex(), loadTheatronomics()]).then(function (results) {
      var index = results[0];
      var abData = results[1];

      var meta = index._meta || {};
      renderHead(meta);
      renderLedger(meta);

      var state = buildVenueState(index, abData);
      renderVenueFilter(state.venues, state);
      drawChart(state);

      renderEarnings(index.topEarners, 'receipts-top', 'receipts-top-section', state.lookup, true,  abData);
      renderEarnings(index.lowEarners, 'receipts-low', 'receipts-low-section', state.lookup, false, abData);
      renderDeficiencies(computeDeficiencyStats(abData));

      var sourceBtns = document.querySelectorAll('.receipts-source-btn');
      sourceBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var src = btn.dataset.source;
          sourceBtns.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
          document.getElementById('top-desc-ls').hidden = src !== 'ls';
          document.getElementById('top-desc-ab').hidden = src !== 'ab';
          var items = src === 'ab' ? (index.txTopEarners || []) : index.topEarners;
          renderEarnings(items, 'receipts-top', 'receipts-top-section', state.lookup, true, abData, src);
        });
      });
    }).catch(function (err) {
      if (window.console && console.error) console.error('Receipts load failed', err);
      renderMissing();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
