const ROW_H_COLLAPSED = 67;
const OVERSCAN = 5;
const SEARCH_MS = 120;

let allDomains = [];
let filtered = [];
const openSet = new Set();
const measuredH = new Map();
let offsets = [];

const outer = document.getElementById('vscroll-outer');
const inner = document.getElementById('vscroll-inner');
const pool = [];
const liveNodes = new Map();

async function loadData() {
  const res = await fetch('api/index.json');
  const data = await res.json();
  allDomains = data.domains;
  filtered = allDomains;
  updateStats();
  initVScroll();
}

function updateStats() {
  let snaps = 0, latest = null;
  allDomains.forEach(d => {
    snaps += d.dates.length;
    d.dates.forEach(e => {
      const dt = new Date(e.date);
      if (!latest || dt > latest) latest = dt;
    });
  });
  document.getElementById('stat-domains').textContent = allDomains.length;
  document.getElementById('stat-snapshots').textContent = snaps;
  document.getElementById('stat-latest').textContent = latest
    ? latest.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
}

let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = document.getElementById('search').value.toLowerCase().trim();
    filtered = q ? allDomains.filter(d => d.domain.toLowerCase().includes(q)) : allDomains;
    openSet.clear();
    measuredH.clear();
    document.getElementById('empty-state').style.display = filtered.length === 0 ? '' : 'none';
    initVScroll();
  }, SEARCH_MS);
}

function rowHeight(i) {
  if (!openSet.has(i)) return ROW_H_COLLAPSED;
  return measuredH.get(i) || ROW_H_COLLAPSED;
}

function buildOffsets() {
  offsets = new Array(filtered.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < filtered.length; i++) {
    offsets[i + 1] = offsets[i] + rowHeight(i);
  }
}

function totalHeight() {
  return offsets[filtered.length] || 0;
}

function measureAndReflow(i) {
  const node = liveNodes.get(i);
  if (!node) return;
  const h = node.offsetHeight + 8;
  if (measuredH.get(i) === h) return;
  measuredH.set(i, h);
  buildOffsets();
  liveNodes.forEach((n, idx) => {
    if (idx >= i) n.style.top = offsets[idx] + 'px';
  });
  outer.style.height = totalHeight() + 'px';
}

function firstVisible(scrollTop) {
  if (filtered.length === 0) return 0;
  let lo = 0, hi = filtered.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function render() {
  if (filtered.length === 0) {
    liveNodes.forEach(node => { pool.push(node); node.remove(); });
    liveNodes.clear();
    outer.style.height = '0px';
    return;
  }

  outer.style.height = totalHeight() + 'px';

  const outerTop = outer.getBoundingClientRect().top + window.scrollY;
  const viewTop = window.scrollY - outerTop;
  const viewBot = viewTop + window.innerHeight;

  const start = Math.max(0, firstVisible(Math.max(0, viewTop)) - OVERSCAN);
  const end = Math.min(filtered.length - 1, firstVisible(viewBot) + OVERSCAN);

  liveNodes.forEach((node, idx) => {
    if (idx < start || idx > end) {
      pool.push(node);
      node.remove();
      liveNodes.delete(idx);
    }
  });

  for (let i = start; i <= end; i++) {
    if (liveNodes.has(i)) continue;
    const node = pool.length ? pool.pop() : document.createElement('div');
    buildRow(node, i);
    node.style.cssText = `position:absolute;top:${offsets[i]}px;left:0;right:0`;
    inner.appendChild(node);
    liveNodes.set(i, node);
    if (openSet.has(i)) {
      requestAnimationFrame(() => requestAnimationFrame(() => measureAndReflow(i)));
    }
  }
}

function latestDate(dates) {
  if (!dates || dates.length === 0) return null;
  return dates.reduce((max, e) => (e.date > max ? e.date : max), dates[0].date);
}

function buildRow(node, i) {
  const d = filtered[i];
  const isOpen = openSet.has(i);
  const fav = d.favicon || `https://icons.duckduckgo.com/ip3/${d.domain}.ico`;

  node.className = 'domain' + (isOpen ? ' open' : '');
  node.innerHTML = `
    <div class="domain-header">
      <div class="domain-favicon">
        <img src="${fav}" alt="" onerror="this.parentElement.textContent='🌐'">
      </div>
      <div class="domain-info">
        <div class="domain-name">${d.domain}</div>
        <div class="domain-meta">${d.dates.length} snapshot${d.dates.length !== 1 ? 's' : ''} · last ${formatDate(latestDate(d.dates))}</div>
      </div>
      <span class="domain-count">${d.dates.length}</span>
      <svg class="chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    ${isOpen ? buildDateGrid(d) : ''}
  `;

  node.querySelector('.domain-header').addEventListener('click', () => toggleRow(i));
  if (isOpen) wireScreenshots(node, i);
}

function buildDateGrid(d) {
  return '<div class="date-list">' + d.dates.map(e => `
    <div class="date-card">
      <div class="date-card-header">
        <span class="date-label">${e.date}</span>
        <button class="date-toggle-btn" data-src="${e.screenshot}">View</button>
      </div>
      <div class="screenshot-wrap"></div>
    </div>`).join('') + '</div>';
}

function wireScreenshots(node, i) {
  node.querySelectorAll('.date-toggle-btn').forEach(btn => {
    const card = btn.closest('.date-card');
    const wrap = card.querySelector('.screenshot-wrap');
    btn.addEventListener('click', () => {
      if (wrap.classList.contains('visible')) {
        wrap.classList.remove('visible');
        wrap.innerHTML = '';
        btn.textContent = 'View';
        requestAnimationFrame(() => requestAnimationFrame(() => measureAndReflow(i)));
      } else {
        wrap.classList.add('visible');
        wrap.innerHTML = '<div class="screenshot-placeholder">Loading…</div>';
        btn.textContent = 'Hide';
        requestAnimationFrame(() => requestAnimationFrame(() => measureAndReflow(i)));
        const img = new Image();
        img.style.cssText = 'width:100%;border-radius:5px;display:block;border:1px solid var(--border)';
        img.onload = () => {
          wrap.innerHTML = '';
          wrap.appendChild(img);
          wrap.addEventListener('click', () => openLightbox(btn.dataset.src));
          requestAnimationFrame(() => requestAnimationFrame(() => measureAndReflow(i)));
        };
        img.onerror = () => {
          wrap.innerHTML = '<div class="screenshot-placeholder">Unavailable</div>';
          requestAnimationFrame(() => requestAnimationFrame(() => measureAndReflow(i)));
        };
        img.src = btn.dataset.src;
      }
    });
  });
}

function toggleRow(i) {
  if (openSet.has(i)) {
    openSet.delete(i);
    measuredH.delete(i);
  } else {
    openSet.add(i);
  }

  buildOffsets();

  const node = liveNodes.get(i);
  if (node) {
    buildRow(node, i);
    node.style.top = offsets[i] + 'px';
    if (openSet.has(i)) {
      requestAnimationFrame(() => requestAnimationFrame(() => measureAndReflow(i)));
    }
  }

  liveNodes.forEach((n, idx) => {
    if (idx > i) n.style.top = offsets[idx] + 'px';
  });
  outer.style.height = totalHeight() + 'px';
  render();
}

function initVScroll() {
  liveNodes.forEach(node => node.remove());
  liveNodes.clear();
  pool.length = 0;
  inner.innerHTML = '';
  measuredH.clear();
  buildOffsets();
  render();
}

function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
  document.getElementById('lightbox-img').src = '';
  document.body.style.overflow = '';
}

document.getElementById('lightbox').addEventListener('click', e => {
  if (e.target === document.getElementById('lightbox')) closeLightbox();
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

function formatDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

let ticking = false;
window.addEventListener('scroll', () => {
  if (!ticking) { requestAnimationFrame(() => { render(); ticking = false; }); ticking = true; }
});
window.addEventListener('resize', () => { measuredH.clear(); buildOffsets(); render(); });

loadData();
