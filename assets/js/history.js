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

const DIR = 'data/history';

/** How many snapshots to pull. Enough for a trend, few enough to stay cheap. */
const WINDOW = 12;

let loaded = null;   // Promise, so concurrent callers share one fetch round

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Snapshots are keyed by book id, so a slate that gains or loses titles does not
 * shift anyone's series. A title absent from an older snapshot simply has a
 * shorter history rather than inheriting its neighbour's.
 */
export function loadHistory() {
  if (loaded) return loaded;
  loaded = (async () => {
    const index = await fetchJSON(`${DIR}/index.json`);
    const names = index?.snapshots;
    if (!Array.isArray(names) || !names.length) return null;

    const wanted = names.slice(0, WINDOW);              // index.json is newest-first
    const snaps = (await Promise.all(wanted.map((n) => fetchJSON(`${DIR}/${n}`))))
      .filter(Boolean)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));   // oldest-first for plotting
    if (!snaps.length) return null;

    const series = new Map();   // id -> [{date, aps, factors}]
    for (const s of snaps) {
      for (const b of s.books || []) {
        if (!series.has(b.id)) series.set(b.id, []);
        series.get(b.id).push({ date: s.date, aps: b.aps, factors: b.factors || {} });
      }
    }
    return { snaps, series, latest: snaps[snaps.length - 1], updatedAt: index.updatedAt };
  })();
  return loaded;
}

/**
 * The change over the window, plus which factor supplied most of it. A number
 * on its own ("+9") is a curiosity; a number with a cause ("+9, mostly
 * momentum") is something to act on.
 */
export function delta(hist, id) {
  const s = hist?.series?.get(id);
  if (!s || s.length < 2) return null;
  const first = s[0], last = s[s.length - 1];
  const change = Math.round((last.aps - first.aps) * 10) / 10;

  let driver = null, best = 0;
  for (const k of Object.keys(last.factors || {})) {
    const d = (last.factors[k] ?? 0) - (first.factors?.[k] ?? 0);
    if (Math.abs(d) > Math.abs(best)) { best = d; driver = k; }
  }
  return {
    change,
    from: first.aps, to: last.aps,
    span: s.length,
    days: dayGap(first.date, last.date),
    driver: Math.abs(best) >= 3 ? driver : null,
    driverChange: Math.round(best * 10) / 10,
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
