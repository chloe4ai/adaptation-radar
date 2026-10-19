// Zero-dependency tests for the scoring core: `node --test tests/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// sources.js caches through localStorage; give it the same in-memory shim the
// harvester uses.
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

const { scoreBook } = await import('../assets/js/score.js');
const { WEIGHTS_DEFAULT } = await import('../assets/js/config.js');
const { pickWork, summarizePageviews, displayTitle, adaptations, stats, resetStats } =
  await import('../assets/js/sources.js');
const { delta, movers } = await import('../assets/js/history.js');
const { configureFetch } = await import('../assets/js/util.js');

/* --------------------------------- fixtures -------------------------------- */

// Chosen so every factor lands on a value that can be checked by hand:
//   momentum     volume 100 (60k views), ratio 1 -> trend 50   => 77.5, conf 1
//   readership   raw 25000, no ratings average                  => 100,  conf 1
//   discussion   600 all-time, 120 recent                       => 100,  conf 1
//   adaptability no subjects or text                            => 40,   conf 0.2
//   whitespace   clear, article has an adaptation section       => 100,  conf 0.85
//   rights       1900, always 96+ years old                     => 100,  conf 0.9
const fixture = () => ({
  seed: { title: 'Fixture Novel', author: 'Ada Example' },
  pv: { days: 91, last30: 60000, priorAvg30: 60000, total: 180000, peak: 3000, series: [] },
  ol: {
    title: 'Fixture Novel', authors: ['Ada Example'], year: 1900,
    ratingsAvg: null, ratingsCount: 0, wantToRead: 25000, alreadyRead: 0, reading: 0,
    subjects: [], pages: null, firstSentence: null,
  },
  hn: { total: 600, recent: 120 },
  gb: null,
  wiki: { page: 'Fixture Novel', pageKey: 'Fixture_Novel', extract: '', description: '' },
  adapt: { status: 'clear', confirmed: false, siblings: [], authorLinked: false, evidence: [], hasSection: true },
});

/* ---------------------------------- score ---------------------------------- */

test('scoreBook on fixture signals with default weights', () => {
  const s = scoreBook(fixture(), WEIGHTS_DEFAULT);
  // (77.5*25 + 100*20 + 100*15 + 40*20 + 100*12 + 100*8) / 100 = 82.375
  assert.equal(s.aps, 82.4);
  // (1*25 + 1*20 + 1*15 + 0.2*20 + 0.85*12 + 0.9*8) / 100 = 0.814
  assert.equal(s.confidence, 0.81);
  assert.equal(s.factors.momentum.score, 77.5);
  assert.equal(s.factors.whitespace.parts.status, 'clear');
});

test('momentum trend: ratio 2 -> 100, ratio 0.5 -> 0', () => {
  const at = (ratio) => {
    const f = fixture();
    f.pv = { ...f.pv, last30: 1000, priorAvg30: 1000 / ratio };
    return scoreBook(f, WEIGHTS_DEFAULT).factors.momentum.parts.trend;
  };
  assert.equal(at(2), 100);
  assert.equal(at(0.5), 0);
  assert.equal(at(1), 50);
});

test('momentum with no pageviews has zero confidence', () => {
  const f = fixture();
  f.pv = null;
  const m = scoreBook(f, WEIGHTS_DEFAULT).factors.momentum;
  assert.equal(m.score, 0);
  assert.equal(m.confidence, 0);
});

/* -------------------------------- pageviews -------------------------------- */

test('priorAvg30 divides by the actual prior window length', () => {
  // 61 prior days at 10/day, then 30 days at 20/day: the 92-day request shape.
  const views = [...Array(61).fill(10), ...Array(30).fill(20)];
  const pv = summarizePageviews(views);
  assert.equal(pv.last30, 600);
  assert.equal(pv.priorAvg30, 300);        // 610 views over 61 days, per 30 days
  assert.equal(pv.days, 91);
  assert.equal(pv.total, 1210);

  // A young article with only 15 prior days: still a 30-day rate.
  const young = summarizePageviews([...Array(15).fill(10), ...Array(30).fill(10)]);
  assert.equal(young.priorAvg30, 300);
  assert.equal(young.last30, 300);

  // No prior window at all.
  assert.equal(summarizePageviews(Array(20).fill(5)).priorAvg30, 0);
});

/* --------------------------------- pickWork -------------------------------- */

test('pickWork rejects a Hangul candidate when the seed is ASCII', () => {
  const hangul = { key: '/works/K', title: '채식주의자', author_name: ['Han Kang'], language: ['kor', 'eng'] };
  const english = { key: '/works/E', title: 'The Vegetarian', author_name: ['Han Kang'], language: ['eng'] };

  assert.equal(pickWork([hangul, english], 'The Vegetarian', 'Han Kang')?.key, '/works/E');
  assert.equal(pickWork([english, hangul], 'The Vegetarian', 'Han Kang')?.key, '/works/E');
  // On its own the Hangul record is not a match at all, rather than a +60 prefix match.
  assert.equal(pickWork([hangul], 'The Vegetarian', 'Han Kang'), null);
  // ...and setting it aside must not hand the slot to another book by the same author.
  const other = { key: '/works/G', title: 'Greek Lessons', author_name: ['Han Kang'], language: ['eng'] };
  assert.equal(pickWork([hangul, other], 'The Vegetarian', 'Han Kang'), null);
});

test('pickWork prefers the English edition for an ASCII seed', () => {
  const danish = { key: '/works/D', title: 'The Employees', author_name: ['Olga Ravn'], language: ['dan'] };
  const english = { key: '/works/E', title: 'The Employees', author_name: ['Olga Ravn'], language: ['eng'] };
  assert.equal(pickWork([danish, english], 'The Employees', 'Olga Ravn')?.key, '/works/E');
});

test('pickWork still matches a non-Latin seed exactly', () => {
  const hangul = { key: '/works/K', title: '채식주의자', author_name: ['Han Kang'], language: ['kor'] };
  assert.equal(pickWork([hangul], '채식주의자', 'Han Kang')?.key, '/works/K');
});

test('displayTitle falls back to the seed when the matched title has no Latin letters', () => {
  assert.equal(displayTitle({ seed: { title: 'The Vegetarian' }, ol: { title: '채식주의자' } }), 'The Vegetarian');
  assert.equal(displayTitle({ seed: { title: 'Tender Is the Flesh' }, ol: { title: 'Cadáver exquisito' } }), 'Cadáver exquisito');
  assert.equal(displayTitle({ seed: { title: 'Piranesi' }, ol: null }), 'Piranesi');
});

/* ------------------------- failure is not "clear" -------------------------- */

test('adaptations() returns null, uncached, when a lookup fails', async () => {
  configureFetch({ retries: 0, hostSpacingMs: 0 });
  resetStats();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  };
  try {
    const seed = { title: 'Outage Novel', author: 'Ada Example' };
    assert.equal(await adaptations(seed, 'Outage Novel'), null);
    assert.equal(stats.adapt.fail, 2);
    assert.equal(stats.adapt.ok, 0);
    // Not cached: a second call goes back to the network.
    const before = calls;
    assert.equal(await adaptations(seed, 'Outage Novel'), null);
    assert.ok(calls > before);
  } finally {
    globalThis.fetch = realFetch;
    configureFetch({ retries: 2, hostSpacingMs: 250 });
  }
});

/* --------------------------------- history --------------------------------- */

const synthetic = () => {
  const snap = (date, books) => ({ date, books });
  const snaps = [
    snap('2026-10-01', [
      { id: 'riser', title: 'Riser', aps: 50, factors: { momentum: 40, readership: 60 } },
      { id: 'faller', title: 'Faller', aps: 70, factors: { momentum: 80, readership: 60 } },
      { id: 'flat', title: 'Flat', aps: 60, factors: { momentum: 50, readership: 50 } },
    ]),
    snap('2026-10-08', [
      { id: 'riser', title: 'Riser', aps: 55, factors: { momentum: 60, readership: 60 } },
      { id: 'faller', title: 'Faller', aps: 66, factors: { momentum: 70, readership: 60 } },
      { id: 'flat', title: 'Flat', aps: 60.5, factors: { momentum: 50, readership: 51 } },
    ]),
    snap('2026-10-15', [
      { id: 'riser', title: 'Riser', aps: 59, factors: { momentum: 76, readership: 61 } },
      { id: 'faller', title: 'Faller', aps: 63, factors: { momentum: 62, readership: 60 } },
      { id: 'flat', title: 'Flat', aps: 61, factors: { momentum: 51, readership: 52 } },
      { id: 'new', title: 'New', aps: 40, factors: { momentum: 10 } },
    ]),
  ];
  const series = new Map();
  for (const s of snaps) {
    for (const b of s.books) {
      if (!series.has(b.id)) series.set(b.id, []);
      series.get(b.id).push({ date: s.date, aps: b.aps, factors: b.factors });
    }
  }
  return { snaps, series, latest: snaps[snaps.length - 1] };
};

test('delta() attributes the change to its driving factor', () => {
  const hist = synthetic();
  const d = delta(hist, 'riser');
  assert.equal(d.change, 9);
  assert.equal(d.from, 50);
  assert.equal(d.to, 59);
  assert.equal(d.span, 3);
  assert.equal(d.days, 14);
  assert.equal(d.driver, 'momentum');
  assert.equal(d.driverChange, 36);
  assert.deepEqual(d.points, [50, 55, 59]);

  // Small factor moves are not named as a driver.
  assert.equal(delta(hist, 'flat').driver, null);
  // One snapshot is not a trend.
  assert.equal(delta(hist, 'new'), null);
  assert.equal(delta(hist, 'missing'), null);
  assert.equal(delta(null, 'riser'), null);
});

test('movers() ranks by absolute change and drops small moves', () => {
  const list = movers(synthetic(), 5, 2);
  assert.deepEqual(list.map((m) => [m.id, m.change]), [['riser', 9], ['faller', -7]]);
  assert.equal(list[0].title, 'Riser');
  assert.equal(list[1].driver, 'momentum');
  assert.deepEqual(movers(null), []);
  assert.equal(movers(synthetic(), 1).length, 1);
});
