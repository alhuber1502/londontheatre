/* London Stage, 1660-1800 — venue detail view
   Plain JS (no bundler). Reads ?code=<TheatreCode> from the URL and
   renders one entry from data/theatres/venue-details.json plus the
   theatre-abbreviations map for the canonical name. Decade sparkline
   and programming-mix bar are hand-rolled inline SVG/HTML. */

(function () {
  'use strict';

  var PERFORMER_CAP = 40;
  var ROLE_CAP = 40;

  var EXPENSE_CATS = [
    { key: 'Personnel',                        color: '#7a3028' },
    { key: 'Music',                            color: '#a05c28' },
    { key: 'Clothing',                         color: '#c4813a' },
    { key: 'Properties, Scenes and Machines',  color: '#4d7a50' },
    { key: 'Heating and Lighting',             color: '#c8a020' },
    { key: 'Printing and Advertising',         color: '#4a6e9a' },
    { key: 'Proprietorial',                    color: '#6b4d80' },
    { key: 'Leases, Rates and Taxes',          color: '#9a2828' },
    { key: 'Authors and Scripts',              color: '#2e6b5e' },
    { key: 'Finance and Law',                  color: '#8a6020' },
    { key: 'Upkeep and Refurbishments',        color: '#5a7040' },
    { key: 'Other',                            color: '#8a8878' }
  ];

  var DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];

  var currentVenue        = null;
  var currentTheatreIndex = null;
  var sliderFrom = 0;
  var sliderTo   = 15;
  var allEras    = true;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString('en-GB');
  }

  function fmtPct(v, total) {
    if (!total) return '0%';
    var pct = (v / total) * 100;
    if (pct > 0 && pct < 1) return '<1%';
    return Math.round(pct) + '%';
  }

  function getCodeParam() {
    try {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get('code');
      if (!raw) return '';
      return String(raw).trim();
    } catch (e) {
      return '';
    }
  }

  function canonicalFor(theatres, code) {
    if (!code) return null;
    var key = String(code).toLowerCase().replace(/\s+/g, '');
    var entry = theatres && theatres[key];
    return entry && entry.canonical ? entry.canonical : null;
  }

  // Make every <li.is-row-link[data-href]> inside a list clickable. Inner
  // <a> elements keep their normal behaviour (keyboard + a11y); the row
  // handler is a mouse-affordance layer so you can click anywhere in
  // the row without having to hit the link exactly.
  function wireListRowLinks(container) {
    if (!container || container._rowLinksWired) return;
    container._rowLinksWired = true;
    container.addEventListener('click', function (ev) {
      var interactive = ev.target.closest ? ev.target.closest('a, button, input, select, textarea, label, [role="button"]') : null;
      if (interactive) return;
      var li = ev.target.closest ? ev.target.closest('li.is-row-link') : null;
      if (!li) return;
      var href = li.getAttribute('data-href');
      if (!href) return;
      if (ev.metaKey || ev.ctrlKey || ev.button === 1) window.open(href, '_blank', 'noopener');
      else window.location.href = href;
    });
    container.addEventListener('auxclick', function (ev) {
      if (ev.button !== 1) return;
      var li = ev.target.closest ? ev.target.closest('li.is-row-link') : null;
      if (!li) return;
      var href = li.getAttribute('data-href');
      if (!href) return;
      ev.preventDefault();
      window.open(href, '_blank', 'noopener');
    });
  }

  // ------------ Slider helpers ------------

  function sortByCount(acc, keyProp, limit) {
    return Object.keys(acc)
      .sort(function (a, b) { return acc[b] - acc[a]; })
      .slice(0, limit)
      .map(function (k) { var o = {}; o[keyProp] = k; o.count = acc[k]; return o; });
  }

  function mergeDecadeRange(record, fromIdx, toIdx) {
    var decadesData = record.decades || {};
    var perfAcc = {}, workAcc = {};
    for (var i = fromIdx; i <= toIdx; i++) {
      var dec = decadesData[String(DECADES[i])];
      if (!dec) continue;
      (dec.performers || []).forEach(function (r) { perfAcc[r.name] = (perfAcc[r.name] || 0) + r.count; });
      (dec.works      || []).forEach(function (r) {
        // build-venue-details bakes ptypeLabel and genre into every per-decade
        // work, so we can take them directly here. workId is the primary key.
        var key = r.workId != null ? String(r.workId) : (r.title || '');
        if (!workAcc[key]) {
          workAcc[key] = {
            id: r.workId,
            title: r.title,
            ptypeLabel: r.ptypeLabel || null,
            genre: r.genre || null,
            count: 0
          };
        }
        workAcc[key].count += r.count;
      });
    }
    var merged = {};
    for (var k in record) { if (Object.prototype.hasOwnProperty.call(record, k)) merged[k] = record[k]; }
    merged.topPerformers = sortByCount(perfAcc, 'name', PERFORMER_CAP);
    merged.topWorks = Object.keys(workAcc)
      .sort(function (a, b) { return workAcc[b].count - workAcc[a].count; })
      .slice(0, 40)
      .map(function (k) {
        var w = workAcc[k];
        var out = { workId: w.id, title: w.title, ptypeLabel: w.ptypeLabel, count: w.count };
        if (w.genre) out.genre = w.genre;
        return out;
      });
    return merged;
  }

  function updateSparkBars() {
    var host = document.getElementById('venue-sparkline');
    if (!host) return;
    var rects = host.querySelectorAll('.spark-bar');
    rects.forEach(function (rect, i) {
      if (i >= sliderFrom && i <= sliderTo) {
        rect.classList.add('drng-in');
        rect.classList.remove('drng-out');
      } else {
        rect.classList.add('drng-out');
        rect.classList.remove('drng-in');
      }
    });
  }

  // Receipts mini-chart (dots) and Expenses stacked bars: grey out columns
  // outside the slider's decade range. Both elements carry data-year so we
  // can compare against [DECADES[from] .. DECADES[to]+9].
  function updateFinanceChartsRange() {
    var yFrom = allEras ? -Infinity : DECADES[sliderFrom];
    var yTo   = allEras ?  Infinity : DECADES[sliderTo] + 9;
    var nodes = document.querySelectorAll(
      '#venue-receipts-chart .receipts-dot[data-year], ' +
      '#venue-expenses-chart .venue-exp-bar[data-year]'
    );
    nodes.forEach(function (el) {
      var y = +el.getAttribute('data-year');
      var inRange = y >= yFrom && y <= yTo;
      if (inRange) {
        el.classList.add('drng-in');
        el.classList.remove('drng-out');
      } else {
        el.classList.add('drng-out');
        el.classList.remove('drng-in');
      }
    });
  }

  function updateSliderUI(from, to) {
    var label = document.getElementById('venue-drng-label');
    var bg    = document.getElementById('venue-drng-bg');
    if (from === 0 && to === 15) {
      if (label) label.textContent = 'All decades';
    } else {
      var d0 = DECADES[from], d1 = DECADES[to];
      if (label) label.textContent = d0 + 's–' + d1 + 's';
    }
    var loPct = (from / 15) * 100;
    var hiPct = (to   / 15) * 100;
    if (bg) {
      bg.style.setProperty('--drng-lo', loPct.toFixed(1) + '%');
      bg.style.setProperty('--drng-hi', hiPct.toFixed(1) + '%');
    }
    updateSparkBars();
    updateFinanceChartsRange();
  }

  function renderFiltered() {
    if (!currentVenue) return;
    var data = allEras
      ? currentVenue
      : mergeDecadeRange(currentVenue, sliderFrom, sliderTo);
    renderWorks(data);
    renderPerformers(data);
  }

  function initSlider() {
    var wrap   = document.getElementById('venue-drng');
    var ticks  = document.getElementById('venue-drng-ticks');
    var inFrom = document.getElementById('venue-drng-from');
    var inTo   = document.getElementById('venue-drng-to');
    var btnAll = document.getElementById('venue-drng-all');
    if (!wrap || !inFrom || !inTo) return;

    if (ticks) {
      ticks.innerHTML = DECADES.map(function (d) {
        return '<span>' + (d % 20 === 0 ? d : '') + '</span>';
      }).join('');
    }

    updateSliderUI(0, 15);
    wrap.hidden = false;

    function onInput() {
      var f = parseInt(inFrom.value, 10);
      var t = parseInt(inTo.value,   10);
      if (f > t) {
        if (this === inFrom) inFrom.value = t; else inTo.value = f;
        f = parseInt(inFrom.value, 10);
        t = parseInt(inTo.value,   10);
      }
      sliderFrom = f; sliderTo = t;
      allEras = (f === 0 && t === 15);
      if (btnAll) btnAll.setAttribute('aria-pressed', allEras ? 'true' : 'false');
      updateSliderUI(f, t);
    }

    inFrom.addEventListener('input',  onInput);
    inTo.addEventListener('input',    onInput);
    inFrom.addEventListener('change', renderFiltered);
    inTo.addEventListener('change',   renderFiltered);

    if (btnAll) {
      btnAll.addEventListener('click', function () {
        inFrom.value = 0; inTo.value = 15;
        sliderFrom = 0; sliderTo = 15; allEras = true;
        btnAll.setAttribute('aria-pressed', 'true');
        updateSliderUI(0, 15);
        renderFiltered();
      });
    }
  }

  // ------------ Data ------------

  function loadExpenses(code) {
    if (code !== 'cg' && code !== 'dl') return Promise.resolve(null);
    return fetch('data/receipts/theatronomics-expenses.json').then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).catch(function () { return null; });
  }

  function loadData(code) {
    var detailsP = fetch('data/theatres/venue-details.json').then(function (r) {
      if (!r.ok) throw new Error('venue-details.json ' + r.status);
      return r.json();
    });
    var theatresP = fetch('data/theatre-abbreviations.json').then(function (r) {
      if (!r.ok) throw new Error('theatre-abbreviations.json ' + r.status);
      return r.json();
    });
    // Receipts are optional — a venue never reporting a take just hides
    // the section. Don't fail the page load if the file is missing.
    var receiptsP = fetch('data/receipts/index.json').then(function (r) {
      if (!r.ok) return null;
      return r.json();
    }).catch(function () { return null; });
    var expensesP = loadExpenses(code);
    return Promise.all([detailsP, theatresP, receiptsP, expensesP]);
  }

  // ------------ Header ------------

  function renderHead(venue, canonical) {
    var section = document.getElementById('venue-head');
    var titleEl = document.getElementById('venue-title');
    var subEl = document.getElementById('venue-subtitle');
    if (!section || !titleEl || !subEl) return;

    var name = canonical || venue.code.toUpperCase();
    titleEl.textContent = name;

    var nights = Number(venue.events) || 0;
    var first = Number(venue.firstYear) || null;
    var last = Number(venue.lastYear) || null;

    var parts = [];
    parts.push('Playhouse code <strong>' + escapeHtml(venue.code.toUpperCase()) + '</strong>');
    if (nights) {
      parts.push(fmtNum(nights) + ' night' + (nights === 1 ? '' : 's') + ' recorded');
    }
    if (first && last) {
      parts.push(first === last ? String(first) : (first + '–' + last));
    } else if (first) {
      parts.push(String(first));
    }
    subEl.innerHTML = parts.join(' · ');
    section.hidden = false;

    document.title = name + ' — The London Stage, 1660–1800';
  }

  // ------------ Ledger ------------

  function renderLedger(venue) {
    var wrap = document.getElementById('venue-ledger');
    var section = document.getElementById('venue-stats');
    if (!wrap || !section) return;

    var nights = Number(venue.events) || 0;
    var perfs = Number(venue.performances) || 0;
    var castCount = (venue.topPerformers || []).length;
    var workCount = (venue.topWorks || []).length;
    var first = Number(venue.firstYear) || null;
    var last = Number(venue.lastYear) || null;
    var span = (first && last) ? (last - first + 1) : null;

    var castFig = castCount >= PERFORMER_CAP ? fmtNum(PERFORMER_CAP) + '+' : fmtNum(castCount);
    var workFig = workCount > 0 ? fmtNum(workCount) + '+' : '&mdash;';
    var spanFig = span != null
      ? fmtNum(span) + ' <em>seasons</em>'
      : '&mdash;';

    var entries = [
      { fig: fmtNum(nights), label: 'Evenings billed' },
      { fig: fmtNum(perfs),  label: 'Performances' },
      { fig: workFig,        label: 'Distinct works' },
      { fig: castFig,        label: 'Named in cast' },
      { fig: spanFig,        label: 'Span in years' }
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

  // ------------ Programming mix ------------

  function renderMix(venue) {
    var host = document.getElementById('venue-mix');
    var section = document.getElementById('venue-mix-section');
    if (!host || !section) return;

    var mix = (venue.ptypeMix || []).slice();
    if (!mix.length) { section.hidden = true; return; }

    var total = mix.reduce(function (s, m) { return s + (m.count || 0); }, 0);
    if (!total) { section.hidden = true; return; }

    var segs = mix.map(function (m) {
      return '<span class="venue-mix-seg is-' + escapeHtml(m.ptype) +
        '" style="flex:' + m.count + ' 1 0;" ' +
        'aria-label="' + escapeHtml(m.label) + ' ' + fmtPct(m.count, total) + '" ' +
        'title="' + escapeHtml(m.label + ' · ' + fmtNum(m.count) + ' · ' + fmtPct(m.count, total)) +
        '"></span>';
    }).join('');

    var legend = mix.map(function (m) {
      return (
        '<span class="venue-mix-key">' +
          '<span class="venue-mix-swatch is-' + escapeHtml(m.ptype) + '"></span>' +
          escapeHtml(m.label.charAt(0).toUpperCase() + m.label.slice(1)) +
          ' <span class="venue-mix-figure metadata-label">' + fmtPct(m.count, total) + '</span>' +
        '</span>'
      );
    }).join('');

    host.innerHTML =
      '<div class="venue-mix-bar" role="img" aria-label="Programming mix">' + segs + '</div>' +
      '<p class="venue-mix-legend metadata-label">' + legend + '</p>';

    section.hidden = false;
  }

  // ------------ Decade sparkline ------------

  function renderSparkline(venue) {
    var host = document.getElementById('venue-sparkline');
    var section = document.getElementById('venue-decade-section');
    if (!host || !section) return;

    var by = venue.byDecade || {};
    var rows = DECADES.map(function (d) {
      return { decade: d, count: Number(by[String(d)]) || 0 };
    });

    var maxCount = 0;
    rows.forEach(function (r) { if (r.count > maxCount) maxCount = r.count; });
    if (maxCount <= 0) maxCount = 1;

    var colW = 40;
    var barW = 18;
    var chartH = 140;
    var baseY = chartH;
    var labelY = chartH + 22;
    var width = rows.length * colW;
    var height = labelY + 8;

    var bars = [];
    var labels = [];
    rows.forEach(function (r, i) {
      var x = i * colW + (colW - barW) / 2;
      var h = r.count > 0 ? (r.count / maxCount) * chartH : 0;
      if (r.count > 0 && h < 3) h = 3;
      var y = baseY - h;
      var cls = 'spark-bar' + (r.count === 0 ? ' is-empty' : '');
      var tip = r.decade + 's · ' + fmtNum(r.count) +
        ' night' + (r.count === 1 ? '' : 's');
      bars.push(
        '<rect class="' + cls + '" x="' + x + '" y="' + y +
        '" width="' + barW + '" height="' + (h || 1) +
        '" rx="0.5" ry="0.5">' +
        '<title>' + escapeHtml(tip) + '</title>' +
        '</rect>'
      );
      if (r.decade % 20 === 0) {
        labels.push(
          '<text class="spark-label" x="' + (i * colW + colW / 2) +
          '" y="' + labelY + '" text-anchor="middle">' +
          r.decade + '</text>'
        );
      }
    });

    var svg =
      '<svg role="img" aria-label="Nights by decade" ' +
      'viewBox="0 0 ' + width + ' ' + height + '" ' +
      'preserveAspectRatio="none">' +
        bars.join('') +
        '<line class="spark-baseline" x1="0" y1="' + baseY +
        '" x2="' + width + '" y2="' + baseY + '"></line>' +
        labels.join('') +
      '</svg>';

    host.innerHTML = svg;
    section.hidden = false;
  }

  // ------------ Signature works ------------

  function renderWorks(venue) {
    var list = document.getElementById('venue-works');
    var section = document.getElementById('venue-works-section');
    if (!list || !section) return;

    var rows = (venue.topWorks || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var html = rows.map(function (r) {
      var id = r.workId;
      var href = id ? 'work.html?id=' + encodeURIComponent(id) : null;
      var labelText = r.ptypeLabel ? (r.ptypeLabel.charAt(0).toUpperCase() + r.ptypeLabel.slice(1)) : '';
      var tags = '';
      if (labelText) tags += '<span class="bar-code metadata-label">' + escapeHtml(labelText) + '</span>';
      if (r.genre)   tags += '<span class="bar-code metadata-label venue-work-genre">' + escapeHtml(r.genre) + '</span>';
      var title = r.title || '(untitled)';
      var link = href
        ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(title) + '</a>'
        : escapeHtml(title);
      var rowAttr = href ? ' class="is-row-link" data-href="' + escapeHtml(href) + '"' : '';
      return (
        '<li' + rowAttr + '>' +
          '<span class="performer-pairing-label">' + link + tags + '</span>' +
          '<span class="performer-costar-count metadata-label">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    wireListRowLinks(list);
    section.hidden = false;
  }

  // ------------ Most-cast performers ------------

  function renderPerformers(venue) {
    var list = document.getElementById('venue-performers');
    var section = document.getElementById('venue-performers-section');
    var note = document.getElementById('venue-performers-note');
    if (!list || !section) return;

    var rows = (venue.topPerformers || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var html = rows.map(function (r) {
      var name = r.name || '';
      var href = 'performer.html?name=' + encodeURIComponent(name);
      return (
        '<li class="is-row-link" data-href="' + escapeHtml(href) + '">' +
          '<a href="' + escapeHtml(href) + '">' + escapeHtml(name) + '</a>' +
          '<span class="performer-costar-count metadata-label">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    wireListRowLinks(list);
    if (note) note.hidden = rows.length < PERFORMER_CAP;
    section.hidden = false;
  }

  // ------------ Signature roles ------------

  function renderRoles(venue) {
    var list = document.getElementById('venue-roles');
    var section = document.getElementById('venue-roles-section');
    var note = document.getElementById('venue-roles-note');
    if (!list || !section) return;

    var rows = (venue.topRoles || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var html = rows.map(function (r) {
      var href = 'role.html?name=' + encodeURIComponent(r.role || '');
      return (
        '<li class="is-row-link" data-href="' + escapeHtml(href) + '">' +
          '<a class="performer-role-name" href="' + escapeHtml(href) + '">' + escapeHtml(r.role || '') + '</a>' +
          '<span class="performer-role-count metadata-label">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    wireListRowLinks(list);
    if (note) note.hidden = rows.length < ROLE_CAP;
    section.hidden = false;
  }

  // ------------ Receipts strip ------------

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

  function seasonStartYear(s) {
    var m = String(s || '').match(/^(\d{4})/);
    return m ? +m[1] : null;
  }

  function renderReceipts(venueCode, receiptsIndex) {
    var section = document.getElementById('venue-receipts-section');
    if (!section || !receiptsIndex) return;
    var venues = receiptsIndex.venues || [];
    var row = null;
    for (var i = 0; i < venues.length; i++) {
      if (venues[i].code === venueCode) { row = venues[i]; break; }
    }
    if (!row || !row.count) { section.hidden = true; return; }

    // ---- Intro blurb ----
    var intro = document.getElementById('venue-receipts-intro');
    if (intro) {
      var first = row.firstYear, last = row.lastYear;
      var span = first && last ? (first === last ? String(first) : first + '–' + last) : '';
      var txt = 'This playhouse reports a take for ' + fmtNum(row.count) +
                ' nights' + (span ? ' across ' + span : '') +
                ', preserved in the managers’ marginal notes in the printed calendars.';
      intro.textContent = txt;
    }

    // ---- Ledger ----
    var ledger = document.getElementById('venue-receipts-ledger');
    if (ledger) {
      var grand = '£' + fmtNum(Math.round((row.sumPence || 0) / 240));
      var benefitShare = row.count ? Math.round((row.benefits / row.count) * 100) : 0;
      var entries = [
        { fig: fmtNum(row.count),         label: 'Nights with receipts' },
        { fig: fmtMoney(row.medianPence), label: 'Median night' },
        { fig: fmtMoney(row.maxPence),    label: 'Best night on record' },
        { fig: grand,                     label: 'Aggregate take' },
        { fig: benefitShare + '%',        label: 'Benefit-night share' }
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

    // ---- Mini chart: median per season ----
    var host = document.getElementById('venue-receipts-chart');
    if (host) {
      var rows = [];
      Object.keys(row.bySeason || {}).forEach(function (s) {
        var y = seasonStartYear(s);
        if (y == null) return;
        rows.push({ year: y, season: s, pence: row.bySeason[s].medianPence, count: row.bySeason[s].count });
      });
      rows.sort(function (a, b) { return a.year - b.year; });

      if (!rows.length) {
        host.innerHTML = '';
      } else {
        var W = 720, H = 180;
        var M = { t: 10, r: 10, b: 24, l: 44 };
        var plotW = W - M.l - M.r;
        var plotH = H - M.t - M.b;
        var xMin = rows[0].year, xMax = rows[rows.length - 1].year, xSpan = Math.max(1, xMax - xMin);
        var yMaxPence = 0;
        rows.forEach(function (r) { if (r.pence > yMaxPence) yMaxPence = r.pence; });
        if (yMaxPence <= 0) yMaxPence = 24000;
        var yMaxPounds = Math.ceil((yMaxPence / 240) / 25) * 25;
        var yMax = yMaxPounds * 240;
        function xOf(y) { return M.l + ((y - xMin) / xSpan) * plotW; }
        function yOf(p) { return M.t + plotH - (p / yMax) * plotH; }

        var parts = [];
        // y ticks
        var yStep = yMaxPounds <= 100 ? 25 : (yMaxPounds <= 400 ? 50 : 100);
        for (var yy = 0; yy <= yMaxPounds; yy += yStep) {
          var yp = yOf(yy * 240);
          parts.push(
            '<line class="receipts-grid" x1="' + M.l + '" y1="' + yp +
            '" x2="' + (M.l + plotW) + '" y2="' + yp + '"></line>' +
            '<text class="receipts-axis-label" x="' + (M.l - 6) + '" y="' + (yp + 3) +
            '" text-anchor="end">£' + yy + '</text>'
          );
        }
        // x ticks
        var startDec = Math.ceil(xMin / 10) * 10;
        for (var d = startDec; d <= xMax; d += 10) {
          var xx = xOf(d);
          parts.push(
            '<text class="receipts-axis-label" x="' + xx + '" y="' + (H - 8) +
            '" text-anchor="middle">' + d + '</text>'
          );
        }
        parts.push(
          '<line class="receipts-axis" x1="' + M.l + '" y1="' + (M.t + plotH) +
          '" x2="' + (M.l + plotW) + '" y2="' + (M.t + plotH) + '"></line>'
        );

        var path = rows.map(function (r, i) {
          return (i === 0 ? 'M' : 'L') + xOf(r.year).toFixed(1) + ',' + yOf(r.pence).toFixed(1);
        }).join(' ');
        parts.push('<path class="receipts-line" d="' + path + '" stroke="var(--brick)" />');
        rows.forEach(function (r) {
          var px = xOf(r.year).toFixed(1), py = yOf(r.pence).toFixed(1);
          parts.push(
            '<circle class="receipts-dot" data-year="' + r.year +
            '" cx="' + px + '" cy="' + py + '" r="2" fill="var(--brick)">' +
            '<title>' + escapeHtml(r.season + ' · median ' + fmtMoney(r.pence) +
              ' across ' + r.count + ' night' + (r.count === 1 ? '' : 's')) +
            '</title></circle>'
          );
        });

        host.innerHTML = '<svg role="img" aria-label="Median nightly receipts by season" ' +
          'viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
          parts.join('') + '</svg>';
      }
    }

    section.hidden = false;
  }

  // ------------ Expense profile (CG/DL only) ------------

  function renderExpenses(venueCode, expData) {
    var section = document.getElementById('venue-expenses-section');
    if (!section || !expData) return;

    var MIN_PENCE = 120000;
    var prefix = venueCode + ':';

    var seasons = [];
    Object.keys(expData).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      var season = k.slice(prefix.length);
      var cats = expData[k];
      var total = Object.keys(cats).reduce(function (s, c) { return s + (cats[c] || 0); }, 0);
      if (total < MIN_PENCE) return;
      var year = parseInt(season.slice(0, 4), 10);
      if (isNaN(year)) return;
      seasons.push({ season: season, year: year, cats: cats, total: total });
    });

    if (!seasons.length) { section.hidden = true; return; }
    seasons.sort(function (a, b) { return a.year - b.year; });

    var intro = document.getElementById('venue-expenses-intro');
    if (intro) {
      intro.textContent = 'Expenses across ' + seasons.length + ' seasons, ' +
        seasons[0].season + ' to ' + seasons[seasons.length - 1].season +
        ', drawn from the Theatronomics account books. ' +
        'Each bar shows the proportional share of expenditure by category.';
    }

    var legendEl = document.getElementById('venue-expenses-legend');
    if (legendEl) {
      legendEl.innerHTML = EXPENSE_CATS.map(function (c) {
        return (
          '<span class="venue-exp-legend-item">' +
            '<span class="venue-exp-swatch" style="background:' + c.color + '"></span>' +
            escapeHtml(c.key) +
          '</span>'
        );
      }).join('');
    }

    var host = document.getElementById('venue-expenses-chart');
    if (!host) { section.hidden = false; return; }

    var W = 720, H = 220;
    var M = { t: 10, r: 12, b: 28, l: 40 };
    var plotW = W - M.l - M.r;
    var plotH = H - M.t - M.b;

    var xMin = seasons[0].year;
    var xMax = seasons[seasons.length - 1].year;
    var xSpan = Math.max(1, xMax - xMin);
    var stride = plotW / xSpan;
    var barW = Math.max(4, Math.min(10, Math.floor(stride * 0.75)));

    function xOf(y) { return M.l + ((y - xMin) / xSpan) * plotW; }

    var parts = [];

    [0, 25, 50, 75, 100].forEach(function (pct) {
      var yp = M.t + plotH - (pct / 100) * plotH;
      parts.push(
        '<line class="receipts-grid" x1="' + M.l + '" y1="' + yp.toFixed(1) +
        '" x2="' + (M.l + plotW) + '" y2="' + yp.toFixed(1) + '"></line>' +
        '<text class="receipts-axis-label" x="' + (M.l - 5) + '" y="' + (yp + 3).toFixed(1) +
        '" text-anchor="end">' + pct + '%</text>'
      );
    });

    parts.push(
      '<line class="receipts-axis" x1="' + M.l + '" y1="' + (M.t + plotH) +
      '" x2="' + (M.l + plotW) + '" y2="' + (M.t + plotH) + '"></line>'
    );

    var startDec = Math.ceil(xMin / 10) * 10;
    for (var d = startDec; d <= xMax; d += 10) {
      parts.push(
        '<text class="receipts-axis-label" x="' + xOf(d).toFixed(1) + '" y="' + (H - 8) +
        '" text-anchor="middle">' + d + '</text>'
      );
    }

    seasons.forEach(function (s) {
      var x = (xOf(s.year) - barW / 2).toFixed(1);
      var cumPct = 0;

      var tipLines = [s.season, 'Total: £' + fmtNum(Math.round(s.total / 240))];
      EXPENSE_CATS.forEach(function (c) {
        var v = s.cats[c.key] || 0;
        if (!v) return;
        tipLines.push(c.key + ': ' + Math.round((v / s.total) * 100) + '% (£' + fmtNum(Math.round(v / 240)) + ')');
      });
      var tip = escapeHtml(tipLines.join('\n'));

      // Wrap each season's stack in a <g> so the slider can fade the whole
      // column at once via the drng-out class.
      var segParts = [];
      EXPENSE_CATS.forEach(function (c) {
        var v = s.cats[c.key] || 0;
        if (!v) return;
        var pct = v / s.total;
        var segH = pct * plotH;
        var segY = (M.t + plotH - (cumPct + pct) * plotH).toFixed(1);
        cumPct += pct;
        segParts.push(
          '<rect x="' + x + '" y="' + segY +
          '" width="' + barW + '" height="' + segH.toFixed(1) +
          '" fill="' + c.color + '">' +
          '<title>' + tip + '</title>' +
          '</rect>'
        );
      });
      parts.push('<g class="venue-exp-bar" data-year="' + s.year + '">' + segParts.join('') + '</g>');
    });

    host.innerHTML = '<svg role="img" aria-label="Seasonal expense profile" ' +
      'viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
      parts.join('') + '</svg>';

    section.hidden = false;
  }

  // ------------ Blank state ------------

  function renderMissing(reason, code) {
    var block = document.getElementById('venue-missing');
    var heading = document.getElementById('missing-heading');
    var body = document.getElementById('missing-body');
    if (!block) return;
    if (reason === 'no-code') {
      if (heading) heading.textContent = 'No playhouse requested';
      if (body) body.textContent = 'This page expects a theatre code in the URL, e.g. venue.html?code=DL.';
    } else if (reason === 'unknown') {
      if (heading) heading.textContent = 'Not in the gazetteer';
      if (body) body.textContent = 'We could not find a playhouse with code "' + (code || '') +
        '" in the London Stage calendars.';
    } else if (reason === 'error') {
      if (heading) heading.textContent = 'Unavailable';
      if (body) body.textContent = 'The playhouse details could not be loaded. Please reload the page or try again later.';
    }
    block.hidden = false;
    document.title = 'Playhouse not found — The London Stage, 1660–1800';
  }

  // ------------ Boot ------------

  function boot() {
    var code = getCodeParam();
    if (!code) {
      renderMissing('no-code', null);
      return;
    }

    var key = code.toLowerCase().replace(/\s+/g, '');

    loadData(key).then(function (res) {
      var detailsDoc = res[0] || {};
      var theatresDoc = res[1] || {};
      var receiptsIndex = res[2] || null;
      var expData = res[3] || null;
      var details = detailsDoc.details || {};
      var theatreIndex = Object.assign(
        {},
        theatresDoc.sentinels || {},
        theatresDoc.compound || {},
        theatresDoc.entries || {}
      );

      var venue = details[key];
      if (!venue) {
        renderMissing('unknown', code);
        return;
      }

      currentVenue = venue;
      currentTheatreIndex = theatreIndex;

      var canonical = canonicalFor(theatreIndex, key);

      renderHead(venue, canonical);
      renderLedger(venue);
      renderMix(venue);
      renderSparkline(venue);
      renderReceipts(key, receiptsIndex);
      renderExpenses(key, expData);
      renderWorks(venue);
      renderPerformers(venue);
      renderRoles(venue);
      initSlider();
    }).catch(function (err) {
      if (window.console && console.error) console.error('Venue load failed', err);
      renderMissing('error', code);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
