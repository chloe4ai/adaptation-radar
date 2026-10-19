#!/usr/bin/env node
/**
 * Snapshot harvester.
 *
 * The board has always been a live scan: open it and you see where a title
 * stands *today*. That is the wrong shape for scouting. A book at APS 71 that
 * was 52 three weeks ago is a very different call from a book that has sat at
 * 71 since spring — the first one is moving and the second one is priced in.
 * Level is what everyone can see; the slope is the edge.
 *
 * So this runs the exact same pipeline the browser runs — the real
 * `gatherSignals` and `scoreBook`, imported unmodified — on a schedule, and
 * writes one dated snapshot per run into `data/history/`. The UI then reads
 * those files and can show a trend rather than a moment.
 *
 * It reuses the browser modules rather than reimplementing the scoring because
 * a second implementation would drift, and a trend line computed by different
 * code than the current score is worse than no trend line at all.
 *
 *   node tools/harvest.mjs [--limit N] [--out data/history] [--keep 120]
 *
 * `--limit` without `--out` is a dry run: the snapshot goes to a scratch
 * directory, and data/history (files, prune, index) is left alone.
 */

import { writeFile, appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `sources.js` caches through localStorage. In a scheduled run there is no
 * browser and, more to the point, no reason to want a warm cache: the whole
 * job is to take a fresh reading. An in-memory shim satisfies the import and
 * is thrown away when the process exits.
 */
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
})();

const { gatherSignals, displayTitle, stats, resetStats, configureSources } = await import('../assets/js/sources.js');
const { scoreBook, recommendFormat } = await import('../assets/js/score.js');
const { WEIGHTS_DEFAULT, SCAN_CONCURRENCY, USER_AGENT } = await import('../assets/js/config.js');
const { pool, slug, round, configureFetch } = await import('../assets/js/util.js');

/**
 * Wikimedia throttles anonymous clients hard (429 with Retry-After ~40 s), and
 * Node's default User-Agent is anonymous. Identify every request.
 */
const baseFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('User-Agent', USER_AGENT);
  return baseFetch(input, { ...init, headers });
};

// Nobody is watching a scheduled run, so honour long Retry-After waits rather
// than giving up after the browser's 4 s cap and recording a failure.
configureFetch({ retries: 3, maxRetryAfterMs: 60000 });

/**
 * Google Books is keyless in the browser, but from a shared CI address its
 * anonymous quota is exhausted every single day: 48 requests, 48 failures,
 * nothing learned. Without a key the adapter is switched off, so the snapshot
 * records it as disabled rather than as a 100% failure rate, and every book
 * scores exactly as it would when the lookup found nothing. With a key
 * (repository secret `GOOGLE_BOOKS_KEY`, passed through by harvest.yml) the
 * source runs and is gated like Wikipedia and pageviews below.
 */
const GOOGLE_BOOKS_KEY = process.env.GOOGLE_BOOKS_KEY || '';
configureSources({ googleBooks: Boolean(GOOGLE_BOOKS_KEY), googleBooksKey: GOOGLE_BOOKS_KEY || null });

/* ------------------------------- arguments -------------------------------- */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LIMIT = Number(arg('limit', 0)) || 0;
// A subset run is a test, not a reading of the slate: unless an output was
// named explicitly, keep it out of data/history so it cannot be committed as
// the day's snapshot (or prune real ones).
const PARTIAL = LIMIT > 0 && !argv.includes('--out');
const OUT = PARTIAL
  ? path.join(os.tmpdir(), 'adaptation-radar-partial')
  : path.resolve(ROOT, arg('out', 'data/history'));
const KEEP = Number(arg('keep', 120));

/* --------------------------------- run ------------------------------------ */

const slate = JSON.parse(await readFile(path.join(ROOT, 'data/slate.json'), 'utf8')).titles;
const seeds = LIMIT ? slate.slice(0, LIMIT) : slate;

console.log(`harvesting ${seeds.length} titles at concurrency ${SCAN_CONCURRENCY}`);
if (!GOOGLE_BOOKS_KEY) console.log('google books: disabled (no GOOGLE_BOOKS_KEY); readership and adaptability use Open Library and Wikipedia only');
if (PARTIAL) console.log(`partial run, not written to data/history (output: ${OUT})`);
const started = Date.now();
resetStats();
let done = 0;

const results = await pool(seeds, SCAN_CONCURRENCY, gatherSignals, () => {
  done++;
  if (done % 10 === 0 || done === seeds.length) console.log(`  ${done}/${seeds.length}`);
});

const books = [];
const failed = [];
let live = 0;
for (const signals of results) {
  if (!signals || signals.error) { failed.push(signals?.error || 'unknown'); continue; }
  // `gatherSignals` resolves even when every adapter returned null — that is the
  // right behaviour in the browser, where one dead source should only dent a
  // book's confidence. In a scheduled run it is a trap: a network outage
  // produces a full slate of well-formed zeros, which the trend line would
  // faithfully render as the day the entire book market collapsed.
  if (signals.ol || signals.wiki || signals.pv || signals.hn || signals.gb) live++;
  const score = scoreBook(signals, WEIGHTS_DEFAULT);
  const format = recommendFormat(signals, score.factors);
  books.push({
    id: slug(`${signals.seed.title}-${signals.seed.author || ''}`),
    title: displayTitle(signals),
    author: signals.ol?.authors?.[0] || signals.seed.author || '',
    aps: score.aps,
    confidence: score.confidence,
    format: format.format,
    // Per-factor scores, so a mover can be attributed rather than just noticed:
    // "up 9 points" is trivia, "up 9 points, all of it momentum" is a lead.
    factors: Object.fromEntries(
      Object.entries(score.factors).map(([k, v]) => [k, round(v.score, 1)])
    ),
    status: score.factors.whitespace?.parts?.status ?? null,
  });
}

/* ---------------------------- source summary ------------------------------ */

const failRate = (s) => (s.ok + s.fail ? s.fail / (s.ok + s.fail) : 0);
const sources = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ok: v.ok, fail: v.fail }]));
// Not asked is not the same as failed: a consumer reading this snapshot should
// see that the source was off, not that it was down.
if (!GOOGLE_BOOKS_KEY) sources.gb = { ok: 0, fail: 0, disabled: true };

console.log('source requests (ok / fail / fail rate):');
for (const [k, v] of Object.entries(sources)) {
  console.log(`  ${k.padEnd(6)} ${String(v.ok).padStart(4)} / ${String(v.fail).padStart(4)} / ${(failRate(v) * 100).toFixed(1)}%${v.disabled ? ' (disabled)' : ''}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = Object.entries(sources)
    .map(([k, v]) => `| ${k} | ${v.ok} | ${v.fail} | ${v.disabled ? 'disabled' : `${(failRate(v) * 100).toFixed(1)}%`} |`)
    .join('\n');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### Harvest sources (${seeds.length} titles${PARTIAL ? ', partial run' : ''})\n\n` +
    `| source | ok | fail | fail rate |\n|---|---|---|---|\n${rows}\n\n`
  );
}

/**
 * Three guards, because "resolved" and "actually got data" are different things
 * and only the second one protects the trend line. A missing day is honest; a
 * day of zeros is a lie the chart will keep telling.
 */
const coverage = books.length / seeds.length;
if (coverage < 0.6) {
  console.error(`only ${books.length}/${seeds.length} titles resolved (${Math.round(coverage * 100)}%) — refusing to write a snapshot this thin`);
  process.exit(1);
}
const liveRate = books.length ? live / books.length : 0;
if (liveRate < 0.6) {
  console.error(`only ${live}/${books.length} titles came back with any live signal (${Math.round(liveRate * 100)}%) — the sources are down, not the books; refusing to write`);
  process.exit(1);
}
const meanConfidence = books.reduce((t, b) => t + b.confidence, 0) / books.length;
if (meanConfidence < 0.35) {
  console.error(`mean confidence ${meanConfidence.toFixed(2)} is too low to snapshot — partial outage`);
  process.exit(1);
}
// Momentum and whitespace both hang off Wikipedia. When it rate-limits, every
// title still "resolves" through Open Library and HN, so the gates above pass
// — and the snapshot records momentum 0 and "lane clear" across the board.
// The per-source failure rate is the only gate that sees that outage. Google
// Books joins the gate only when it is actually running (keyed): a disabled
// source has nothing to fail.
const MAX_FAIL_RATE = 0.15;
const gated = ['wiki', 'pv', ...(GOOGLE_BOOKS_KEY ? ['gb'] : [])];
const throttled = gated.filter((k) => failRate(sources[k]) > MAX_FAIL_RATE);
if (throttled.length) {
  console.error(throttled.map((k) =>
    `${k}: ${sources[k].fail}/${sources[k].ok + sources[k].fail} requests failed (${(failRate(sources[k]) * 100).toFixed(1)}%)`
  ).join('; ') + ` — above the ${MAX_FAIL_RATE * 100}% limit; refusing to write`);
  process.exit(1);
}

books.sort((a, b) => b.aps - a.aps);

const date = new Date().toISOString().slice(0, 10);
const snapshot = {
  date,
  generatedAt: new Date().toISOString(),
  weights: WEIGHTS_DEFAULT,   // a score is only comparable against the weights that made it
  titles: seeds.length,
  resolved: books.length,
  liveSignal: live,
  meanConfidence: round(meanConfidence, 3),
  durationMs: Date.now() - started,
  sources,
  books,
};

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, `${date}.json`), JSON.stringify(snapshot) + '\n');

if (PARTIAL) {
  console.log(`wrote ${path.join(OUT, `${date}.json`)} — ${books.length}/${seeds.length} resolved in ${Math.round(snapshot.durationMs / 1000)}s`);
  console.log('partial run, not written to data/history (no prune, no index)');
  process.exit(0);
}

/* ------------------------------ index + prune ------------------------------ */

const files = (await readdir(OUT))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();

// Keep the window bounded: this is a git repo, and an unbounded history of
// daily JSON turns a static site into a slow clone.
for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
  await unlink(path.join(OUT, f));
  console.log(`pruned ${f}`);
}

const kept = (await readdir(OUT))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();

await writeFile(
  path.join(OUT, 'index.json'),
  JSON.stringify({
    updatedAt: new Date().toISOString(),
    // Newest first: the UI almost always wants the last few and should not have
    // to read the whole list to find them.
    snapshots: kept.slice().reverse(),
  }) + '\n'
);

console.log(`wrote ${date}.json — ${books.length}/${seeds.length} resolved in ${Math.round(snapshot.durationMs / 1000)}s`);
if (failed.length) console.log(`${failed.length} title(s) failed to resolve`);
console.log(`history now holds ${kept.length} snapshot(s)`);
