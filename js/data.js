/* ============================================================
   data.js — Photo data loading & view count management
   ============================================================ */

const DATA_URL = '/photos/manifest.json';
const VIEWS_KEY = 'of_views';

let _cache = null;

/**
 * Load the photo manifest, merging persisted local view counts.
 */
async function loadManifest() {
  if (_cache) return _cache;

  const resp = await fetch(DATA_URL);
  if (!resp.ok) throw new Error('Failed to load manifest');
  const data = await resp.json();

  const local = getLocalViews();
  data.photos = data.photos.map(p => ({
    ...p,
    views: p.views + (local[p.id] || 0)
  }));

  _cache = data;
  return data;
}

/** Return all photos, optionally filtered by category, sorted by field. */
async function getPhotos({ category = null, sort = 'views' } = {}) {
  const data = await loadManifest();
  let photos = [...data.photos];

  if (category) {
    photos = photos.filter(p => p.category === category);
  }

  if (sort === 'views') {
    photos.sort((a, b) => b.views - a.views);
  } else if (sort === 'date') {
    photos.sort((a, b) => new Date(b.date) - new Date(a.date));
  } else if (sort === 'title') {
    photos.sort((a, b) => a.title.localeCompare(b.title));
  }

  return photos;
}

/** Return featured photos for the carousel. */
async function getFeaturedPhotos() {
  const data = await loadManifest();
  return data.photos.filter(p => p.featured);
}

/** Return all categories with photo counts. */
async function getCategories() {
  const data = await loadManifest();
  return data.categories.map(cat => ({
    ...cat,
    count: data.photos.filter(p => p.category === cat.id).length,
    photos: data.photos.filter(p => p.category === cat.id).slice(0, 4)
  }));
}

/** Return a single photo by id. */
async function getPhotoById(id) {
  const data = await loadManifest();
  return data.photos.find(p => p.id === id) || null;
}

/** Record a view for a photo (persisted in localStorage). */
function recordView(photoId) {
  const local = getLocalViews();
  local[photoId] = (local[photoId] || 0) + 1;
  localStorage.setItem(VIEWS_KEY, JSON.stringify(local));
  // Bust cache so next load reflects new count
  _cache = null;
}

function getLocalViews() {
  try {
    return JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}');
  } catch {
    return {};
  }
}

/** Format a number compactly: 8423 → "8.4k" */
function fmtViews(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/** Format a date string to "Feb 20, 2026" */
function fmtDate(str) {
  return new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
