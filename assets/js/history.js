/**
 * Reads the committed APS snapshots in `data/history/` and turns them into the
 * two things a scout actually asks of a board: how has this title moved, and
 * what moved most this week.
 *
 * Everything here is optional by design. The history directory does not exist
 * until the scheduled harvest has run at least once, and a fork or a local
 * checkout may never run it. So a missing or unreadable history degrades to
 * "no trend shown" and the board behaves exactly as it did before.
 */

import { WEIGHTS_DEFAULT } from './config.js';

const DIR = 'data/history';

/** How many snapshots to pull. Enough for a trend, few enough to stay cheap. */
export const WINDOW = 12;

/**
 * A delta is not shown until the window spans this many days. Two snapshots a
 * day apart measure the sources' jitter, not the title's movement; at the
 * daily cadence of the harvest a week is the shortest span worth reporting.
 */
export const MIN_DAYS = 7;

/** How many snapshots at each end of the window are pooled into a median. */
export const END_POINTS = 3;

/** A factor is named as driver only when its weighted share of the change is this many points. */
export const DRIVER_MIN = 3;

let loaded = null;   // Promise, so concurrent callers share one fetch round

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Two weight tables are the same regime when every key carries the same weight. */
export function sameWeights(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Number(a[k]) === Number(b[k]));
}

/**
 * Turn a set of snapshots into per-title series. Exported so the delta maths
 * can be tested on synthetic snapshots without a fetch.
 *
 * Two kinds of snapshot are left out before anything is compared:
 *   - ones with no `sources` block, written before the harvester gated on
 *     per-source failures. On a rate-limited day those recorded momentum 0 and
 *     "lane clear" across the slate, and nothing in the file says so.
 *   - ones scored under different weights from the newest snapshot. A score is
 *     only comparable against the weights that made it; a delta across a
 *     weights change would report the edit, not the title.
 *
 * Snapshots are keyed by book id, so a slate that gains or loses titles does
 * not shift anyone's series. A title absent from an older snapshot simply has
 * a shorter history rather than inheriting its neighbour's.
 */
export function fromSnapshots(snapshots, updatedAt = null) {
  const sorted = (snapshots || [])
    .filter((s) => s && Array.isArray(s.books) && s.sources)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));   // oldest-first for plotting
  if (!sorted.length) return null;
  const latest = sorted[sorted.length - 1];
  const weights = latest.weights || WEIGHTS_DEFAULT;
  const snaps = sorted.filter((s) => sameWeights(s.weights || WEIGHTS_DEFAULT, weights));

  const series = new Map();   // id -> [{date, aps, factors}]
  for (const s of snaps) {
    for (const b of s.books) {
      if (!series.has(b.id)) series.set(b.id, []);
      series.get(b.id).push({ date: s.date, aps: b.aps, factors: b.factors || {} });
    }
  }
  return { snaps, series, latest, weights, updatedAt, skipped: sorted.length - snaps.length };
}

export function loadHistory() {
  if (loaded) return loaded;
  loaded = (async () => {
    const index = await fetchJSON(`${DIR}/index.json`);
    const names = index?.snapshots;
    if (!Array.isArray(names) || !names.length) return null;

    const wanted = names.slice(0, WINDOW);              // index.json is newest-first
    const snaps = await Promise.all(wanted.map((n) => fetchJSON(`${DIR}/${n}`)));
    return fromSnapshots(snaps, index.updatedAt);
  })();
  return loaded;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The change over the window, plus which factor supplied most of it. A number
 * on its own ("+9") is a curiosity; a number with a cause ("+9, mostly
 * momentum") is something to act on.
 *
 * The change is the median of the last few snapshots minus the median of the
 * first few (three at each end once the window holds six; fewer, never
 * overlapping, when it holds less). Last-minus-first would hand the whole delta
 * to whichever two days happened to sit at the ends, and one rate-limited
 * morning at either end is enough to invent a mover.
 *
 * The driver is the factor whose *weighted* contribution to that change is
 * largest: Δfactor × weight / Σweights, in APS points. The raw factor change
 * would name Rights (8%) over Momentum (25%) whenever its 0–100 score swung
 * further, even when it moved the score less.
 */
export function delta(hist, id) {
  const s = hist?.series?.get(id);
  if (!s || s.length < 2) return null;
  const first = s[0], last = s[s.length - 1];
  const days = dayGap(first.date, last.date);
  if (days === null || days < MIN_DAYS) return null;

  const k = Math.min(END_POINTS, Math.floor(s.length / 2));
  const head = s.slice(0, k), tail = s.slice(-k);
  const from = median(head.map((p) => p.aps));
  const to = median(tail.map((p) => p.aps));
  if (from === null || to === null) return null;

  const weights = hist.weights || WEIGHTS_DEFAULT;
  const total = Object.values(weights).reduce((t, w) => t + Number(w || 0), 0) || 1;
  let driver = null, best = 0, bestRaw = 0;
  for (const key of Object.keys(weights)) {
    const w = Number(weights[key] || 0);
    if (!w) continue;
    const a = median(head.map((p) => p.factors?.[key]));
    const b = median(tail.map((p) => p.factors?.[key]));
    if (a === null || b === null) continue;     // factor missing from a snapshot: unknown, not zero
    const contribution = ((b - a) * w) / total;
    if (Math.abs(contribution) > Math.abs(best)) { best = contribution; bestRaw = b - a; driver = key; }
  }
  return {
    change: round1(to - from),
    from: round1(from), to: round1(to),
    span: s.length,
    ends: k,
    days,
    driver: Math.abs(best) >= DRIVER_MIN ? driver : null,
    driverChange: round1(best),         // in APS points
    driverFactorChange: round1(bestRaw), // on the factor's own 0–100 scale
    points: s.map((p) => p.aps),
  };
}

function dayGap(a, b) {
  const d = (Date.parse(b) - Date.parse(a)) / 86400000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

/** Titles that moved most over the window, biggest absolute change first. */
export function movers(hist, limit = 5, minChange = 2) {
  if (!hist) return [];
  const out = [];
  for (const id of hist.series.keys()) {
    const d = delta(hist, id);
    if (!d || Math.abs(d.change) < minChange) continue;
    const meta = hist.latest.books.find((b) => b.id === id);
    out.push({ id, title: meta?.title || id, ...d });
  }
  return out.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, limit);
}

/**
 * A trend line for the APS series. Deliberately not the same component as the
 * existing pageviews sparkline: that one shows attention, this one shows the
 * score, and conflating them would hide the case where attention climbs but the
 * score does not (an adaptation got announced, and whitespace collapsed).
 */
export function trendPath(points, w = 96, h = 24, pad = 2) {
  if (!points || points.length < 2) return null;
  const lo = Math.min(...points), hi = Math.max(...points);
  const range = hi - lo || 1;
  const step = (w - pad * 2) / (points.length - 1);
  return points
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + (h - pad * 2) * (1 - (v - lo) / range);
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
