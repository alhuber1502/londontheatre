/* London Stage, 1660-1800 — performer detail view
   Plain JS (no bundler). Reads ?name=<Performer> from the URL and
   renders one entry from data/performers/by-name/<encoded>.json plus the
   theatre-abbreviations map. No charting library — the decade
   sparkline is hand-rolled inline SVG. */

(function () {
  'use strict';

  var ROLE_CAP = 40;
  var THEATRE_CAP = 10;

  var DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];

  // Slider state
  var currentProfile      = null;
  var currentTheatreIndex = null;
  var sliderFrom = 0;
  var sliderTo   = 15;
  var allEras    = true;

  // Same gender -> period label mapping as people.js. Repeated here
  // rather than shared so this page stays a single, small script.
  var KIND_LABEL = {
    'female':        'Actress',
    'male-explicit': 'Actor',
    'male-inferred': 'Actor',
    'male-child':    'Child performer',
    'company':       'Company',
    'unknown':       'Performer'
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString('en-GB');
  }

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

  function kindLabel(gender) {
    return KIND_LABEL[gender] || KIND_LABEL.unknown;
  }

  function getNameParam() {
    try {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get('name');
      if (!raw) return '';
      return String(raw).trim();
    } catch (e) {
      return '';
    }
  }

  function canonicalTheatre(theatres, code) {
    if (!code) return null;
    var key = String(code).toLowerCase().replace(/\s+/g, '');
    var entry = theatres && theatres[key];
    return entry && entry.canonical ? entry.canonical : null;
  }

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

  // ------------ Data ------------

  function loadData(name) {
    var shardP = fetch('data/performers/by-name/' + encodeURIComponent(name) + '.json').then(function (r) {
      if (r.status === 404) throw new Error('unknown');
      if (!r.ok) throw new Error('shard ' + r.status);
      return r.json();
    });
    var theatresP = fetch('data/theatre-abbreviations.json').then(function (r) {
      if (!r.ok) throw new Error('theatre-abbreviations.json ' + r.status);
      return r.json();
    });
    return Promise.all([shardP, theatresP]);
  }

  // ------------ Decade-range merge ------------

  function sortByCount(acc, keyProp, limit) {
    return Object.keys(acc).map(function (k) {
      var o = {}; o[keyProp] = k; o.count = acc[k]; return o;
    }).sort(function (a, b) { return b.count - a.count; }).slice(0, limit);
  }

  function mergeDecadeRange(record, fromIdx, toIdx) {
    var decades = record.decades || {};
    var roleAcc = {}, costarAcc = {}, venueAcc = {};
    for (var i = fromIdx; i <= toIdx; i++) {
      var dec = decades[String(DECADES[i])];
      if (!dec) continue;
      (dec.roles   || []).forEach(function (r) { roleAcc[r.role]   = (roleAcc[r.role]   || 0) + r.count; });
      (dec.costars || []).forEach(function (r) { costarAcc[r.name] = (costarAcc[r.name] || 0) + r.count; });
      (dec.venues  || []).forEach(function (r) { venueAcc[r.code]  = (venueAcc[r.code]  || 0) + r.count; });
    }
    var merged = {};
    for (var k in record) { if (Object.prototype.hasOwnProperty.call(record, k)) merged[k] = record[k]; }
    merged.roles     = sortByCount(roleAcc,   'role', ROLE_CAP);
    merged.costars   = sortByCount(costarAcc, 'name', 12);
    merged.byTheatre = sortByCount(venueAcc,  'code', THEATRE_CAP);
    return merged;
  }

  // ------------ Slider helpers ------------

  function decadeLabel(idx) {
    return DECADES[idx] + 's';
  }

  function updateSparkBars() {
    var rects = document.querySelectorAll('#performer-sparkline .spark-bar');
    rects.forEach(function (rect, i) {
      if (rect.classList.contains('is-empty')) { rect.classList.remove('drng-in', 'drng-out'); return; }
      if (allEras) {
        rect.classList.remove('drng-in', 'drng-out');
      } else {
        var inRange = (i >= sliderFrom && i <= sliderTo);
        rect.classList.toggle('drng-in',  inRange);
        rect.classList.toggle('drng-out', !inRange);
      }
    });
  }

  function updateSliderUI() {
    var bg    = document.getElementById('performer-drng-bg');
    var label = document.getElementById('performer-drng-label');
    var btn   = document.getElementById('performer-drng-all');
    if (allEras) {
      if (bg) { bg.style.setProperty('--drng-lo', '0%'); bg.style.setProperty('--drng-hi', '100%'); }
      if (label) label.textContent = 'All decades';
      if (btn) btn.setAttribute('aria-pressed', 'true');
    } else {
      var lo = (sliderFrom / 15) * 100;
      var hi = (sliderTo   / 15) * 100;
      if (bg) { bg.style.setProperty('--drng-lo', lo.toFixed(1) + '%'); bg.style.setProperty('--drng-hi', hi.toFixed(1) + '%'); }
      var text = sliderFrom === sliderTo
        ? decadeLabel(sliderFrom)
        : decadeLabel(sliderFrom) + ' – ' + decadeLabel(sliderTo);
      if (label) label.textContent = text;
      if (btn) btn.setAttribute('aria-pressed', 'false');
    }
  }

  function filterBenefitNights(profile) {
    if (allEras || !profile.benefitNightsList) return profile;
    var yFrom = DECADES[sliderFrom];
    var yTo   = DECADES[sliderTo] + 9;
    var filtered = [];
    (profile.benefitNightsList || []).forEach(function (n) {
      var y = +n.date.slice(0, 4);
      if (y >= yFrom && y <= yTo) filtered.push(n);
    });
    var out = {};
    for (var k in profile) { if (Object.prototype.hasOwnProperty.call(profile, k)) out[k] = profile[k]; }
    out.benefitNightsList = filtered;
    return out;
  }

  function renderFiltered() {
    if (!currentProfile) return;
    if (allEras) {
      renderTheatres(currentProfile, currentTheatreIndex);
      renderRoles(currentProfile);
      renderCostars(currentProfile);
      renderBenefitNights(currentProfile, currentTheatreIndex);
    } else {
      var merged = mergeDecadeRange(currentProfile, sliderFrom, sliderTo);
      renderTheatres(merged, currentTheatreIndex);
      renderRoles(merged);
      renderCostars(merged);
      renderBenefitNights(filterBenefitNights(currentProfile), currentTheatreIndex);
    }
  }

  function initSlider() {
    var wrap   = document.getElementById('performer-drng');
    var fromEl = document.getElementById('performer-drng-from');
    var toEl   = document.getElementById('performer-drng-to');
    var allBtn = document.getElementById('performer-drng-all');
    var ticks  = document.getElementById('performer-drng-ticks');
    if (!wrap || !fromEl || !toEl || !allBtn) return;

    if (ticks) {
      ticks.innerHTML = DECADES.map(function (d) {
        return d % 20 === 0 ? '<span>' + d + '</span>' : '<span></span>';
      }).join('');
    }

    updateSliderUI();
    wrap.hidden = false;

    function onInput() {
      var f = +fromEl.value, t = +toEl.value;
      if (f > t) { var tmp = f; f = t; t = tmp; fromEl.value = f; toEl.value = t; }
      sliderFrom = f; sliderTo = t; allEras = false;
      updateSliderUI();
      updateSparkBars();
    }

    fromEl.addEventListener('input',  onInput);
    toEl.addEventListener('input',    onInput);
    fromEl.addEventListener('change', function () { if (!allEras) renderFiltered(); });
    toEl.addEventListener('change',   function () { if (!allEras) renderFiltered(); });

    allBtn.addEventListener('click', function () {
      allEras = true; sliderFrom = 0; sliderTo = 15;
      fromEl.value = '0'; toEl.value = '15';
      updateSliderUI();
      updateSparkBars();
      renderFiltered();
    });
  }

  // ------------ Identity-caveat banner ------------

  function renderCaveat(name, profile) {
    var block = document.getElementById('performer-caveat');
    var body = document.getElementById('performer-caveat-body');
    if (!block || !body) return;
    var first = Number(profile.firstYear) || null;
    var last = Number(profile.lastYear) || null;
    var span = (first && last) ? (last - first) : 0;
    var collisions = Number(profile.collisionNights) || 0;
    var reasons = [];
    if (span > 50) {
      reasons.push(
        'the first-to-last span on this record is <strong>' + span +
        ' years</strong> (' + first + '–' + last + '), longer than almost any individual career of the period'
      );
    }
    if (collisions > 0) {
      reasons.push(
        '<strong>' + collisions.toLocaleString('en-GB') + ' night' +
        (collisions === 1 ? '' : 's') +
        '</strong> in the calendars credit "' + escapeHtml(name) +
        '" at two or more playhouses simultaneously, which cannot be one person'
      );
    }
    if (!reasons.length) { block.hidden = true; return; }
    body.innerHTML =
      'This record very likely conflates two or more performers sharing the surname "' +
      escapeHtml(name) + '" — ' + reasons.join(', and ') +
      '. The figures below are the sum across all of them; the per-decade chart ' +
      'will often show the hand-off between one person and the next. The ' +
      '<a href="./people.html">People page</a> has a date-range filter that can ' +
      'slice this down to a single era.';
    block.hidden = false;
  }

  // ------------ Header ------------

  function renderHead(name, profile) {
    var section = document.getElementById('performer-head');
    var titleEl = document.getElementById('performer-title');
    var subEl = document.getElementById('performer-subtitle');
    if (!section || !titleEl || !subEl) return;

    titleEl.textContent = name;

    var label = kindLabel(profile.gender);
    var total = Number(profile.total) || 0;
    var first = Number(profile.firstYear) || null;
    var last = Number(profile.lastYear) || null;

    var parts = [escapeHtml(label)];
    if (total) {
      parts.push(fmtNum(total) + ' appearance' + (total === 1 ? '' : 's') + ' recorded');
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

  function renderLedger(profile) {
    var wrap = document.getElementById('performer-ledger');
    var section = document.getElementById('performer-stats');
    if (!wrap || !section) return;

    var total = Number(profile.total) || 0;
    var roleCount = (profile.roles || []).length;
    var theatreCount = (profile.byTheatre || []).length;
    var first = Number(profile.firstYear) || null;
    var last = Number(profile.lastYear) || null;
    var seasons = (first && last) ? (last - first + 1) : null;

    var rolesFig = roleCount >= ROLE_CAP ? fmtNum(ROLE_CAP) + '+' : fmtNum(roleCount);
    var theatresFig = theatreCount >= THEATRE_CAP ? fmtNum(THEATRE_CAP) + '+' : fmtNum(theatreCount);
    var seasonsFig = seasons != null ? fmtNum(seasons) + ' <em>seasons</em>' : '&mdash;';
    var benefitNights = Number(profile.benefitNights) || 0;

    var entries = [
      { fig: fmtNum(total),   label: 'Appearances' },
      { fig: rolesFig,        label: 'Distinct roles' },
      { fig: theatresFig,     label: 'Distinct theatres' },
      { fig: seasonsFig,      label: 'Span in years' }
    ];
    if (benefitNights > 0) {
      entries.push({ fig: fmtNum(benefitNights), label: 'Benefit nights' });
    }

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

  // ------------ Career type ------------

  function renderRoleType(profile) {
    var fig     = document.getElementById('performer-type-fig');
    var section = document.getElementById('performer-type-section');
    if (!fig || !section) return;

    var by = profile.byCat || {};
    var CATS = [
      { key: 'named',    label: 'Named' },
      { key: 'titled',   label: 'Titled' },
      { key: 'generic',  label: 'Generic' },
      { key: 'ensemble', label: 'Ensemble' },
      { key: 'paratext', label: 'Paratext' }
    ];

    var total = 0;
    CATS.forEach(function (c) { total += +by[c.key] || 0; });
    if (!total) { section.hidden = true; return; }

    var segs = CATS.filter(function (c) { return (+by[c.key] || 0) > 0; }).map(function (c) {
      var v = +by[c.key] || 0;
      var pct = (v / total) * 100;
      var pctStr = pct < 1 ? '<1%' : Math.round(pct) + '%';
      return (
        '<span class="role-mix-seg is-' + c.key +
        '" style="flex:' + v + ' 1 0;" ' +
        'aria-label="' + escapeHtml(c.label) + ' ' + pctStr + '" ' +
        'title="' + escapeHtml(c.label + ' · ' + fmtNum(v) + ' · ' + pctStr) + '"></span>'
      );
    }).join('');

    var legend = CATS.filter(function (c) { return (+by[c.key] || 0) > 0; }).map(function (c) {
      var v = +by[c.key] || 0;
      var pct = (v / total) * 100;
      var pctStr = pct < 1 ? '<1%' : Math.round(pct) + '%';
      return (
        '<span class="venue-mix-key">' +
          '<span class="role-mix-swatch is-' + c.key + '"></span>' +
          escapeHtml(c.label) +
          ' <span class="venue-mix-figure metadata-label">' + fmtNum(v) + ' · ' + pctStr + '</span>' +
        '</span>'
      );
    }).join('');

    fig.innerHTML =
      '<div class="role-type-bar" role="img" ' +
        'aria-label="Role profile breakdown">' + segs + '</div>' +
      '<p class="venue-mix-legend metadata-label">' + legend + '</p>';
    section.hidden = false;
  }

  // ------------ Decade sparkline ------------

  function renderSparkline(profile) {
    var host = document.getElementById('performer-sparkline');
    var section = document.getElementById('performer-decade-section');
    if (!host || !section) return;

    var by = profile.byDecade || {};
    var rows = DECADES.map(function (d) {
      return { decade: d, count: Number(by[String(d)]) || 0 };
    });

    var maxCount = 0;
    rows.forEach(function (r) { if (r.count > maxCount) maxCount = r.count; });
    if (maxCount <= 0) maxCount = 1;

    var colW = 40, barW = 18, chartH = 140;
    var baseY = chartH, labelY = chartH + 22;
    var width = rows.length * colW, height = labelY + 8;

    var firstYear = Number(profile.firstYear) || null;
    var lastYear  = Number(profile.lastYear)  || null;

    var bars = [], labels = [];
    rows.forEach(function (r, i) {
      var x = i * colW + (colW - barW) / 2;
      var h = r.count > 0 ? (r.count / maxCount) * chartH : 0;
      if (r.count > 0 && h < 3) h = 3;
      var y = baseY - h;
      var cls = 'spark-bar' + (r.count === 0 ? ' is-empty' : '');
      var tip = r.decade + 's · ' + fmtNum(r.count) +
        ' appearance' + (r.count === 1 ? '' : 's');
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
          '" y="' + labelY + '" text-anchor="middle">' + r.decade + '</text>'
        );
      }
    });

    host.innerHTML =
      '<svg role="img" aria-label="Appearances by decade" ' +
      'viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
        bars.join('') +
        '<line class="spark-baseline" x1="0" y1="' + baseY +
        '" x2="' + width + '" y2="' + baseY + '"></line>' +
        labels.join('') +
      '</svg>';

    section.hidden = false;
  }

  // ------------ Top theatres ------------

  function renderTheatres(profile, theatreIndex) {
    var list = document.getElementById('performer-theatres');
    var section = document.getElementById('performer-theatres-section');
    if (!list || !section) return;

    var rows = (profile.byTheatre || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var top = rows[0].count || 1;

    var html = rows.map(function (r) {
      var code = r.code || '';
      var canonical = canonicalTheatre(theatreIndex, code) || code;
      var pct = Math.max(0, Math.min(100, (r.count / top) * 100));
      var codeBadge = canonical !== code
        ? '<span class="bar-code">' + escapeHtml(code) + '</span>'
        : '';
      return (
        '<li class="performer-bar-row" style="--bar-w: ' + pct.toFixed(1) + '%;">' +
          '<span class="performer-bar-label">' + escapeHtml(canonical) + codeBadge + '</span>' +
          '<span class="performer-bar-count">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    section.hidden = false;
  }

  // ------------ Roles ------------

  function renderRoles(profile) {
    var list = document.getElementById('performer-roles');
    var section = document.getElementById('performer-roles-section');
    var note = document.getElementById('performer-roles-note');
    if (!list || !section) return;

    var rows = (profile.roles || []).slice();
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

  // ------------ Co-stars ------------

  function renderCostars(profile) {
    var list = document.getElementById('performer-costars');
    var section = document.getElementById('performer-costars-section');
    if (!list || !section) return;

    var rows = (profile.costars || []).slice();
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
    section.hidden = false;
  }

  // ------------ Benefit nights ------------

  function renderBenefitNights(profile, theatreIndex) {
    var section = document.getElementById('performer-benefit-section');
    var list    = document.getElementById('performer-benefit-list');
    var intro   = document.getElementById('performer-benefit-intro');
    if (!section || !list) return;

    var nights = profile.benefitNightsList;
    if (!nights || !nights.length) { section.hidden = true; return; }

    var totalBenefits = Number(profile.benefitNights) || nights.length;

    if (intro) {
      if (totalBenefits > nights.length) {
        intro.textContent =
          'This performer appeared in ' + fmtNum(totalBenefits) + ' benefit nights in total. ' +
          'The ' + fmtNum(nights.length) + ' at Covent Garden and Drury Lane from 1732 are shown ' +
          'below with account-book door receipts from Theatronomics.';
      } else {
        intro.textContent =
          fmtNum(nights.length) + ' benefit night' + (nights.length === 1 ? '' : 's') +
          ' recorded in the Covent Garden or Drury Lane account books, with door receipts.';
      }
    }

    var CAP = 12;

    var rows = nights.map(function (n) {
      var theatre = n.venue === 'cg' ? 'Covent Garden' : 'Drury Lane';
      var ti = theatreIndex && (theatreIndex[n.venue] || theatreIndex[(n.venue || '').toLowerCase()]);
      if (ti && ti.canonical) theatre = ti.canonical;

      var dateLink = n.date
        ? '<a href="day.html?date=' + encodeURIComponent(n.date) + '">' + escapeHtml(fmtDate(n.date)) + '</a>'
        : '';
      var venueLink = '<a href="venue.html?code=' + encodeURIComponent(n.venue) + '">' + escapeHtml(theatre) + '</a>';
      var drEl = n.dr
        ? '<span class="performer-benefit-dr">' + escapeHtml(fmtMoney(n.dr)) + '</span>'
        : '';
      var bdEl = n.bd
        ? '<span class="performer-benefit-bd metadata-label" ' +
            'title="Door receipts fell short of house charges by ' + escapeHtml(fmtMoney(n.bd)) + '">' +
            'deficiency ' + escapeHtml(fmtMoney(n.bd)) + '</span>'
        : '';
      return (
        '<li class="performer-benefit-row">' +
          '<span class="performer-benefit-date">' + dateLink + '</span>' +
          '<span class="performer-benefit-venue">' + venueLink + '</span>' +
          '<span class="performer-benefit-amount">' + drEl + bdEl + '</span>' +
        '</li>'
      );
    });

    var overflow = rows.length > CAP;
    list.innerHTML = overflow ? rows.slice(0, CAP).join('') : rows.join('');

    var existing = section.querySelector('.benefit-expand-btn');
    if (existing) existing.remove();

    if (overflow) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'benefit-expand-btn metadata-label';
      btn.textContent = 'Show all ' + rows.length + ' nights';
      btn.addEventListener('click', function () {
        list.innerHTML = rows.join('');
        btn.remove();
      });
      section.appendChild(btn);
    }

    section.hidden = false;
  }

  // ------------ Milestones ------------

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd || yyyymmdd.length < 8) return yyyymmdd || '';
    var y = yyyymmdd.slice(0, 4);
    var m = parseInt(yyyymmdd.slice(4, 6), 10);
    var d = parseInt(yyyymmdd.slice(6, 8), 10);
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (!m || !d) return y;
    return d + ' ' + MONTHS[m - 1] + ' ' + y;
  }

  function milestoneDateEl(date) {
    if (!date) return '';
    var dateStr = fmtDate(date);
    var href = 'day.html?date=' + encodeURIComponent(date);
    return '<a href="' + escapeHtml(href) + '" class="milestone-date">' + escapeHtml(dateStr) + '</a>';
  }

  function renderMilestones(profile, theatreIndex) {
    var list = document.getElementById('performer-milestones');
    var section = document.getElementById('performer-milestones-section');
    if (!list || !section) return;

    var ms = profile.milestones;
    if (!ms) { section.hidden = true; return; }

    var items = [];

    if (ms.stageDebut) {
      var sd = ms.stageDebut;
      var sdTheatre = canonicalTheatre(theatreIndex, sd.venue) || sd.venue || '';
      var sdDetail = [];
      if (sd.title) sdDetail.push(escapeHtml(sd.title));
      if (sdTheatre) sdDetail.push(escapeHtml(sdTheatre));
      if (sd.date)   sdDetail.push(milestoneDateEl(sd.date));
      items.push(
        '<li class="milestone-entry">' +
          '<span class="milestone-badge">Stage debut</span>' +
          '<span class="milestone-detail">' + sdDetail.join(' · ') + '</span>' +
        '</li>'
      );
    }

    if (ms.farewell) {
      var fw = ms.farewell;
      var fwTheatre = canonicalTheatre(theatreIndex, fw.venue) || fw.venue || '';
      var fwDetail = [];
      if (fw.title)  fwDetail.push(escapeHtml(fw.title));
      if (fwTheatre) fwDetail.push(escapeHtml(fwTheatre));
      if (fw.date)   fwDetail.push(milestoneDateEl(fw.date));
      items.push(
        '<li class="milestone-entry">' +
          '<span class="milestone-badge is-farewell">Farewell</span>' +
          '<span class="milestone-detail">' + fwDetail.join(' · ') + '</span>' +
        '</li>'
      );
    }

    if (!items.length) { section.hidden = true; return; }
    list.innerHTML = items.join('');
    section.hidden = false;
  }

  // ------------ Blank state ------------

  function renderMissing(reason, name) {
    var block = document.getElementById('performer-missing');
    var heading = document.getElementById('missing-heading');
    var body = document.getElementById('missing-body');
    if (!block) return;
    if (reason === 'no-name') {
      if (heading) heading.textContent = 'No performer requested';
      if (body) body.textContent = 'This page expects a performer name in the URL, e.g. performer.html?name=Garrick.';
    } else if (reason === 'unknown') {
      if (heading) heading.textContent = 'Not in the dramatis personae';
      if (body) body.textContent = 'We could not find “' + (name || '') +
        '” in the London Stage calendars. Names are case-sensitive and use period spelling (e.g. “Mrs Clive”, not “Clive”).';
    } else if (reason === 'error') {
      if (heading) heading.textContent = 'Unavailable';
      if (body) body.textContent = 'The performer details could not be loaded. Please reload the page or try again later.';
    }
    block.hidden = false;
    document.title = 'Performer not found — The London Stage, 1660–1800';
  }

  // ------------ Boot ------------

  function boot() {
    var name = getNameParam();
    if (!name) {
      renderMissing('no-name', null);
      return;
    }

    loadData(name).then(function (res) {
      var profile     = res[0];
      var theatresDoc = res[1] || {};
      var theatreIndex = Object.assign(
        {},
        theatresDoc.sentinels || {},
        theatresDoc.compound  || {},
        theatresDoc.entries   || {}
      );

      currentProfile      = profile;
      currentTheatreIndex = theatreIndex;

      renderHead(name, profile);
      renderCaveat(name, profile);
      renderLedger(profile);
      renderRoleType(profile);
      renderMilestones(profile, theatreIndex);
      renderSparkline(profile);
      renderTheatres(profile, theatreIndex);
      renderRoles(profile);
      renderCostars(profile);
      renderBenefitNights(profile, theatreIndex);
      initSlider();
    }).catch(function (err) {
      if (window.console && console.error) console.error('Performer load failed', err);
      if (err && err.message === 'unknown') {
        renderMissing('unknown', name);
      } else {
        renderMissing('error', name);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
