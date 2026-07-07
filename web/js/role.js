/* London Stage, 1660-1800 — role detail view.
   Reads ?slug=<slug> (preferred) or ?name=<raw role> from the URL and
   renders one entry from data/roles/by-slug/<slug>.json, with theatre
   abbreviations + role-index loaded for the sidebar details. */

(function () {
  'use strict';

  var PERFORMER_CAP = 40;
  var WORK_CAP = 12;
  var THEATRE_CAP = 10;

  var DECADES = [1650,1660,1670,1680,1690,1700,1710,1720,1730,1740,1750,1760,1770,1780,1790,1800];

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString('en-GB');
  }

  function getParam(name) {
    try {
      var params = new URLSearchParams(window.location.search);
      var raw = params.get(name);
      if (!raw) return '';
      return String(raw).trim();
    } catch (e) {
      return '';
    }
  }

  function canonicalFor(code, abbr) {
    if (!code) return '';
    var entry = abbr[code];
    if (entry && entry.canonical) return entry.canonical;
    return code;
  }

  function fetchShard(slug) {
    return fetch('data/roles/by-slug/' + encodeURIComponent(slug) + '.json').then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchIndex() {
    return fetch('data/roles/role-index.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchAbbr() {
    return fetch('data/theatre-abbreviations.json')
      .then(function (r) { return r.json(); })
      // Merge entries + compound (dlking's etc.) + sentinels (none).
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

  // Resolve "?name=Hamlet" by finding the highest-count entry in the
  // index with matching name. This is tolerant of case/whitespace.
  function lookupByName(indexDoc, rawName) {
    if (!rawName || !indexDoc || !indexDoc.roles) return null;
    var needle = rawName.toLowerCase().replace(/\s+/g, ' ').trim();
    var matches = [];
    for (var i = 0; i < indexDoc.roles.length; i++) {
      var r = indexDoc.roles[i];
      if (!r || !r.name) continue;
      if (r.name.toLowerCase().replace(/\s+/g, ' ').trim() === needle) matches.push(r);
    }
    if (!matches.length) return null;
    matches.sort(function (a, b) { return b.count - a.count; });
    return matches[0];
  }

  // ------------ Header ------------
  function renderHead(role) {
    var section = document.getElementById('role-head');
    var titleEl = document.getElementById('role-title');
    var subEl = document.getElementById('role-subtitle');
    if (!section || !titleEl || !subEl) return;

    titleEl.textContent = role.name;

    var parts = [];
    parts.push(fmtNum(role.total) + ' appearance' + (role.total === 1 ? '' : 's'));
    var f = role.firstYear, l = role.lastYear;
    if (f && l && f !== l) parts.push(f + '\u2013' + l);
    else if (f) parts.push(String(f));
    if (role.category) {
      var catLabel = role.category === 'titled'
        ? 'Role held by title'
        : 'Named character';
      parts.push(catLabel);
    }
    subEl.innerHTML = parts.join(' \u00b7 ');
    section.hidden = false;

    document.title = role.name + ' \u2014 The London Stage, 1660\u20131800';
  }

  // ------------ Ledger ------------
  function renderLedger(role) {
    var wrap = document.getElementById('role-ledger');
    var section = document.getElementById('role-stats');
    if (!wrap || !section) return;

    var first = Number(role.firstYear) || null;
    var last = Number(role.lastYear) || null;
    var span = (first && last) ? (last - first + 1) : null;

    var performers = Number(role.performerCount) || 0;
    var works = Number(role.workCount) || 0;
    var theatres = Number(role.theatreCount) || 0;

    var entries = [
      { fig: fmtNum(role.total), label: 'Appearances' },
      { fig: fmtNum(performers), label: 'Players' },
      { fig: fmtNum(works),      label: 'Plays' },
      { fig: fmtNum(theatres),   label: 'Theatres' },
      { fig: span != null ? fmtNum(span) + ' <em>seasons</em>' : '&mdash;', label: 'Span in years' }
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

  // ------------ Decade sparkline ------------
  function renderSparkline(role) {
    var host = document.getElementById('role-sparkline');
    var section = document.getElementById('role-decade-section');
    if (!host || !section) return;

    var by = role.byDecade || {};
    var rows = DECADES.map(function (d) {
      return { decade: d, count: Number(by[String(d)]) || 0 };
    });
    var total = rows.reduce(function (s, r) { return s + r.count; }, 0);
    if (!total) { section.hidden = true; return; }

    var maxCount = 0;
    rows.forEach(function (r) { if (r.count > maxCount) maxCount = r.count; });
    if (maxCount <= 0) maxCount = 1;

    var colW = 40, barW = 18, chartH = 140;
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
      var tip = r.decade + 's \u00b7 ' + fmtNum(r.count) +
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
          '" y="' + labelY + '" text-anchor="middle">' +
          r.decade + '</text>'
        );
      }
    });

    host.innerHTML =
      '<svg role="img" aria-label="Appearances by decade" ' +
      'viewBox="0 0 ' + width + ' ' + height + '" ' +
      'preserveAspectRatio="none">' +
        bars.join('') +
        '<line class="spark-baseline" x1="0" y1="' + baseY +
        '" x2="' + width + '" y2="' + baseY + '"></line>' +
        labels.join('') +
      '</svg>';
    section.hidden = false;
  }

  // ------------ Players ------------
  function renderPerformers(role) {
    var list = document.getElementById('role-performers');
    var section = document.getElementById('role-performers-section');
    var note = document.getElementById('role-performers-note');
    if (!list || !section) return;

    var rows = (role.topPerformers || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var html = rows.map(function (r) {
      var name = r.name || '';
      var href = 'performer.html?name=' + encodeURIComponent(name);
      var range = '';
      if (r.firstYear && r.lastYear && r.firstYear !== r.lastYear) {
        range = r.firstYear + '\u2013' + r.lastYear;
      } else if (r.firstYear) {
        range = String(r.firstYear);
      }
      var tag = range
        ? '<span class="performer-pairing-tenure">' + escapeHtml(range) + '</span>'
        : '';
      return (
        '<li>' +
          '<span class="performer-pairing-label">' +
            '<a href="' + escapeHtml(href) + '">' + escapeHtml(name) + '</a>' +
            tag +
          '</span>' +
          '<span class="performer-costar-count metadata-label">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    if (note) note.hidden = rows.length < PERFORMER_CAP;
    section.hidden = false;
  }

  // ------------ Works ------------
  function renderWorks(role) {
    var list = document.getElementById('role-works');
    var section = document.getElementById('role-works-section');
    if (!list || !section) return;

    var rows = (role.topWorks || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var html = rows.map(function (r) {
      var href = r.workId ? 'work.html?id=' + encodeURIComponent(r.workId) : null;
      var title = r.title || '(untitled)';
      var link = href
        ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(title) + '</a>'
        : escapeHtml(title);
      return (
        '<li>' +
          '<span class="performer-pairing-label">' + link + '</span>' +
          '<span class="performer-costar-count metadata-label">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    section.hidden = false;
  }

  // ------------ Theatres ------------
  function renderTheatres(role, abbr) {
    var list = document.getElementById('role-theatres');
    var section = document.getElementById('role-theatres-section');
    if (!list || !section) return;

    var rows = (role.topTheatres || []).slice();
    if (!rows.length) { section.hidden = true; return; }

    var html = rows.map(function (r) {
      var code = r.code || '';
      var canonical = canonicalFor(code, abbr) || code.toUpperCase();
      var href = code ? 'venue.html?code=' + encodeURIComponent(code) : null;
      var link = href
        ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(canonical) + '</a>'
        : escapeHtml(canonical);
      var codeBadge = (code && canonical.toLowerCase() !== code.toLowerCase())
        ? '<span class="bar-code metadata-label">' + escapeHtml(code.toUpperCase()) + '</span>'
        : '';
      return (
        '<li>' +
          '<span class="performer-pairing-label">' + link + codeBadge + '</span>' +
          '<span class="performer-costar-count metadata-label">' + fmtNum(r.count) + '</span>' +
        '</li>'
      );
    }).join('');

    list.innerHTML = html;
    section.hidden = false;
  }

  // ------------ Blank state ------------
  function renderMissing(reason, ref) {
    var block = document.getElementById('role-missing');
    var heading = document.getElementById('role-missing-heading');
    var body = document.getElementById('role-missing-body');
    if (!block) return;
    if (reason === 'no-id') {
      if (heading) heading.textContent = 'No role requested';
      if (body) body.textContent = 'This page expects a role name or slug in the URL, e.g. role.html?name=Hamlet.';
    } else if (reason === 'too-few') {
      if (heading) heading.textContent = 'Too few appearances';
      if (body) body.textContent = (ref ? '\u201c' + ref + '\u201d' : 'That role') +
        ' has fewer than five recorded appearances, so no biography is built.';
    } else if (reason === 'unknown') {
      if (heading) heading.textContent = 'No such role';
      if (body) body.textContent = 'We could not find a role matching \u201c' + (ref || '') +
        '\u201d in the London Stage calendars.';
    } else if (reason === 'error') {
      if (heading) heading.textContent = 'Unavailable';
      if (body) body.textContent = 'The role details could not be loaded. Please reload or try again later.';
    }
    block.hidden = false;
    document.title = 'Role not found \u2014 The London Stage, 1660\u20131800';
  }

  // ------------ Boot ------------
  function boot() {
    var slug = getParam('slug');
    var name = getParam('name');

    if (!slug && !name) {
      renderMissing('no-id');
      return;
    }

    // When given only a name, walk the index to pick the best slug.
    var resolveSlug;
    if (slug) {
      resolveSlug = Promise.resolve({ slug: slug, entry: null });
    } else {
      resolveSlug = fetchIndex().then(function (doc) {
        var entry = lookupByName(doc, name);
        if (!entry) return { slug: null, entry: null, name: name };
        return { slug: entry.slug, entry: entry };
      });
    }

    Promise.all([resolveSlug, fetchAbbr()]).then(function (res) {
      var resolved = res[0];
      var abbr = res[1];

      if (!resolved.slug) {
        renderMissing('unknown', name);
        return;
      }

      if (resolved.entry && resolved.entry.detail === false) {
        renderMissing('too-few', resolved.entry.name);
        return;
      }

      return fetchShard(resolved.slug).then(function (role) {
        if (!role) {
          renderMissing('unknown', name || slug);
          return;
        }
        renderHead(role);
        renderLedger(role);
        renderSparkline(role);
        renderPerformers(role);
        renderWorks(role);
        renderTheatres(role, abbr);
      });
    }).catch(function (err) {
      if (window.console && console.error) console.error('Role load failed', err);
      renderMissing('error');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
