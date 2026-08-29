import { SCAN_CONCURRENCY } from './config.js';
import { pool, escapeHtml, slug, round, clearCache } from './util.js';
import { gatherSignals, coverUrl } from './sources.js';
import { scoreBook, recommendFormat, findComps, FACTOR_LABELS, FACTOR_BLURBS } from './score.js';
import { buildTemplatedPitch, generateAIPitch } from './pitch.js';
import { loadHistory, delta, movers, trendPath } from './history.js';
import * as store from './store.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  slate: [],
  books: [],          // { id, seed, signals, score, format }
  weights: store.getWeights(),
  verdicts: store.getVerdicts(),
  notes: store.getNotes(),
  selectedId: null,
  history: null,       // null until the harvest has run; the board works without it
  filter: 'all',
  query: '',
  scanning: false,
};

/* ------------------------------- bootstrap -------------------------------- */

async function init() {
  bindChrome();
  renderWeightControls();

  let slate = store.getSlate();
  if (!slate) {
    const res = await fetch('data/slate.json');
    slate = (await res.json()).titles;
    store.setSlate(slate);
  }
  state.slate = slate;

  renderEmpty();

  // Fire the history fetch alongside the scan rather than before it: the board
  // must not wait on an optional file, and a repo that has never run the
  // harvest has no history to wait for.
  const histReady = loadHistory().then((h) => {
    state.history = h;
    renderMovers();
    if (state.books.length) render();
  });

  await scan();
  await histReady;
}

/* --------------------------------- scan ----------------------------------- */

async function scan(seeds = state.slate) {
  if (state.scanning) return;
  state.scanning = true;
  setStatus(`Scanning ${seeds.length} titles across Open Library, Wikipedia, Pageviews and HN…`, true);
  $('#scan-btn').disabled = true;

  const bar = $('#progress-bar');
  bar.hidden = false;
  bar.style.setProperty('--pct', '0%');

  const results = await pool(seeds, SCAN_CONCURRENCY, gatherSignals, (done, total) => {
    bar.style.setProperty('--pct', `${Math.round((done / total) * 100)}%`);
    setStatus(`Scanning… ${done}/${total}`, true);
  });

  const incoming = results
    .filter((s) => s && !s.error)
    .map((signals) => makeBook(signals));

  // Merge: replace matching ids, append the rest.
  const byId = new Map(state.books.map((b) => [b.id, b]));
  for (const b of incoming) byId.set(b.id, b);
  state.books = Array.from(byId.values());

  rescoreAll();
  bar.hidden = true;
  $('#scan-btn').disabled = false;
  state.scanning = false;

  const dead = results.length - incoming.length;
  setStatus(
    `${state.books.length} titles scored · live data from Open Library, Wikipedia, Wikimedia Pageviews and HN` +
    (dead ? ` · ${dead} title${dead > 1 ? 's' : ''} returned no data` : ''),
  );
  render();
}

function makeBook(signals) {
  return {
    id: slug(`${signals.seed.title}-${signals.seed.author || ''}`),
    seed: signals.seed,
    signals,
    score: null,
    format: null,
  };
}

function rescoreAll() {
  for (const b of state.books) {
    b.score = scoreBook(b.signals, state.weights);
    b.format = recommendFormat(b.signals, b.score.factors);
  }
  state.books.sort((a, b) => b.score.aps - a.score.aps);
}

/* -------------------------------- rendering -------------------------------- */

function visibleBooks() {
  const q = state.query.trim().toLowerCase();
  return state.books.filter((b) => {
    const v = state.verdicts[b.id];
    if (state.filter === 'watchlist' && v !== 'watchlist') return false;
    if (state.filter === 'passed' && v !== 'pass') return false;
    if (state.filter === 'all' && v === 'pass') return false; // passes hide from the main board
    if (state.filter === 'clear' && b.score.factors.whitespace.parts.status !== 'clear') return false;
    if (!q) return true;
    const hay = `${b.seed.title} ${b.seed.author} ${(b.signals.ol?.subjects || []).join(' ')}`.toLowerCase();
    return hay.includes(q);
  });
}

function render() {
  const books = visibleBooks();
  const list = $('#board');

  if (!books.length) {
    list.innerHTML = `<li class="empty">No titles match this view.</li>`;
  } else {
    list.innerHTML = books.map((b, i) => rowHtml(b, i + 1)).join('');
  }

  $('#count').textContent = `${books.length} shown / ${state.books.length} scanned`;
  $$('#board .row').forEach((el) => {
    el.addEventListener('click', () => selectBook(el.dataset.id));
  });

  if (state.selectedId && state.books.some((b) => b.id === state.selectedId)) {
    renderDetail(state.books.find((b) => b.id === state.selectedId));
  }
}

function bandClass(aps) {
  if (aps >= 75) return 'band-hot';
  if (aps >= 60) return 'band-warm';
  if (aps >= 45) return 'band-mid';
  return 'band-cool';
}

function statusFlag(ws) {
  const { status, confirmed } = ws.parts;
  if (status === 'clear') return '<span class="flag flag-clear">lane clear</span>';
  if (status === 'in-dev') return '<span class="flag flag-dev">in development</span>';
  if (status === 'unknown') return '<span class="flag flag-thin">status unknown</span>';
  return `<span class="flag flag-taken">${confirmed ? 'adapted' : 'likely adapted'}</span>`;
}

function rowHtml(b, rank) {
  const v = state.verdicts[b.id];
  const author = b.signals.ol?.authors?.[0] || b.seed.author || '';
  const conf = Math.round(b.score.confidence * 100);
  return `
    <li class="row ${b.id === state.selectedId ? 'is-selected' : ''}" data-id="${b.id}" tabindex="0">
      <span class="rank">${rank}</span>
      <span class="row-main">
        <span class="row-title">${escapeHtml(b.signals.ol?.title || b.seed.title)}</span>
        <span class="row-meta">${escapeHtml(author)}${b.signals.ol?.year ? ` · ${b.signals.ol.year}` : ''} · ${escapeHtml(b.format.format)}</span>
      </span>
      <span class="row-flags">
        ${v === 'watchlist' ? '<span class="flag flag-watch">watching</span>' : ''}
        ${v === 'pass' ? '<span class="flag flag-pass">passed</span>' : ''}
        ${statusFlag(b.score.factors.whitespace)}
        ${conf < 55 ? `<span class="flag flag-thin">thin data ${conf}%</span>` : ''}
      </span>
      ${deltaBadge(b.id)}
      <span class="spark">${sparkline(b.signals.pv?.series || [])}</span>
      <span class="aps ${bandClass(b.score.aps)}">${round(b.score.aps, 0)}</span>
    </li>`;
}

/**
 * Absent history, this renders nothing at all rather than a placeholder: an
 * empty badge column on a board that has never been harvested would be a
 * promise the page cannot keep.
 */
function deltaBadge(id) {
  const d = delta(state.history, id);
  if (!d) return '';
  // A column of "0" badges down a board of stable titles is noise pretending to
  // be information. Only titles that actually moved get one.
  if (Math.abs(d.change) < 1) return '';
  const cls = d.change > 0 ? 'delta-up' : 'delta-down';
  const sign = d.change > 0 ? '+' : '';
  const why = d.driver ? `, mostly ${d.driver}` : '';
  const over = d.days ? ` over ${d.days}d` : '';
  return `<span class="delta ${cls}" title="APS ${d.from} to ${d.to}${over}${why}">${sign}${d.change}</span>`;
}

function renderMovers() {
  const panel = $('#movers-panel');
  const list = movers(state.history, 5);
  if (!list.length) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#movers').innerHTML = list.map((m) => {
    const cls = m.change > 0 ? 'delta-up' : 'delta-down';
    const sign = m.change > 0 ? '+' : '';
    return `<li data-id="${m.id}">
      <span class="delta ${cls}">${sign}${m.change}</span>
      <span class="mover-title">${escapeHtml(m.title)}</span>
      ${m.driver ? `<span class="mover-why">${escapeHtml(m.driver)}</span>` : ''}
    </li>`;
  }).join('');
  $('#movers').querySelectorAll('li').forEach((el) => {
    el.addEventListener('click', () => selectBook(el.dataset.id));
  });
  const n = state.history?.snaps?.length || 0;
  $('#movers-foot').textContent =
    `${n} snapshot${n === 1 ? '' : 's'}, latest ${state.history?.latest?.date || '—'}.`;
}

function trendSvg(id) {
  const d = delta(state.history, id);
  if (!d) return '';
  const path = trendPath(d.points);
  if (!path) return '';
  const sign = d.change > 0 ? '+' : '';
  return `<div class="trend-line">
    <span class="trend"><svg viewBox="0 0 96 24" aria-hidden="true"><path d="${path}"/></svg></span>
    <span class="dim tiny">APS ${d.from} &rarr; ${d.to} (${sign}${d.change}) across ${d.span} snapshots${d.driver ? `, driven by ${escapeHtml(d.driver)} ${d.driverChange > 0 ? '+' : ''}${d.driverChange}` : ''}</span>
  </div>`;
}

function sparkline(series) {
  if (!series.length) return '<svg viewBox="0 0 60 18" aria-hidden="true"></svg>';
  const pts = series.slice(-60);
  const max = Math.max(...pts, 1);
  const step = 60 / Math.max(pts.length - 1, 1);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(17 - (v / max) * 16).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 60 18" aria-hidden="true"><path d="${d}"/></svg>`;
}

/* ------------------------------ detail panel ------------------------------- */

function selectBook(id) {
  state.selectedId = id;
  render();
  $('#detail').scrollTop = 0;
}

function renderDetail(b) {
  const { ol, wiki, gb, pv, hn } = b.signals;
  const cover = coverUrl(ol?.coverId, 'M');
  const v = state.verdicts[b.id];
  const comps = findComps(b, state.books);
  const note = state.notes[b.id] || '';

  $('#detail').innerHTML = `
    <header class="detail-head">
      ${cover ? `<img class="cover" src="${cover}" alt="" loading="lazy">` : '<div class="cover cover-blank"></div>'}
      <div>
        <h2>${escapeHtml(ol?.title || b.seed.title)}</h2>
        <p class="byline">${escapeHtml(ol?.authors?.join(', ') || b.seed.author || 'Unknown author')}${ol?.year ? ` · ${ol.year}` : ''}${ol?.pages ? ` · ${ol.pages}pp` : ''}</p>
        <p class="score-line">
          <span class="aps-big ${bandClass(b.score.aps)}">${round(b.score.aps, 1)}</span>
          <span class="aps-label">Adaptation Potential<br><span class="dim">${Math.round(b.score.confidence * 100)}% data confidence</span></span>
        </p>
        ${trendSvg(b.id)}
        <div class="verdict-row">
          <button class="btn ${v === 'watchlist' ? 'btn-on' : ''}" data-act="watchlist">${v === 'watchlist' ? '✓ Watching' : 'Add to watchlist'}</button>
          <button class="btn ${v === 'pass' ? 'btn-on' : ''}" data-act="pass">${v === 'pass' ? '✓ Passed' : 'Pass'}</button>
        </div>
      </div>
    </header>

    <section class="panel">
      <h3>Signal breakdown</h3>
      ${Object.entries(b.score.factors).map(([k, f]) => `
        <div class="factor">
          <div class="factor-head">
            <span class="factor-name" title="${escapeHtml(FACTOR_BLURBS[k])}">${FACTOR_LABELS[k]}</span>
            <span class="factor-weight">w${state.weights[k]}</span>
            <span class="factor-score">${Math.round(f.score)}</span>
          </div>
          <div class="meter"><i style="width:${Math.round(f.score)}%"></i></div>
          <p class="factor-detail">${escapeHtml(f.detail)}</p>
        </div>`).join('')}
    </section>

    <section class="panel">
      <h3>Format read</h3>
      <p class="format-pick">${escapeHtml(b.format.format)}</p>
      <p class="dim">${escapeHtml(b.format.why)}</p>
    </section>

    <section class="panel">
      <h3>Coverage <span class="tag">${store.getApiKey() ? 'AI available' : 'templated'}</span></h3>
      <div id="pitch-out">${pitchHtml(buildTemplatedPitch(b))}</div>
      <button class="btn btn-primary" id="ai-pitch-btn">${store.getApiKey() ? 'Generate AI coverage' : 'Add API key for AI coverage'}</button>
    </section>

    <section class="panel">
      <h3>Comparables <span class="dim">(from this slate)</span></h3>
      ${comps.length
        ? `<ul class="comps">${comps.map((c) => `
            <li><button data-comp="${c.book.id}">${escapeHtml(c.book.signals.ol?.title || c.book.seed.title)}</button>
            <span class="dim">${round(c.book.score.aps, 0)} · ${escapeHtml(c.shared.slice(0, 3).join(', '))}</span></li>`).join('')}</ul>`
        : '<p class="dim">No strong subject overlap with other scanned titles.</p>'}
    </section>

    <section class="panel">
      <h3>Notes</h3>
      <textarea id="note" rows="4" placeholder="Development notes — saved locally.">${escapeHtml(note)}</textarea>
    </section>

    <section class="panel">
      <h3>Sources</h3>
      <ul class="sources">
        <li>Open Library: ${ol ? `<a target="_blank" rel="noopener" href="https://openlibrary.org${ol.workKey}">${escapeHtml(ol.workKey)}</a>` : '<span class="dim">no match</span>'}</li>
        <li>Wikipedia: ${wiki?.url ? `<a target="_blank" rel="noopener" href="${wiki.url}">${escapeHtml(wiki.page)}</a>` : '<span class="dim">no article</span>'}</li>
        <li>Pageviews: ${pv ? `${pv.total.toLocaleString()} over ${pv.days}d, peak ${pv.peak.toLocaleString()}` : '<span class="dim">unavailable</span>'}</li>
        <li>Hacker News: ${hn ? `${hn.total} mentions` : '<span class="dim">unavailable</span>'}</li>
        <li>Adaptation check: ${adaptSourceHtml(b.signals.adapt)}</li>
        <li>Google Books: ${gb ? 'enriched' : '<span class="dim">quota exhausted or no match</span>'}</li>
      </ul>
    </section>
  `;

  $('#detail').querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      state.verdicts = store.setVerdict(b.id, state.verdicts[b.id] === act ? null : act);
      render();
    });
  });
  $('#detail').querySelectorAll('[data-comp]').forEach((btn) => {
    btn.addEventListener('click', () => selectBook(btn.dataset.comp));
  });
  $('#note').addEventListener('change', (e) => {
    state.notes = store.setNote(b.id, e.target.value);
  });
  $('#ai-pitch-btn').addEventListener('click', () => onAIPitch(b));
}

function adaptSourceHtml(adapt) {
  if (!adapt) return '<span class="dim">unavailable</span>';
  if (adapt.siblings.length) {
    return adapt.siblings.slice(0, 2).map((t) =>
      `<a target="_blank" rel="noopener" href="https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}">${escapeHtml(t)}</a>`
    ).join(', ');
  }
  if (adapt.evidence.length) return `<span class="dim">${escapeHtml(adapt.evidence[0].slice(0, 120))}…</span>`;
  return `<span class="dim">no sibling article; ${adapt.hasSection ? 'adaptation section read, nothing found' : 'no adaptation section in article'}</span>`;
}

function pitchHtml(p) {
  if (p.kind === 'ai') {
    if (p.raw) return `<pre class="raw">${escapeHtml(p.raw)}</pre>`;
    return `
      <p class="logline">${escapeHtml(p.logline || '')}</p>
      <dl class="pitch">
        <dt>Format</dt><dd>${escapeHtml(p.format || '')} — ${escapeHtml(p.format_rationale || '')}</dd>
        <dt>Why now</dt><dd>${escapeHtml(p.why_now || '')}</dd>
        <dt>Comps</dt><dd>${escapeHtml(p.comparables || '')}</dd>
        <dt>Risks</dt><dd>${escapeHtml(p.risks || '')}</dd>
        <dt>Verdict</dt><dd><strong>${escapeHtml(p.verdict || '')}</strong></dd>
      </dl>
      <p class="dim tiny">Generated by Claude from the signal data above.</p>`;
  }
  return `
    <p class="logline">${escapeHtml(p.logline)}</p>
    <dl class="pitch">
      <dt>Format</dt><dd>${escapeHtml(p.format)} — ${escapeHtml(p.formatWhy)}</dd>
      <dt>Why now</dt><dd>${escapeHtml(p.whyNow)}</dd>
      <dt>Strengths</dt><dd>${escapeHtml(p.strengths)}</dd>
      <dt>Risk</dt><dd>${escapeHtml(p.risk)}</dd>
    </dl>
    <p class="dim tiny">Templated from source data — no model involved. Add an API key for written coverage.</p>`;
}

async function onAIPitch(b) {
  if (!store.getApiKey()) { openSettings(); return; }
  const out = $('#pitch-out');
  const btn = $('#ai-pitch-btn');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const pitch = await generateAIPitch(b);
    out.innerHTML = pitchHtml(pitch);
  } catch (err) {
    out.insertAdjacentHTML('beforeend', `<p class="error">Claude request failed: ${escapeHtml(err.message)}</p>`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate AI coverage';
  }
}

/* -------------------------------- controls -------------------------------- */

function renderWeightControls() {
  $('#weights').innerHTML = Object.entries(state.weights).map(([k, v]) => `
    <label class="weight" title="${escapeHtml(FACTOR_BLURBS[k])}">
      <span>${FACTOR_LABELS[k]}</span>
      <output>${v}</output>
      <input type="range" min="0" max="40" value="${v}" data-w="${k}">
    </label>`).join('');

  $$('#weights input').forEach((input) => {
    input.addEventListener('input', (e) => {
      const k = e.target.dataset.w;
      state.weights[k] = Number(e.target.value);
      e.target.previousElementSibling.textContent = e.target.value;
      store.setWeights(state.weights);
      if (state.books.length) { rescoreAll(); render(); }
    });
  });
}

function bindChrome() {
  $('#scan-btn').addEventListener('click', () => scan());
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });

  $$('.filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.filter').forEach((b) => b.classList.remove('is-on'));
      btn.classList.add('is-on');
      state.filter = btn.dataset.filter;
      render();
    });
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#add-title').value.trim();
    const author = $('#add-author').value.trim();
    if (!title) return;
    const seed = { title, author };
    state.slate = [...state.slate, seed];
    store.setSlate(state.slate);
    $('#add-title').value = '';
    $('#add-author').value = '';
    await scan([seed]);
    const id = slug(`${title}-${author}`);
    if (state.books.some((b) => b.id === id)) selectBook(id);
  });

  $('#reset-weights').addEventListener('click', () => {
    store.resetWeights();
    state.weights = store.getWeights();
    renderWeightControls();
    rescoreAll();
    render();
  });

  $('#export-btn').addEventListener('click', exportCsv);
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => $('#settings').close());
  $('#save-key').addEventListener('click', () => {
    store.setApiKey($('#api-key').value.trim());
    $('#settings').close();
    if (state.selectedId) render();
  });
  $('#clear-cache').addEventListener('click', () => {
    const n = clearCache();
    setStatus(`Cleared ${n} cached signal entries. Re-scan for fresh data.`);
  });
}

function openSettings() {
  $('#api-key').value = store.getApiKey();
  $('#settings').showModal();
}

function exportCsv() {
  const cols = ['rank', 'title', 'author', 'year', 'aps', 'confidence', 'format', 'adaptation_status',
    ...Object.keys(state.weights), 'verdict', 'notes'];
  const rows = visibleBooks().map((b, i) => [
    i + 1,
    b.signals.ol?.title || b.seed.title,
    b.signals.ol?.authors?.join('; ') || b.seed.author || '',
    b.signals.ol?.year || '',
    b.score.aps,
    b.score.confidence,
    b.format.format,
    b.score.factors.whitespace.parts.status || '',
    ...Object.keys(state.weights).map((k) => Math.round(b.score.factors[k].score)),
    state.verdicts[b.id] || '',
    (state.notes[b.id] || '').replace(/\s+/g, ' '),
  ]);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cols, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `adaptation-radar-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function setStatus(text, busy = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('is-busy', busy);
}

function renderEmpty() {
  $('#detail').innerHTML = `<div class="placeholder">
    <h2>Adaptation Radar</h2>
    <p>Ranks books by how well they'd travel to screen, using live public signal data.
    Select a title to see its breakdown.</p>
  </div>`;
}

init();
