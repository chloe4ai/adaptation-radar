import { CACHE_TTL_MS, FETCH_TIMEOUT_MS, USER_AGENT } from './config.js';

export const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export const round = (n, d = 0) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * Log-compressed 0–100 scale. Reader counts and mention counts are heavily
 * power-law distributed; a linear scale would put everything at 2 and the
 * one runaway bestseller at 100.
 */
export const logScale = (value, ceiling) => {
  if (!value || value <= 0) return 0;
  return clamp((100 * Math.log10(1 + value)) / Math.log10(1 + ceiling));
};

export const isoDaysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

export const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- fetch policy: retries, Retry-After cap, per-host spacing ---------- */

/**
 * Browser defaults stay modest: a person is watching the board fill in, and
 * waiting 40 s on one Retry-After is worse than showing that title as partial.
 * The harvester has no one waiting, so it raises the cap (see configureFetch).
 */
const fetchPolicy = {
  retries: 2,
  maxRetryAfterMs: 4000,
  hostSpacingMs: 250,
};

/** Override the fetch policy, e.g. `{ retries: 3, maxRetryAfterMs: 60000 }`. */
export function configureFetch(opts = {}) {
  Object.assign(fetchPolicy, opts);
  return { ...fetchPolicy };
}

// Wikipedia and Wikimedia answer bursts with 429s, so requests to them are
// spaced per host. Other sources (Open Library, HN, Google Books) are not.
const THROTTLED_HOST_RE = /(^|\.)(wikipedia|wikimedia)\.org$/i;
const nextSlot = new Map();   // host -> earliest time the next request may start

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Reserve the next slot for `host` and wait for it. */
async function throttle(host) {
  if (!THROTTLED_HOST_RE.test(host)) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  nextSlot.set(host, at + fetchPolicy.hostSpacingMs);
  if (at > now) await sleep(at - now);
}

/** Hold the whole host back, so concurrent workers do not walk into the same 429. */
function backOffHost(host, ms) {
  if (!THROTTLED_HOST_RE.test(host)) return;
  nextSlot.set(host, Math.max(nextSlot.get(host) || 0, Date.now() + ms));
}

/** Retry-After is either delta-seconds or an HTTP date. */
function retryAfterMs(res) {
  const h = res.headers.get('retry-after');
  if (!h) return NaN;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  return Date.parse(h) - Date.now();
}

/**
 * Only *.wikipedia.org gets Api-User-Agent from the browser. It is not a
 * CORS-safelisted header, so it forces a preflight: en.wikipedia.org answers
 * that preflight (api.php and rest_v1 both list api-user-agent), but the
 * wikimedia.org pageviews API answers OPTIONS with 405, which would make the
 * browser drop every pageviews call. In Node there is no preflight, and the
 * harvester sets a real User-Agent on every request anyway.
 */
function requestHeaders(host) {
  const headers = { Accept: 'application/json' };
  if (/(^|\.)wikipedia\.org$/i.test(host)) headers['Api-User-Agent'] = USER_AGENT;
  return headers;
}

/**
 * Fetch JSON with a timeout, retrying transient failures, and say whether the
 * source actually answered.
 *
 * Retrying matters more than it looks: a single dropped request silently
 * zeroes a whole factor (a failed pageviews call costs a book 25% of its
 * score). Worse, a failure that reads as "no data" gets written down as a
 * fact — an adaptation check that never ran reads as "lane clear". So this
 * returns `{ ok: true, data }` when the source answered (data is null for a
 * 404: the source answered "nothing here") and `{ ok: false, status }` when
 * it did not (429/5xx after retries, other 4xx, network error, timeout).
 */
export async function getJSON(url, { timeout = FETCH_TIMEOUT_MS, retries = fetchPolicy.retries } = {}) {
  const host = hostOf(url);
  let status = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: requestHeaders(host) });
      status = res.status;
      if (res.ok) return { ok: true, data: await res.json() };
      // 404 is an answer: the article or record does not exist.
      if (res.status === 404) return { ok: true, data: null };
      // Other 4xx (except 429) mean the request itself is wrong — retrying won't help.
      if (res.status !== 429 && res.status < 500) return { ok: false, status };
      if (attempt === retries) return { ok: false, status };
      const asked = retryAfterMs(res);
      const wait = Number.isFinite(asked) && asked > 0
        ? Math.min(asked, fetchPolicy.maxRetryAfterMs)
        : 400 * 2 ** attempt;
      backOffHost(host, wait);
      await sleep(wait);
    } catch {
      // Network error, timeout or unparseable body — worth one more try.
      if (attempt === retries) return { ok: false, status };
      await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status };
}

/* ---------- signal cache (localStorage, TTL'd) ---------- */

const CACHE_PREFIX = 'ar:cache:';

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    // Quota exceeded — drop the oldest half of the cache and move on.
    pruneCache();
  }
}

export function pruneCache(fraction = 0.5) {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(CACHE_PREFIX)) continue;
    try {
      entries.push([k, JSON.parse(localStorage.getItem(k)).t]);
    } catch {
      entries.push([k, 0]);
    }
  }
  entries.sort((a, b) => a[1] - b[1]);
  entries.slice(0, Math.ceil(entries.length * fraction)).forEach(([k]) => localStorage.removeItem(k));
}

export function clearCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  return keys.length;
}

/** Run async tasks with bounded concurrency, reporting progress as they land. */
export async function pool(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: String(err) };
      }
      onProgress?.(++done, items.length, results[i]);
    }
  });
  await Promise.all(runners);
  return results;
}
