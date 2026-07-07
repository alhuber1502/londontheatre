/* London Stage, 1660-1800 — calendar heatmap
   Day-by-day count grid across 141 years. Cells click through to
   day.html for the single-night playbill; the picker below opens the
   "this day across years" view. */

(function () {
  'use strict';

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS_IN_MONTH = [31,29,31,30,31,30,31,31,30,31,30,31]; // allow Feb 29

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // Fixed column ordering: 366 entries, "0101" .. "1231".
  function buildMmddList() {
    var out = [];
    var monthStarts = [];
    for (var m = 1; m <= 12; m++) {
      monthStarts.push(out.length);
      var dim = DAYS_IN_MONTH[m - 1];
      for (var d = 1; d <= dim; d++) out.push(pad2(m) + pad2(d));
    }
    return { list: out, monthStarts: monthStarts };
  }

  function mmddToPretty(mmdd) {
    var m = parseInt(mmdd.slice(0, 2), 10);
    var d = parseInt(mmdd.slice(2, 4), 10);
    return d + ' ' + MONTHS[m - 1];
  }

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd || yyyymmdd.length !== 8) return '';
    var y = yyyymmdd.slice(0, 4);
    var m = parseInt(yyyymmdd.slice(4, 6), 10);
    var d = parseInt(yyyymmdd.slice(6, 8), 10);
    return d + ' ' + MONTHS[m - 1] + ' ' + y;
  }

  // Discrete five-step colour scale against whatever the max daily count is.
  function fillFor(count, max) {
    if (!count) return null;
    var steps = 5;
    var step = Math.max(1, Math.min(steps, Math.ceil((count / max) * steps)));
    return 'var(--heat-' + step + ')';
  }

  function buildGrid(counts) {
    var fig = document.getElementById('calendar-figure');
    if (!fig) return;

    var mm = buildMmddList();
    var mmddList = mm.list;
    var monthStarts = mm.monthStarts;
    var mmddIndex = {};
    for (var mi = 0; mi < mmddList.length; mi++) mmddIndex[mmddList[mi]] = mi;

    var yMin = counts.yearMin;
    var yMax = counts.yearMax;
    var yearList = [];
    for (var y = yMin; y <= yMax; y++) yearList.push(y);
    var maxCount = counts.maxCount || 1;

    // Viewbox units: cellW x cellH per cell.
    var cellW = 4;
    var cellH = 6;
    var leftGutter = 40;      // year labels
    var topGutter  = 22;      // month labels
    var width  = leftGutter + mmddList.length * cellW;
    var height = topGutter  + yearList.length * cellH + 4;

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'calendar-svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Heatmap of performances per day from ' + yMin + ' to ' + yMax);
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

    // Month label row + separators
    for (var m = 0; m < 12; m++) {
      var sx = leftGutter + monthStarts[m] * cellW;
      var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', sx + 2);
      t.setAttribute('y', topGutter - 7);
      t.setAttribute('class', 'calendar-month-label');
      t.textContent = MONTHS[m];
      svg.appendChild(t);

      if (m > 0) {
        var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'calendar-month-rule');
        line.setAttribute('x1', sx);
        line.setAttribute('x2', sx);
        line.setAttribute('y1', topGutter - 2);
        line.setAttribute('y2', height - 2);
        svg.appendChild(line);
      }
    }

    // Year labels — every 10th year plus yMin / yMax
    var labelRows = {};
    for (var yi = 0; yi < yearList.length; yi++) {
      var yr = yearList[yi];
      if (yi === 0 || yi === yearList.length - 1 || yr % 10 === 0) labelRows[yi] = yr;
    }
    Object.keys(labelRows).forEach(function (idx) {
      var i = +idx;
      var label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', leftGutter - 6);
      label.setAttribute('y', topGutter + i * cellH + cellH - 1);
      label.setAttribute('class', 'calendar-year-label');
      label.setAttribute('text-anchor', 'end');
      label.textContent = labelRows[idx];
      svg.appendChild(label);
    });

    // Grid background — one rect per year row so empty days are still visible
    for (var yi2 = 0; yi2 < yearList.length; yi2++) {
      var rowBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rowBg.setAttribute('class', 'calendar-row-bg');
      rowBg.setAttribute('x', leftGutter);
      rowBg.setAttribute('y', topGutter + yi2 * cellH);
      rowBg.setAttribute('width', mmddList.length * cellW);
      rowBg.setAttribute('height', cellH);
      svg.appendChild(rowBg);
    }

    // Active cells
    var cellGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    cellGroup.setAttribute('class', 'calendar-cells');

    var years = counts.years || {};
    for (var yi3 = 0; yi3 < yearList.length; yi3++) {
      var year = yearList[yi3];
      var row = years[year];
      if (!row) continue;
      for (var key in row) {
        if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
        var n = row[key] | 0;
        if (!n) continue;
        var col = mmddIndex[key];
        if (col == null) continue;
        var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('class', 'calendar-cell');
        rect.setAttribute('x', leftGutter + col * cellW);
        rect.setAttribute('y', topGutter + yi3 * cellH);
        rect.setAttribute('width', cellW);
        rect.setAttribute('height', cellH);
        var fill = fillFor(n, maxCount);
        if (fill) rect.setAttribute('fill', fill);
        rect.setAttribute('data-date', String(year) + key);
        rect.setAttribute('data-count', String(n));
        cellGroup.appendChild(rect);
      }
    }
    svg.appendChild(cellGroup);

    fig.innerHTML = '';
    var scroll = document.createElement('div');
    scroll.className = 'calendar-scroll';
    scroll.appendChild(svg);
    fig.appendChild(scroll);

    // Legend
    var legend = document.createElement('div');
    legend.className = 'calendar-legend metadata-label';
    legend.innerHTML =
      '<span>Fewer</span>' +
      '<span class="calendar-swatch" style="background:var(--heat-1)"></span>' +
      '<span class="calendar-swatch" style="background:var(--heat-2)"></span>' +
      '<span class="calendar-swatch" style="background:var(--heat-3)"></span>' +
      '<span class="calendar-swatch" style="background:var(--heat-4)"></span>' +
      '<span class="calendar-swatch" style="background:var(--heat-5)"></span>' +
      '<span>Busier</span>' +
      '<span class="calendar-legend-sep" aria-hidden="true">&middot;</span>' +
      '<span>Deepest-coloured cell: ' + maxCount + ' nights logged</span>';
    fig.appendChild(legend);

    // Tooltip
    var tip = document.createElement('div');
    tip.className = 'calendar-tooltip metadata-label';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    fig.appendChild(tip);

    function showTip(ev, el) {
      var date = el.getAttribute('data-date');
      var n = +el.getAttribute('data-count');
      if (!date) return;
      tip.innerHTML =
        '<span class="calendar-tooltip-date">' + fmtDate(date) + '</span>' +
        '<span class="calendar-tooltip-count">' + n + ' night' + (n === 1 ? '' : 's') + ' logged</span>' +
        '<span class="calendar-tooltip-cta">Click to read the bill &rsaquo;</span>';
      // Measure before we paint so we can clamp against the figure's right edge.
      tip.style.left = '-9999px';
      tip.style.top  = '-9999px';
      tip.hidden = false;
      var rect = fig.getBoundingClientRect();
      var tipW = tip.offsetWidth || 200;
      var tipH = tip.offsetHeight || 60;
      var x = ev.clientX - rect.left + 14;
      var y = ev.clientY - rect.top + 14;
      if (x + tipW > rect.width - 4) x = Math.max(4, ev.clientX - rect.left - tipW - 14);
      if (y + tipH > rect.height - 4) y = Math.max(4, ev.clientY - rect.top - tipH - 14);
      tip.style.left = x + 'px';
      tip.style.top  = y + 'px';
    }
    function hideTip() { tip.hidden = true; }

    cellGroup.addEventListener('mousemove', function (ev) {
      var el = ev.target;
      if (el && el.classList && el.classList.contains('calendar-cell')) showTip(ev, el);
      else hideTip();
    });
    cellGroup.addEventListener('mouseleave', hideTip);
    cellGroup.addEventListener('click', function (ev) {
      var el = ev.target;
      if (!el || !el.classList || !el.classList.contains('calendar-cell')) return;
      var date = el.getAttribute('data-date');
      if (!date) return;
      window.location.href = 'day.html?date=' + encodeURIComponent(date);
    });
  }

  function buildPicker(counts) {
    var mSel = document.getElementById('cp-month');
    var dSel = document.getElementById('cp-day');
    var go   = document.getElementById('cp-go');
    var tot  = document.getElementById('cp-total');
    if (!mSel || !dSel || !go) return;

    var totals = counts.totals || {};

    // Month options
    for (var m = 1; m <= 12; m++) {
      var o = document.createElement('option');
      o.value = pad2(m);
      o.textContent = MONTHS_LONG[m - 1];
      mSel.appendChild(o);
    }

    // Default to today so the picker opens on "what happened on this date
    // across the long 18th century" — more immediate than a generic month start.
    var today = new Date();
    var initialMonth = pad2(today.getMonth() + 1);
    var initialDay = pad2(today.getDate());
    mSel.value = initialMonth;

    function fillDays() {
      var month = parseInt(mSel.value, 10);
      var keep = dSel.value;
      dSel.innerHTML = '';
      var dim = DAYS_IN_MONTH[month - 1];
      for (var d = 1; d <= dim; d++) {
        var o = document.createElement('option');
        o.value = pad2(d);
        o.textContent = d;
        dSel.appendChild(o);
      }
      // Priority: explicit change kept, then today's day (if valid for
      // this month), then fall back to the 1st.
      if (keep && keep.length === 2 && +keep <= dim) dSel.value = keep;
      else if (+initialDay <= dim && +mSel.value === today.getMonth() + 1) dSel.value = initialDay;
      else dSel.value = '01';
      refreshTotal();
    }

    function refreshTotal() {
      var mmdd = mSel.value + dSel.value;
      var n = totals[mmdd] || 0;
      tot.textContent = n
        ? n.toLocaleString() + ' night' + (n === 1 ? '' : 's') + ' across the span on ' + mmddToPretty(mmdd)
        : 'No nights recorded on ' + mmddToPretty(mmdd);
    }

    mSel.addEventListener('change', fillDays);
    dSel.addEventListener('change', refreshTotal);
    go.addEventListener('click', function () {
      var mmdd = mSel.value + dSel.value;
      window.location.href = 'day.html?mmdd=' + encodeURIComponent(mmdd);
    });

    fillDays();
  }

  function fail(err) {
    console.error('[london-stage calendar]', err);
    var el = document.getElementById('calendar-missing');
    if (el) {
      el.hidden = false;
      document.getElementById('calendar-section').hidden = true;
      document.getElementById('thisday-section').hidden = true;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    fetch('data/calendar/calendar-counts.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (counts) {
        buildGrid(counts);
        buildPicker(counts);
      })
      .catch(fail);
  });
})();
