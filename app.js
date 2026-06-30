/* ============================================================
   Henry Watch Tracker — app.js
   Reads (and optionally writes) the Airtable "Titles" table.
   No build step. No framework. Vanilla JS, mobile-first.
   ============================================================ */

const CFG_KEY = 'hwt_config_v1';
const CACHE_KEY = 'hwt_records_cache_v1';

const FIELDS = {
  title: 'Title',
  poster: 'Poster/Image',
  type: 'Type',
  year: 'Year',
  status: 'Status',
  lists: 'Lists',
  priority: 'Priority Queue',
  personalRating: 'Personal Rating',
  actualRating: 'Actual Rating',
  genres: 'Genres',
  mood: 'Mood',
  language: 'Language',
  matchPct: 'Match %',
  confidencePct: 'Confidence %',
  predictedRating: 'Predicted Rating',
  discoveryScore: 'Discovery Score',
  hiddenGemScore: 'Hidden Gem Score',
  why: 'Why It Was Recommended',
  recSource: 'Recommendation Source',
  recRound: 'Recommendation Round',
  currentStreaming: 'Current Streaming',
  platform: 'Platform',
  owned: 'Owned',
  k4: '4K',
  bluray: 'Blu-ray',
  dvd: 'DVD',
  digital: 'Digital Purchase',
  franchise: 'Franchise / Collection',
  canon: 'Canon',
  franchiseCompletion: 'Franchise Completion',
  notes: 'Notes',
  favorite: 'Favorite',
  needRating: 'Need Rating',
  runtime: 'Runtime Minutes',
};

let CONFIG = null;
let RECORDS = [];
let CURRENT_SCREEN = 'dashboard';

/* ---------------- Config ---------------- */

function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

/* ---------------- Airtable client ---------------- */

function airtableUrl(offset) {
  const base = `https://api.airtable.com/v0/${CONFIG.baseId}/${encodeURIComponent(CONFIG.table)}`;
  const params = new URLSearchParams();
  if (CONFIG.view) params.set('view', CONFIG.view);
  params.set('pageSize', '100');
  if (offset) params.set('offset', offset);
  return `${base}?${params.toString()}`;
}

async function fetchAllRecords() {
  let all = [];
  let offset = undefined;
  do {
    const res = await fetch(airtableUrl(offset), {
      headers: { Authorization: `Bearer ${CONFIG.token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    all = all.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return all;
}

async function patchRecord(recordId, fields) {
  const url = `https://api.airtable.com/v0/${CONFIG.baseId}/${encodeURIComponent(CONFIG.table)}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable write ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/* Tries to persist a resolved poster URL back to Airtable.
   1) Poster/Image attachment field (Airtable will fetch & store the image itself).
   2) Fallback: a plain text/URL field literally named "Poster URL", if it exists.
   Returns { ok, field } or { ok: false, reason } — never throws. */
async function savePosterUrlToAirtable(record, url) {
  try {
    await patchRecord(record.id, { [FIELDS.poster]: [{ url }] });
    record.fields[FIELDS.poster] = [{ url }];
    return { ok: true, field: 'Poster/Image' };
  } catch (e) {
    // Attachment write failed — try the plain-text fallback field.
  }
  try {
    await patchRecord(record.id, { [POSTER_URL_FIELD]: url });
    record.fields[POSTER_URL_FIELD] = url;
    return { ok: true, field: POSTER_URL_FIELD };
  } catch (e) {
    return { ok: false, reason: 'no-field' };
  }
}

async function createRecords(fieldsArray) {
  // Airtable allows max 10 records per create call — batch automatically.
  const url = `https://api.airtable.com/v0/${CONFIG.baseId}/${encodeURIComponent(CONFIG.table)}`;
  const created = [];
  for (let i = 0; i < fieldsArray.length; i += 10) {
    const batch = fieldsArray.slice(i, i + 10).map(fields => ({ fields }));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable create ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    created.push(...(data.records || []));
  }
  return created;
}

/* ---------------- Data helpers ---------------- */

function f(record, key) {
  return record.fields ? record.fields[FIELDS[key]] : undefined;
}

function asArray(v) { return Array.isArray(v) ? v : (v ? [v] : []); }

const POSTER_URL_FIELD = 'Poster URL'; // fallback text/URL field if the Poster/Image attachment field can't be written to

function posterUrl(record) {
  const att = f(record, 'poster');
  if (att && att[0]) {
    return att[0].thumbnails ? (att[0].thumbnails.large || att[0].thumbnails.full || att[0]).url : att[0].url;
  }
  const fallback = record.fields && record.fields[POSTER_URL_FIELD];
  if (fallback) return fallback;
  return null;
}

/* ---------------- TMDb auto-poster lookup (optional, client-side, cached) ---------------- */

const TMDB_CACHE_KEY = 'hwt_tmdb_cache_v1';
let TMDB_CACHE = null;

function loadTmdbCache() {
  if (TMDB_CACHE) return TMDB_CACHE;
  try {
    TMDB_CACHE = JSON.parse(localStorage.getItem(TMDB_CACHE_KEY)) || {};
  } catch (e) { TMDB_CACHE = {}; }
  return TMDB_CACHE;
}
function saveTmdbCache() {
  try { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(TMDB_CACHE)); } catch (e) { /* ignore quota errors */ }
}

async function fetchTmdbPoster(record) {
  if (!CONFIG.tmdbKey) return null;
  const title = f(record, 'title');
  const year = f(record, 'year');
  const type = f(record, 'type') === 'TV Show' ? 'tv' : 'movie';
  const cache = loadTmdbCache();
  const cacheKey = `${type}:${normalizeTitle(title)}:${year || ''}`;
  if (cacheKey in cache) return cache[cacheKey];

  try {
    const params = new URLSearchParams({ api_key: CONFIG.tmdbKey, query: title });
    if (year) params.set(type === 'tv' ? 'first_air_date_year' : 'year', year);
    const res = await fetch(`https://api.themoviedb.org/3/search/${type}?${params.toString()}`);
    if (!res.ok) { cache[cacheKey] = null; saveTmdbCache(); return null; }
    const data = await res.json();
    const hit = (data.results || [])[0];
    const path = hit && hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null;
    cache[cacheKey] = path;
    saveTmdbCache();
    return path;
  } catch (e) {
    return null; // offline or TMDb unreachable — fall back to styled placeholder, don't cache failures from network errors
  }
}

/* Resolves the best poster for a record: Airtable first, TMDb second (if key set), else null. */
async function resolvePoster(record) {
  const direct = posterUrl(record);
  if (direct) return direct;
  return fetchTmdbPoster(record);
}

/* Swaps a skeleton placeholder element's background once an image is resolved & preloaded, with a fade-in. */
let posterFieldWarningShown = false;

function hydratePosterEl(el, record) {
  if (!el || el.dataset.hydrated) return;
  el.dataset.hydrated = '1';
  const direct = posterUrl(record);
  if (direct) {
    paintPoster(el, direct);
    return;
  }
  if (!CONFIG.tmdbKey) return; // no key configured — keep the cinematic fallback as final state
  el.classList.add('skeleton');
  fetchTmdbPoster(record).then(async url => {
    el.classList.remove('skeleton');
    if (!url) return;
    paintPoster(el, url);
    if (CONFIG.writeEnabled) {
      const result = await savePosterUrlToAirtable(record, url);
      saveCache(RECORDS);
      if (!result.ok && !posterFieldWarningShown) {
        posterFieldWarningShown = true;
        toast('Posters found but not saved — add a "Poster URL" field in Airtable (see Settings)');
      }
    }
  });
}

function paintPoster(el, url) {
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url('${url}')`;
    el.classList.remove('noimg', 'skeleton');
    el.classList.add('poster-fade-in');
    if (!el.classList.contains('hero-card')) {
      el.innerHTML = '';
    } else {
      el.classList.add('has-poster');
    }
  };
  img.onerror = () => { el.classList.remove('skeleton'); };
  img.src = url;
}

let posterObserver = null;
function getPosterObserver() {
  if (posterObserver) return posterObserver;
  posterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const card = entry.target;
      posterObserver.unobserve(card);
      const record = RECORDS.find(r => r.id === card.dataset.id);
      if (!record) return;
      const imgEl = card.matches('.hero-card') ? card : card.querySelector('.poster-card-img, .card-poster');
      if (imgEl && !posterUrl(record)) hydratePosterEl(imgEl, record);
    });
  }, { rootMargin: '200px' });
  return posterObserver;
}

function hydratePostersIn(container) {
  if (!CONFIG.tmdbKey) return; // nothing to hydrate beyond what's already rendered
  const obs = getPosterObserver();
  container.querySelectorAll('[data-id]').forEach(card => obs.observe(card));
}

function pct(v) {
  if (v === undefined || v === null) return null;
  return Math.round(v <= 1 ? v * 100 : v);
}

function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/* ---------------- Smart recommendation reason (no AI — pure overlap scoring) ---------------- */

function computeSmartReason(record) {
  const targetGenres = new Set(asArray(f(record, 'genres')));
  const targetMoods = new Set(asArray(f(record, 'mood')));
  if (!targetGenres.size && !targetMoods.size) return null;

  const watched = RECORDS.filter(r =>
    r.id !== record.id &&
    (asArray(f(r, 'lists')).includes('Previously Watched') || f(r, 'status') === 'Watched')
  );
  if (!watched.length) return null;

  const scored = watched.map(r => {
    const g = asArray(f(r, 'genres')).filter(x => targetGenres.has(x)).length;
    const m = asArray(f(r, 'mood')).filter(x => targetMoods.has(x)).length;
    const rating = f(r, 'actualRating') || f(r, 'personalRating') || 0;
    return { r, score: g * 2 + m, rating };
  }).filter(x => x.score > 0);

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.rating - a.rating);
  const top = scored.slice(0, 3).map(x => f(x.r, 'title'));
  const list = top.length === 1 ? top[0] : top.slice(0, -1).join(', ') + ' & ' + top[top.length - 1];
  return `Because you watched ${list}`;
}

const STREAM_META = {
  'Netflix': { icon: 'N', color: '#E50914' },
  'Prime Video': { icon: 'P', color: '#00A8E1' },
  'Peacock': { icon: 'PK', color: '#9B5DE0' },
  'Hulu': { icon: 'H', color: '#1CE783' },
  'Max': { icon: 'M', color: '#7B2FF7' },
  'Disney+': { icon: 'D+', color: '#113CCF' },
  'Apple TV+': { icon: '', color: '#A6A6A6' },
  'Paramount+': { icon: 'P+', color: '#0064FF' },
  'Theater': { icon: '🎟', color: '#8A8F99' },
  'Physical Media': { icon: '💿', color: '#8A8F99' },
  'Not Streaming': { icon: '—', color: '#8A8F99' },
  'Other': { icon: '•', color: '#8A8F99' },
};
function streamChip(name) {
  const meta = STREAM_META[name] || { icon: '•', color: '#8A8F99' };
  return `<span class="stream-chip" style="--sc:${meta.color}"><span class="stream-dot">${escapeHtml(meta.icon)}</span>${escapeHtml(name)}</span>`;
}

function findRecordByTitle(title) {
  const norm = normalizeTitle(title);
  if (!norm) return null;
  return RECORDS.find(r => normalizeTitle(f(r, 'title')) === norm) || null;
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveCache(records) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(records)); } catch (e) { /* storage full, ignore */ }
}

/* ---------------- Toast ---------------- */

function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------------- Boot ---------------- */

async function boot() {
  CONFIG = loadConfig();
  wireConfigScreen();
  wireNav();
  wireSearch();
  wireOverlays();
  wireAddRecScreen();
  wireBulkImport();
  wireInstallFlow();
  wireFetchMissingPosters();

  if (!CONFIG || !CONFIG.baseId || !CONFIG.token) {
    showScreen('setup');
    return;
  }

  const cached = loadCache();
  if (cached) {
    RECORDS = cached;
    renderAll();
    showScreen('dashboard');
  }

  try {
    RECORDS = await fetchAllRecords();
    saveCache(RECORDS);
    renderAll();
    if (!cached) showScreen('dashboard');
  } catch (err) {
    console.error(err);
    if (!cached) {
      showScreen('setup');
      toast('Could not connect — check your settings');
    } else {
      toast('Refresh failed, showing cached data');
    }
  }
}

/* ---------------- Config screen wiring ---------------- */

function wireConfigScreen() {
  const baseIdEl = document.getElementById('cfgBaseId');
  const tableEl = document.getElementById('cfgTable');
  const viewEl = document.getElementById('cfgView');
  const tokenEl = document.getElementById('cfgToken');
  const writeEl = document.getElementById('cfgWriteEnabled');
  const tmdbEl = document.getElementById('cfgTmdbKey');

  if (CONFIG) {
    baseIdEl.value = CONFIG.baseId || '';
    tableEl.value = CONFIG.table || 'Titles';
    viewEl.value = CONFIG.view || '';
    tokenEl.value = CONFIG.token || '';
    writeEl.checked = !!CONFIG.writeEnabled;
    tmdbEl.value = CONFIG.tmdbKey || '';
  }

  document.getElementById('cfgSaveBtn').addEventListener('click', async () => {
    const cfg = {
      baseId: baseIdEl.value.trim(),
      table: tableEl.value.trim() || 'Titles',
      view: viewEl.value.trim(),
      token: tokenEl.value.trim(),
      writeEnabled: writeEl.checked,
      tmdbKey: tmdbEl.value.trim(),
    };
    if (!cfg.baseId || !cfg.token) {
      toast('Base ID and token are required');
      return;
    }
    CONFIG = cfg;
    saveConfig(cfg);
    toast('Connecting…');
    try {
      RECORDS = await fetchAllRecords();
      saveCache(RECORDS);
      renderAll();
      showScreen('dashboard');
      toast(`Connected — ${RECORDS.length} titles loaded`);
    } catch (err) {
      console.error(err);
      toast('Connection failed — check base ID / token / table name');
    }
  });

  document.getElementById('configBtn').addEventListener('click', () => showScreen('setup'));
  document.getElementById('moreSettingsBtn').addEventListener('click', () => {
    closeOverlay('moreSheet');
    showScreen('setup');
  });
}

/* ---------------- Add Recommendation screen ---------------- */

let arSelectedMoods = new Set();

function wireAddRecScreen() {
  document.querySelectorAll('#arMoodGrid .mood-select-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const m = chip.dataset.mood;
      if (arSelectedMoods.has(m)) { arSelectedMoods.delete(m); chip.classList.remove('active'); }
      else { arSelectedMoods.add(m); chip.classList.add('active'); }
    });
  });

  document.getElementById('arSaveBtn').addEventListener('click', async () => {
    if (!CONFIG.writeEnabled) { toast('Enable write access in Settings first'); return; }
    const title = document.getElementById('arTitle').value.trim();
    if (!title) { toast('Title is required'); return; }

    const type = document.getElementById('arType').value;
    const year = parseInt(document.getElementById('arYear').value, 10);
    const language = document.getElementById('arLanguage').value;
    const priority = document.getElementById('arPriority').value;
    const matchVal = parseInt(document.getElementById('arMatch').value, 10);
    const why = document.getElementById('arWhy').value.trim();
    const streaming = document.getElementById('arStreaming').value.trim();
    const notes = document.getElementById('arNotes').value.trim();

    const listTag = language === 'English' ? 'English Recommendation' : 'Foreign Dub Recommendation';
    const fields = {
      [FIELDS.title]: title,
      [FIELDS.type]: type,
      [FIELDS.status]: 'Want to Watch',
      [FIELDS.lists]: ['Watch List', listTag],
      [FIELDS.language]: language,
      [FIELDS.priority]: priority,
      [FIELDS.recSource]: 'ChatGPT',
    };
    if (!isNaN(year)) fields[FIELDS.year] = year;
    if (!isNaN(matchVal)) fields[FIELDS.matchPct] = matchVal / 100;
    if (why) fields[FIELDS.why] = why;
    if (notes) fields[FIELDS.notes] = notes;
    if (streaming) fields[FIELDS.currentStreaming] = streaming.split(',').map(s => s.trim()).filter(Boolean);
    if (arSelectedMoods.size) fields[FIELDS.mood] = Array.from(arSelectedMoods);

    try {
      toast('Saving…');
      const existing = findRecordByTitle(title);
      if (existing) {
        await patchRecord(existing.id, fields);
        toast(`Updated existing title "${title}"`);
      } else {
        await createRecords([fields]);
        toast(`Added "${title}"`);
      }
      RECORDS = await fetchAllRecords();
      saveCache(RECORDS);
      renderAll();
      resetAddRecForm();
      showScreen('dashboard');
    } catch (e) {
      console.error(e);
      toast('Could not save — check write permissions');
    }
  });
}

function resetAddRecForm() {
  ['arTitle', 'arYear', 'arMatch', 'arWhy', 'arStreaming', 'arNotes'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('arType').value = 'Movie';
  document.getElementById('arLanguage').value = 'English';
  document.getElementById('arPriority').value = 'Watch Next';
  arSelectedMoods.clear();
  document.querySelectorAll('#arMoodGrid .mood-select-chip').forEach(c => c.classList.remove('active'));
}

/* ---------------- Bulk paste import ---------------- */

function parseBulkLine(line) {
  const parts = line.split('|').map(p => p.trim());
  if (parts.length < 1 || !parts[0]) return null;
  const [title, type, yearStr, language, priority, mood, matchStr, why, streaming] = parts;
  return {
    title,
    type: type || 'Movie',
    year: yearStr ? parseInt(yearStr, 10) : null,
    language: (language || 'English').toLowerCase().startsWith('foreign') ? 'Foreign - Dubbed' : 'English',
    priority: priority || 'Backlog',
    mood: mood || '',
    match: matchStr ? parseInt(matchStr, 10) : null,
    why: why || '',
    streaming: streaming || '',
  };
}

function buildFieldsFromParsedRow(parsed) {
  const listTag = parsed.language === 'English' ? 'English Recommendation' : 'Foreign Dub Recommendation';
  const fields = {
    [FIELDS.title]: parsed.title,
    [FIELDS.type]: parsed.type,
    [FIELDS.status]: 'Want to Watch',
    [FIELDS.lists]: ['Watch List', listTag],
    [FIELDS.language]: parsed.language,
    [FIELDS.priority]: parsed.priority,
    [FIELDS.recSource]: 'ChatGPT',
  };
  if (parsed.year) fields[FIELDS.year] = parsed.year;
  if (parsed.match !== null && !isNaN(parsed.match)) fields[FIELDS.matchPct] = parsed.match / 100;
  if (parsed.why) fields[FIELDS.why] = parsed.why;
  if (parsed.mood) fields[FIELDS.mood] = [parsed.mood];
  if (parsed.streaming) fields[FIELDS.currentStreaming] = parsed.streaming.split(',').map(s => s.trim()).filter(Boolean);
  return fields;
}

let pendingQuickAdd = null; // { toCreate: [...], toUpdate: [...], errors: [...] }

function wireBulkImport() {
  document.getElementById('bulkImportBtn').addEventListener('click', () => {
    if (!CONFIG.writeEnabled) { toast('Enable write access in Settings first'); return; }
    const raw = document.getElementById('bulkTextarea').value;
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^Title\s*\|/i));
    if (!lines.length) { toast('Paste at least one line first'); return; }

    const toCreate = [];
    const toUpdate = [];
    const errors = [];

    lines.forEach(line => {
      const parsed = parseBulkLine(line);
      if (!parsed || !parsed.title) {
        errors.push({ line: line.slice(0, 60) });
        return;
      }
      const fields = buildFieldsFromParsedRow(parsed);
      const existing = findRecordByTitle(parsed.title);
      if (existing) {
        toUpdate.push({ id: existing.id, fields, title: parsed.title });
      } else {
        toCreate.push({ fields, title: parsed.title });
      }
    });

    pendingQuickAdd = { toCreate, toUpdate, errors };
    renderQuickAddPreview();
  });

  document.getElementById('bulkCancelBtn').addEventListener('click', () => {
    pendingQuickAdd = null;
    document.getElementById('bulkPreviewWrap').classList.add('hidden');
  });

  document.getElementById('bulkConfirmBtn').addEventListener('click', confirmQuickAdd);
}

function renderQuickAddPreview() {
  const { toCreate, toUpdate, errors } = pendingQuickAdd;
  const wrap = document.getElementById('bulkPreviewWrap');
  const summary = document.getElementById('bulkPreviewSummary');
  const list = document.getElementById('bulkPreviewList');
  document.getElementById('bulkResults').innerHTML = '';

  summary.textContent = `${toCreate.length} new · ${toUpdate.length} updating existing${errors.length ? ' · ' + errors.length + ' errors' : ''}`;
  list.innerHTML =
    toCreate.map(r => `<div class="bulk-result-row created"><span>${escapeHtml(r.title)}</span><span class="bulk-result-tag">new</span></div>`).join('') +
    toUpdate.map(r => `<div class="bulk-result-row updated"><span>${escapeHtml(r.title)}</span><span class="bulk-result-tag">update existing</span></div>`).join('') +
    errors.map(r => `<div class="bulk-result-row error"><span>${escapeHtml(r.line)}</span><span class="bulk-result-tag">error</span></div>`).join('');

  wrap.classList.remove('hidden');
  document.getElementById('bulkConfirmBtn').classList.toggle('disabled', !toCreate.length && !toUpdate.length);
}

async function confirmQuickAdd() {
  if (!pendingQuickAdd) return;
  const { toCreate, toUpdate } = pendingQuickAdd;
  if (!toCreate.length && !toUpdate.length) { toast('Nothing to save'); return; }

  const resultsEl = document.getElementById('bulkResults');
  document.getElementById('bulkPreviewWrap').classList.add('hidden');
  resultsEl.innerHTML = '<p class="muted small">Saving…</p>';

  let savedCount = 0, errorCount = 0;
  try {
    // Updating an existing record only sends the fields we set here — Airtable leaves
    // everything else (ratings, watch history, etc.) on that record untouched.
    for (const u of toUpdate) {
      await patchRecord(u.id, u.fields);
      savedCount++;
    }
    if (toCreate.length) {
      await createRecords(toCreate.map(r => r.fields));
      savedCount += toCreate.length;
    }
    RECORDS = await fetchAllRecords();
    saveCache(RECORDS);
    renderAll();
    resultsEl.innerHTML = `<div class="bulk-summary">✔ ${savedCount} saved${errorCount ? ' · ' + errorCount + ' errors' : ''}</div>`;
    document.getElementById('bulkTextarea').value = '';
    toast('Quick Add complete');
  } catch (e) {
    console.error(e);
    errorCount = (toCreate.length + toUpdate.length) - savedCount;
    resultsEl.innerHTML = `<div class="bulk-summary">⚠ ${savedCount} saved before an error · ${errorCount} not saved</div><p class="muted small">Check write permissions and try the remaining rows again. Already-saved rows are safe and won't duplicate.</p>`;
    toast('Quick Add stopped on an error');
  } finally {
    pendingQuickAdd = null;
  }
}

/* ---------------- Install prompt (PWA) ---------------- */

let deferredInstallPrompt = null;

function wireInstallFlow() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById('installBanner').classList.add('show');
  });

  document.getElementById('installBannerBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) { showScreen('install'); return; }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('installBanner').classList.remove('show');
  });

  document.getElementById('installBannerClose').addEventListener('click', () => {
    document.getElementById('installBanner').classList.remove('show');
  });

  window.addEventListener('appinstalled', () => {
    document.getElementById('installBanner').classList.remove('show');
    toast('Installed — find it on your home screen');
  });
}



const SCREEN_MAP = {
  dashboard: { el: 'screen-dashboard' },
  search: { el: 'screen-search' },
  stats: { el: 'screen-stats' },
  setup: { el: 'screen-setup' },
  addrec: { el: 'screen-addrec' },
  bulkimport: { el: 'screen-bulkimport' },
  install: { el: 'screen-install' },
  watchnext: { el: 'screen-list', title: 'Watch Next', filter: r => f(r, 'priority') === 'Watch Next' },
  highpriority: { el: 'screen-list', title: 'High Priority', filter: r => f(r, 'priority') === 'High Priority' },
  english: { el: 'screen-list', title: 'English Watch List', filter: r => asArray(f(r, 'lists')).includes('Watch List') && asArray(f(r, 'lists')).includes('English Recommendation') },
  foreign: { el: 'screen-list', title: 'Foreign Dub Watch List', filter: r => asArray(f(r, 'lists')).includes('Watch List') && asArray(f(r, 'lists')).includes('Foreign Dub Recommendation') },
  previously: { el: 'screen-list', title: 'Previously Watched', filter: r => asArray(f(r, 'lists')).includes('Previously Watched') },
  favorites: { el: 'screen-list', title: 'Favorites', filter: r => f(r, 'favorite') === true || asArray(f(r, 'lists')).includes('Favorite') },
  rewatch: { el: 'screen-list', title: 'Rewatch Soon', filter: r => asArray(f(r, 'lists')).includes('Rewatch Soon') },
  hiddengems: { el: 'screen-list', title: 'Hidden Gems', filter: r => f(r, 'discoveryScore') === 'Hidden Gem' },
  movies: { el: 'screen-list', title: 'Movies Only', filter: r => f(r, 'type') === 'Movie' },
  tvshows: { el: 'screen-list', title: 'TV Shows Only', filter: r => f(r, 'type') === 'TV Show' },
  needrating: { el: 'screen-list', title: 'Need Rating', filter: r => !!f(r, 'needRating') && String(f(r, 'needRating')).trim() !== '' },
};

const ROWS = [
  { key: 'watchnext', title: 'Watch Next', filter: r => f(r, 'priority') === 'Watch Next' },
  { key: 'highpriority', title: 'High Priority', filter: r => f(r, 'priority') === 'High Priority' },
  { key: 'continuewatching', title: 'Continue Watching', filter: r => f(r, 'status') === 'Watching' },
  { key: 'english', title: 'English Recommendations', filter: r => asArray(f(r, 'lists')).includes('English Recommendation') },
  { key: 'foreign', title: 'Foreign Dub Recommendations', filter: r => asArray(f(r, 'lists')).includes('Foreign Dub Recommendation') },
  { key: 'hiddengems', title: 'Hidden Gems', filter: r => f(r, 'discoveryScore') === 'Hidden Gem' },
  { key: 'recentlyadded', title: 'Recently Added', filter: () => true, sortMode: 'recent' },
  { key: 'favorites', title: 'Favorites', filter: r => f(r, 'favorite') === true || asArray(f(r, 'lists')).includes('Favorite') },
  { key: 'mood-tactical', title: 'Tactical / Military', filter: r => asArray(f(r, 'mood')).includes('Tactical/Military') },
  { key: 'mood-crime', title: 'Crime / Thriller', filter: r => asArray(f(r, 'mood')).includes('Crime/Thriller') },
  { key: 'mood-scifi', title: 'Sci-Fi', filter: r => asArray(f(r, 'mood')).includes('Sci-Fi') },
  { key: 'previously', title: 'Previously Watched', filter: r => asArray(f(r, 'lists')).includes('Previously Watched') },
  { key: 'rewatch', title: 'Rewatch Soon', filter: r => asArray(f(r, 'lists')).includes('Rewatch Soon') },
];

const PRIORITY_ORDER = { 'Watch Next': 0, 'High Priority': 1, 'Watch Soon': 2, 'Backlog': 3, 'Someday': 4 };

function sortByPriorityThenMatch(list) {
  return list.slice().sort((a, b) => {
    const pa = PRIORITY_ORDER[f(a, 'priority')] ?? 9;
    const pb = PRIORITY_ORDER[f(b, 'priority')] ?? 9;
    if (pa !== pb) return pa - pb;
    return (pct(f(b, 'matchPct')) || 0) - (pct(f(a, 'matchPct')) || 0);
  });
}

function showScreen(name) {
  closeOverlay('moreSheet');
  closeOverlay('detailOverlay');
  closeOverlay('moodSheet');
  closeOverlay('pickSheet');
  CURRENT_SCREEN = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const def = SCREEN_MAP[name];
  if (!def) return;
  document.getElementById(def.el).classList.add('active');

  document.querySelectorAll('.navbtn').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === name);
  });

  if (def.el === 'screen-list') {
    renderListScreen(name);
  } else if (name === 'dashboard') {
    renderDashboard();
  } else if (name === 'stats') {
    renderStats();
  } else if (name === 'search') {
    renderSearch(document.getElementById('searchInput').value);
  } else if (name === 'addrec') {
    document.getElementById('arWriteWarning').classList.toggle('hidden', !!CONFIG.writeEnabled);
  } else if (name === 'bulkimport') {
    document.getElementById('bulkWriteWarning').classList.toggle('hidden', !!CONFIG.writeEnabled);
  }
}

function wireNav() {
  document.querySelectorAll('.navbtn[data-screen]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.screen === 'more') {
        openOverlay('moreSheet');
      } else {
        showScreen(btn.dataset.screen);
      }
    });
  });
  document.querySelectorAll('.more-item[data-screen]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.goto));
  });
  document.querySelector('[data-refresh]').addEventListener('click', async () => {
    toast('Refreshing…');
    try {
      RECORDS = await fetchAllRecords();
      saveCache(RECORDS);
      renderAll();
      toast('Up to date');
    } catch (e) {
      toast('Refresh failed');
    }
  });

  document.getElementById('dashStatsBtn').addEventListener('click', () => showScreen('stats'));

  document.getElementById('pickSomethingBtn').addEventListener('click', () => openPickSheet());
  document.getElementById('moodPickerBtn').addEventListener('click', () => openOverlay('moodSheet'));
  document.getElementById('moreMoodBtn').addEventListener('click', () => { closeOverlay('moreSheet'); openOverlay('moodSheet'); });
  document.getElementById('morePickBtn').addEventListener('click', () => { closeOverlay('moreSheet'); openPickSheet(); });

  document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      closeOverlay('moodSheet');
      showMoodResults(btn.dataset.mood);
    });
  });

  document.querySelectorAll('.pick-option').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pick-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      runPick(btn.dataset.pick);
    });
  });
}

function wireOverlays() {
  document.querySelectorAll('.overlay').forEach(ov => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov) ov.classList.add('hidden');
    });
  });
}
function openOverlay(id) { document.getElementById(id).classList.remove('hidden'); }
function closeOverlay(id) { document.getElementById(id).classList.add('hidden'); }

/* ---------------- Rendering: cards ---------------- */

function renderStars(rating) {
  if (!rating) return '';
  const n = Math.round(rating / 2);
  return '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(5 - Math.max(0, Math.min(5, n)));
}

function priorityClass(p) {
  if (p === 'Watch Next') return 'priority-watchnext';
  if (p === 'High Priority') return 'priority-high';
  return '';
}

function cardHTML(record) {
  const title = f(record, 'title') || 'Untitled';
  const type = f(record, 'type') || '';
  const year = f(record, 'year') || '';
  const match = pct(f(record, 'matchPct'));
  const priority = f(record, 'priority');
  const moods = asArray(f(record, 'mood')).slice(0, 3);
  const lang = f(record, 'language') || '';
  const streaming = asArray(f(record, 'currentStreaming'));
  const rating = f(record, 'actualRating') || f(record, 'personalRating');
  const why = f(record, 'why');
  const poster = posterUrl(record);

  const moodChips = moods.map(m => `<span class="chip-mini">${escapeHtml(m)}</span>`).join('');
  const priorityChip = priority ? `<span class="chip-mini ${priorityClass(priority)}">${escapeHtml(priority)}</span>` : '';
  const langChip = lang && lang !== 'English' ? `<span class="chip-mini lang-foreign">${escapeHtml(lang)}</span>` : '';

  return `
    <div class="title-card" data-id="${record.id}">
      <div class="card-poster ${poster ? '' : 'noimg'}" style="${poster ? `background-image:url('${poster}')` : ''}">
        ${poster ? '' : `<span class="noimg-initial">${escapeHtml((title || '?').charAt(0).toUpperCase())}</span>`}
      </div>
      <div class="card-body">
        <div class="card-top-row">
          <div>
            <p class="card-title">${escapeHtml(title)}</p>
            <div class="card-meta">${escapeHtml(type)}${type && year ? ' · ' : ''}${year || ''}</div>
          </div>
          ${match !== null ? `<div class="match-badge">${match}%</div>` : ''}
        </div>
        <div class="chip-mini-row">${priorityChip}${moodChips}${langChip}</div>
        ${why ? `<div class="card-why">${escapeHtml(why)}</div>` : ''}
        <div class="card-divider"></div>
        <div class="card-bottom-row">
          <span class="stars">${renderStars(rating) || '<span class="muted">unrated</span>'}</span>
          ${streaming.length ? streamChip(streaming[0]) : ''}
        </div>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function attachCardClicks(container) {
  container.querySelectorAll('.title-card').forEach(card => {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  });
}

/* ---------------- List screens ---------------- */

function renderListScreen(name) {
  const def = SCREEN_MAP[name];
  document.getElementById('listTitle').textContent = def.title;
  const filtered = RECORDS.filter(def.filter);
  document.getElementById('listCount').textContent = filtered.length;

  const container = document.getElementById('listContainer');
  const empty = document.getElementById('listEmpty');
  const subfilters = document.getElementById('listSubfilters');
  subfilters.innerHTML = '';

  const order = { 'Watch Next': 0, 'High Priority': 1, 'Watch Soon': 2, 'Backlog': 3, 'Someday': 4 };
  filtered.sort((a, b) => {
    const pa = order[f(a, 'priority')] ?? 9;
    const pb = order[f(b, 'priority')] ?? 9;
    if (pa !== pb) return pa - pb;
    return (pct(f(b, 'matchPct')) || 0) - (pct(f(a, 'matchPct')) || 0);
  });

  if (filtered.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    container.innerHTML = filtered.map(posterCardHTML).join('');
    container.querySelectorAll('.poster-card').forEach(card => {
      card.addEventListener('click', () => openDetail(card.dataset.id));
    });
    hydratePostersIn(container);
  }
}

/* ---------------- Fetch Missing Posters (Settings) ---------------- */

function wireFetchMissingPosters() {
  document.getElementById('fetchMissingPostersBtn').addEventListener('click', async () => {
    if (!CONFIG.tmdbKey) { toast('Add a TMDb API key above first'); return; }
    const statusEl = document.getElementById('posterFetchStatus');
    const missing = RECORDS.filter(r => !posterUrl(r));
    if (!missing.length) { statusEl.textContent = 'Every title already has artwork.'; return; }
    if (!CONFIG.writeEnabled) {
      statusEl.textContent = `Read-only mode: posters will display temporarily but won't be saved. Enable write access above to persist them.`;
    }

    let saved = 0, displayedOnly = 0, notFound = 0, fieldIssue = false;
    for (let i = 0; i < missing.length; i++) {
      const record = missing[i];
      statusEl.textContent = `Fetching ${i + 1} of ${missing.length}…`;
      const url = await fetchTmdbPoster(record);
      if (!url) { notFound++; }
      else if (CONFIG.writeEnabled) {
        const result = await savePosterUrlToAirtable(record, url);
        if (result.ok) saved++;
        else { displayedOnly++; fieldIssue = true; }
      } else {
        displayedOnly++;
      }
      await new Promise(res => setTimeout(res, 280)); // simple rate limit so we don't hammer TMDb
    }

    saveCache(RECORDS);
    renderAll();
    statusEl.textContent = `Done — ${saved} saved, ${notFound} not found on TMDb${displayedOnly ? `, ${displayedOnly} found but not saved` : ''}.`;
    if (fieldIssue) {
      statusEl.textContent += ` Add a "Poster URL" field (single line text or URL) to Titles in Airtable so these can be saved.`;
    }
    toast('Poster fetch complete');
  });
}

function showMoodResults(mood) {
  SCREEN_MAP.moodresult = {
    el: 'screen-list',
    title: `Mood: ${mood}`,
    filter: r => asArray(f(r, 'lists')).includes('Watch List') && asArray(f(r, 'mood')).includes(mood),
  };
  showScreen('moodresult');
}

/* ---------------- Pick Something ---------------- */

function poolForPick(kind) {
  const watchList = RECORDS.filter(r => asArray(f(r, 'lists')).includes('Watch List'));
  switch (kind) {
    case 'watchnext':
      return RECORDS.filter(r => f(r, 'priority') === 'Watch Next');
    case 'allwatchlist':
      return watchList;
    case 'english':
      return watchList.filter(r => asArray(f(r, 'lists')).includes('English Recommendation'));
    case 'foreign':
      return watchList.filter(r => asArray(f(r, 'lists')).includes('Foreign Dub Recommendation'));
    case 'under2h':
      return watchList.filter(r => {
        const mins = f(r, 'runtime');
        return typeof mins === 'number' && mins > 0 && mins < 120;
      });
    default:
      return watchList;
  }
}

function openPickSheet() {
  document.getElementById('pickResultWrap').innerHTML = '';
  document.querySelectorAll('.pick-option').forEach(b => b.classList.remove('active'));
  openOverlay('pickSheet');
}

function runPick(kind) {
  const pool = poolForPick(kind);
  const wrap = document.getElementById('pickResultWrap');
  if (!pool.length) {
    wrap.innerHTML = `<div class="pick-empty">No titles match that pool yet. Try a different option, or add some to your Watch List first.</div>`;
    return;
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  wrap.innerHTML = cardHTML(pick) + `<button class="pick-reroll" id="rerollBtn">🎲 Pick Again</button>`;
  attachCardClicks(wrap);
  document.getElementById('rerollBtn').addEventListener('click', () => runPick(kind));
}

/* ---------------- Hero ---------------- */

function pickHero() {
  const pool = RECORDS.filter(r => asArray(f(r, 'lists')).includes('Watch List'));
  if (!pool.length) return null;
  const watchNext = pool.filter(r => f(r, 'priority') === 'Watch Next');
  if (watchNext.length) {
    return watchNext.sort((a, b) => (pct(f(b, 'matchPct')) || 0) - (pct(f(a, 'matchPct')) || 0))[0];
  }
  const byMatch = pool.slice().sort((a, b) => (pct(f(b, 'matchPct')) || 0) - (pct(f(a, 'matchPct')) || 0));
  if (byMatch.length && pct(f(byMatch[0], 'matchPct')) !== null) return byMatch[0];
  const highPriority = pool.filter(r => f(r, 'priority') === 'High Priority');
  if (highPriority.length) return highPriority[0];
  return pool[0];
}

function renderHero() {
  const wrap = document.getElementById('heroWrap');
  const record = pickHero();
  if (!record) {
    wrap.innerHTML = `<div class="hero-empty">Your Watch List is empty — add titles in Airtable or browse Search to get started.</div>`;
    return;
  }
  const title = f(record, 'title') || 'Untitled';
  const type = f(record, 'type') || '';
  const year = f(record, 'year') || '';
  const match = pct(f(record, 'matchPct'));
  const moods = asArray(f(record, 'mood')).slice(0, 3);
  const streaming = asArray(f(record, 'currentStreaming'));
  const why = f(record, 'why');
  const poster = posterUrl(record);
  const priority = f(record, 'priority');

  wrap.innerHTML = `
    <div class="hero-card ${poster ? 'has-poster' : ''}" ${poster ? `style="background-image:url('${poster}')"` : ''} data-id="${record.id}">
      <div class="hero-scrim"></div>
      <div class="hero-content">
        <div class="hero-eyebrow">${priority ? '🎯 ' + escapeHtml(priority) : '✨ Recommended for you'}</div>
        <h2 class="hero-title">${escapeHtml(title)}</h2>
        <div class="hero-meta">${escapeHtml(type)}${type && year ? ' · ' : ''}${year || ''}${match !== null ? ' · ' + match + '% match' : ''}</div>
        <div class="hero-chip-row">
          ${moods.map(m => `<span class="chip-mini">${escapeHtml(m)}</span>`).join('')}
          ${streaming.length ? streamChip(streaming[0]) : ''}
        </div>
        ${why ? `<div class="hero-why">${escapeHtml(why)}</div>` : ''}
        <div class="hero-actions">
          <button class="hero-btn primary" id="heroViewBtn">View Details</button>
          <button class="hero-btn secondary" id="heroWatchedBtn">✔ Watched</button>
          <button class="hero-btn secondary" id="heroRateBtn">★ Rate</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('heroViewBtn').addEventListener('click', () => openDetail(record.id));
  document.getElementById('heroWatchedBtn').addEventListener('click', () => {
    if (!CONFIG.writeEnabled) { toast('Enable write access in Settings first'); return; }
    markWatched(record);
  });
  document.getElementById('heroRateBtn').addEventListener('click', () => {
    if (!CONFIG.writeEnabled) { toast('Enable write access in Settings first'); return; }
    openDetail(record.id);
  });
  hydratePostersIn(wrap);
}

/* ---------------- Horizontal rows ---------------- */

function posterCardHTML(record) {
  const title = f(record, 'title') || 'Untitled';
  const match = pct(f(record, 'matchPct'));
  const priority = f(record, 'priority');
  const rating = f(record, 'actualRating') || f(record, 'personalRating');
  const poster = posterUrl(record);
  const type = f(record, 'type') || '';
  const year = f(record, 'year') || '';

  return `
    <div class="poster-card" data-id="${record.id}">
      <div class="poster-card-img ${poster ? '' : 'noimg'}" ${poster ? `style="background-image:url('${poster}')"` : ''}>
        ${poster ? '' : `<div class="noimg-frame"></div><span class="noimg-title">${escapeHtml(title)}</span><span class="noimg-tag">${escapeHtml(type || 'Untitled')}</span>`}
        ${match !== null ? `<span class="poster-match-badge">${match}%</span>` : ''}
        ${priority === 'Watch Next' ? `<span class="poster-priority-badge">NEXT</span>` : ''}
      </div>
      <p class="poster-card-title">${escapeHtml(title)}</p>
      <div class="poster-card-sub">
        <span>${escapeHtml(type)}${type && year ? ' · ' : ''}${year || ''}</span>
        ${rating ? `<span class="stars">${renderStars(rating)}</span>` : ''}
      </div>
    </div>`;
}

function renderRows() {
  const container = document.getElementById('rowsContainer');
  const blocks = ROWS.map((row, idx) => {
    let items = RECORDS.filter(row.filter);
    if (row.sortMode === 'recent') {
      items = items.slice().sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
    } else {
      items = sortByPriorityThenMatch(items);
    }
    items = items.slice(0, 20);
    if (!items.length) return '';
    return `
      <div class="row-block" style="animation-delay:${Math.min(idx * 40, 240)}ms">
        <div class="row-header">
          <h2 class="section-label">${escapeHtml(row.title)}</h2>
          <span class="row-seeall">${items.length}</span>
        </div>
        <div class="row-scroll">${items.map(posterCardHTML).join('')}</div>
      </div>`;
  }).join('');
  container.innerHTML = blocks || '<p class="muted">No titles loaded yet.</p>';
  container.querySelectorAll('.poster-card').forEach(card => {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  });
  hydratePostersIn(container);
}



function wireSearch() {
  const input = document.getElementById('searchInput');
  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderSearch(input.value), 160);
  });
}

function renderSearch(q) {
  const container = document.getElementById('searchContainer');
  const query = (q || '').trim().toLowerCase();
  if (!query) { container.innerHTML = ''; return; }
  const results = RECORDS.filter(r => {
    const hay = [
      f(r, 'title'), f(r, 'franchise'), f(r, 'notes'), f(r, 'type'),
      f(r, 'language'), f(r, 'platform'), f(r, 'recSource'), f(r, 'why'),
      ...asArray(f(r, 'genres')), ...asArray(f(r, 'mood')), ...asArray(f(r, 'currentStreaming')),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(query);
  }).slice(0, 60);
  container.innerHTML = results.length ? results.map(posterCardHTML).join('') : '<p class="muted" style="padding:20px 4px;grid-column:1/-1">No matches. (Note: actor search isn\'t available — the Titles table doesn\'t track actors. Title, type, genre, mood, language, streaming service, and notes are all searched.)</p>';
  container.querySelectorAll('.poster-card').forEach(card => {
    card.addEventListener('click', () => openDetail(card.dataset.id));
  });
  hydratePostersIn(container);
}

/* ---------------- Dashboard ---------------- */

function renderDashboard() {
  renderHero();
  renderRows();
}

function topCounts(records, key, limit) {
  const counts = {};
  records.forEach(r => asArray(f(r, key)).forEach(v => { counts[v] = (counts[v] || 0) + 1; }));
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `<span class="chip">${escapeHtml(name)}<b>${count}</b></span>`)
    .join('') || '<span class="muted">No data yet</span>';
}

/* ---------------- Stats screen (deeper) ---------------- */

function barList(counts, total) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => {
      const w = total ? Math.round((count / total) * 100) : 0;
      return `<div class="bar-row">
        <span class="bar-label">${escapeHtml(name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(w, 4)}%"></span></span>
        <span class="bar-count">${count}</span>
      </div>`;
    }).join('') || '<p class="muted small">No data yet.</p>';
}

function renderStats() {
  const watched = RECORDS.filter(r => asArray(f(r, 'lists')).includes('Previously Watched') || f(r, 'status') === 'Watched');
  const movies = watched.filter(r => f(r, 'type') === 'Movie');
  const tv = watched.filter(r => f(r, 'type') === 'TV Show');
  const watchlist = RECORDS.filter(r => asArray(f(r, 'lists')).includes('Watch List'));
  const hiddenGems = RECORDS.filter(r => f(r, 'discoveryScore') === 'Hidden Gem');
  const foreignDub = RECORDS.filter(r => f(r, 'language') === 'Foreign - Dubbed' || asArray(f(r, 'lists')).includes('Foreign Dub Recommendation'));
  const ratings = watched.map(r => f(r, 'actualRating') || f(r, 'personalRating')).filter(v => typeof v === 'number');
  const avgRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : '—';

  const topTiles = [
    [RECORDS.length, 'Total Titles'],
    [watched.length, 'Watched'],
    [watchlist.length, 'Watch List'],
    [movies.length, 'Movies Watched'],
    [tv.length, 'TV Watched'],
    [avgRating, 'Avg Rating'],
    [hiddenGems.length, 'Hidden Gems'],
    [foreignDub.length, 'Foreign Dub'],
  ];

  const genreCounts = {};
  RECORDS.forEach(r => asArray(f(r, 'genres')).forEach(g => { genreCounts[g] = (genreCounts[g] || 0) + 1; }));
  const moodCounts = {};
  RECORDS.forEach(r => asArray(f(r, 'mood')).forEach(m => { moodCounts[m] = (moodCounts[m] || 0) + 1; }));
  const sourceCounts = {};
  RECORDS.forEach(r => { const s = f(r, 'recSource'); if (s) sourceCounts[s] = (sourceCounts[s] || 0) + 1; });
  const byYear = {};
  watched.forEach(r => { const y = f(r, 'year'); if (y) byYear[y] = (byYear[y] || 0) + 1; });

  const body = document.getElementById('statsBody');
  body.innerHTML = `
    <div class="stat-grid2">
      ${topTiles.map(([num, label]) => `<div class="stat-tile"><span class="stat-num">${num}</span><span class="stat-label">${label}</span></div>`).join('')}
    </div>

    <div class="dash-block">
      <h2 class="section-label">Top 5 genres</h2>
      <div class="bar-list">${barList(genreCounts, RECORDS.length)}</div>
    </div>

    <div class="dash-block">
      <h2 class="section-label">Top 5 moods</h2>
      <div class="bar-list">${barList(moodCounts, RECORDS.length)}</div>
    </div>

    <div class="dash-block">
      <h2 class="section-label">Watched by release year</h2>
      <div class="chip-row">${Object.entries(byYear).sort((a, b) => b[0] - a[0]).slice(0, 10).map(([y, c]) => `<span class="chip">${y}<b>${c}</b></span>`).join('') || '<span class="muted">No data</span>'}</div>
    </div>

    <div class="dash-block">
      <h2 class="section-label">Recommendation sources</h2>
      <div class="chip-row">${Object.entries(sourceCounts).map(([s, c]) => `<span class="chip">${escapeHtml(s)}<b>${c}</b></span>`).join('') || '<span class="muted">No data</span>'}</div>
    </div>
  `;
}

/* ---------------- Detail sheet ---------------- */

function openDetail(id) {
  const record = RECORDS.find(r => r.id === id);
  if (!record) return;
  const sheet = document.getElementById('detailSheet');
  const poster = posterUrl(record);
  const title = f(record, 'title') || 'Untitled';
  const type = f(record, 'type') || '';
  const year = f(record, 'year') || '';
  const match = pct(f(record, 'matchPct'));
  const confidence = pct(f(record, 'confidencePct'));
  const predicted = f(record, 'predictedRating');
  const discovery = f(record, 'discoveryScore');
  const gemScore = f(record, 'hiddenGemScore');
  const why = f(record, 'why');
  const recSource = f(record, 'recSource');
  const recRound = f(record, 'recRound');
  const genres = asArray(f(record, 'genres'));
  const moods = asArray(f(record, 'mood'));
  const lang = f(record, 'language');
  const streaming = asArray(f(record, 'currentStreaming'));
  const platform = f(record, 'platform');
  const franchise = f(record, 'franchise');
  const completion = f(record, 'franchiseCompletion');
  const canon = f(record, 'canon');
  const notes = f(record, 'notes');
  const personalRating = f(record, 'personalRating');
  const actualRating = f(record, 'actualRating');
  const status = f(record, 'status');
  const owned = [
    f(record, 'k4') && '4K', f(record, 'bluray') && 'Blu-ray',
    f(record, 'dvd') && 'DVD', f(record, 'digital') && 'Digital',
  ].filter(Boolean);
  const runtime = f(record, 'runtime');
  const isFavorite = f(record, 'favorite') === true || asArray(f(record, 'lists')).includes('Favorite');
  const isRewatch = asArray(f(record, 'lists')).includes('Rewatch Soon');
  const smartReason = computeSmartReason(record);

  sheet.innerHTML = `
    <div class="close-sheet"></div>
    ${poster ? `<div class="detail-banner" style="background-image:url('${poster}')"></div>` : ''}
    <div class="detail-poster-wrap">
      <div class="detail-poster large ${poster ? '' : 'noimg'}" ${poster ? `style="background-image:url('${poster}')"` : ''}>
        ${poster ? '' : `<span class="noimg-title">${escapeHtml(title)}</span>`}
      </div>
    </div>
    <h2 class="detail-title">${escapeHtml(title)}</h2>
    <div class="detail-meta">${escapeHtml(type)}${type && year ? ' · ' : ''}${year || ''}${status ? ' · ' + escapeHtml(status) : ''}</div>

    <div class="chip-row" style="margin-bottom:16px">
      ${match !== null ? `<span class="chip">Match<b>${match}%</b></span>` : ''}
      ${confidence !== null ? `<span class="chip">Confidence<b>${confidence}%</b></span>` : ''}
      ${predicted ? `<span class="chip">Predicted<b>${predicted}</b></span>` : ''}
      ${discovery ? `<span class="chip">${escapeHtml(discovery)}</span>` : ''}
      ${gemScore ? `<span class="chip">Gem Score<b>${gemScore}</b></span>` : ''}
    </div>

    ${why ? `<div class="detail-section"><h3>Why It Was Recommended</h3><p>${escapeHtml(why)}</p>${smartReason ? `<p class="smart-reason">🧠 ${escapeHtml(smartReason)}</p>` : ''}</div>` : (smartReason ? `<div class="detail-section"><h3>Why This Fits You</h3><p class="smart-reason">🧠 ${escapeHtml(smartReason)}</p></div>` : '')}

    <div class="detail-section">
      <h3>Ratings</h3>
      <p class="muted small">Personal: ${personalRating ? renderStars(personalRating) + ` (${personalRating}/10)` : 'unrated'} &nbsp;·&nbsp; Actual: ${actualRating ? renderStars(actualRating) + ` (${actualRating}/10)` : 'unrated'}</p>
      <div class="rating-row-label">${CONFIG.writeEnabled ? 'Tap to rate (writes to Airtable)' : 'Rating (enable write access in Settings to edit)'}</div>
      <div class="rating-buttons" id="ratingButtons">
        ${[1,2,3,4,5,6,7,8,9,10].map(n => `<button class="rate-btn ${actualRating === n ? 'active' : ''} ${CONFIG.writeEnabled ? '' : 'disabled'}" data-rate="${n}">${n}</button>`).join('')}
      </div>
    </div>

    ${(genres.length || moods.length) ? `<div class="detail-section"><h3>Genres &amp; Mood</h3>
      ${genres.length ? `<div class="chip-row" style="margin-bottom:6px">${genres.map(g => `<span class="chip">${escapeHtml(g)}</span>`).join('')}</div>` : ''}
      ${moods.length ? `<div class="chip-row">${moods.map(m => `<span class="chip">${escapeHtml(m)}</span>`).join('')}</div>` : ''}
    </div>` : ''}

    <div class="detail-section">
      <h3>Watch Info</h3>
      <p class="muted small">${lang ? escapeHtml(lang) : ''}${lang && runtime ? ' · ' : ''}${runtime ? runtime + ' min' : ''}</p>
      <div class="chip-row" style="margin-top:8px">
        ${streaming.length ? streaming.map(streamChip).join('') : (platform ? streamChip(platform) : '<span class="muted small">Streaming not set</span>')}
      </div>
    </div>

    <div class="detail-section">
      <h3>Ownership</h3>
      <p class="muted small">${owned.length ? owned.join(' · ') : 'Not owned on physical/digital media'}</p>
    </div>

    ${(franchise || canon) ? `<div class="detail-section"><h3>Franchise &amp; Canon</h3>
      ${franchise ? `<p class="muted small">${escapeHtml(franchise)}${completion ? ' — ' + escapeHtml(completion) : ''}</p>` : ''}
      ${canon ? `<p class="muted small">${escapeHtml(canon)}</p>` : ''}
    </div>` : ''}

    ${(recSource || recRound) ? `<div class="detail-section"><h3>Recommendation Info</h3><p class="muted small">${escapeHtml(recSource || '')}${recSource && recRound ? ' · ' : ''}${escapeHtml(recRound || '')}</p></div>` : ''}
    ${notes ? `<div class="detail-section"><h3>Notes</h3><p class="muted small">${escapeHtml(notes)}</p></div>` : ''}

    <div class="detail-actions">
      <button class="btn-secondary ${CONFIG.writeEnabled ? '' : 'disabled'}" id="markWatchedBtn">✔ Mark Watched</button>
      <button class="btn-secondary ${isFavorite ? 'btn-active' : ''} ${CONFIG.writeEnabled ? '' : 'disabled'}" id="favBtn">${isFavorite ? '★ Favorited' : '☆ Favorite'}</button>
      <button class="btn-secondary ${isRewatch ? 'btn-active' : ''} ${CONFIG.writeEnabled ? '' : 'disabled'}" id="rewatchBtn">${isRewatch ? '🔁 Rewatch Soon ✓' : '🔁 Rewatch Soon'}</button>
    </div>
    ${!CONFIG.writeEnabled ? '<p class="muted small">Read-only mode — enable a write-scoped token in Settings to use these.</p>' : ''}
  `;

  openOverlay('detailOverlay');

  if (CONFIG.writeEnabled) {
    document.getElementById('markWatchedBtn').addEventListener('click', () => markWatched(record));
    document.getElementById('favBtn').addEventListener('click', () => toggleFavorite(record));
    document.getElementById('rewatchBtn').addEventListener('click', () => toggleRewatch(record));
    document.querySelectorAll('#ratingButtons .rate-btn').forEach(btn => {
      btn.addEventListener('click', () => rateInline(record, parseInt(btn.dataset.rate, 10)));
    });
  }
}

async function toggleFavorite(record) {
  const current = f(record, 'favorite') === true;
  try {
    toast('Saving…');
    await patchRecord(record.id, { [FIELDS.favorite]: !current });
    record.fields[FIELDS.favorite] = !current;
    saveCache(RECORDS);
    toast(!current ? 'Added to Favorites' : 'Removed from Favorites');
    openDetail(record.id);
    renderAll();
  } catch (e) {
    console.error(e);
    toast('Could not save — check write permissions');
  }
}

async function toggleRewatch(record) {
  const lists = new Set(asArray(f(record, 'lists')));
  const has = lists.has('Rewatch Soon');
  if (has) lists.delete('Rewatch Soon'); else lists.add('Rewatch Soon');
  try {
    toast('Saving…');
    await patchRecord(record.id, { [FIELDS.lists]: Array.from(lists) });
    record.fields[FIELDS.lists] = Array.from(lists);
    saveCache(RECORDS);
    toast(has ? 'Removed from Rewatch Soon' : 'Added to Rewatch Soon');
    openDetail(record.id);
    renderAll();
  } catch (e) {
    console.error(e);
    toast('Could not save — check write permissions');
  }
}

async function rateInline(record, num) {
  try {
    toast('Saving…');
    await patchRecord(record.id, { [FIELDS.actualRating]: num });
    record.fields[FIELDS.actualRating] = num;
    saveCache(RECORDS);
    toast(`Rated ${num}/10`);
    openDetail(record.id);
    renderAll();
  } catch (e) {
    console.error(e);
    toast('Could not save — check write permissions');
  }
}

async function markWatched(record) {
  const lists = new Set(asArray(f(record, 'lists')));
  lists.delete('Watch List');
  lists.add('Previously Watched');
  const fields = {
    [FIELDS.status]: 'Watched',
    [FIELDS.lists]: Array.from(lists),
  };
  try {
    toast('Saving…');
    await patchRecord(record.id, fields);
    record.fields[FIELDS.status] = 'Watched';
    record.fields[FIELDS.lists] = Array.from(lists);
    saveCache(RECORDS);
    toast('Marked watched');
    closeOverlay('detailOverlay');
    renderAll();
  } catch (e) {
    console.error(e);
    toast('Could not save — check write permissions');
  }
}

/* (Quick Rate via prompt() replaced in v2 by inline rateInline() buttons in the detail sheet) */

/* ---------------- Render orchestration ---------------- */

function renderAll() {
  if (CURRENT_SCREEN === 'dashboard') renderDashboard();
  else if (SCREEN_MAP[CURRENT_SCREEN] && SCREEN_MAP[CURRENT_SCREEN].el === 'screen-list') renderListScreen(CURRENT_SCREEN);
  else if (CURRENT_SCREEN === 'stats') renderStats();
  if (document.getElementById('screen-dashboard')) renderDashboard();
}

/* ---------------- Service worker ---------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

boot();
