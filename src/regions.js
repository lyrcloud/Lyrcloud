// Network page: provider filters for the cloud regions map and directory.
import { markersSvg } from './cloud-map.js';
import { REGIONS } from './clouds.js';

const boxes = [...document.querySelectorAll('.provider-filter input')];
const markers = document.querySelector('.cloud-map .map-markers');

function apply() {
  const shown = new Set(boxes.filter((box) => box.checked).map((box) => box.value));
  if (markers) markers.innerHTML = markersSvg(REGIONS.filter((region) => shown.has(region.provider)));
  for (const row of document.querySelectorAll('.region-rows li')) {
    row.hidden = !row.dataset.providers.split(' ').some((id) => shown.has(id));
    for (const code of row.querySelectorAll('code')) code.hidden = !shown.has(code.className.replace('provider-', ''));
  }
}

for (const box of boxes) box.addEventListener('change', apply);
