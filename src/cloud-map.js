// World map of cloud regions as SVG strings, shared by the Network page (built at deploy time) and the
// dashboard (in the browser). Land comes from LAND in clouds.js; regions in the same city are merged
// into one marker that lists them.
import { LAND, PROVIDERS } from './clouds.js';

const COLS = 144;
const CELL = 10;
// Crop to 80°N…58°S: nothing lives further out, and it keeps the map wide.
const TOP_ROW = 4;
const ROWS = 56;
export const MAP_WIDTH = COLS * CELL;
export const MAP_HEIGHT = ROWS * CELL;

export const project = (lat, lon) => [((lon + 180) / 360) * MAP_WIDTH, ((80 - lat) / 140) * MAP_HEIGHT];

const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// One rectangle per horizontal run of land cells, filled with a dot pattern.
let landCache;
function landPath() {
  if (landCache) return landCache;
  const parts = [];
  for (let row = 0; row < ROWS; row += 1) {
    const hex = LAND[row + TOP_ROW];
    const bits = [...hex].map((digit) => parseInt(digit, 16).toString(2).padStart(4, '0')).join('');
    let start = -1;
    for (let col = 0; col <= COLS; col += 1) {
      const on = col < COLS && bits[col] === '1';
      if (on && start < 0) start = col;
      if (!on && start >= 0) {
        parts.push(`M${start * CELL} ${row * CELL}h${(col - start) * CELL}v${CELL}h-${(col - start) * CELL}z`);
        start = -1;
      }
    }
  }
  landCache = parts.join('');
  return landCache;
}

const providerName = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.name]));
const providerColor = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.color]));

// Regions within about 1.5° of each other become one marker.
export function groupRegions(regions) {
  const groups = [];
  for (const region of regions) {
    const near = groups.find((group) => Math.abs(group.lat - region.lat) < 1.5 && Math.abs(group.lon - region.lon) < 1.5);
    if (near) near.regions.push(region);
    else groups.push({ lat: region.lat, lon: region.lon, regions: [region] });
  }
  return groups;
}

// Markers only (the dashboard redraws these when filters change). `highlight` is a Set of
// "provider:code" keys drawn as rings (e.g. the customer's clusters).
export function markersSvg(regions, { highlight = new Set() } = {}) {
  return groupRegions(regions).map((group) => {
    const [x, y] = project(group.lat, group.lon);
    const providers = [...new Set(group.regions.map((region) => region.provider))];
    const color = providers.length === 1 ? providerColor[providers[0]] : 'var(--map-multi, #7c3aed)';
    const radius = Math.min(4 + group.regions.length * 1.2, 11);
    const ring = group.regions.some((region) => highlight.has(`${region.provider}:${region.code}`));
    const title = group.regions.map((region) => `${providerName[region.provider]} · ${region.city} (${region.code})`).join('\n');
    return `<g class="map-marker"><title>${esc(title)}</title>${ring ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius + 5}" class="map-ring" />` : ''}<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}" fill="${color}" class="map-dot" /></g>`;
  }).join('');
}

export function worldMapSvg(regions, options = {}) {
  return `<svg class="world-map" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img" aria-label="${esc(options.label || 'Cloud data center regions around the world')}">
  <defs><pattern id="map-dots" width="${CELL}" height="${CELL}" patternUnits="userSpaceOnUse"><circle cx="${CELL / 2}" cy="${CELL / 2}" r="2.4" class="map-land-dot" /></pattern></defs>
  <path d="${landPath()}" fill="url(#map-dots)" />
  <g class="map-markers">${markersSvg(regions, options)}</g>
</svg>`;
}
