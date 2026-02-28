/* ============================================================
   app.js — UI rendering, carousel, page logic
   ============================================================ */

/* ── Page Transitions ───────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setActiveNav();

  document.body.addEventListener('click', e => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http') || link.target) return;
    e.preventDefault();
    document.body.classList.add('page-exit');
    setTimeout(() => { window.location.href = href; }, 250);
  });
});

function setActiveNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-link').forEach(l => {
    const lhref = l.getAttribute('href').split('/').pop();
    if (
      (lhref === path) ||
      (lhref === 'index.html' && path === '') ||
      (lhref === '' && path === 'index.html')
    ) {
      l.classList.add('active');
    }
  });
}

/* ── Eye Icon SVG ───────────────────────────────────────────── */
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/>
  <circle cx="12" cy="12" r="3"/>
</svg>`;

/* ── Photo Card HTML ────────────────────────────────────────── */
function photoCardHTML(photo, catMap) {
  const cat = catMap ? catMap[photo.category] : null;
  const flag = cat ? cat.flag : '';
  const catLabel = cat ? cat.shortLabel : photo.category;
  return `
    <div class="photo-card" data-id="${photo.id}" onclick="openPhoto('${photo.id}')">
      <div class="card-img-wrap">
        <img src="${photo.file}" alt="${photo.title}" loading="lazy" onerror="this.style.background='#1e1e36'">
      </div>
      <div class="card-body">
        <div class="card-title">${photo.title}</div>
        <div class="card-meta">
          <span class="card-category">${flag} ${catLabel}</span>
          <span class="card-views">${EYE} ${fmtViews(photo.views)}</span>
        </div>
      </div>
      <div class="card-overlay">
        <div class="overlay-title">${photo.title}</div>
        <div class="overlay-desc">${photo.description}</div>
      </div>
    </div>`;
}

function openPhoto(id) {
  window.location.href = `photo.html?id=${id}`;
}

/* ── Carousel ───────────────────────────────────────────────── */
function initCarousel(slides) {
  const hero = document.querySelector('.hero');
  if (!hero || slides.length === 0) return;

  const track = hero.querySelector('.carousel-track');
  const dotsEl = hero.querySelector('.carousel-dots');
  let current = 0;
  let timer;

  function goto(n) {
    const prev = current;
    current = (n + slides.length) % slides.length;
    track.querySelectorAll('.carousel-slide')[prev]?.classList.remove('active');
    track.querySelectorAll('.carousel-slide')[current]?.classList.add('active');
    track.style.transform = `translateX(-${current * 100}%)`;
    dotsEl.querySelectorAll('.carousel-dot').forEach((d, i) =>
      d.classList.toggle('active', i === current));
    resetTimer();
  }

  function resetTimer() {
    clearInterval(timer);
    timer = setInterval(() => goto(current + 1), 5500);
  }

  hero.querySelector('.carousel-btn.prev')?.addEventListener('click', () => goto(current - 1));
  hero.querySelector('.carousel-btn.next')?.addEventListener('click', () => goto(current + 1));
  dotsEl.querySelectorAll('.carousel-dot').forEach((d, i) =>
    d.addEventListener('click', () => goto(i)));

  // Touch swipe
  let tx = 0;
  track.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 50) goto(current + (dx < 0 ? 1 : -1));
  });

  goto(0);
  resetTimer();
}

/* ── Init: Home Page ────────────────────────────────────────── */
async function initHome() {
  const [featured, allPhotos, categories] = await Promise.all([
    getFeaturedPhotos(),
    getPhotos({ sort: 'views' }),
    getCategories()
  ]);

  const catMap = Object.fromEntries(categories.map(c => [c.id, c]));

  // Build carousel
  const hero = document.querySelector('.hero');
  if (hero && featured.length) {
    const track = hero.querySelector('.carousel-track');
    const dots = hero.querySelector('.carousel-dots');
    track.innerHTML = featured.map(p => `
      <div class="carousel-slide">
        <img class="slide-img" src="${p.file}" alt="${p.title}" loading="eager">
        <div class="slide-overlay"></div>
        <div class="slide-content">
          <div class="label slide-label">${catMap[p.category]?.flag || ''} ${catMap[p.category]?.label || p.category}</div>
          <h2 class="slide-title">${p.title}</h2>
          <p class="slide-desc">${p.description}</p>
          <div class="slide-meta">
            <span class="slide-views">${fmtViews(p.views)} views</span>
            <a class="btn-view" href="photo.html?id=${p.id}">View Photo →</a>
          </div>
        </div>
      </div>`).join('');
    dots.innerHTML = featured.map(() => `<div class="carousel-dot"></div>`).join('');
    initCarousel(featured);
  }

  // Popular photos grid
  const popularGrid = document.getElementById('popular-grid');
  if (popularGrid) {
    popularGrid.innerHTML = allPhotos.slice(0, 8).map(p => photoCardHTML(p, catMap)).join('');
  }
}

/* ── Init: Gallery Page ─────────────────────────────────────── */
async function initGallery() {
  const params = new URLSearchParams(window.location.search);
  const initCat = params.get('cat') || 'all';
  const initSort = params.get('sort') || 'views';

  const [allPhotos, categories] = await Promise.all([
    getPhotos({ sort: initSort }),
    getCategories()
  ]);
  const catMap = Object.fromEntries(categories.map(c => [c.id, c]));

  const filterBar = document.getElementById('filter-bar');
  const sortSelect = document.getElementById('sort-select');
  const grid = document.getElementById('gallery-grid');
  const countEl = document.getElementById('photo-count');

  // Build filter buttons
  filterBar.innerHTML = `<button class="filter-btn ${initCat === 'all' ? 'active' : ''}" data-cat="all">All Photos</button>` +
    categories.map(c =>
      `<button class="filter-btn ${initCat === c.id ? 'active' : ''}" data-cat="${c.id}">${c.flag} ${c.shortLabel}</button>`
    ).join('');

  sortSelect.value = initSort;

  let currentCat = initCat;
  let currentSort = initSort;

  function render() {
    let photos = allPhotos;
    if (currentCat !== 'all') photos = photos.filter(p => p.category === currentCat);
    if (currentSort === 'views') photos = [...photos].sort((a, b) => b.views - a.views);
    else if (currentSort === 'date') photos = [...photos].sort((a, b) => new Date(b.date) - new Date(a.date));
    else if (currentSort === 'title') photos = [...photos].sort((a, b) => a.title.localeCompare(b.title));

    grid.innerHTML = photos.length
      ? photos.map(p => photoCardHTML(p, catMap)).join('')
      : '<div class="empty-state"><h3>No photos found</h3><p>Try a different filter.</p></div>';

    if (countEl) countEl.textContent = `${photos.length} photo${photos.length !== 1 ? 's' : ''}`;
  }

  filterBar.addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentCat = btn.dataset.cat;
    render();
  });

  sortSelect.addEventListener('change', () => {
    currentSort = sortSelect.value;
    render();
  });

  render();
}

/* ── Init: Categories Page ──────────────────────────────────── */
async function initCategories() {
  const categories = await getCategories();
  const grid = document.getElementById('category-grid');
  if (!grid) return;

  grid.innerHTML = categories.map(cat => {
    const previews = cat.photos.slice(0, 4);
    const previewHTML = previews.map((p, i) => i === 0
      ? `<img src="${p.file}" alt="${p.title}" loading="lazy" style="grid-column:1/2;grid-row:1/3;">`
      : `<img src="${p.file}" alt="${p.title}" loading="lazy">`
    ).join('');

    return `
      <div class="category-card" onclick="gotoCategory('${cat.id}')">
        <div class="category-preview">${previewHTML}</div>
        <div class="category-body">
          <div class="category-flag">${cat.flag}</div>
          <div class="category-name">${cat.label}</div>
          <div class="category-count">${cat.count} photos</div>
          <div class="category-desc">${cat.description}</div>
        </div>
        <div class="category-arrow">→</div>
      </div>`;
  }).join('');
}

function gotoCategory(id) {
  window.location.href = `gallery.html?cat=${id}`;
}

/* ── Init: Photo Page ───────────────────────────────────────── */
async function initPhoto() {
  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) { window.location.href = 'gallery.html'; return; }

  recordView(id);

  const [photo, allPhotos, categories] = await Promise.all([
    getPhotoById(id),
    getPhotos({ sort: 'views' }),
    getCategories()
  ]);

  if (!photo) { window.location.href = 'gallery.html'; return; }

  const catMap = Object.fromEntries(categories.map(c => [c.id, c]));
  const cat = catMap[photo.category];

  // Populate page
  document.title = `${photo.title} — OnlyFeet.Asia`;

  const el = id => document.getElementById(id);
  if (el('photo-img')) el('photo-img').src = photo.file;
  if (el('photo-label')) el('photo-label').textContent = `${cat?.flag || ''} ${cat?.label || photo.category}`;
  if (el('photo-title')) el('photo-title').textContent = photo.title;
  if (el('photo-views')) el('photo-views').textContent = fmtViews(photo.views + 1);
  if (el('photo-date')) el('photo-date').textContent = fmtDate(photo.date);
  if (el('photo-desc')) el('photo-desc').textContent = photo.description;
  if (el('photo-tags')) {
    el('photo-tags').innerHTML = (photo.tags || []).map(t => `<span class="tag">#${t}</span>`).join('');
  }
  if (el('back-cat')) {
    el('back-cat').href = `gallery.html?cat=${photo.category}`;
    el('back-cat').textContent = `← Back to ${cat?.label || 'Gallery'}`;
  }

  // Related photos
  const related = allPhotos.filter(p => p.category === photo.category && p.id !== photo.id).slice(0, 4);
  const relGrid = el('related-grid');
  if (relGrid) {
    relGrid.innerHTML = related.map(p => photoCardHTML(p, catMap)).join('');
  }
}
