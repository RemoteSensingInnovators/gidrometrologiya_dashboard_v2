let chartMonth = null;
let chartPollutant = null;
let chartWind = null;
let map = null;
let geoLayer = null;
let stationsLayer = null;
let dataStore = null;
let geojson = null;
let stationsGeojson = null;

function makeTooltip(labelFn) {
  return {
    enabled: false,
    external(context) {
      const { chart, tooltip } = context;
      let el = document.getElementById('chart-tooltip');
      if (!el) {
        el = document.createElement('div');
        el.id = 'chart-tooltip';
        document.body.appendChild(el);
      }

      if (tooltip.opacity === 0) {
        el.style.opacity = '0';
        return;
      }

      const item = tooltip.dataPoints?.[0];
      if (!item) return;

      const title = tooltip.title?.[0] || '';
      const value = labelFn(item);

      el.innerHTML = `
        <div class="ct-title">${title}</div>
        <div class="ct-value">${value}</div>
      `;

      const rect = chart.canvas.getBoundingClientRect();
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      let left = rect.left + scrollX + tooltip.caretX;
      let top  = rect.top  + scrollY + tooltip.caretY - 58;

      el.style.opacity = '1';
      el.style.left = left + 'px';
      el.style.top  = top  + 'px';
    },
  };
}

const GAS_NAMES = {
  SO2:   'Oltingugurt dioksid (SO₂)',
  NO2:   'Azot dioksid (NO₂)',
  NH3:   'Ammiak (NH₃)',
  HF:    'Vodorod ftorid (HF)',
  NO:    'Azot oksid (NO)',
  Fenol: 'Fenol (C₆H₅OH)',
  CO:    'Uglerod oksid (CO)',
  CL:    'Xlor (Cl₂)',
  Chang: 'Chang (PM)',
};

function gasLabel(code) {
  return GAS_NAMES[code] || code;
}

const POLLUTANT_HUES = {
  SO2: 205,
  NO2: 275,
  NH3: 135,
  HF: 320,
  NO: 28,
  Fenol: 355,
  CO: 45,
  CL: 165,
  Chang: 95,
};

function gasHue(code) {
  return POLLUTANT_HUES[code] ?? 210;
}

function formatNumber(value) {
  if (value === null || value === undefined || isNaN(value)) return '0';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function updateSummary() {
  const year = document.getElementById('yearSelect').value;
  const pollutant = document.getElementById('pollutantSelect').value;
  const measure = document.getElementById('measureSelect').value;

  document.getElementById('summaryYear').textContent = year;
  document.getElementById('summaryPollutant').textContent = pollutant;
  document.getElementById('summaryMeasure').textContent = measure;
}

function buildTable(year, measure) {
  const table = document.getElementById('dataTable');
  const months = dataStore.months;
  const pollutants = dataStore.pollutants;

  let html = '<thead><tr><th>Parametr / Oy</th>';
  for (const month of months) {
    html += `<th>${month}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const pollutant of pollutants) {
    html += `<tr><td><strong>${pollutant}</strong></td>`;
    for (const month of months) {
      const value = dataStore.years[year][month]?.[pollutant]?.[measure];
      html += `<td>${formatNumber(value)}</td>`;
    }
    html += '</tr>';
  }

  if (dataStore.wind && dataStore.wind.years && dataStore.wind.years[year]) {
    html += `<tr class="section-row"><td colspan="${months.length + 1}"><strong>Shamol tezligi (m/s) yo'nalishlarga ko'ra</strong></td></tr>`;
    const directions = dataStore.wind.directions || [];
    for (const direction of directions) {
      html += `<tr><td>${direction}</td>`;
      for (const month of months) {
        const value = dataStore.wind.years[year][month]?.[direction];
        html += `<td>${formatNumber(value)}</td>`;
      }
      html += '</tr>';
    }
  }

  html += '</tbody>';
  table.innerHTML = html;
}

function buildWindChart(year) {
  const directions = dataStore.wind?.directions || [];
  if (!directions.length || !dataStore.wind.years[year]) {
    if (chartWind) {
      chartWind.destroy();
      chartWind = null;
    }
    return;
  }

  const directionValues = directions.map((direction) => {
    const values = dataStore.months.map((month) => dataStore.wind.years[year][month]?.[direction]);
    const valid = values.filter((v) => v !== null && v !== undefined);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  });

  const windCtx = document.getElementById('windChart').getContext('2d');
  if (chartWind) chartWind.destroy();

  chartWind = new Chart(windCtx, {
    type: 'radar',
    data: {
      labels: directions,
      datasets: [
        {
          label: `${year} yil shamol yo'nalishlari (o'rtacha)`,
          data: directionValues,
          backgroundColor: 'rgba(66, 194, 213, 0.25)',
          borderColor: '#4dd0e1',
          borderWidth: 2,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#4dd0e1',
          pointRadius: 4,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: true },
        tooltip: makeTooltip((item) => `${formatNumber(item.parsed.r)} m/s`),
      },
      scales: {
        r: {
          beginAtZero: true,
          grid: { color: '#edf2f8' },
          angleLines: { color: '#edf2f8' },
          pointLabels: { color: '#f0f6ff' },
          ticks: {
            backdropColor: 'rgba(16, 31, 55, 0.8)',
            color: '#cbd8ff',
          },
        },
      },
    },
  });
}

function buildCharts(year, pollutant, measure) {
  const monthCtx = document.getElementById('monthChart').getContext('2d');
  const pollutantCtx = document.getElementById('pollutantChart').getContext('2d');

  if (chartMonth) chartMonth.destroy();
  if (chartPollutant) chartPollutant.destroy();

  const months = dataStore.months;
  const values = months.map((month) => dataStore.years[year][month]?.[pollutant]?.[measure]);

  chartMonth = new Chart(monthCtx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [
        {
          label: `${gasLabel(pollutant)} — ${measure === 'Mean' ? 'O\'rtacha' : 'Maksimal'}`,
          data: values,
          borderColor: '#4dd0e1',
          backgroundColor: 'rgba(77, 208, 225, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#4dd0e1',
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#b5c4e6', font: { size: 12 } } },
        tooltip: makeTooltip((item) => formatNumber(item.parsed.y)),
      },
      scales: {
        y: { ticks: { color: '#9eb4db' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        x: { ticks: { color: '#9eb4db' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });

  const pollutants = dataStore.pollutants;
  const pollutantValues = pollutants.map((p) => {
    const monthValues = dataStore.months.map((m) => dataStore.years[year][m]?.[p]?.[measure]);
    const valid = monthValues.filter((v) => v !== null && v !== undefined);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  });

  chartPollutant = new Chart(pollutantCtx, {
    type: 'bar',
    data: {
      labels: pollutants.map(gasLabel),
      datasets: [
        {
          label: measure === 'Mean' ? 'O\'rtacha' : 'Maksimal',
          data: pollutantValues,
          backgroundColor: 'rgba(87, 167, 255, 0.7)',
          borderColor: '#57a7ff',
          borderWidth: 1,
          borderRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#b5c4e6', font: { size: 12 } } },
        tooltip: makeTooltip((item) => formatNumber(item.parsed.y)),
      },
      scales: {
        y: { ticks: { color: '#9eb4db' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        x: {
          ticks: { color: '#9eb4db', autoSkip: false, maxRotation: 45, minRotation: 30 },
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
      },
    },
  });

  buildWindChart(year);
}

function pollutantMaxAcrossAll(pollutant, measure) {
  let max = 0;
  for (const year of Object.keys(dataStore.years)) {
    for (const month of dataStore.months) {
      const value = dataStore.years[year][month]?.[pollutant]?.[measure];
      if (typeof value === 'number' && value > max) max = value;
    }
  }
  return max;
}

function pollutantIntensity(year, pollutant, measure) {
  const max = pollutantMaxAcrossAll(pollutant, measure);
  if (!max) return 0;
  const values = dataStore.months
    .map((month) => dataStore.years[year][month]?.[pollutant]?.[measure])
    .filter((v) => typeof v === 'number');
  if (!values.length) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.min(1, avg / max);
}

function colorForPollutant(pollutant, t, measure) {
  const hue = gasHue(pollutant);
  // Saturation stays high even at low intensity, so the gas's hue is always
  // unmistakable at a glance instead of fading into a washed-out pastel.
  const saturation = 68 + t * 27;
  // Same hue per gas either way — "O'rtacha" always reads lighter, "Maksimal" always darker,
  // with intensity adding nuance within each band.
  const lightness = measure === 'Max' ? 46 - t * 18 : 68 - t * 14;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function updateMapColor(year, pollutant, measure) {
  if (!geoLayer) return;
  const intensity = pollutantIntensity(year, pollutant, measure);

  // The boundary color/badge/legend are the important, user-facing part of this
  // function — set those first and unconditionally, so a problem in the
  // decorative heatmap layer below can never block them.
  const hue = gasHue(pollutant);
  const fill = colorForPollutant(pollutant, intensity, measure);
  const borderLightness = measure === 'Max' ? 20 - intensity * 6 : 32 - intensity * 8;
  const border = `hsl(${hue}, 75%, ${Math.max(12, borderLightness)}%)`;
  geoLayer.setStyle({
    fillColor: fill,
    color: border,
    fillOpacity: 0.42 + intensity * 0.33,
  });

  const measureLabel = measure === 'Max' ? "Maksimal" : "O'rtacha";
  const legendLabel = document.getElementById('gasLegendLabel');
  const legendBar = document.getElementById('gasLegendBar');
  if (legendLabel) {
    legendLabel.textContent = `${gasLabel(pollutant)} — ${measureLabel}`;
  }

  const gasBadge = document.getElementById('mapGasBadge');
  if (gasBadge) {
    gasBadge.textContent = `${gasLabel(pollutant)} — ${measureLabel}`;
    gasBadge.style.background = fill;
    gasBadge.style.borderColor = border;
    gasBadge.style.color = (measure === 'Max') ? '#fff' : '#0f172a';
  }
  if (legendBar) {
    const lowColor = colorForPollutant(pollutant, 0, measure);
    const highColor = colorForPollutant(pollutant, 1, measure);
    legendBar.style.background = `linear-gradient(90deg, ${lowColor}, ${highColor})`;
  }

  try {
    updateWindHeatmap(intensity);
  } catch (err) {
    console.error('Wind heatmap update failed (non-critical):', err);
  }
}

function updateDashboard() {
  const year = document.getElementById('yearSelect').value;
  const pollutant = document.getElementById('pollutantSelect').value;
  const measure = document.getElementById('measureSelect').value;

  // Each step is isolated so a failure in one (e.g. a chart) can never stop
  // the others (e.g. the map color) from updating.
  try { updateMapColor(year, pollutant, measure); } catch (err) { console.error('updateMapColor failed:', err); }
  try { buildTable(year, measure); } catch (err) { console.error('buildTable failed:', err); }
  try { buildCharts(year, pollutant, measure); } catch (err) { console.error('buildCharts failed:', err); }
  try { buildWindChart(year); } catch (err) { console.error('buildWindChart failed:', err); }
  try { updateWindAnimation(year, pollutant); } catch (err) { console.error('updateWindAnimation failed:', err); }
}

function initSelectors() {
  const yearSelect = document.getElementById('yearSelect');
  const pollutantSelect = document.getElementById('pollutantSelect');
  const measureSelect = document.getElementById('measureSelect');

  dataStore.years && Object.keys(dataStore.years).forEach((year) => {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = year;
    yearSelect.appendChild(option);
  });

  dataStore.pollutants.forEach((pollutant) => {
    const option = document.createElement('option');
    option.value = pollutant;
    option.textContent = gasLabel(pollutant);
    pollutantSelect.appendChild(option);
  });

  yearSelect.value = Object.keys(dataStore.years).slice(-1)[0];
  pollutantSelect.value = dataStore.pollutants[0];

  yearSelect.addEventListener('change', updateDashboard);
  pollutantSelect.addEventListener('change', updateDashboard);
  measureSelect.addEventListener('change', updateDashboard);
}

function initMap() {
  const mapContainer = document.getElementById('map');
  // scrollWheelZoom off by default so a normal scroll over the map scrolls the
  // page like everywhere else; Ctrl+scroll (handled below) zooms the map instead.
  map = L.map(mapContainer, { zoomControl: true, scrollWheelZoom: false }).setView([39.6, 66.9], 11);

  mapContainer.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    map.setZoom(map.getZoom() + (e.deltaY < 0 ? 1 : -1), { animate: true });
  }, { passive: false });

  const gasBadge = document.createElement('div');
  gasBadge.id = 'mapGasBadge';
  gasBadge.className = 'map-gas-badge';
  mapContainer.appendChild(gasBadge);

  const scrollHint = document.createElement('div');
  scrollHint.className = 'map-scroll-hint';
  scrollHint.textContent = 'Ctrl + g‘ildirak: kattalashtirish';
  mapContainer.appendChild(scrollHint);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  geoLayer = L.geoJSON(geojson, {
    style: {
      color: '#285d9e',
      weight: 2,
      fillColor: '#5189d7',
      fillOpacity: 0.25,
    },
  }).addTo(map);

  stationsLayer = L.geoJSON(stationsGeojson, {
    pointToLayer: function (feature, latlng) {
      const color = feature.properties.color || '#e74c3c';
      return L.circleMarker(latlng, {
        radius: 10,
        fillColor: color,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9,
      });
    },
    onEachFeature: function (feature, layer) {
      const name = feature.properties.name;
      layer.bindPopup(
        `<div style="font-weight:bold;font-size:13px;">${name}</div>`,
        { closeButton: true }
      );
      layer.bindTooltip(name, { permanent: true, direction: 'top', offset: [0, -12], className: 'station-label' });
    },
  }).addTo(map);

  const overlays = {
    'Stansiyalar': stationsLayer,
    'Samarqand': geoLayer,
  };
  L.control.layers(null, overlays, { collapsed: false }).addTo(map);

  map.fitBounds(geoLayer.getBounds(), { padding: [20, 20] });

  initWindHeatmap(mapContainer);
  initWindAnimation(mapContainer);
  initWindCompass(mapContainer);
}

// ---------- Windy.com-style procedural gradient field ----------

let heatmapCanvas = null;
let heatmapCtx = null;
let heatmapSeed = Math.floor(Math.random() * 10000);
let heatmapBaseIntensity = 0.4;
let heatmapTimeOffset = 0;
let heatmapTimer = null;

function noiseHash(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 982451653) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 100000) / 100000;
}

function smoothNoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const xf = x - x0, yf = y - y0;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const n00 = noiseHash(x0, y0, seed), n10 = noiseHash(x0 + 1, y0, seed);
  const n01 = noiseHash(x0, y0 + 1, seed), n11 = noiseHash(x0 + 1, y0 + 1, seed);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}

function fractalNoise(x, y, seed) {
  let total = 0, amp = 0.6, freq = 1, max = 0;
  for (let o = 0; o < 4; o++) {
    total += smoothNoise(x * freq, y * freq, seed + o * 17) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return total / max;
}

const HEAT_STOPS = [
  [0, [46, 204, 113]],
  [0.35, [241, 196, 15]],
  [0.62, [230, 126, 34]],
  [1, [231, 76, 60]],
];

function heatColor(t) {
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [t0, c0] = HEAT_STOPS[i - 1];
    const [t1, c1] = HEAT_STOPS[i];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return c0.map((v, idx) => Math.round(v + (c1[idx] - v) * f));
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1][1];
}

function resizeHeatmapCanvas(mapContainer) {
  if (!heatmapCanvas) return;
  const w = mapContainer.clientWidth, h = mapContainer.clientHeight;
  if (!w || !h) return;
  if (heatmapCanvas.width === w && heatmapCanvas.height === h) return;
  heatmapCanvas.width = w;
  heatmapCanvas.height = h;
}

function renderWindHeatmap() {
  if (!heatmapCtx || !heatmapCanvas.width || !heatmapCanvas.height) return;
  const w = heatmapCanvas.width, h = heatmapCanvas.height;
  const cell = 22;
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;
  const scale = 4.2;

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nx = (c / cols) * scale + heatmapTimeOffset;
      const ny = (r / rows) * scale;
      let n = fractalNoise(nx, ny, heatmapSeed);
      n = Math.min(1, Math.max(0, n * 0.65 + heatmapBaseIntensity * 0.55));
      const [cr, cg, cb] = heatColor(n);
      octx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
      octx.fillRect(c * cell, r * cell, cell + 1, cell + 1);
    }
  }

  heatmapCtx.clearRect(0, 0, w, h);
  heatmapCtx.save();
  heatmapCtx.filter = 'blur(26px)';
  heatmapCtx.globalAlpha = 0.5;
  heatmapCtx.drawImage(off, 0, 0);
  heatmapCtx.restore();
}

function initWindHeatmap(mapContainer) {
  heatmapCanvas = document.createElement('canvas');
  heatmapCanvas.className = 'wind-heatmap';
  mapContainer.appendChild(heatmapCanvas);
  heatmapCtx = heatmapCanvas.getContext('2d');
  resizeHeatmapCanvas(mapContainer);
  renderWindHeatmap();

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      resizeHeatmapCanvas(mapContainer);
      renderWindHeatmap();
    }).observe(mapContainer);
  }

  heatmapTimer = setInterval(() => {
    heatmapTimeOffset += 0.045;
    renderWindHeatmap();
  }, 3500);
}

function updateWindHeatmap(intensity) {
  heatmapBaseIntensity = intensity;
  renderWindHeatmap();
}

const WIND_DIRECTION_ANGLES = {
  Shimol: 0,
  'Shimoliy sharq': 45,
  Sharq: 90,
  'Janubiy sharq': 135,
  Janub: 180,
  'Janubiy G‘arb': 225,
  'G‘arb': 270,
  'Shimoliy G‘arb': 315,
};

let windCanvas = null;
let windCtx = null;
let windParticles = [];
let windVector = { dx: 0, dy: -1, speed: 0 };

function computeWindVector(year) {
  const wind = dataStore.wind;
  if (!wind || !wind.years || !wind.years[year]) return { dx: 0, dy: -1, speed: 0 };

  let vx = 0, vy = 0, totalSpeed = 0, count = 0;
  for (const [direction, angle] of Object.entries(WIND_DIRECTION_ANGLES)) {
    const values = dataStore.months
      .map((month) => wind.years[year][month]?.[direction])
      .filter((v) => typeof v === 'number');
    if (!values.length) continue;
    const avgSpeed = values.reduce((a, b) => a + b, 0) / values.length;
    const rad = (angle * Math.PI) / 180;
    vx += Math.sin(rad) * avgSpeed;
    vy += -Math.cos(rad) * avgSpeed;
    totalSpeed += avgSpeed;
    count++;
  }

  const avgSpeed = count ? totalSpeed / count : 0;
  const mag = Math.sqrt(vx * vx + vy * vy);
  if (mag < 1e-6) return { dx: 0, dy: -1, speed: avgSpeed };
  return { dx: vx / mag, dy: vy / mag, speed: avgSpeed };
}

const COMPASS_DIRECTIONS = [
  { key: 'Shimol', label: 'Sh', angle: 0 },
  { key: 'Shimoliy sharq', label: 'ShSh', angle: 45 },
  { key: 'Sharq', label: 'Sharq', angle: 90 },
  { key: 'Janubiy sharq', label: 'JSh', angle: 135 },
  { key: 'Janub', label: 'J', angle: 180 },
  { key: 'Janubiy G‘arb', label: 'JG‘', angle: 225 },
  { key: 'G‘arb', label: 'G‘', angle: 270 },
  { key: 'Shimoliy G‘arb', label: 'ShG‘', angle: 315 },
];

let compassCanvas = null;
let compassCtx = null;
let compassCurrent = new Array(COMPASS_DIRECTIONS.length).fill(0);
let compassTarget = new Array(COMPASS_DIRECTIONS.length).fill(0);
let compassDominant = { label: '—', speed: 0 };

function updateCompassTargets(year) {
  const wind = dataStore.wind;
  if (!wind || !wind.years || !wind.years[year]) {
    compassTarget = new Array(COMPASS_DIRECTIONS.length).fill(0);
    return;
  }
  const speeds = COMPASS_DIRECTIONS.map((d) => {
    const values = dataStore.months
      .map((month) => wind.years[year][month]?.[d.key])
      .filter((v) => typeof v === 'number');
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  });
  const max = Math.max(1, ...speeds);
  compassTarget = speeds.map((v) => v / max);

  let bestIdx = 0;
  for (let i = 1; i < speeds.length; i++) {
    if (speeds[i] > speeds[bestIdx]) bestIdx = i;
  }
  compassDominant = { label: COMPASS_DIRECTIONS[bestIdx].label, speed: speeds[bestIdx] };
}

function drawCompass(now) {
  const w = compassCanvas.width;
  const h = compassCanvas.height;
  const cx = w / 2, cy = h / 2;
  const maxR = Math.min(w, h) / 2 - 26;
  const pulse = 0.82 + 0.18 * Math.sin(now / 480);

  compassCtx.clearRect(0, 0, w, h);

  compassCtx.beginPath();
  compassCtx.arc(cx, cy, maxR + 16, 0, Math.PI * 2);
  compassCtx.fillStyle = 'rgba(8, 16, 40, 0.7)';
  compassCtx.fill();
  compassCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  compassCtx.lineWidth = 1;
  compassCtx.stroke();

  for (let r = 1; r <= 3; r++) {
    compassCtx.beginPath();
    compassCtx.arc(cx, cy, (maxR * r) / 3, 0, Math.PI * 2);
    compassCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    compassCtx.stroke();
  }

  COMPASS_DIRECTIONS.forEach((d, i) => {
    const len = compassCurrent[i] * maxR;
    const rad = ((d.angle - 90) * Math.PI) / 180;
    const x = cx + Math.cos(rad) * len;
    const y = cy + Math.sin(rad) * len;

    const grad = compassCtx.createLinearGradient(cx, cy, x, y);
    grad.addColorStop(0, 'rgba(86, 226, 255, 0.12)');
    grad.addColorStop(1, `hsla(${windHue}, 95%, 68%, ${0.92 * pulse})`);

    compassCtx.shadowColor = `hsla(${windHue}, 100%, 65%, 0.85)`;
    compassCtx.shadowBlur = 8;
    compassCtx.strokeStyle = grad;
    compassCtx.lineWidth = 6;
    compassCtx.lineCap = 'round';
    compassCtx.beginPath();
    compassCtx.moveTo(cx, cy);
    compassCtx.lineTo(x, y);
    compassCtx.stroke();
    compassCtx.shadowBlur = 0;

    const lx = cx + Math.cos(rad) * (maxR + 14);
    const ly = cy + Math.sin(rad) * (maxR + 14);
    compassCtx.fillStyle = 'rgba(216, 228, 255, 0.9)';
    compassCtx.font = '600 11px Inter, sans-serif';
    compassCtx.textAlign = 'center';
    compassCtx.textBaseline = 'middle';
    compassCtx.fillText(d.label, lx, ly);
  });

  compassCtx.beginPath();
  compassCtx.arc(cx, cy, 4.5, 0, Math.PI * 2);
  compassCtx.fillStyle = '#ffffff';
  compassCtx.fill();

  compassCtx.fillStyle = 'rgba(238, 243, 255, 0.95)';
  compassCtx.font = '700 12px Inter, sans-serif';
  compassCtx.textAlign = 'center';
  compassCtx.fillText(compassDominant.label, cx, cy + maxR + 34);
  compassCtx.fillStyle = 'rgba(158, 180, 219, 0.85)';
  compassCtx.font = '10px Inter, sans-serif';
  compassCtx.fillText(`${formatNumber(compassDominant.speed)} m/s`, cx, cy + maxR + 48);
}

function stepCompass(now) {
  if (compassCtx) {
    for (let i = 0; i < compassCurrent.length; i++) {
      compassCurrent[i] += (compassTarget[i] - compassCurrent[i]) * 0.07;
    }
    drawCompass(now);
  }
  requestAnimationFrame(stepCompass);
}

function initWindCompass(mapContainer) {
  compassCanvas = document.createElement('canvas');
  compassCanvas.className = 'wind-compass';
  compassCanvas.width = 168;
  compassCanvas.height = 168;
  mapContainer.appendChild(compassCanvas);
  compassCtx = compassCanvas.getContext('2d');
  requestAnimationFrame(stepCompass);
}

function spawnWindParticle(w, h) {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    life: Math.random() * 80,
    size: 1.1 + Math.random() * 2.4,
  };
}

function resizeWindCanvas(mapContainer) {
  if (!windCanvas) return;
  const w = mapContainer.clientWidth || (map ? map.getSize().x : 0);
  const h = mapContainer.clientHeight || (map ? map.getSize().y : 0);
  if (!w || !h) return;
  if (windCanvas.width === w && windCanvas.height === h) return;
  windCanvas.width = w;
  windCanvas.height = h;
  if (!windParticles.length) {
    windParticles = Array.from({ length: 85 }, () => spawnWindParticle(w, h));
  }
}

function initWindAnimation(mapContainer) {
  windCanvas = document.createElement('canvas');
  windCanvas.className = 'wind-canvas';
  mapContainer.appendChild(windCanvas);
  windCtx = windCanvas.getContext('2d');
  resizeWindCanvas(mapContainer);

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => resizeWindCanvas(mapContainer)).observe(mapContainer);
  } else {
    map.on('resize', () => resizeWindCanvas(mapContainer));
    window.addEventListener('resize', () => resizeWindCanvas(mapContainer));
  }

  requestAnimationFrame(stepWindAnimation);
}

let windHue = 205;

function updateWindAnimation(year, pollutant) {
  windVector = computeWindVector(year);
  windHue = gasHue(pollutant);
  updateCompassTargets(year);
}

function stepWindAnimation() {
  if (windCtx && windCanvas.width && windCanvas.height) {
    const w = windCanvas.width;
    const h = windCanvas.height;
    const pxSpeed = Math.min(5, 1 + windVector.speed * 0.22);
    const vx = windVector.dx * pxSpeed;
    const vy = windVector.dy * pxSpeed;

    windCtx.globalCompositeOperation = 'destination-in';
    windCtx.fillStyle = 'rgba(0, 0, 0, 0.93)';
    windCtx.fillRect(0, 0, w, h);
    windCtx.globalCompositeOperation = 'source-over';

    windCtx.lineCap = 'round';
    for (const p of windParticles) {
      const x0 = p.x, y0 = p.y;
      p.x += vx * (p.size / 2);
      p.y += vy * (p.size / 2);
      p.life -= 1;
      if (p.life <= 0 || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
        Object.assign(p, spawnWindParticle(w, h));
        continue;
      }

      windCtx.shadowColor = `hsla(${windHue}, 100%, 65%, 0.9)`;
      windCtx.shadowBlur = 6 + p.size * 2;
      windCtx.strokeStyle = `hsla(${windHue}, 95%, 70%, 0.85)`;
      windCtx.lineWidth = p.size;
      windCtx.beginPath();
      windCtx.moveTo(x0, y0);
      windCtx.lineTo(p.x, p.y);
      windCtx.stroke();
    }
    windCtx.shadowBlur = 0;
  }
  requestAnimationFrame(stepWindAnimation);
}

function loadLeafletScript() {
  if (typeof L !== 'undefined') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Leaflet skripti yuklanmadi. Iltimos, internet aloqangizni tekshiring.'));
    document.head.appendChild(script);
  });
}

async function loadData() {
  try {
    await loadLeafletScript();

    const [dataResp, geoResp, stationsResp] = await Promise.all([
      fetch('data/samarqand_data.json'),
      fetch('samarqand.json'),
      fetch('data/stations.geojson'),
    ]);

    if (!dataResp.ok || !geoResp.ok || !stationsResp.ok) {
      throw new Error('Data fayllarini yuklashda hatolik yuz berdi. Iltimos, dashboardni server orqali oching.');
    }

    dataStore = await dataResp.json();
    geojson = await geoResp.json();
    stationsGeojson = await stationsResp.json();

    initSelectors();
    initMap();
    updateDashboard();
  } catch (err) {
    document.body.innerHTML = `<div class="error"><h2>Xatolik</h2><p>${err.message}</p><p>Oddiy serverni ishga tushiring: <code>python -m http.server 8000</code></p></div>`;
  }
}

window.addEventListener('DOMContentLoaded', loadData);
