/* London Stage, 1660-1800 — venue map
   Plain JS (no bundler). Loads four JSON files, renders Leaflet markers
   sized by event count (lifetime or decade-filtered) and styled by
   precision. A decade slider re-runs the size/visibility pass. */

(function () {
  'use strict';

  var LONDON_CENTER = [51.5176, -0.0875];
  var DEFAULT_ZOOM  = 13;

  var BRICK      = '#7a2e1f';
  var BRICK_DEEP = '#5e2217';

  var map;
  let layerControl = null;
  let rocqueLayer = null;
  let strypeLayer = null;
  let currentBaseLayer = null;
  let rocquePolygonsLayer = null;
  let rocqueWardsLayer = null;
  let rocqueParishesLayer = null;

  function yearOf(yyyymmdd) {
    if (!yyyymmdd) return null;
    var s = String(yyyymmdd);
    return s.length >= 4 ? s.slice(0, 4) : null;
  }

  // Area-proportional sizing: circle area ∝ performance count, so visible
  // weight corresponds to volume rather than to radius. Calibrated so
  // Drury Lane (18,570) lands near 28 px; smaller houses stay readable.
  var R_MIN = 3.5;
  var R_MAX = 28;
  var R_K   = (R_MAX - R_MIN) / Math.sqrt(18570);  // ≈ 0.18

  function radiusFor(eventCount) {
    var ec = Number(eventCount) || 0;
    if (ec <= 0) return R_MIN;
    return Math.min(R_MAX, R_MIN + Math.sqrt(ec) * R_K);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function popupHtml(code, canonical, eventCount, firstYear, lastYear, decadeLabel, decadeCount) {
    var name = canonical || code;
    var range = '';
    if (firstYear && lastYear && firstYear !== lastYear) range = firstYear + '\u2013' + lastYear;
    else if (firstYear) range = firstYear;

    var lifetime = eventCount
      ? eventCount.toLocaleString() + ' performance' + (eventCount === 1 ? '' : 's') + (range ? ' &middot; ' + range : '')
      : 'No recorded performances';

    var decadeLine = '';
    if (decadeLabel) {
      var n = decadeCount || 0;
      decadeLine =
        '<p class="popup-decade metadata-label">' +
          escapeHtml(decadeLabel) + ': ' +
          (n ? n.toLocaleString() + ' performance' + (n === 1 ? '' : 's') : 'silent') +
        '</p>';
    }

    var href = 'venue.html?code=' + encodeURIComponent(code);
    return (
      '<div class="popup-body">' +
        '<p class="popup-name"><a class="popup-link" href="' + escapeHtml(href) + '">' + escapeHtml(name) + '</a><br><small>Theatre code: ' + escapeHtml(code.toUpperCase()) + '</small></p>' +
        '<p class="popup-meta">' + lifetime + '</p>' +
        decadeLine +
        '<p class="popup-cta metadata-label"><a href="' + escapeHtml(href) + '">View playhouse &rsaquo;</a></p>' +
      '</div>'
    );
  }

  function styleFor(precision) {
    if (precision === 'exact') {
      return { color: BRICK_DEEP, weight: 1, fillColor: BRICK, fillOpacity: 0.82, opacity: 0.95, dashArray: null };
    }
    return { color: BRICK, weight: 1.2, fillColor: BRICK, fillOpacity: 0.22, opacity: 0.85, dashArray: '3,3' };
  }

  function buildTheatreIndex(rows) {
    var idx = {};
    for (var i = 0; i < rows.length; i++) idx[rows[i].code] = rows[i];
    return idx;
  }

  function initMap() {
    map = L.map('map', {
      center: LONDON_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: 10,
      maxZoom: 18,
      zoomControl: true,
      scrollWheelZoom: true,
      worldCopyJump: false
    });
    
    // Initialize Leaflet.hash plugin for shareable URLs
    new L.Hash(map);
    // Add custom reset zoom button
    L.Control.ResetZoom = L.Control.extend({
        onAdd: function(map) {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
            container.innerHTML = '<a href="#" title="Reset zoom" role="button" aria-label="Reset zoom" style="width: 30px; height: 30px; line-height: 30px; display: flex; align-items: center; justify-content: center; font-size: 30px;">&#x21BA;</a>';
            container.onclick = function(e) {
                e.preventDefault();
                map.setView([51.5176, -0.0875], 13);
            };
            return container;
        }
    });
    L.control.resetZoom = function(opts) {
        return new L.Control.ResetZoom(opts);
    };
    L.control.resetZoom({ position: 'topleft' }).addTo(map);
    
    var tiles = { base: null, labels: null };

    function makeTiles(theme) {
      var variant = theme === 'dark' ? 'dark' : 'light';
      var base = L.tileLayer('https://{s}.basemaps.cartocdn.com/' + variant + '_all/{z}/{x}/{y}{r}.png', {
        attribution: 'Basemap &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
      });
      var labels = L.tileLayer('https://{s}.basemaps.cartocdn.com/' + variant + '_only_labels/{z}/{x}/{y}{r}.png', {
        attribution: '',
        subdomains: 'abcd',
        maxZoom: 19,
        pane: 'shadowPane'
      });
      // Update layer control if it exists
      if (layerControl) {
          map.removeControl(layerControl);
          currentBaseLayer = base;
          initLayerControl();
      }
      return { base: base, labels: labels };
    }

    function applyTheme(theme) {
      var next = makeTiles(theme);
      next.base.addTo(map);
//      next.labels.addTo(map);
      if (tiles.base)   map.removeLayer(tiles.base);
//      if (tiles.labels) map.removeLayer(tiles.labels);
      tiles = next;
    }

    applyTheme(document.documentElement.dataset.theme);

    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].attributeName === 'data-theme') {
          applyTheme(document.documentElement.dataset.theme);
          return;
        }
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Initialize layer control with historical map overlay
    currentBaseLayer = tiles.base;
    initLayerControl();

    return map;
  }

  // Load Rocque 1746 polygons layer
  async function loadRocquePolygons() {
      if (rocquePolygonsLayer) {
          return rocquePolygonsLayer;
      }

      try {
          console.log('Loading Rocque 1746 polygons...');
          const response = await fetch('map/rocque1746_polygons.min.geojson');

          if (!response.ok) {
              throw new Error(`Failed to load polygons: ${response.status}`);
          }

          const geojsonData = await response.json();
          console.log(`Loaded ${geojsonData.features.length} polygon features`);

          // Create GeoJSON layer with styling
          rocquePolygonsLayer = L.geoJSON(geojsonData, {
              style: function(feature) {
                  return {
                      color: '#ff6b6b',        // Red outline
                      weight: 1,               // Thin border
                      opacity: 0.6,            // Semi-transparent border
                      fillColor: '#4ecdc4',    // Teal fill
                      fillOpacity: 0.1         // Very transparent fill
                  };
              },
              onEachFeature: function(feature, layer) {
                  // Create popup content
                  const props = feature.properties;
                  let popupContent = '';

                  if (props.geo_description) {
                      popupContent += `<strong>${escapeHtml(props.geo_description)}</strong><br>`;
                  }
                  if (props.placename && props.placename !== props.geo_description) {
                      popupContent += `Place: ${escapeHtml(props.placename)}<br>`;
                  }
                  if (props.parish) {
                      popupContent += `Parish: ${escapeHtml(props.parish)}<br>`;
                  }
                  if (props.ward) {
                      popupContent += `Ward: ${escapeHtml(props.ward)}<br>`;
                  }

                  if (popupContent) {
                      layer.bindPopup(popupContent);
                  }

                  // Add tooltip for quick reference
                  if (props.geo_description || props.placename) {
                      const tooltipText = props.geo_description || props.placename;
                      layer.bindTooltip(tooltipText, {
                          permanent: false,
                          direction: 'center',
                          className: 'polygon-tooltip'
                      });
                  }
              }
          });

          console.log('Rocque polygons layer created successfully');
          return rocquePolygonsLayer;

      } catch (error) {
          console.error('Error loading Rocque polygons:', error);
          return null;
      }
  }

  // Load Rocque 1746 wards layer
  async function loadRocqueWards() {
      if (rocqueWardsLayer) return rocqueWardsLayer;

      try {
          console.log('Loading Rocque 1746 wards...');
          const response = await fetch('map/rocque1746_wards.geojson');
          if (!response.ok) throw new Error(`Failed to load wards: ${response.status}`);
          const geojsonData = await response.json();
          console.log(`Loaded ${geojsonData.features.length} ward features`);

          rocqueWardsLayer = L.geoJSON(geojsonData, {
              style: function(feature) {
                  return {
                      color: '#2563eb',
                      weight: 2,
                      opacity: 0.7,
                      fillColor: '#3b82f6',
                      fillOpacity: 0.08,
                      dashArray: '5, 5'
                  };
              },
              onEachFeature: function(feature, layer) {
                  const props = feature.properties;
                  const name = props.ward || props.geo_description;
                  layer.bindPopup(`<strong>Ward: ${escapeHtml(name)}</strong>`);
                  layer.bindTooltip(escapeHtml(name), {
                      permanent: false,
                      direction: 'center',
                      className: 'ward-tooltip'
                  });
              }
          });

          return rocqueWardsLayer;
      } catch (error) {
          console.error('Error loading Rocque wards:', error);
          return null;
      }
  }

  // Load Rocque 1746 parishes layer
  async function loadRocqueParishes() {
      if (rocqueParishesLayer) return rocqueParishesLayer;

      try {
          console.log('Loading Rocque 1746 parishes...');
          const response = await fetch('map/rocque1746_parishes.geojson');
          if (!response.ok) throw new Error(`Failed to load parishes: ${response.status}`);
          const geojsonData = await response.json();
          console.log(`Loaded ${geojsonData.features.length} parish features`);

          rocqueParishesLayer = L.geoJSON(geojsonData, {
              style: function(feature) {
                  return {
                      color: '#9333ea',
                      weight: 2,
                      opacity: 0.7,
                      fillColor: '#a855f7',
                      fillOpacity: 0.08
                  };
              },
              onEachFeature: function(feature, layer) {
                  const props = feature.properties;
                  const name = props.parish || props.geo_description;
                  let popupContent = `<strong>Parish: ${escapeHtml(name)}</strong>`;

                  if (props.area_classification) {
                      popupContent += `<br><em>${escapeHtml(props.area_classification)}</em>`;
                  }
                  if (props.pop_1740s) {
                      popupContent += `<br>Population (1740s): ${Number(props.pop_1740s).toLocaleString()}`;
                  }
                  if (props.pop_1801) {
                      popupContent += `<br>Population (1801): ${Number(props.pop_1801).toLocaleString()}`;
                  }
                  if (props.area_sq_meters) {
                      popupContent += `<br>Area: ${(Number(props.area_sq_meters) / 10000).toFixed(1)} hectares`;
                  }

                  layer.bindPopup(popupContent);
                  layer.bindTooltip(escapeHtml(name), {
                      permanent: false,
                      direction: 'center',
                      className: 'parish-tooltip'
                  });
              }
          });

          return rocqueParishesLayer;
      } catch (error) {
          console.error('Error loading Rocque parishes:', error);
          return null;
      }
  }

  // Initialize layer control with base and overlay layers
  async function initLayerControl() {
      // Create Rocque 1746 historical map layer (TMS format)
      if (!rocqueLayer) {
          rocqueLayer = L.tileLayer('map/rocque1746/{z}/{x}/{y}.png', {
              tms: true,  // TMS tiles have origin at bottom-left
              opacity: 0.7,
              attribution: 'Rocque (1746) - An Exact Survey of the Cities of London and Westminster',
              minZoom: 11,
              maxZoom: 17,
              bounds: [[51.48582648866646, -0.16410884197518], [51.55296427043378, -0.02463064539588]]
          }).addTo(map);  // Add to map by default
      }
      if (!strypeLayer) {
          strypeLayer = L.tileLayer('map/strype1720/{z}/{x}/{y}.png', {
              tms: true,  // TMS tiles have origin at bottom-left
              opacity: 0.7,
              attribution: 'Strype (1720) - A New Plan of the City of London',
              minZoom: 11,
              maxZoom: 15,
              bounds: [[51.48582648866646, -0.16410884197518], [51.55296427043378, -0.02463064539588]]
          });
      }

      // Load all polygon layers in parallel
      const [wardsResult, parishesResult, polygonsResult] = await Promise.all([
          rocqueWardsLayer ? rocqueWardsLayer : loadRocqueWards(),
          rocqueParishesLayer ? rocqueParishesLayer : loadRocqueParishes(),
          rocquePolygonsLayer ? rocquePolygonsLayer : loadRocquePolygons()
      ]);

      if (wardsResult) rocqueWardsLayer = wardsResult;
      if (parishesResult) rocqueParishesLayer = parishesResult;
      if (polygonsResult) rocquePolygonsLayer = polygonsResult;

      // Base layers (only one can be active at a time)
      const baseLayers = {
          "Modern Map": currentBaseLayer
      };

      // Overlay layers in display order: Map > Wards > Parishes > Places
      const overlayLayers = {
          "Strype (1720) Map": strypeLayer
      };
      if (rocqueLayer) {
          overlayLayers["Rocque (1746) Map"] = rocqueLayer;
      }
      if (rocqueWardsLayer) {
          overlayLayers["Rocque (1746) Wards"] = rocqueWardsLayer;
      }
      if (rocqueParishesLayer) {
          overlayLayers["Rocque (1746) Parishes"] = rocqueParishesLayer;
      }
      if (rocquePolygonsLayer) {
          overlayLayers["Rocque (1746) Places"] = rocquePolygonsLayer;
      }

      // Add layer control
      layerControl = L.control.layers(baseLayers, overlayLayers, {
          position: 'topright',
          collapsed: true
      }).addTo(map);
  }

  function build(map, locations, abbreviations, theatreIndex, timeline) {
    // Per-theatre marker records, so slider updates can mutate them in place.
    var records = [];

    Object.keys(locations).forEach(function (code) {
      var loc = locations[code];
      if (!loc || loc.lat == null || loc.lng == null) return;

      var entry     = abbreviations[code];
      var canonical = entry && entry.canonical ? entry.canonical : null;

      var theatre    = theatreIndex[code];
      var eventCount = theatre ? theatre.eventCount : 0;
      var firstYear  = theatre ? yearOf(theatre.firstDate) : null;
      var lastYear   = theatre ? yearOf(theatre.lastDate)  : null;

      var byDecade = (timeline[code] && timeline[code].byDecade) || {};

      var style = styleFor(loc.precision);
      style.radius = radiusFor(eventCount);

      var marker = L.circleMarker([loc.lat, loc.lng], style);
      marker.bindPopup(popupHtml(code, canonical, eventCount, firstYear, lastYear, null, null), {
        closeButton: true,
        autoPanPadding: [30, 30],
        autoPan: false
      });
      // Hover to peek, click to pin. On touch, hover events don't fire so
      // click still toggles the popup open and closed. The grace delay
      // below keeps the popup alive long enough for the cursor to cross
      // into the popup body and hit the "View playhouse" link.
      marker.off('click', marker._openPopup, marker);

      var closeTimer = null;
      function scheduleClose() {
        if (marker._pinned) return;
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(function () { marker.closePopup(); }, 180);
      }
      function cancelClose() {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      }

      marker.on('mouseover', function () {
        cancelClose();
        if (!marker.isPopupOpen()) marker.openPopup();
      });
      marker.on('mouseout', scheduleClose);
      marker.on('click', function () {
        if (marker._pinned) {
          marker._pinned = false;
          marker.closePopup();
        } else {
          marker._pinned = true;
          marker.openPopup();
        }
      });
      marker.on('popupopen', function (e) {
        var el = e.popup && e.popup.getElement();
        if (!el) return;
        L.DomEvent.on(el, 'mouseenter', cancelClose);
        L.DomEvent.on(el, 'mouseleave', scheduleClose);
      });
      marker.on('popupclose', function () {
        marker._pinned = false;
        cancelClose();
      });
      marker.addTo(map);

      records.push({
        code: code,
        marker: marker,
        loc: loc,
        canonical: canonical,
        eventCount: eventCount,
        firstYear: firstYear,
        lastYear: lastYear,
        byDecade: byDecade
      });
    });

    // Bring exact markers to front once
    records.forEach(function (r) { if (r.loc.precision === 'exact') r.marker.bringToFront(); });

    return records;
  }

  // Re-apply size + visibility + popup given the current decade (null = all).
  function applyDecade(records, decade) {
    var visible = 0;
    var label = decade == null ? null : (decade + 's');

    records.forEach(function (r) {
      var count = decade == null ? r.eventCount : (r.byDecade[decade] || 0);

      if (decade != null && count === 0) {
        if (r.marker._map) r.marker.remove();
        return;
      }

      if (!r.marker._map) r.marker.addTo(r.marker._mapRef || window._lsMap);

      var style = styleFor(r.loc.precision);
      style.radius = radiusFor(count);
      r.marker.setStyle(style);

      r.marker.setPopupContent(
        popupHtml(r.code, r.canonical, r.eventCount, r.firstYear, r.lastYear, label, count)
      );
      visible++;
    });

    // Push exact markers forward again after style updates
    records.forEach(function (r) {
      if (r.loc.precision === 'exact' && r.marker._map) r.marker.bringToFront();
    });

    return visible;
  }

  function wireTimeline(records, map) {
    var slider   = document.getElementById('tl-slider');
    var allBtn   = document.getElementById('tl-all');
    var decadeEl = document.getElementById('tl-decade');
    var countEl  = document.getElementById('tl-count');
    if (!slider || !allBtn || !decadeEl || !countEl) return;

    slider.disabled = false;

    function setCount(n) {
      countEl.textContent = n.toLocaleString() + ' venue' + (n === 1 ? '' : 's');
    }
    function refresh(decade) {
      if (decade == null) {
        decadeEl.textContent = 'All decades';
        allBtn.classList.add('is-active');
        allBtn.setAttribute('aria-pressed', 'true');
      } else {
        decadeEl.textContent = decade + 's';
        allBtn.classList.remove('is-active');
        allBtn.setAttribute('aria-pressed', 'false');
      }
      setCount(applyDecade(records, decade));
    }

    // Initial paint — All mode
    refresh(null);

    slider.addEventListener('input', function () {
      var d = parseInt(slider.value, 10);
      if (!Number.isFinite(d)) return;
      refresh(d);
    });

    allBtn.addEventListener('click', function () {
      refresh(null);
    });

    // Keyboard support: arrow keys on slider already work natively;
    // pressing Esc returns to "All".
    slider.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); refresh(null); }
    });
  }

  function fail(msg, err) {
    console.error('[london-stage]', msg, err);
    var el = document.getElementById('map');
    if (el) {
      el.innerHTML = '<div style="padding:2rem;color:#3b2a1a;font-style:italic;">' +
        'Unable to load venue data: ' + msg + '.</div>';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (typeof L === 'undefined') { fail('Leaflet failed to load'); return; }

    var records = [];
    var map = initMap();
    window._lsMap = map;

    Promise.all([
      fetch('data/theatre-locations.json').then(function (r) { return r.json(); }),
      fetch('data/theatre-abbreviations.json').then(function (r) { return r.json(); }),
      fetch('data/theatres.json').then(function (r) { return r.json(); }),
      fetch('data/theatre-timeline.json').then(function (r) { return r.json(); })
    ]).then(function (results) {
      var locations     = results[0].locations || {};
      // Merge entries + compound + sentinels so hybrid codes like
      // "dlking's" and placeholders like "none" resolve to readable names.
      var abbreviations = Object.assign(
        {},
        results[1].sentinels || {},
        results[1].compound  || {},
        results[1].entries   || {}
      );
      var theatreIndex  = buildTheatreIndex(results[2] || []);
      var timeline      = results[3].theatres || {};

      records = build(map, locations, abbreviations, theatreIndex, timeline);
      // Stash map ref on records so applyDecade can re-add markers after removal
      records.forEach(function (r) { r.marker._mapRef = map; });

      wireTimeline(records, map);

      if (window && window.console) {
        console.log('[london-stage] records:', records.length, 'timeline entries:', Object.keys(timeline).length);
      }
    }).catch(function (err) {
      fail('fetch error', err);
    });

    map.on('overlayadd', function(a) {
      records.forEach(function (r) { r.marker.bringToFront(); });
    });
    map.on('overlayremove', function(a) {

    });

  });
})();
