/* London Stage, 1660-1800 — work detail view
   Plain JS (no bundler). Reads ?id=<WorkId> from the URL and renders
   one entry from data/works/work-details.json plus the theatre
   abbreviations map. Decade sparkline is hand-rolled inline SVG. */

(function () {
  'use strict';

  var CAST_CAP = 40;
  var ROLE_CAP = 40;
  var THEATRE_CAP = 10;

  var DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];

  var currentWork         = null;
  var currentTheatreIndex = null;
  var sliderFrom = 0;
  var sliderTo   = 15;
  var allEras    = true;

  var PTYPE_LABEL = {
    p: 'Mainpiece',
    a: 'Afterpiece',
    d: 'Dance',
    s: 'Song',
    m: 'Music',
    e: 'Entertainment',
    i: 'Interlude',
    o: 'Other',
    b: 'Ballet'
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

  function ptypeLabel(code) {
    return PTYPE_LABEL[code] || (code ? (code.charAt(0).toUpperCase() + code.slice(1)) : 'Work');
  }

  function getIdParam() {
    try {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get('id');
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

  // Make every <li.is-row-link[data-href]> inside a list clickable —
  // a mouse-affordance layer on top of the inner <a> that stays the
  // canonical link for keyboard + screen readers.
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
    var castAcc = {}, venueAcc = {}, roleAcc = {}, pairingAcc = {};
    for (var i = fromIdx; i <= toIdx; i++) {
      var dec = decadesData[String(DECADES[i])];
      if (!dec) continue;
      (dec.cast     || []).forEach(function (r) { castAcc[r.name]  = (castAcc[r.name]  || 0) + r.count; });
      (dec.venues   || []).forEach(function (r) { venueAcc[r.code] = (venueAcc[r.code] || 0) + r.count; });
      (dec.roles    || []).forEach(function (r) { roleAcc[r.role]  = (roleAcc[r.role]  || 0) + r.count; });
      (dec.pairings || []).forEach(function (r) {
        if (!pairingAcc[r.workId]) {
          pairingAcc[r.workId] = { workId: r.workId, title: r.title, ptype: r.ptype, ptypeLabel: r.ptypeLabel, count: 0 };
        }
        pairingAcc[r.workId].count += r.count;
      });
    }
    var merged = {};
    for (var k in record) { if (Object.prototype.hasOwnProperty.call(record, k)) merged[k] = record[k]; }
    merged.cast      = sortByCount(castAcc,  'name', CAST_CAP);
    merged.byTheatre = sortByCount(venueAcc, 'code', THEATRE_CAP);
    merged.roles     = sortByCount(roleAcc,  'role', ROLE_CAP);
    merged.pairings  = Object.values(pairingAcc)
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 12);
    return merged;
  }

  function updateCastGridRange() {
    var cols = document.querySelectorAll('[data-decade-val]');
    cols.forEach(function (el) {
      var dec = +el.getAttribute('data-decade-val');
      var inRange = allEras || (dec >= DECADES[sliderFrom] && dec <= DECADES[sliderTo]);
      el.classList.toggle('drng-out', !inRange);
      el.classList.toggle('drng-in',  !allEras && inRange);
    });
  }

  function updateSparkBars() {
    var host = document.getElementById('work-sparkline');
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

  function updateSliderUI(from, to) {
    var label = document.getElementById('work-drng-label');
    var bg    = document.getElementById('work-drng-bg');
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
    updateCastGridRange();
  }

  function renderFiltered() {
    if (!currentWork || !currentTheatreIndex) return;
    var yFrom = allEras ? 0    : DECADES[sliderFrom];
    var yTo   = allEras ? 9999 : DECADES[sliderTo] + 9;

    var data = allEras
      ? currentWork
      : mergeDecadeRange(currentWork, sliderFrom, sliderTo);
    renderTheatres(data, currentTheatreIndex);
    renderCast(data);
    renderRoles(data);
    renderPairings(data);

    var msWork = currentWork;
    if (!allEras && currentWork.milestones) {
      var filteredMs = {};
      ['stageDebuts', 'roleDebuts', 'farewells'].forEach(function (key) {
        var arr = currentWork.milestones[key];
        if (!arr) return;
        var kept = arr.filter(function (m) {
          if (!m.date) return true;
          var y = +m.date.slice(0, 4);
          return y >= yFrom && y <= yTo;
        });
        if (kept.length) filteredMs[key] = kept;
      });
      msWork = Object.assign({}, currentWork, {
        milestones: Object.keys(filteredMs).length ? filteredMs : null
      });
    }
    renderMilestones(msWork, currentTheatreIndex);

    if (currentAbNights) {
      var filtered = allEras ? currentAbNights : currentAbNights.filter(function (n) {
        var y = +n.d.slice(0, 4);
        return y >= yFrom && y <= yTo;
      });
      renderAbSection(filtered, currentAbNights);
    }
  }

  function initSlider() {
    var wrap   = document.getElementById('work-drng');
    var ticks  = document.getElementById('work-drng-ticks');
    var inFrom = document.getElementById('work-drng-from');
    var inTo   = document.getElementById('work-drng-to');
    var btnAll = document.getElementById('work-drng-all');
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

  function loadData() {
    var detailsP = fetch('data/works/work-details.json').then(function (r) {
      if (!r.ok) throw new Error('work-details.json ' + r.status);
      return r.json();
    });
    var theatresP = fetch('data/theatre-abbreviations.json').then(function (r) {
      if (!r.ok) throw new Error('theatre-abbreviations.json ' + r.status);
      return r.json();
    });
    return Promise.all([detailsP, theatresP]);
  }

  // ------------ Header ------------

  function renderHead(work) {
    var section = document.getElementById('work-head');
    var titleEl = document.getElementById('work-title');
    var subEl = document.getElementById('work-subtitle');
    var attrEl = document.getElementById('work-attribution');
    if (!section || !titleEl || !subEl) return;

    titleEl.textContent = work.title || '(untitled)';

    var label = ptypeLabel(work.ptype);
    var total = Number(work.total) || 0;
    var first = Number(work.firstYear) || null;
    var last = Number(work.lastYear) || null;
    var tx = work.tx || null;

    var parts = [escapeHtml(label)];
    if (tx && tx.genre && tx.genre.label) {
      parts.push(escapeHtml(tx.genre.label));
    }
    if (tx && tx.medium) {
      parts.push(escapeHtml(tx.medium));
    }
    if (total) {
      parts.push(fmtNum(total) + ' performance' + (total === 1 ? '' : 's') + ' recorded');
    }
    if (first && last) {
      parts.push(first === last ? String(first) : (first + '–' + last));
    } else if (first) {
      parts.push(String(first));
    }
    subEl.innerHTML = parts.join(' · ');

    if (attrEl) renderAttribution(attrEl, tx);

    section.hidden = false;
    document.title = (work.title || 'Work') + ' — The London Stage, 1660–1800';
  }

  // Render the by-line beneath the subtitle: "By <Author> · Composed by <Composer>".
  // Each person becomes a link to ODNB > Wikipedia > VIAF in that order.
  function renderAttribution(el, tx) {
    if (!tx || !tx.persons || !tx.persons.length) {
      el.hidden = true; el.innerHTML = '';
      return;
    }
    var groups = { Author: [], Composer: [], Choreographer: [] };
    tx.persons.forEach(function (p) {
      if (p.label && groups[p.label]) groups[p.label].push(p);
    });
    var verbs = {
      Author: 'By',
      Composer: 'Composed by',
      Choreographer: 'Choreographed by'
    };
    var personLink = function (p) {
      var href = p.odnb || p.wiki || p.viaf || null;
      var name = escapeHtml(p.name || '');
      if (!href) return name;
      var cls = p.odnb ? 'work-person-link work-person-odnb'
              : p.wiki ? 'work-person-link work-person-wiki'
              :          'work-person-link work-person-viaf';
      return '<a href="' + escapeHtml(href) + '" class="' + cls + '" rel="noopener" target="_blank">' + name + '</a>';
    };
    var segments = [];
    ['Author', 'Composer', 'Choreographer'].forEach(function (role) {
      var list = groups[role];
      if (!list.length) return;
      segments.push(verbs[role] + ' ' + list.map(personLink).join(', '));
    });
    if (!segments.length) {
      el.hidden = true; el.innerHTML = '';
      return;
    }
    el.innerHTML = segments.join(' · ');
    el.hidden = false;
  }

  // Source + editorial notes section ("Background"), shown when either is present.
  function renderBackground(work) {
    var section = document.getElementById('work-background-section');
    var srcEl   = document.getElementById('work-source');
    var notesEl = document.getElementById('work-notes');
    var tcpEl   = document.getElementById('work-tcp');
    if (!section || !srcEl || !notesEl || !tcpEl) return;

    var tx = work.tx || null;
    var source = tx ? tx.source1 : null;
    var notes  = tx ? tx.notes   : null;
    var tcp    = work.tcp || null;

    if (!source && !notes && !(tcp && tcp.length)) {
      section.hidden = true;
      srcEl.hidden = true; notesEl.hidden = true; tcpEl.hidden = true;
      return;
    }

    if (source) {
      srcEl.innerHTML = '<span class="work-source-label metadata-label">Source</span> ' + escapeHtml(source);
      srcEl.hidden = false;
    } else {
      srcEl.hidden = true; srcEl.innerHTML = '';
    }
    if (notes) {
      notesEl.textContent = notes;
      notesEl.hidden = false;
    } else {
      notesEl.hidden = true; notesEl.textContent = '';
    }
    if (tcp && tcp.length) {
      var linkParts = tcp.map(function (t) {
        var bits = [];
        if (t.title) bits.push(escapeHtml(t.title));
        if (t.date)  bits.push(String(t.date));
        var inner = escapeHtml(t.id) + (bits.length ? ' (' + bits.join(', ') + ')' : '');
        // 'collection' entries point at a multi-play volume — flag with a
        // small badge so visitors know they're entering a folio/anthology.
        var collTag = (t.match === 'collection')
          ? ' <span class="work-tcp-coll metadata-label">in collection</span>'
          : '';
        return '<a href="https://www.prisms.digital/workbench/' +
                 encodeURIComponent(t.id) +
               '" rel="noopener" target="_blank" class="external">' +
                 inner +
               '</a>' + collTag;
      }).join(' &middot; ');
      tcpEl.innerHTML = '<span class="work-tcp-label metadata-label">Full text</span> ' + linkParts;
      tcpEl.hidden = false;
    } else {
      tcpEl.hidden = true; tcpEl.innerHTML = '';
    }
    section.hidden = false;
  }

  // ------------ Ledger ------------

  function renderLedger(work) {
    var wrap = document.getElementById('work-ledger');
    var section = document.getElementById('work-stats');
    if (!wrap || !section) return;

    var total = Number(work.total) || 0;
    var castCount = (work.cast || []).length;
    var theatreCount = (work.byTheatre || []).length;
    var first = Number(work.firstYear) || null;
    var last = Number(work.lastYear) || null;
    var span = (first && last) ? (last - first + 1) : null;

    var castFig = castCount >= CAST_CAP ? fmtNum(CAST_CAP) + '+' : fmtNum(castCount);
    var theatresFig = theatreCount >= THEATRE_CAP ? fmtNum(THEATRE_CAP) + '+' : fmtNum(theatreCount);
    var spanFig = span != null
      ? fmtNum(span) + ' <em>seasons</em>'
      : '&mdash;';

    var benefitNights = Number(work.benefitNights) || 0;

    var entries = [
      { fig: fmtNum(total),  label: 'Performances' },
      { fig: castFig,        label: 'Named in cast' },
      { fig: theatresFig,    label: 'Distinct theatres' },
      { fig: spanFig,        label: 'Span in years' }
    ];
    if (benefitNights > 0) {
      entries.push({ fig: fmtNum(benefitNights), label: 'Benefit performances' });
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

  // ------------ Cast-across-eras grid ------------

  function renderCastGrid(work) {
    var wrap    = document.getElementById('work-cast-grid');
    var note    = document.getElementById('work-cast-grid-note');
    var section = document.getElementById('work-cast-grid-section');
    if (!wrap || !section) return;

    var decadesData = work.decades || {};
    var decadeKeys  = Object.keys(decadesData).sort();
    if (decadeKeys.length < 2) { section.hidden = true; return; }

    // Build performer map: name → { firstDecade, totalCount, cells: {decade→count} }
    var perfMap = {};
    decadeKeys.forEach(function (d) {
      var cast = decadesData[d].cast || [];
      cast.forEach(function (c) {
        var name = c.name || '';
        if (!name) return;
        if (!perfMap[name]) perfMap[name] = { firstDecade: d, totalCount: 0, cells: {} };
        perfMap[name].cells[d] = c.count;
        perfMap[name].totalCount += c.count;
        if (d < perfMap[name].firstDecade) perfMap[name].firstDecade = d;
      });
    });

    // Sort: by firstDecade asc, then totalCount desc; cap at 40
    var performers = Object.keys(perfMap).sort(function (a, b) {
      var fa = perfMap[a].firstDecade, fb = perfMap[b].firstDecade;
      if (fa !== fb) return fa < fb ? -1 : 1;
      return perfMap[b].totalCount - perfMap[a].totalCount;
    }).slice(0, 40);

    if (!performers.length) { section.hidden = true; return; }

    // Header row
    var headCells = decadeKeys.map(function (d) {
      return '<span class="cast-grid-head-decade" data-decade-val="' + d + '">' + d + '</span>';
    }).join('');
    var html = '<div class="cast-grid-head">' +
      '<span class="cast-grid-head-name"></span>' + headCells + '</div>';

    // Data rows
    performers.forEach(function (name) {
      var p    = perfMap[name];
      var maxC = Math.max.apply(null, Object.keys(p.cells).map(function (d) { return p.cells[d]; }));
      var href = 'performer.html?name=' + encodeURIComponent(name);
      var cells = decadeKeys.map(function (d) {
        var c = p.cells[d];
        if (!c) {
          return '<span class="cast-grid-cell-decade" data-decade-val="' + d + '"><span class="cast-cell-empty"></span></span>';
        }
        var opacity = (0.25 + 0.75 * (c / maxC)).toFixed(2);
        var tip = escapeHtml(name + ' · ' + d + 's · ' + fmtNum(c) + ' performance' + (c === 1 ? '' : 's'));
        return (
          '<span class="cast-grid-cell-decade" data-decade-val="' + d + '">' +
            '<span class="cast-cell-dot" style="opacity:' + opacity + '" title="' + tip + '"></span>' +
          '</span>'
        );
      }).join('');
      html += '<div class="cast-grid-row">' +
        '<span class="cast-grid-cell-name"><a href="' + escapeHtml(href) + '">' + escapeHtml(name) + '</a></span>' +
        cells + '</div>';
    });

    wrap.innerHTML = '<div class="cast-grid" role="presentation">' + html + '</div>';

    if (note) {
      var capped = Object.keys(perfMap).length > 40;
      note.textContent = 'Top ' + performers.length + ' performers by appearance count' +
        (capped ? ', across ' + decadeKeys.length + ' decades' : '') +
        '. Filled squares show relative activity within each performer\u2019s run; hover a row to highlight.';
    }

    section.hidden = false;
  }

  // ------------ Decade sparkline ------------

  function renderSparkline(work) {
    var host = document.getElementById('work-sparkline');
    var section = document.getElementById('work-decade-section');
    if (!host || !section) return;

    var by = work.byDecade || {};
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
        ' performance' + (r.count === 1 ? '' : 's');
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
      '<svg role="img" aria-label="Performances by decade" ' +
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

  // ------------ Top theatres ------------

  function renderTheatres(work, theatreIndex) {
    var list = document.getElementById('work-theatres');
    var section = document.getElementById('work-theatres-section');
    if (!list || !section) return;

    var rows = (work.byTheatre || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var top = rows[0].count || 1;

    var html = rows.map(function (r) {
      var code = r.code || '';
      var canonical = canonicalTheatre(theatreIndex, code) || code;
      var pct = Math.max(0, Math.min(100, (r.count / top) * 100));
      var codeBadge = canonical !== code
        ? '<span class="bar-code">' + escapeHtml(code) + '</span>'
        : '';
      var href = code ? 'venue.html?code=' + encodeURIComponent(code) : null;
      var label = href
        ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(canonical) + '</a>' + codeBadge
        : escapeHtml(canonical) + codeBadge;
      return (
        '<li class="performer-bar-row" style="--bar-w: ' + pct.toFixed(1) + '%;">' +
          '<span class="performer-bar-label">' + label + '</span>' +
          '<span class="performer-bar-count">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    section.hidden = false;
  }

  // ------------ Principal cast ------------

  function renderCast(work) {
    var list = document.getElementById('work-cast');
    var section = document.getElementById('work-cast-section');
    var note = document.getElementById('work-cast-note');
    if (!list || !section) return;

    var rows = (work.cast || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var html = rows.map(function (r) {
      var name = r.name || '';
      var href = 'performer.html?name=' + encodeURIComponent(name);
      return (
        '<li>' +
          '<a href="' + escapeHtml(href) + '">' + escapeHtml(name) + '</a>' +
          '<span class="performer-costar-count metadata-label">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    if (note) note.hidden = rows.length < CAST_CAP;
    section.hidden = false;
  }

  // ------------ Roles ------------

  function renderRoles(work) {
    var list = document.getElementById('work-roles');
    var section = document.getElementById('work-roles-section');
    var note = document.getElementById('work-roles-note');
    if (!list || !section) return;

    var rows = (work.roles || []).slice();
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

  // ------------ Pairings ------------

  function renderPairings(work) {
    var list = document.getElementById('work-pairings');
    var section = document.getElementById('work-pairings-section');
    if (!list || !section) return;

    var rows = (work.pairings || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var html = rows.map(function (r) {
      var id = r.workId;
      var href = id ? 'work.html?id=' + encodeURIComponent(id) : null;
      var labelText = (r.ptypeLabel ? (r.ptypeLabel.charAt(0).toUpperCase() + r.ptypeLabel.slice(1)) : '');
      var tag = labelText
        ? '<span class="bar-code metadata-label">' + escapeHtml(labelText) + '</span>'
        : '';
      var title = r.title || '(untitled)';
      var link = href
        ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(title) + '</a>'
        : escapeHtml(title);
      var rowAttr = href ? ' class="is-row-link" data-href="' + escapeHtml(href) + '"' : '';
      return (
        '<li' + rowAttr + '>' +
          '<span class="performer-pairing-label">' + link + tag + '</span>' +
          '<span class="performer-costar-count metadata-label">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    wireListRowLinks(list);
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

  function renderMilestones(work, theatreIndex) {
    var list = document.getElementById('work-milestones');
    var section = document.getElementById('work-milestones-section');
    if (!list || !section) return;

    var ms = work.milestones;
    if (!ms) { section.hidden = true; return; }

    var items = [];

    function addGroup(entries, badgeText, badgeCls) {
      if (!entries || !entries.length) return;
      entries.forEach(function (m) {
        var theatre = canonicalTheatre(theatreIndex, m.venue) || m.venue || '';
        var detail = [];
        if (theatre) detail.push(escapeHtml(theatre));
        if (m.date)  detail.push(milestoneDateEl(m.date));
        var castNames = (m.cast || []).slice(0, 4).map(escapeHtml).join(', ');
        if (castNames) {
          detail.push('<span class="milestone-cast">' + castNames + '</span>');
        }
        items.push(
          '<li class="milestone-entry">' +
            '<span class="milestone-badge' + (badgeCls ? ' ' + badgeCls : '') + '">' + badgeText + '</span>' +
            '<span class="milestone-detail">' + detail.join(' · ') + '</span>' +
          '</li>'
        );
      });
    }

    addGroup(ms.stageDebuts, 'Stage debut',  '');
    addGroup(ms.roleDebuts,  'Role debut',   'is-role');
    addGroup(ms.farewells,   'Farewell',     'is-farewell');

    if (!items.length) { section.hidden = true; return; }

    list.innerHTML = items.join('');
    section.hidden = false;
  }

  // ------------ At the box office (Theatronomics) ------------

  var currentAbNights = null;

  function fmtPence(pence) {
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

  function computeAbStats(nights) {
    if (!nights || !nights.length) return null;
    var sorted = nights.slice().sort(function (a, b) { return a.dr - b.dr; });
    var mid = Math.floor(sorted.length / 2);
    var median = sorted.length % 2 === 1
      ? sorted[mid].dr
      : Math.round((sorted[mid - 1].dr + sorted[mid].dr) / 2);
    var best = nights.reduce(function (a, b) { return b.dr > a.dr ? b : a; });
    return { count: nights.length, median: median, best: best };
  }

  function buildAbChart(allNights, filteredNights) {
    var W = 600, H = 72, PAD = 6, FOOT = 14;
    var X0 = 1732, X1 = 1810;
    var maxDr = 0;
    allNights.forEach(function (n) { if (n.dr > maxDr) maxDr = n.dr; });
    if (!maxDr) maxDr = 1;

    var filteredSet = {};
    filteredNights.forEach(function (n) { filteredSet[n.d + n.v] = true; });

    var dots = allNights.map(function (n) {
      var year = +n.d.slice(0, 4);
      var cx = ((year - X0) / (X1 - X0)) * (W - PAD * 2) + PAD;
      var cy = H - PAD - (n.dr / maxDr) * (H - PAD * 2);
      var inRange = filteredSet[n.d + n.v];
      var cls = 'ab-dot ab-dot-' + n.v + (inRange ? '' : ' drng-out');
      var tip = escapeHtml(fmtDate(n.d) + ' · ' + (n.v === 'cg' ? 'Covent Garden' : 'Drury Lane') + ' · ' + fmtPence(n.dr));
      return '<circle class="' + cls + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) +
        '" r="3" data-year="' + year + '"><title>' + tip + '</title></circle>';
    });

    var ticks = [1740, 1760, 1780, 1800].map(function (y) {
      var x = ((y - X0) / (X1 - X0)) * (W - PAD * 2) + PAD;
      return '<line class="ab-tick" x1="' + x.toFixed(1) + '" y1="' + (H - PAD) +
        '" x2="' + x.toFixed(1) + '" y2="' + (H - PAD + 3) + '"></line>' +
        '<text class="ab-tick-label" x="' + x.toFixed(1) + '" y="' + (H + FOOT - 2) +
        '" text-anchor="middle">' + y + '</text>';
    });

    return '<svg role="img" aria-label="Account-book door receipts by year" ' +
      'viewBox="0 0 ' + W + ' ' + (H + FOOT) + '" class="work-ab-svg">' +
      '<line class="ab-baseline" x1="' + PAD + '" y1="' + (H - PAD) +
        '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '"></line>' +
      ticks.join('') + dots.join('') +
      '</svg>';
  }

  function renderAbSection(filteredNights, allNights) {
    var section = document.getElementById('work-ab-section');
    var statsEl = document.getElementById('work-ab-stats');
    var chartEl = document.getElementById('work-ab-chart');
    if (!section) return;
    if (!allNights || !allNights.length) { section.hidden = true; return; }

    var stats = computeAbStats(filteredNights.length ? filteredNights : allNights);
    var isAll = (filteredNights.length === allNights.length);

    var hasCg = allNights.some(function (n) { return n.v === 'cg'; });
    var hasDl = allNights.some(function (n) { return n.v === 'dl'; });
    var venueText = hasCg && hasDl ? 'Covent Garden and Drury Lane'
      : hasCg ? 'Covent Garden' : 'Drury Lane';
    var yFirst = allNights[0].d.slice(0, 4);
    var yLast  = allNights[allNights.length - 1].d.slice(0, 4);

    var countLine = isAll
      ? fmtNum(allNights.length) + ' nights at ' + venueText + ', ' + yFirst + '&ndash;' + yLast + '.'
      : fmtNum(filteredNights.length) + ' of ' + fmtNum(allNights.length) + ' nights in the selected era.';

    var medianLine = stats ? 'Median door receipts: ' + escapeHtml(fmtPence(stats.median)) + '.' : '';

    var bestLine = '';
    if (stats && stats.best) {
      var bestHref = 'day.html?date=' + encodeURIComponent(stats.best.d);
      var bestVenue = stats.best.v === 'cg' ? 'CG' : 'DL';
      bestLine = 'Best night: ' + escapeHtml(fmtPence(stats.best.dr)) +
        ' (' + bestVenue + ', <a href="' + escapeHtml(bestHref) + '">' +
        escapeHtml(fmtDate(stats.best.d)) + '</a>).';
    }

    if (statsEl) {
      statsEl.innerHTML = [countLine, medianLine, bestLine].filter(Boolean).join(' ');
    }

    if (chartEl) {
      if (allNights.length >= 4) {
        var legendParts = [];
        if (hasCg) legendParts.push('<span class="ab-legend-item"><svg width="10" height="10" class="ab-legend-swatch" aria-hidden="true"><circle cx="5" cy="5" r="4" class="ab-dot ab-dot-cg"></circle></svg>Covent Garden</span>');
        if (hasDl) legendParts.push('<span class="ab-legend-item"><svg width="10" height="10" class="ab-legend-swatch" aria-hidden="true"><circle cx="5" cy="5" r="4" class="ab-dot ab-dot-dl"></circle></svg>Drury Lane</span>');
        var legendHtml = (legendParts.length > 1)
          ? '<p class="ab-legend metadata-label">' + legendParts.join('') + '</p>' : '';
        chartEl.innerHTML = buildAbChart(allNights, filteredNights) + legendHtml;
        chartEl.hidden = false;
      } else {
        chartEl.hidden = true;
      }
    }

    section.hidden = false;
  }

  // ------------ Blank state ------------

  function renderMissing(reason, id) {
    var block = document.getElementById('work-missing');
    var heading = document.getElementById('missing-heading');
    var body = document.getElementById('missing-body');
    if (!block) return;
    if (reason === 'no-id') {
      if (heading) heading.textContent = 'No work requested';
      if (body) body.textContent = 'This page expects a work identifier in the URL, e.g. work.html?id=298.';
    } else if (reason === 'unknown') {
      if (heading) heading.textContent = 'Not in the repertoire';
      if (body) body.textContent = 'We could not find a work with identifier “' + (id || '') +
        '” in the London Stage calendars.';
    } else if (reason === 'error') {
      if (heading) heading.textContent = 'Unavailable';
      if (body) body.textContent = 'The work details could not be loaded. Please reload the page or try again later.';
    }
    block.hidden = false;
    document.title = 'Work not found — The London Stage, 1660–1800';
  }

  // ------------ Boot ------------

  function boot() {
    var id = getIdParam();
    if (!id) {
      renderMissing('no-id', null);
      return;
    }

    loadData().then(function (res) {
      var detailsDoc = res[0] || {};
      var theatresDoc = res[1] || {};
      var details = detailsDoc.details || {};
      var theatreIndex = Object.assign(
        {},
        theatresDoc.sentinels || {},
        theatresDoc.compound || {},
        theatresDoc.entries || {}
      );

      var work = details[id];
      if (!work) {
        renderMissing('unknown', id);
        return;
      }

      currentWork = work;
      currentTheatreIndex = theatreIndex;
      currentAbNights = work.abNights || null;

      renderHead(work);
      renderLedger(work);
      renderBackground(work);
      renderMilestones(work, theatreIndex);
      renderCastGrid(work);
      renderSparkline(work);
      renderTheatres(work, theatreIndex);
      renderAbSection(currentAbNights || [], currentAbNights || []);
      renderCast(work);
      renderRoles(work);
      renderPairings(work);
      initSlider();
    }).catch(function (err) {
      if (window.console && console.error) console.error('Work load failed', err);
      renderMissing('error', id);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
