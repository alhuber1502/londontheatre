/* London Stage, 1660-1800 — repertoire catalogue
   Featured cards are still hand-rolled; the table is a DataTables instance
   with sort / search / pagination + a chip filter layered on top of the
   DT search extension. */

(function () {
  'use strict';

  var FEATURED_COUNT = 12;
  var TYPE_ORDER = ['p', 'a', 'd', 's', 'm', 'e', 'i', 'o', 'b'];
  var ARC_DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];
  var arcState = { typeFilter: 'all', sort: 'count', minPerf: 5, fromIdx: 0, toIdx: 15 };

  var state = {
    works: [],
    theatres: {},    // code -> { canonical }
    types: [],       // [{ptype, label, count}]
    typeFilter: 'all',
    womenOnly: false,
    dt: null,
    rangeMin: 1660, rangeMax: 1800,
    rangeCurMin: 1660, rangeCurMax: 1800
  };

  // True when the slider is wide open — let the original lifetime figures
  // pass through without recomputation.
  function rangeIsFull() {
    return state.rangeCurMin === state.rangeMin && state.rangeCurMax === state.rangeMax;
  }

  // Sum a work's byDecade buckets that intersect the current window.
  // A decade bucket `1770` covers 1770–1779; we include it if it overlaps
  // the window at all.
  function rangeTotal(row, fallback) {
    if (!row) return fallback || 0;
    if (rangeIsFull()) return (typeof fallback === 'number') ? fallback : (row.count || 0);
    var by = row.byDecade || {};
    var min = state.rangeCurMin, max = state.rangeCurMax;
    var total = 0;
    for (var decStr in by) {
      if (!Object.prototype.hasOwnProperty.call(by, decStr)) continue;
      var dec = +decStr;
      if (dec + 9 < min || dec > max) continue;
      total += by[decStr] || 0;
    }
    return total;
  }

  // First / last year inside the window — decade precision. Returns the
  // lifetime values when the slider is wide open or the work has no
  // byDecade data.
  function rangeFirstYear(row) {
    if (!row) return null;
    if (rangeIsFull()) return row.firstYear != null ? row.firstYear : null;
    var by = row.byDecade || {};
    var min = state.rangeCurMin, max = state.rangeCurMax;
    var best = null;
    for (var decStr in by) {
      if (!Object.prototype.hasOwnProperty.call(by, decStr)) continue;
      var dec = +decStr;
      if (dec + 9 < min || dec > max) continue;
      if (best == null || dec < best) best = dec;
    }
    if (best == null) return null;
    // Clamp to the actual firstYear if we happen to know it and it falls in-window.
    return (row.firstYear != null && row.firstYear > best && row.firstYear <= max) ? row.firstYear : best;
  }
  function rangeLastYear(row) {
    if (!row) return null;
    if (rangeIsFull()) return row.lastYear != null ? row.lastYear : null;
    var by = row.byDecade || {};
    var min = state.rangeCurMin, max = state.rangeCurMax;
    var best = null;
    for (var decStr in by) {
      if (!Object.prototype.hasOwnProperty.call(by, decStr)) continue;
      var dec = +decStr;
      if (dec + 9 < min || dec > max) continue;
      if (best == null || dec > best) best = dec;
    }
    if (best == null) return null;
    var decEnd = best + 9;
    return (row.lastYear != null && row.lastYear < decEnd && row.lastYear >= min) ? row.lastYear : decEnd;
  }

  // Count of distinct theatres that performed this work within the window.
  // Uses byDecadeTheatres: {dec: [codes]} emitted by build-works.mjs.
  function rangeTheatreCount(row) {
    if (!row) return 0;
    if (rangeIsFull()) return row.theatreCount || 0;
    var by = row.byDecadeTheatres || {};
    var min = state.rangeCurMin, max = state.rangeCurMax;
    var union = Object.create(null);
    var n = 0;
    for (var decStr in by) {
      if (!Object.prototype.hasOwnProperty.call(by, decStr)) continue;
      var dec = +decStr;
      if (dec + 9 < min || dec > max) continue;
      var codes = by[decStr] || [];
      for (var i = 0; i < codes.length; i++) {
        if (!union[codes[i]]) { union[codes[i]] = 1; n++; }
      }
    }
    return n;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtNum(n) { return (Number(n) || 0).toLocaleString('en-GB'); }
  function titleCaseLabel(label) {
    if (!label) return '';
    if (label.length <= 1) return 'Other';
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  function canonicalTheatre(code) {
    if (!code) return null;
    var key = String(code).toLowerCase().replace(/\s+/g, '');
    var entry = state.theatres[key];
    return entry && entry.canonical ? entry.canonical : null;
  }

  // Turn each .is-row-link <tr> into a clickable row. The real <a> in the
  // first cell stays put and handles keyboard/assistive-tech navigation;
  // this delegate is only a mouse-affordance layer.
  function wireRowLinks(tableSel) {
    var tbody = document.querySelector(tableSel + ' tbody');
    if (!tbody) return;
    tbody.addEventListener('click', function (ev) {
      var interactive = ev.target.closest('a, button, input, select, textarea, label, [role="button"]');
      if (interactive) return; // let the inner link/button handle it
      var tr = ev.target.closest('tr.is-row-link');
      if (!tr) return;
      var href = tr.getAttribute('data-href');
      if (!href) return;
      // Open-in-new-tab conveniences: meta/ctrl-click or middle-click.
      if (ev.metaKey || ev.ctrlKey || ev.button === 1) {
        window.open(href, '_blank', 'noopener');
      } else {
        window.location.href = href;
      }
    });
    // Also honour middle-click / aux-click for new tab.
    tbody.addEventListener('auxclick', function (ev) {
      if (ev.button !== 1) return;
      var tr = ev.target.closest('tr.is-row-link');
      if (!tr) return;
      var href = tr.getAttribute('data-href');
      if (!href) return;
      ev.preventDefault();
      window.open(href, '_blank', 'noopener');
    });
  }

  function loadData() {
    return Promise.all([
      fetch('data/works.json').then(function (r) { if (!r.ok) throw new Error('works.json ' + r.status); return r.json(); }),
      fetch('data/theatre-abbreviations.json').then(function (r) { if (!r.ok) throw new Error('theatre-abbreviations.json ' + r.status); return r.json(); })
    ]);
  }

  function indexTypes(works) {
    var byPtype = {};
    works.forEach(function (w) {
      var key = w.ptype || 'o';
      if (!byPtype[key]) byPtype[key] = { ptype: key, label: w.ptypeLabel || key, count: 0 };
      byPtype[key].count += 1;
    });
    var list = Object.keys(byPtype).map(function (k) { return byPtype[k]; });
    list.sort(function (a, b) {
      var ia = TYPE_ORDER.indexOf(a.ptype); if (ia === -1) ia = 99;
      var ib = TYPE_ORDER.indexOf(b.ptype); if (ib === -1) ib = 99;
      if (ia !== ib) return ia - ib;
      return b.count - a.count;
    });
    return list;
  }

  function renderFeatured() {
    var grid = document.getElementById('rep-featured-grid');
    if (!grid) return;
    var top = state.works.slice(0, FEATURED_COUNT);
    grid.innerHTML = top.map(function (w) {
      var label = titleCaseLabel(w.ptypeLabel || w.ptype);
      var years = '';
      if (w.firstYear && w.lastYear) {
        years = w.firstYear === w.lastYear ? String(w.firstYear) : (w.firstYear + '\u2013' + w.lastYear);
      } else if (w.firstYear) years = String(w.firstYear);
      var tt = w.topTheatre || null;
      var canon = tt ? canonicalTheatre(tt.code) : null;
      var theatreLine = '';
      if (tt) {
        var canonText = canon ? escapeHtml(canon) : escapeHtml(String(tt.code || '').toUpperCase());
        var codeTag = tt.code
          ? '<span class="rep-card-theatre-code metadata-label">' + escapeHtml(String(tt.code).toUpperCase()) + '</span>'
          : '';
        theatreLine = '<p class="rep-card-theatre">Most often at ' + canonText + codeTag + '</p>';
      }
      return (
        '<li class="rep-card">' +
          '<p class="rep-card-tag">' + escapeHtml(label) + '</p>' +
          '<h3 class="rep-card-title">' + escapeHtml(w.title || '') + '</h3>' +
          '<p class="rep-card-count">' + fmtNum(w.count) + ' performances</p>' +
          (years ? '<p class="rep-card-years">' + escapeHtml(years) + '</p>' : '') +
          theatreLine +
        '</li>'
      );
    }).join('');
  }

  function renderChips() {
    var chips = document.getElementById('rep-type-chips');
    if (!chips) return;
    var html = '<button type="button" class="rep-chip" data-type="all" aria-pressed="true">All</button>';
    state.types.forEach(function (t) {
      if (!t.count) return;
      html += '<button type="button" class="rep-chip" data-type="' + escapeHtml(t.ptype) +
        '" aria-pressed="false">' + escapeHtml(titleCaseLabel(t.label)) + '</button>';
    });
    chips.innerHTML = html;
    chips.addEventListener('click', function (e) {
      var btn = e.target.closest('button.rep-chip');
      if (!btn) return;
      var next = btn.getAttribute('data-type') || 'all';
      if (state.typeFilter === next) return;
      state.typeFilter = next;
      chips.querySelectorAll('button.rep-chip').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      if (state.dt) state.dt.draw();
    });

    // Women playwrights toggle — independent of the ptype chip group; composes
    // with the ptype + date-range filters via the shared DT search function.
    var womenBtn = document.getElementById('rep-chip-women');
    if (womenBtn) {
      womenBtn.addEventListener('click', function () {
        state.womenOnly = !state.womenOnly;
        womenBtn.setAttribute('aria-pressed', state.womenOnly ? 'true' : 'false');
        womenBtn.classList.toggle('is-active', state.womenOnly);
        if (state.dt) state.dt.draw();
      });
    }
  }

  function initTable() {
    var $ = window.jQuery;
    if (!$) throw new Error('jQuery missing');

    // Chip + date-range filters hooked into DT's search extension.
    $.fn.dataTable.ext.search.push(function (settings, rowData, dataIndex, rowObj) {
      if (settings.nTable.id !== 'rep-table') return true;
      var w = state.works[dataIndex];
      if (!w) return false;
      if (state.typeFilter !== 'all' && w.ptype !== state.typeFilter) return false;
      if (state.womenOnly && !w.hasWomanAuthor) return false;
      var rMin = state.rangeCurMin, rMax = state.rangeCurMax;
      if (rMin === state.rangeMin && rMax === state.rangeMax) return true;
      if (w.firstYear == null || w.lastYear == null) return true;
      if (w.lastYear < rMin || w.firstYear > rMax) return false;
      return rangeTotal(w, 0) > 0;
    });

    state.dt = new $.fn.dataTable.Api(
      $('#rep-table').DataTable({
        data: state.works,
        deferRender: true,
        pageLength: 25,
        lengthMenu: [[10, 25, 50, 100, 500], [10, 25, 50, 100, 500]],
        order: [[2, 'desc']],
        createdRow: function (tr, data) {
          // Make the full row clickable — but keep the inner <a class="rep-title">
          // as the canonical link for keyboard users and screen readers, so the
          // row navigation is purely a mouse convenience layer on top of it.
          if (data && data.workId != null) {
            tr.setAttribute('data-href', 'work.html?id=' + encodeURIComponent(data.workId));
            tr.classList.add('is-row-link');
          }
        },
        columns: [
          { data: 'title', className: 'rep-col-title', render: function (d, type, row) {
              var title = escapeHtml(d || '');
              if (type === 'filter') {
                // Make author names searchable alongside the title.
                return (d || '') + ' ' + (row && row.authors ? row.authors : '');
              }
              if (type !== 'display') return d || '';
              var sub = '';
              if (row && (row.authors || row.genre)) {
                var bits = [];
                if (row.authors) bits.push(escapeHtml(row.authors));
                if (row.genre)   bits.push('<span class="rep-subtitle-genre">' + escapeHtml(row.genre) + '</span>');
                sub = '<span class="rep-subtitle">' + bits.join(' &middot; ') + '</span>';
              }
              if (!row || row.workId == null) return '<span class="rep-title">' + title + '</span>' + sub;
              var href = 'work.html?id=' + encodeURIComponent(row.workId);
              return '<a class="rep-title" href="' + escapeHtml(href) + '">' + title + '</a>' + sub;
          }},
          { data: null, render: function (row) {
              return escapeHtml(titleCaseLabel(row.ptypeLabel || row.ptype));
          }, orderDataType: 'dom-text' },
          { data: 'count', className: 'rep-col-num is-perf', type: 'num',
            render: function (d, type, row) {
              if (type === 'sort' || type === 'type') return rangeTotal(row, d);
              if (type === 'display' || type === 'filter') return fmtNum(rangeTotal(row, d));
              return d;
          }},
          { data: 'firstYear', className: 'rep-col-num is-dim rep-col-year', type: 'num',
            render: function (d, type, row) {
              var y = rangeFirstYear(row);
              if (type === 'sort' || type === 'type') return y || 0;
              if (type !== 'display') return y || 0;
              return y ? '<button type="button" class="rep-year-focus" data-year="' + y + '">' + y + '</button>' : '&mdash;';
          }},
          { data: 'lastYear', className: 'rep-col-num is-dim rep-col-year', type: 'num',
            render: function (d, type, row) {
              var y = rangeLastYear(row);
              if (type === 'sort' || type === 'type') return y || 0;
              if (type !== 'display') return y || 0;
              return y ? '<button type="button" class="rep-year-focus" data-year="' + y + '">' + y + '</button>' : '&mdash;';
          }},
          { data: 'theatreCount', className: 'rep-col-num is-dim', type: 'num',
            render: function (d, type, row) {
              var v = rangeTheatreCount(row);
              if (type === 'sort' || type === 'type') return v;
              return type === 'display' ? fmtNum(v) : v;
          }},
          // Performer count can't be recomputed in-range without per-decade
          // name sets (too big to ship). When the slider is active we show
          // a muted em-dash rather than a misleading lifetime figure.
          { data: 'performerCount', className: 'rep-col-num is-dim', type: 'num',
            render: function (d, type) {
              if (type !== 'display') return d || 0;
              if (!rangeIsFull()) return '<span class="is-stale" title="Distinct-performer count is not recomputed within the date range &mdash; the underlying name sets are too large to ship client-side. Open a work page for per-decade cast.">&mdash;</span>';
              return fmtNum(d);
          }},
          { data: null, className: 'rep-col-arc', orderable: false, searchable: false,
            render: function (d, type, row) {
              if (type !== 'display') return '';
              var by = row.byDecade || {};
              // Sixteen decade buckets across the full 1660-1800 span (we
              // include 1650 because a handful of pre-Restoration revivals
              // attach to it). Each bucket is 5px wide (4px bar + 1px gap)
              // for 80px total width; bars rise to 22px tall so the arc
              // shape is legible at table density without crowding the
              // 0.92rem text in adjacent cells.
              var DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];
              var W = 80, H = 22, BAR = 4, STRIDE = 5;
              var maxCount = 0;
              DECADES.forEach(function (dec) {
                var c = by[String(dec)] || 0;
                if (c > maxCount) maxCount = c;
              });
              var titleTxt = 'Performance arc by decade, 1660–1800 (self-normalised).';
              if (maxCount === 0) {
                return '<svg class="rep-arc-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="No decade data"><title>No decade data</title></svg>';
              }
              var bars = DECADES.map(function (dec, i) {
                var c = by[String(dec)] || 0;
                if (!c) return '';
                var h = Math.max(2, Math.round((c / maxCount) * H));
                var y = H - h;
                return '<rect class="rep-spark-bar" x="' + (i * STRIDE) + '" y="' + y + '" width="' + BAR + '" height="' + h + '"/>';
              }).join('');
              return '<svg class="rep-arc-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Performance arc by decade"><title>' + titleTxt + '</title>' + bars + '</svg>';
          }}
        ],
        language: {
          search: 'Search',
          searchPlaceholder: 'by title\u2026',
          lengthMenu: 'Show _MENU_ works',
          info: '_START_\u2013_END_ of _TOTAL_ works',
          infoEmpty: 'No works',
          infoFiltered: '(filtered from _MAX_)',
          emptyTable: 'No works recorded',
          zeroRecords: 'No works match the current filter',
          paginate: { first: '\u00ab', previous: '\u2039', next: '\u203a', last: '\u00bb' }
        }
      })
    );

    wireRowLinks('#rep-table');
  }

  function initRangeSlider(ids) {
    var minEl = document.getElementById(ids.min);
    var maxEl = document.getElementById(ids.max);
    var fillEl = document.getElementById(ids.fill);
    var readout = document.getElementById(ids.readout);
    var reset = document.getElementById(ids.reset);
    if (!minEl || !maxEl) return;

    var absoluteMin = Infinity, absoluteMax = -Infinity;
    state.works.forEach(function (w) {
      if (w.firstYear != null && w.firstYear < absoluteMin) absoluteMin = w.firstYear;
      if (w.lastYear  != null && w.lastYear  > absoluteMax) absoluteMax = w.lastYear;
    });
    if (!isFinite(absoluteMin)) absoluteMin = 1660;
    if (!isFinite(absoluteMax)) absoluteMax = 1800;
    state.rangeMin = absoluteMin; state.rangeMax = absoluteMax;
    state.rangeCurMin = absoluteMin; state.rangeCurMax = absoluteMax;

    [minEl, maxEl].forEach(function (el) { el.min = String(absoluteMin); el.max = String(absoluteMax); });
    minEl.value = String(absoluteMin);
    maxEl.value = String(absoluteMax);

    // Slider drag fires `input` on every pixel. The visual parts (readout,
    // fill bar, reset-button visibility, state vars) are cheap so they
    // run every event, but the DataTables rebuild across 13k rows is
    // expensive — debounce it with requestAnimationFrame + a short
    // settle window so dragging stays smooth.
    var pendingDraw = null;

    function updateState() {
      var minV = +minEl.value, maxV = +maxEl.value;
      if (minV > maxV) {
        if (document.activeElement === minEl) minV = maxV; else maxV = minV;
        minEl.value = String(minV); maxEl.value = String(maxV);
      }
      state.rangeCurMin = minV;
      state.rangeCurMax = maxV;
      if (readout) {
        readout.textContent = (minV === absoluteMin && maxV === absoluteMax)
          ? absoluteMin + '–' + absoluteMax
          : minV + '–' + maxV;
      }
      if (fillEl) {
        var span = absoluteMax - absoluteMin || 1;
        fillEl.style.left  = (((minV - absoluteMin) / span) * 100) + '%';
        fillEl.style.width = (((maxV - minV) / span) * 100) + '%';
      }
      if (reset) reset.hidden = (minV === absoluteMin && maxV === absoluteMax);
    }

    function scheduleTableRedraw() {
      if (!state.dt) return;
      if (pendingDraw) clearTimeout(pendingDraw);
      pendingDraw = setTimeout(function () {
        pendingDraw = null;
        // invalidate() forces DT to re-run the column renderers —
        // without this, cells display the values cached at first draw.
        state.dt.rows().invalidate().draw(false);
      }, 120);
    }

    function redraw(immediate) {
      updateState();
      if (immediate) {
        if (pendingDraw) { clearTimeout(pendingDraw); pendingDraw = null; }
        if (state.dt) state.dt.rows().invalidate().draw(false);
      } else {
        scheduleTableRedraw();
      }
    }

    minEl.addEventListener('input', function () { redraw(false); });
    maxEl.addEventListener('input', function () { redraw(false); });
    // Settle-on-release: when the user lets go of the handle, force the
    // draw immediately regardless of the debounce window.
    minEl.addEventListener('change', function () { redraw(true); });
    maxEl.addEventListener('change', function () { redraw(true); });
    if (reset) {
      reset.addEventListener('click', function () {
        minEl.value = String(absoluteMin);
        maxEl.value = String(absoluteMax);
        redraw(true);
      });
    }

    var wrap = document.getElementById(ids.tableWrap);
    if (wrap) {
      wrap.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('.rep-year-focus') : null;
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        var y = +btn.getAttribute('data-year');
        if (!y) return;
        var dec = Math.floor(y / 10) * 10;
        minEl.value = String(Math.max(absoluteMin, dec));
        maxEl.value = String(Math.min(absoluteMax, dec + 9));
        redraw(true);
      });
    }

    redraw(true);
  }

  function renderArcGrid() {
    var overlay = document.getElementById('arc-section');
    if (!overlay || overlay.hidden) return;
    var grid = document.getElementById('arc-grid');
    var countEl = document.getElementById('arc-count');
    if (!grid) return;

    var visDecades = ARC_DECADES.slice(arcState.fromIdx, arcState.toIdx + 1);
    var ncols = visDecades.length;

    var colCells = document.getElementById('arc-col-cells');
    if (colCells) {
      colCells.style.setProperty('--ncols', ncols);
      colCells.innerHTML = visDecades.map(function (d) {
        var lbl = (d % 100 === 0) ? String(d) : '’' + String(d).slice(2);
        return '<span class="arc-cell-head">' + lbl + '</span>';
      }).join('');
    }

    var works = state.works.filter(function (w) {
      if (arcState.typeFilter !== 'all' && w.ptype !== arcState.typeFilter) return false;
      if ((w.count || 0) < arcState.minPerf) return false;
      var by = w.byDecade || {};
      for (var i = arcState.fromIdx; i <= arcState.toIdx; i++) {
        if (by[String(ARC_DECADES[i])]) return true;
      }
      return false;
    });

    var sorted = works.slice();
    sorted.sort(function (a, b) {
      switch (arcState.sort) {
        case 'count': return (b.count || 0) - (a.count || 0);
        case 'first': return (a.firstYear || 9999) - (b.firstYear || 9999);
        case 'last':  return (b.lastYear || 0) - (a.lastYear || 0);
        case 'span': {
          var sa = (a.lastYear || a.firstYear || 0) - (a.firstYear || 0);
          var sb = (b.lastYear || b.firstYear || 0) - (b.firstYear || 0);
          return sb - sa;
        }
        default: return 0;
      }
    });

    if (countEl) countEl.textContent = sorted.length.toLocaleString('en-GB') + ' works';

    var html = sorted.map(function (w) {
      var by = w.byDecade || {};
      var maxC = 0;
      visDecades.forEach(function (d) { var c = by[String(d)] || 0; if (c > maxC) maxC = c; });
      var href = 'work.html?id=' + encodeURIComponent(w.workId);
      var cells = visDecades.map(function (d) {
        var c = by[String(d)] || 0;
        if (!c) return '<span class="arc-cell arc-cell-empty"></span>';
        var opa = maxC > 0 ? Math.max(0.15, c / maxC) : 0.15;
        return '<span class="arc-cell" style="--opa:' + opa.toFixed(3) + '"></span>';
      }).join('');
      return '<div class="arc-row">' +
        '<a class="arc-label" href="' + escapeHtml(href) + '" title="' + escapeHtml(w.title || '') + '">' +
          escapeHtml(w.title || '') + '</a>' +
        '<div class="arc-cells" style="--ncols:' + ncols + '">' + cells + '</div>' +
        '</div>';
    }).join('');

    grid.innerHTML = html || '<p class="arc-empty">No works match the current filters.</p>';
  }

  function initArcOverlay() {
    var overlay = document.getElementById('arc-section');
    var openBtn = document.getElementById('arc-view-btn');
    var closeBtn = document.getElementById('arc-close-btn');
    var featured = document.querySelector('.rep-featured');
    var tableSection = document.querySelector('.rep-table-section');
    if (!overlay || !openBtn) return;

    // Decade slider ticks
    var ticks = document.getElementById('arc-drng-ticks');
    if (ticks) {
      ticks.innerHTML = ARC_DECADES.map(function (d, i) {
        var pct = (i / (ARC_DECADES.length - 1) * 100).toFixed(2);
        var lbl = (d % 100 === 0) ? d : '’' + String(d).slice(2);
        return '<span class="drng-tick" style="left:' + pct + '%">' + lbl + '</span>';
      }).join('');
    }

    // Type chips
    var chips = document.getElementById('arc-type-chips');
    if (chips) {
      var chipHtml = '<button type="button" class="rep-chip" data-type="all" aria-pressed="true">All</button>';
      state.types.forEach(function (t) {
        if (!t.count) return;
        chipHtml += '<button type="button" class="rep-chip" data-type="' + escapeHtml(t.ptype) +
          '" aria-pressed="false">' + escapeHtml(titleCaseLabel(t.label)) + '</button>';
      });
      chips.innerHTML = chipHtml;
      chips.addEventListener('click', function (e) {
        var btn = e.target.closest('button.rep-chip');
        if (!btn) return;
        arcState.typeFilter = btn.getAttribute('data-type') || 'all';
        chips.querySelectorAll('.rep-chip').forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        renderArcGrid();
      });
    }

    // Sort
    var sortEl = document.getElementById('arc-sort');
    if (sortEl) sortEl.addEventListener('change', function () { arcState.sort = sortEl.value; renderArcGrid(); });

    // Min performances
    var minEl = document.getElementById('arc-minperf');
    var minValEl = document.getElementById('arc-minperf-val');
    if (minEl) {
      minEl.addEventListener('input', function () {
        arcState.minPerf = +minEl.value;
        if (minValEl) minValEl.textContent = minEl.value;
        renderArcGrid();
      });
    }

    // Decade range
    var fromEl = document.getElementById('arc-dec-from');
    var toEl = document.getElementById('arc-dec-to');
    var decLabelEl = document.getElementById('arc-dec-label');
    var decBgEl = document.getElementById('arc-drng-bg');
    var allBtn = document.getElementById('arc-drng-all');

    function updateDecRange() {
      var f = +fromEl.value, t = +toEl.value;
      if (f > t) {
        if (document.activeElement === fromEl) f = t; else t = f;
        fromEl.value = f; toEl.value = t;
      }
      arcState.fromIdx = f;
      arcState.toIdx = t;
      var isAll = (f === 0 && t === ARC_DECADES.length - 1);
      if (decLabelEl) decLabelEl.textContent = isAll ? 'All decades' : ARC_DECADES[f] + '–' + ARC_DECADES[t];
      if (decBgEl) {
        var span = ARC_DECADES.length - 1;
        decBgEl.style.left = (f / span * 100).toFixed(2) + '%';
        decBgEl.style.width = ((t - f) / span * 100).toFixed(2) + '%';
      }
      if (allBtn) allBtn.setAttribute('aria-pressed', isAll ? 'true' : 'false');
      renderArcGrid();
    }

    if (fromEl) fromEl.addEventListener('input', updateDecRange);
    if (toEl) toEl.addEventListener('input', updateDecRange);
    if (allBtn) {
      allBtn.addEventListener('click', function () {
        if (fromEl) fromEl.value = '0';
        if (toEl) toEl.value = String(ARC_DECADES.length - 1);
        updateDecRange();
      });
    }
    updateDecRange(); // init fill bar (renderArcGrid skips when overlay is hidden)

    // Open / close
    function openOverlay() {
      if (featured) featured.hidden = true;
      if (tableSection) tableSection.hidden = true;
      overlay.hidden = false;
      window.scrollTo(0, 0);
      renderArcGrid();
      if (closeBtn) closeBtn.focus();
    }
    function closeOverlay() {
      overlay.hidden = true;
      if (featured) featured.hidden = false;
      if (tableSection) tableSection.hidden = false;
      openBtn.focus();
    }
    openBtn.addEventListener('click', openOverlay);
    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) closeOverlay(); });
  }

  function renderError(msg) {
    var tbody = document.querySelector('#rep-table tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="rep-table-error">' + escapeHtml(msg) + '</td></tr>';
    var grid = document.getElementById('rep-featured-grid');
    if (grid) grid.innerHTML = '<li class="rep-card" aria-hidden="true"><p class="rep-card-tag">Unavailable</p><p class="rep-card-title">&mdash;</p><p class="rep-card-years">' + escapeHtml(msg) + '</p></li>';
  }

  function boot() {
    loadData().then(function (res) {
      var worksDoc = res[0] || {};
      var theatresDoc = res[1] || {};
      state.works = Array.isArray(worksDoc.works) ? worksDoc.works : [];
      // Merge entries + compound + sentinels so hybrid codes like
      // "dlking's" and placeholders like "none" resolve to readable names.
      state.theatres = Object.assign(
        {},
        (theatresDoc && theatresDoc.sentinels) || {},
        (theatresDoc && theatresDoc.compound) || {},
        (theatresDoc && theatresDoc.entries) || {}
      );
      state.types = indexTypes(state.works);

      renderFeatured();
      renderChips();
      initTable();
      initRangeSlider({
        min: 'rep-range-min', max: 'rep-range-max',
        fill: 'rep-range-fill', readout: 'rep-range-readout',
        reset: 'rep-range-reset', tableWrap: 'rep-table-wrap'
      });
      initArcOverlay();
    }).catch(function (err) {
      if (window.console && console.error) console.error('Repertoire load failed', err);
      renderError('The catalogue could not be loaded. Please reload the page or try again later.');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
