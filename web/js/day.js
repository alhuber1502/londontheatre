/* London Stage, 1660-1800 — day view.
   Two modes off the same shard (data/calendar/by-mmdd/<MMDD>.json):
     ?date=YYYYMMDD  — single night, grouped by theatre
     ?mmdd=MMDD      — every recorded night on that calendar day, across years */

(function () {
  'use strict';

  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var DAYS_IN_MONTH = [31,29,31,30,31,30,31,31,30,31,30,31];

  var HATHI_IDS = {
    'vol1':   'mdp.39015020696632',
    'vol2-1': 'mdp.39015038922269',
    'vol2-2': 'mdp.39015011592139',
    'vol3-1': 'mdp.39015005538999',
    'vol3-2': 'mdp.39015014594983',
    'vol4-1': 'mdp.39015012277045',
    'vol4-2': 'mdp.39015013525210',
    'vol4-3': 'mdp.39015012265909',
    'vol5-1': 'mdp.39015011600239',
    'vol5-2': 'mdp.39015012284389',
    'vol5-3': 'mdp.39015012265917'
  };

  // Price section display order and labels.
  var PRICE_ORDER  = ['boxes','pit','firstGallery','secondGallery','upperGallery','slips'];
  var PRICE_LABELS = {
    boxes:        'Boxes',
    pit:          'Pit',
    firstGallery: 'First gallery',
    secondGallery:'Second gallery',
    upperGallery: 'Upper gallery',
    slips:        'Slips'
  };

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function qs() {
    var out = {};
    var q = window.location.search.replace(/^\?/, '');
    if (!q) return out;
    q.split('&').forEach(function (kv) {
      var ix = kv.indexOf('=');
      var k = ix < 0 ? kv : kv.slice(0, ix);
      var v = ix < 0 ? '' : decodeURIComponent(kv.slice(ix + 1).replace(/\+/g, ' '));
      if (k) out[decodeURIComponent(k)] = v;
    });
    return out;
  }

  function validateDate(s) {
    if (!s || s.length !== 8) return null;
    if (!/^\d{8}$/.test(s)) return null;
    var y = +s.slice(0,4), m = +s.slice(4,6), d = +s.slice(6,8);
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > DAYS_IN_MONTH[m-1]) return null;
    return { y:y, m:m, d:d, full:s, mmdd: pad2(m) + pad2(d) };
  }
  function validateMmdd(s) {
    if (!s || s.length !== 4 || !/^\d{4}$/.test(s)) return null;
    var m = +s.slice(0,2), d = +s.slice(2,4);
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > DAYS_IN_MONTH[m-1]) return null;
    return { m:m, d:d, mmdd: pad2(m)+pad2(d) };
  }

  function prettyDate(parts) {
    return parts.d + ' ' + MONTHS[parts.m - 1] + ' ' + parts.y;
  }
  function prettyMmdd(parts) {
    return parts.d + ' ' + MONTHS[parts.m - 1];
  }

  function addDays(y, m, d, diff) {
    var dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + diff);
    return {
      y: dt.getUTCFullYear(),
      m: dt.getUTCMonth() + 1,
      d: dt.getUTCDate(),
      full: String(dt.getUTCFullYear()) + pad2(dt.getUTCMonth() + 1) + pad2(dt.getUTCDate()),
      mmdd: pad2(dt.getUTCMonth() + 1) + pad2(dt.getUTCDate())
    };
  }
  function shiftMmdd(m, d, diff) {
    // Use a leap year (2000) so 29 Feb is reachable.
    var dt = new Date(Date.UTC(2000, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + diff);
    return { m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), mmdd: pad2(dt.getUTCMonth() + 1) + pad2(dt.getUTCDate()) };
  }

  // Basic ordinal for things like "7th" when writing the subtitle.
  function ordinal(n) {
    var s = ['th','st','nd','rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ------------ Calendar-reform helpers ------------
  // Britain adopted the Gregorian calendar on 14 Sep 1752 (New Style),
  // dropping 11 days. Julian dates up to 2 Sep 1752 (OS) are "Old Style";
  // 3–13 Sep 1752 were skipped entirely; 14 Sep 1752+ are Gregorian.

  function isOldStyle(parts) {
    if (!parts || !parts.y) return false;
    if (parts.y < 1752) return true;
    if (parts.y > 1752) return false;
    if (parts.m < 9) return true;
    if (parts.m > 9) return false;
    return parts.d <= 2;
  }

  function isDroppedDay(parts) {
    return parts.m === 9 && parts.d >= 3 && parts.d <= 13;
  }

  // ------------ Benefit beneficiary cleaner ------------
  // Raw beneficiary text can be noisy ("Mr Hodgson, beginning at…").
  // Strip trailing clause fragments after a comma, cap at 30 chars.
  function cleanBeneficiary(raw) {
    if (!raw) return '';
    var s = raw.replace(/\s+/g, ' ').trim();
    var comma = s.indexOf(',');
    if (comma > 0) s = s.slice(0, comma).trim();
    s = s.replace(/[.,;:]+$/, '').trim();
    if (s.length > 32) s = s.slice(0, 30).trim() + '…';
    return s;
  }

  // ------------ Money & clock formatters ------------

  function fmtMoney(m) {
    if (!m) return '';
    var p = [];
    if (m.pounds)    p.push('£' + m.pounds);
    if (m.shillings) p.push(m.shillings + 's');
    if (m.pence)     p.push(m.pence + 'd');
    return p.join(' ') || '—';
  }

  function fmtPence(totalPence) {
    var pence = Number(totalPence) || 0;
    var p = Math.floor(pence / 240);
    var rest = pence - p * 240;
    var s = Math.floor(rest / 12);
    var d = rest - s * 12;
    var out = '£' + p;
    if (s || d) out += ' ' + s + 's.';
    if (d) out += ' ' + d + 'd.';
    return out;
  }

  function fmtClock(t) {
    if (!t || t.h == null) return '';
    var h = t.h;
    var m = t.m || 0;
    if (m === 0) return h + ' o’clock';
    return h + ':' + (m < 10 ? '0' + m : m) + ' o’clock';
  }

  function extrasHtml(ex) {
    if (!ex) return '';
    var parts = [];

    if (ex.benefit && ex.benefit.flagged) {
      var beneficiary = cleanBeneficiary(ex.benefit.beneficiary || '');
      var label = beneficiary
        ? 'Benefit of ' + escapeHtml(beneficiary)
        : 'Benefit night';
      parts.push('<span class="day-bill-benefit">' + label + '</span>');
    }

    if (ex.curtain) {
      var c = ex.curtain;
      var cParts = [];
      if (c.doorsOpen)        cParts.push('Doors ' + fmtClock(c.doorsOpen));
      if (c.performanceStart) cParts.push('Curtain ' + fmtClock(c.performanceStart));
      if (cParts.length) parts.push('<span class="day-bill-curtain">' + cParts.join(' · ') + '</span>');
    }

    if (ex.prices) {
      var pr = ex.prices;
      var pItems = [];
      PRICE_ORDER.forEach(function (k) {
        if (pr[k]) {
          pItems.push(
            '<span class="day-bill-price-item">' +
            escapeHtml(PRICE_LABELS[k] || k) + ' ' + fmtMoney(pr[k]) +
            '</span>'
          );
        }
      });
      if (pItems.length) parts.push('<span class="day-bill-prices">' + pItems.join(' · ') + '</span>');
    }

    if (ex.halfPrice) {
      parts.push('<span class="day-bill-halfprice">Half-price at doors</span>');
    }

    var html = '';
    if (parts.length) {
      html += '<p class="day-bill-extras metadata-label">' + parts.join('<span class="day-extras-sep"> &nbsp; </span>') + '</p>';
    }
    if (ex.h) {
      var hParts   = ex.h.split(':');
      var hathiId  = HATHI_IDS[hParts[0]];
      if (hathiId) {
        var hUrl = 'https://babel.hathitrust.org/cgi/pt?id=' + hathiId + '&seq=' + hParts[1];
        html += '<p class="day-bill-source metadata-label"><a href="' + escapeHtml(hUrl) + '" target="_blank" rel="noopener" class="external">View source &#8599;</a></p>';
      }
    }
    return html;
  }

  // ------------ Data fetchers ------------

  function fetchAbbr() {
    return fetch('data/theatre-abbreviations.json')
      .then(function (r) { return r.json(); })
      .then(function (doc) {
        return Object.assign(
          {},
          (doc && doc.sentinels) || {},
          (doc && doc.compound) || {},
          (doc && doc.entries) || {}
        );
      })
      .catch(function () { return {}; });
  }

  function fetchShard(mmdd) {
    return fetch('data/calendar/by-mmdd/' + mmdd + '.json')
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  function fetchExtras() {
    return fetch('data/events-extras.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; });
  }

  function fetchTheatronomics() {
    return fetch('data/receipts/theatronomics-by-date.json')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; });
  }

  function canonicalFor(code, abbr) {
    if (!code) return 'Unknown theatre';
    var entry = abbr[code];
    if (entry && entry.canonical) return entry.canonical;
    return code;
  }

  // ------------ Bill row ------------

  function eventRowHtml(ev, abbr, extras, abData) {
    var venue = canonicalFor(ev.th, abbr);
    var venueHref = ev.th ? 'venue.html?code=' + encodeURIComponent(ev.th) : null;
    var title = ev.t && String(ev.t).trim()
      ? ev.t
      : '(untitled entry)';
    var workHref = ev.w ? 'work.html?id=' + encodeURIComponent(ev.w) : null;
    var n = ev.n || 0;
    var nLabel = n
      ? n.toLocaleString() + ' piece' + (n === 1 ? '' : 's') + ' in the bill'
      : 'No performance pieces logged';
    var season = ev.s ? 'Season ' + ev.s : '';
    var vol = ev.v ? 'Vol. ' + ev.v : '';

    var meta = [season, vol].filter(Boolean).join(' &middot; ');

    // Displaced-house badge
    var displacedBadge = '';
    if (ev.dt) {
      var hostName = canonicalFor(ev.dt, abbr);
      var hostHref = 'venue.html?code=' + encodeURIComponent(ev.dt);
      displacedBadge =
        ' <span class="day-bill-displaced metadata-label" title="' +
        escapeHtml(venue + ' company played this night at ' + hostName) + '">' +
          'at <a href="' + escapeHtml(hostHref) + '">' + escapeHtml(hostName) + '</a>' +
        '</span>';
    }

    // Extras: prices / curtain times
    var ex = (extras && ev.id != null) ? (extras[String(ev.id)] || null) : null;

    // Account-book door receipts (Theatronomics, CG/DL from 1732)
    var abHtml = '';
    if (abData && (ev.th === 'cg' || ev.th === 'dl') && ev.date) {
      var ab = abData[ev.th + ':' + ev.date];
      if (ab && ab.dr) {
        abHtml = '<p class="day-bill-ab metadata-label">' +
          '<span class="day-bill-ab-label">Account-book</span> ' +
          escapeHtml(fmtPence(ab.dr)) + ' door receipts' +
          (ab.bd ? ' <span class="day-bill-ab-deficit">deficiency</span>' : '') +
        '</p>';
      }
    }

    return (
      '<li class="day-bill">' +
        '<p class="day-bill-venue">' +
          (venueHref
            ? '<a href="' + escapeHtml(venueHref) + '">' + escapeHtml(venue) + '</a>'
            : escapeHtml(venue)) +
          displacedBadge +
        '</p>' +
        '<p class="day-bill-title">' +
          (workHref
            ? '<a href="' + escapeHtml(workHref) + '">' + escapeHtml(title) + '</a>'
            : escapeHtml(title)) +
        '</p>' +
        '<p class="day-bill-meta metadata-label">' + nLabel +
          (meta ? ' &middot; ' + meta : '') +
        '</p>' +
        extrasHtml(ex) +
        abHtml +
      '</li>'
    );
  }

  // ------------ Reform caveat helper ------------

  function showReformNote(html) {
    var el = document.getElementById('day-reform-note');
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
  }

  // ------------ Render: single date ------------

  function renderSingleDate(parts, shard, abbr, extras, abData) {
    var head = document.getElementById('day-head');
    var kicker = document.getElementById('day-kicker');
    var title = document.getElementById('day-title');
    var sub   = document.getElementById('day-subtitle');
    var billsSection = document.getElementById('day-bills-section');
    var billsWrap = document.getElementById('day-bills');
    var note = document.getElementById('day-note');
    var navSection = document.getElementById('day-nav-section');
    var prev = document.getElementById('day-prev');
    var next = document.getElementById('day-next');
    var mmddLink = document.getElementById('day-mmdd');

    kicker.textContent = 'That Evening in the Theatres';
    title.textContent = prettyDate(parts);

    var events = (shard && shard.events)
      ? shard.events.filter(function (e) { return e.date === parts.full; })
      : [];

    function buildStep(diff) {
      var step = addDays(parts.y, parts.m, parts.d, diff);
      return 'day.html?date=' + step.full;
    }
    prev.href = buildStep(-1);
    next.href = buildStep(1);
    mmddLink.href = 'day.html?mmdd=' + parts.mmdd;
    navSection.hidden = false;

    if (!events.length) {
      head.hidden = false;
      sub.textContent = 'No bill from this night survives in the London Stage calendars.';
      document.getElementById('day-missing').hidden = false;
      return;
    }

    var venues = {};
    events.forEach(function (e) { venues[e.th || 'unknown'] = true; });
    var venueCount = Object.keys(venues).length;

    head.hidden = false;
    sub.textContent = events.length.toLocaleString() + ' bill' + (events.length === 1 ? '' : 's') +
      ' across ' + venueCount + ' house' + (venueCount === 1 ? '' : 's') + '.';

    note.innerHTML =
      'The city offered ' + events.length + ' advertised program' + (events.length === 1 ? '' : 's') +
      ' on the ' + ordinal(parts.d) + ' of ' + MONTHS[parts.m - 1] + ' ' + parts.y + '.';

    // Calendar-reform caveat for Old Style dates
    if (isOldStyle(parts)) {
      showReformNote(
        'Dates before 14 September 1752 follow the Old Style Julian calendar. ' +
        '<a href="about.html#calendar-dates">More about dates on this site.</a>'
      );
    }

    var hasAb = false;
    var html = events.map(function (ev) {
      if (abData && (ev.th === 'cg' || ev.th === 'dl') && ev.date) {
        var ab = abData[ev.th + ':' + ev.date];
        if (ab && ab.dr) hasAb = true;
      }
      return eventRowHtml(ev, abbr, extras, abData);
    }).join('');
    billsWrap.innerHTML = '<ol class="day-bills-list">' + html + '</ol>';
    billsSection.hidden = false;

    if (hasAb) {
      note.innerHTML += ' <span class="day-ab-attribution">Account-book figures from ' +
        '<a href="https://theatronomics.com/" rel="noopener" target="_blank" class="external">Theatronomics</a>' +
        ' (O’Shaughnessy et al., 2025), CC BY-NC 4.0.</span>';
    }
  }

  // ------------ Render: MMDD (across years) ------------

  function renderMmdd(parts, shard, abbr, extras, abData) {
    var head = document.getElementById('day-head');
    var kicker = document.getElementById('day-kicker');
    var title = document.getElementById('day-title');
    var sub   = document.getElementById('day-subtitle');
    var billsSection = document.getElementById('day-bills-section');
    var billsWrap = document.getElementById('day-bills');
    var note = document.getElementById('day-note');
    var navSection = document.getElementById('day-nav-section');
    var prev = document.getElementById('day-prev');
    var next = document.getElementById('day-next');
    var mmddLink = document.getElementById('day-mmdd');

    var prevStep = shiftMmdd(parts.m, parts.d, -1);
    var nextStep = shiftMmdd(parts.m, parts.d, 1);
    prev.href = 'day.html?mmdd=' + prevStep.mmdd;
    next.href = 'day.html?mmdd=' + nextStep.mmdd;
    mmddLink.textContent = 'Return to the calendar ›';
    mmddLink.href = 'calendar.html';
    navSection.hidden = false;

    kicker.textContent = 'The Same Day, Across Seasons';
    title.textContent = prettyMmdd(parts);

    var events = (shard && shard.events) || [];

    if (!events.length) {
      head.hidden = false;
      sub.textContent = 'No bills recorded on this calendar day between 1659 and 1800.';
      document.getElementById('day-missing').hidden = false;
      return;
    }

    var firstYear = events[0].y;
    var lastYear = events[events.length - 1].y;
    var yearSet = {};
    events.forEach(function (e) { yearSet[e.y] = true; });
    var yearCount = Object.keys(yearSet).length;

    head.hidden = false;
    sub.textContent = events.length.toLocaleString() + ' bill' + (events.length === 1 ? '' : 's') +
      ' across ' + yearCount + ' year' + (yearCount === 1 ? '' : 's') +
      ' (' + firstYear + '–' + lastYear + ').';

    note.innerHTML =
      'Every evening the London stage recorded on the ' + ordinal(parts.d) + ' of ' +
      MONTHS[parts.m - 1] + ' between 1659 and 1800. Year labels link through to the full bill of that night.';

    // Calendar-reform caveat for dropped days (3–13 September)
    if (isDroppedDay(parts)) {
      showReformNote(
        'These dates were dropped when Britain adopted the Gregorian calendar in September 1752. ' +
        'No performances are recorded for ' + ordinal(parts.d) + ' September 1752. ' +
        '<a href="about.html#calendar-dates">More about dates on this site.</a>'
      );
    }

    // Group by year
    var byYear = {};
    events.forEach(function (e) {
      var k = e.y;
      if (!byYear[k]) byYear[k] = [];
      byYear[k].push(e);
    });
    var years = Object.keys(byYear).map(Number).sort(function (a, b) { return a - b; });

    var htmlParts = years.map(function (y) {
      var list = byYear[y];
      var date = list[0].date;
      var dayLink = 'day.html?date=' + encodeURIComponent(date);
      var rows = list.map(function (ev) { return eventRowHtml(ev, abbr, extras, abData); }).join('');
      return (
        '<section class="day-year-group">' +
          '<h3 class="day-year-head">' +
            '<a href="' + escapeHtml(dayLink) + '">' + y + '</a>' +
            '<span class="metadata-label day-year-count">' +
              list.length.toLocaleString() + ' bill' + (list.length === 1 ? '' : 's') +
            '</span>' +
          '</h3>' +
          '<ol class="day-bills-list">' + rows + '</ol>' +
        '</section>'
      );
    });

    billsWrap.innerHTML = htmlParts.join('');
    billsSection.hidden = false;
  }

  // ------------ Error state ------------

  function showInvalid(msg) {
    document.getElementById('day-head').hidden = false;
    document.getElementById('day-kicker').textContent = 'Unrecognised date';
    document.getElementById('day-title').textContent = '';
    document.getElementById('day-subtitle').textContent = msg || 'The URL does not name a valid date.';
    var miss = document.getElementById('day-missing');
    document.getElementById('day-missing-heading').textContent = 'Nothing to show';
    document.getElementById('day-missing-body').textContent = 'Open the calendar to pick a date.';
    miss.hidden = false;
  }

  // ------------ Boot ------------

  document.addEventListener('DOMContentLoaded', function () {
    var params = qs();
    var date = params.date ? validateDate(params.date) : null;
    var mmdd = params.mmdd ? validateMmdd(params.mmdd) : null;

    if (!date && !mmdd) { showInvalid(); return; }

    var targetMmdd = date ? date.mmdd : mmdd.mmdd;

    Promise.all([fetchAbbr(), fetchShard(targetMmdd), fetchExtras(), fetchTheatronomics()])
      .then(function (results) {
        var abbr   = results[0];
        var shard  = results[1];
        var extras = results[2];
        var abData = results[3];
        if (date) renderSingleDate(date, shard, abbr, extras, abData);
        else      renderMmdd(mmdd, shard, abbr, extras, abData);
      })
      .catch(function (err) {
        console.error('[london-stage day]', err);
        showInvalid('The day record failed to load. Try reloading or return to the calendar.');
      });
  });
})();
