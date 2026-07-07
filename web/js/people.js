/* London Stage, 1660-1800 — dramatis personae
   Featured cards hand-rolled; the table is a DataTables instance with
   sort / search / pagination + a chip filter on the DT search extension. */

(function () {
  'use strict';

  var FEATURED_COUNT = 12;

  var KIND = {
    'female':        { label: 'Actress',         order: 1 },
    'male-explicit': { label: 'Actor',           order: 2 },
    'male-inferred': { label: 'Actor',           order: 2 },
    'male-child':    { label: 'Child performer', order: 3 },
    'company':       { label: 'Company',         order: 4 },
    'unknown':       { label: 'Unknown',         order: 5 }
  };
  function kindBucket(gender) {
    if (gender === 'female') return 'actress';
    if (gender === 'male-child') return 'child';
    if (gender === 'male-explicit' || gender === 'male-inferred') return 'actor';
    if (gender === 'company') return 'company';
    return 'unknown';
  }
  var BUCKET_LABEL = {
    'actress':'Actresses', 'actor':'Actors', 'child':'Child performers',
    'company':'Companies', 'unknown':'Unknown'
  };
  var BUCKET_ORDER = ['actress', 'actor', 'child', 'company', 'unknown'];
  var CAT_ORDER = ['named', 'titled', 'generic', 'ensemble', 'paratext'];

  var state = {
    profiles: [],
    buckets: [],
    kindFilter: 'all',
    dt: null,
    // Date-range filter. min/max are the absolute dataset extremes; cur is
    // the currently selected window. When cur === absolute, no filtering.
    rangeMin: 1660, rangeMax: 1800,
    rangeCurMin: 1660, rangeCurMax: 1800
  };

  function rangeIsFull() {
    return state.rangeCurMin === state.rangeMin && state.rangeCurMax === state.rangeMax;
  }

  // Sum a profile's byDecade buckets that intersect the current window.
  // A decade bucket named `1770` covers 1770–1779 inclusive. We include the
  // bucket if it overlaps the window at all.
  function rangeTotal(row, fallback) {
    if (!row) return fallback || 0;
    if (rangeIsFull()) return (typeof fallback === 'number') ? fallback : (row.total || 0);
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

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtNum(n) { return (Number(n) || 0).toLocaleString('en-GB'); }
  function fmtPct(n) { n = Number(n) || 0; if (n > 0 && n < 1) return '<1%'; return Math.round(n) + '%'; }
  function kindLabel(g) { var k = KIND[g]; return k ? k.label : 'Unknown'; }

  function loadData() {
    return fetch('data/roles/performers.json').then(function (r) {
      if (!r.ok) throw new Error('performers.json ' + r.status);
      return r.json();
    });
  }

  function enrich(profiles) {
    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      p.kindLabel = kindLabel(p.gender);
      p.kindBucket = kindBucket(p.gender);
      var by = p.byCat || {};
      p.named = Number(by.named) || 0;
      p.titled = Number(by.titled) || 0;
      p.generic = Number(by.generic) || 0;
      p.ensemble = Number(by.ensemble) || 0;
      p.paratext = Number(by.paratext) || 0;
      var top = p.topRoles && p.topRoles.length ? p.topRoles[0] : null;
      p.topRole = top ? top.role : '';
      p.topRoleCount = top ? (Number(top.count) || 0) : 0;
    }
    return profiles;
  }

  function indexBuckets(profiles) {
    var byBucket = {};
    profiles.forEach(function (p) {
      var k = p.kindBucket;
      if (!byBucket[k]) byBucket[k] = { key: k, label: BUCKET_LABEL[k] || k, count: 0 };
      byBucket[k].count += 1;
    });
    var list = [];
    BUCKET_ORDER.forEach(function (k) { if (byBucket[k]) list.push(byBucket[k]); });
    Object.keys(byBucket).forEach(function (k) {
      if (BUCKET_ORDER.indexOf(k) === -1) list.push(byBucket[k]);
    });
    return list;
  }

  function roleMixHtml(p) {
    var total = p.named + p.titled + p.generic + p.ensemble + p.paratext;
    if (!total) return '';
    var segs = [], tipParts = [];
    CAT_ORDER.forEach(function (cat) {
      var v = p[cat] || 0;
      if (!v) return;
      var pct = (v / total) * 100;
      segs.push('<span class="role-mix-seg is-' + cat + '" style="flex:' + v + ' 1 0;" aria-label="' + escapeHtml(cat) + ' ' + fmtPct(pct) + '"></span>');
      tipParts.push(cat.charAt(0).toUpperCase() + cat.slice(1) + ' ' + fmtPct(pct));
    });
    if (!segs.length) return '';
    return '<span class="role-mix" role="img" aria-label="Role mix: ' +
      escapeHtml(tipParts.join(', ')) + '" title="' +
      escapeHtml(tipParts.join(' \u00b7 ')) + '">' + segs.join('') + '</span>';
  }

  function renderFeatured() {
    var grid = document.getElementById('people-featured-grid');
    if (!grid) return;
    var top = state.profiles.slice().sort(function (a, b) { return (b.total || 0) - (a.total || 0); }).slice(0, FEATURED_COUNT);
    grid.innerHTML = top.map(function (p) {
      var sig = p.topRole ? 'Best known for <em>' + escapeHtml(p.topRole) + '</em> &middot; ' + fmtNum(p.topRoleCount) : '';
      return (
        '<li class="rep-card people-card">' +
          '<p class="rep-card-tag">' + escapeHtml(p.kindLabel) + '</p>' +
          '<h3 class="rep-card-title">' + escapeHtml(p.name || '') + '</h3>' +
          '<p class="rep-card-count">' + fmtNum(p.total) + ' appearances</p>' +
          (sig ? '<p class="people-card-signature">' + sig + '</p>' : '') +
          roleMixHtml(p) +
        '</li>'
      );
    }).join('');
  }

  function renderChips() {
    var chips = document.getElementById('people-kind-chips');
    if (!chips) return;
    var html = '<button type="button" class="rep-chip" data-kind="all" aria-pressed="true">All</button>';
    state.buckets.forEach(function (b) {
      if (!b.count) return;
      html += '<button type="button" class="rep-chip" data-kind="' + escapeHtml(b.key) +
        '" aria-pressed="false">' + escapeHtml(b.label) + '</button>';
    });
    chips.innerHTML = html;
    chips.addEventListener('click', function (e) {
      var btn = e.target.closest('button.rep-chip');
      if (!btn) return;
      var next = btn.getAttribute('data-kind') || 'all';
      if (state.kindFilter === next) return;
      state.kindFilter = next;
      chips.querySelectorAll('button.rep-chip').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      if (state.dt) state.dt.draw();
    });
  }

  // ---- Date-range slider ----
  function initRangeSlider(ids) {
    var minEl = document.getElementById(ids.min);
    var maxEl = document.getElementById(ids.max);
    var fillEl = document.getElementById(ids.fill);
    var readout = document.getElementById(ids.readout);
    var reset = document.getElementById(ids.reset);
    if (!minEl || !maxEl) return;

    // Derive absolute extremes from the loaded profiles so the rail
    // spans only what the data actually covers.
    var absoluteMin = Infinity, absoluteMax = -Infinity;
    state.profiles.forEach(function (p) {
      if (p.firstYear != null && p.firstYear < absoluteMin) absoluteMin = p.firstYear;
      if (p.lastYear  != null && p.lastYear  > absoluteMax) absoluteMax = p.lastYear;
    });
    if (!isFinite(absoluteMin)) absoluteMin = 1660;
    if (!isFinite(absoluteMax)) absoluteMax = 1800;
    state.rangeMin = absoluteMin; state.rangeMax = absoluteMax;
    state.rangeCurMin = absoluteMin; state.rangeCurMax = absoluteMax;

    [minEl, maxEl].forEach(function (el) {
      el.min = String(absoluteMin);
      el.max = String(absoluteMax);
    });
    minEl.value = String(absoluteMin);
    maxEl.value = String(absoluteMax);

    // Slider drag fires `input` on every pixel. Keep the visual parts
    // (readout, fill) live while debouncing the expensive DT rebuild.
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

    minEl.addEventListener('input',  function () { redraw(false); });
    maxEl.addEventListener('input',  function () { redraw(false); });
    minEl.addEventListener('change', function () { redraw(true); });
    maxEl.addEventListener('change', function () { redraw(true); });
    if (reset) {
      reset.addEventListener('click', function () {
        minEl.value = String(absoluteMin);
        maxEl.value = String(absoluteMax);
        redraw(true);
      });
    }

    // Click-to-focus on year cells in the body. Sets both handles to that
    // decade (1770 → 1770-1779). Clicking the same decade again or a
    // different one replaces the window, not a toggle.
    var wrapId = ids.tableWrap;
    var wrap = document.getElementById(wrapId);
    if (wrap) {
      wrap.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('.rep-year-focus') : null;
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        var y = +btn.getAttribute('data-year');
        if (!y) return;
        var dec = Math.floor(y / 10) * 10;
        var from = Math.max(absoluteMin, dec);
        var to   = Math.min(absoluteMax, dec + 9);
        minEl.value = String(from);
        maxEl.value = String(to);
        redraw(true);
      });
    }

    redraw(true);
  }

  function initTable() {
    var $ = window.jQuery;
    if (!$) throw new Error('jQuery missing');

    $.fn.dataTable.ext.search.push(function (settings, rowData, dataIndex) {
      if (settings.nTable.id !== 'people-table') return true;
      var p = state.profiles[dataIndex];
      if (!p) return false;
      if (state.kindFilter !== 'all' && p.kindBucket !== state.kindFilter) return false;
      // Date-range filter: include row if the profile's first-to-last span
      // overlaps the current window. The per-decade breakdown determines
      // the displayed count; this filter just hides the rows that fall
      // entirely outside the window.
      var rMin = state.rangeCurMin, rMax = state.rangeCurMax;
      if (rMin === state.rangeMin && rMax === state.rangeMax) return true;
      var fy = p.firstYear, ly = p.lastYear;
      if (fy == null || ly == null) return true; // don't hide rows with no date
      if (ly < rMin || fy > rMax) return false;
      // And require at least one in-range performance — cheap guard against
      // rows whose first/last dates straddle the window but whose decades
      // don't overlap.
      return rangeTotal(p, 0) > 0;
    });

    state.dt = new $.fn.dataTable.Api(
      $('#people-table').DataTable({
        data: state.profiles,
        deferRender: true,
        pageLength: 25,
        lengthMenu: [[10, 25, 50, 100, 500], [10, 25, 50, 100, 500]],
        order: [[2, 'desc']],
        createdRow: function (tr, data) {
          if (data && data.name) {
            tr.setAttribute('data-href', 'performer.html?name=' + encodeURIComponent(data.name));
            tr.classList.add('is-row-link');
          }
        },
        columns: [
          { data: 'name', className: 'rep-col-title', render: function (d) {
              var href = 'performer.html?name=' + encodeURIComponent(d || '');
              return '<a class="rep-title" href="' + escapeHtml(href) + '">' + escapeHtml(d || '') + '</a>';
          }},
          { data: 'kindLabel' },
          // Appearances: in-range derived count if a range is active, else lifetime.
          { data: 'total', className: 'rep-col-num is-perf', type: 'num',
            render: function (d, type, row) {
              if (type === 'sort' || type === 'type') return rangeTotal(row, d);
              if (type === 'display' || type === 'filter') return fmtNum(rangeTotal(row, d));
              return d;
          }},
          // Role mix — five-segment bar showing the distribution of cast
          // credits across the taxonomy (named / titled / generic / ensemble
          // / paratext). The distribution is lifetime — not decade-
          // decomposable without per-decade role-category breakdowns. Sort
          // key: the "named" share, so clicking the header ranks players
          // by how often they held proper-name roles.
          { data: null, className: 'people-col-mix',
            orderable: true, searchable: false,
            render: function (d, type, row) {
              if (type === 'sort' || type === 'type') {
                var tot = (row.named || 0) + (row.titled || 0) + (row.generic || 0) + (row.ensemble || 0) + (row.paratext || 0);
                return tot ? ((row.named || 0) / tot) : 0;
              }
              if (type !== 'display') return '';
              return roleMixHtml(row);
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
          // Signature role is a lifetime top pick — not decade-decomposable
          // without per-decade role sets. When the range is active we dim
          // it so the reader isn't misled into thinking it's in-window.
          { data: 'topRole', className: 'people-col-sig', render: function (d) {
              if (!d) return '<span class="is-dim">&mdash;</span>';
              if (!rangeIsFull()) {
                return '<span class="people-sig is-stale" title="Lifetime signature role &mdash; not recomputed within the date range.">' + escapeHtml(d) + '</span>';
              }
              return '<span class="people-sig">' + escapeHtml(d) + '</span>';
          }},
          { data: 'topRoleCount', className: 'rep-col-num is-dim', type: 'num',
            render: function (d, type) {
              if (type !== 'display') return d || 0;
              if (!d) return '&mdash;';
              if (!rangeIsFull()) return '<span class="is-stale" title="Lifetime count.">' + fmtNum(d) + '</span>';
              return fmtNum(d);
          }}
        ],
        language: {
          search: 'Search',
          searchPlaceholder: 'by name\u2026',
          lengthMenu: 'Show _MENU_ performers',
          info: '_START_\u2013_END_ of _TOTAL_ performers',
          infoEmpty: 'No performers',
          infoFiltered: '(filtered from _MAX_)',
          emptyTable: 'No performers recorded',
          zeroRecords: 'No performers match the current filter',
          paginate: { first: '\u00ab', previous: '\u2039', next: '\u203a', last: '\u00bb' }
        }
      })
    );

    wireRowLinks('#people-table');
  }

  // Turn each .is-row-link <tr> into a clickable row. The real <a> in the
  // first cell stays put and handles keyboard/assistive-tech navigation;
  // this delegate is only a mouse-affordance layer.
  function wireRowLinks(tableSel) {
    var tbody = document.querySelector(tableSel + ' tbody');
    if (!tbody) return;
    tbody.addEventListener('click', function (ev) {
      var interactive = ev.target.closest('a, button, input, select, textarea, label, [role="button"]');
      if (interactive) return;
      var tr = ev.target.closest('tr.is-row-link');
      if (!tr) return;
      var href = tr.getAttribute('data-href');
      if (!href) return;
      if (ev.metaKey || ev.ctrlKey || ev.button === 1) {
        window.open(href, '_blank', 'noopener');
      } else {
        window.location.href = href;
      }
    });
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

  function renderError(msg) {
    var tbody = document.querySelector('#people-table tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="rep-table-error">' + escapeHtml(msg) + '</td></tr>';
    var grid = document.getElementById('people-featured-grid');
    if (grid) grid.innerHTML = '<li class="rep-card people-card" aria-hidden="true"><p class="rep-card-tag">Unavailable</p><p class="rep-card-title">&mdash;</p><p class="rep-card-count">' + escapeHtml(msg) + '</p></li>';
  }

  function boot() {
    loadData().then(function (doc) {
      var profiles = (doc && Array.isArray(doc.profiles)) ? doc.profiles : [];
      state.profiles = enrich(profiles);
      state.buckets = indexBuckets(state.profiles);

      renderFeatured();
      renderChips();
      initTable();
      initRangeSlider({
        min: 'people-range-min', max: 'people-range-max',
        fill: 'people-range-fill', readout: 'people-range-readout',
        reset: 'people-range-reset', tableWrap: 'people-table-wrap'
      });
    }).catch(function (err) {
      if (window.console && console.error) console.error('People load failed', err);
      renderError('The dramatis personae could not be loaded. Please reload the page or try again later.');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
