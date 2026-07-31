import { CACHE_TTL_MS, FETCH_TIMEOUT_MS } from './config.js';

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

/**
 * Fetch JSON with a timeout, retrying transient failures.
 *
 * Retrying matters more than it looks: a single dropped request silently
 * zeroes a whole factor (a failed pageviews call costs a book 25% of its
 * score), and the failure is invisible because the result just reads as
 * "no data". Permanent failures (404, 400) are not retried.
 *
 * Returns null once retries are exhausted, so one dead source degrades a
 * book's confidence rather than failing the scan.
 */
export async function getJSON(url, { timeout = FETCH_TIMEOUT_MS, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (res.ok) return await res.json();
      // 4xx other than 429 means the request itself is wrong — retrying won't help.
      if (res.status !== 429 && res.status < 500) return null;
      if (attempt === retries) return null;
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 4000) : 400 * 2 ** attempt);
    } catch {
      // Network error or timeout — worth one more try.
      if (attempt === retries) return null;
      await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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
