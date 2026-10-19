// Zero-dependency tests for the trend maths in history.js: `node --test tests/*.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fromSnapshots, delta, movers, median, sameWeights, MIN_DAYS, DRIVER_MIN } =
  await import('../assets/js/history.js');
const { WEIGHTS_DEFAULT } = await import('../assets/js/config.js');
const { isSuspect } = await import('../tools/clean-history.mjs');

/* --------------------------------- fixtures -------------------------------- */

const day = (i) => `2026-10-${String(i).padStart(2, '0')}`;
const SOURCES = { wiki: { ok: 2, fail: 0 }, pv: { ok: 1, fail: 0 } };

/** One gated snapshot per day with the given books; weights default unless overridden. */
const snap = (date, books, weights = WEIGHTS_DEFAULT) => ({ date, weights, sources: SOURCES, books });

/**
 * Eight daily snapshots, 2026-10-01 to 2026-10-08. Factors move linearly, so
 * the median of three evenly spaced snapshots is the middle one and the
 * head-to-tail distance is 5/7 of the full range.
 *   riser   climbs 50→56 steadily, but the last day is a 70 spike. Momentum
 *           moves 40→60 (×5/7 × 25% = 3.6 pts); readership 60→70 (1.4 pts).
 *   rights  is the raw-vs-weighted trap: rights swings 10→60 (×5/7 × 8% = 2.9 pts)
 *           while momentum moves 40→64 (×5/7 × 25% = 4.3 pts). Raw size says
 *           rights; weighted contribution says momentum.
 *   flat    sits at 60 with a one-day dip to 50 in the middle.
 *   small   moves 2.1 points of momentum contribution — under the bar.
 */
const synthetic = () => {
  const riserAps = [50, 51, 52, 53, 54, 55, 56, 70];
  const snaps = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    snaps.push(snap(day(i + 1), [
      { id: 'riser', title: 'Riser', aps: riserAps[i],
        factors: { momentum: 40 + 20 * t, readership: 60 + 10 * t } },
      { id: 'rights', title: 'Rights Trap', aps: 50 + 10 * t,
        factors: { momentum: 40 + 24 * t, rights: 10 + 50 * t } },
      { id: 'flat', title: 'Flat', aps: i === 4 ? 50 : 60,
        factors: { momentum: 50, readership: 50 } },
      { id: 'small', title: 'Small', aps: 50 + 2.9 * t,
        factors: { momentum: 40 + 11.6 * t } },
    ]));
  }
  // A title that only appears in the last snapshot has no trend yet.
  snaps[7].books.push({ id: 'new', title: 'New', aps: 40, factors: { momentum: 10 } });
  return snaps;
};

/* --------------------------------- helpers --------------------------------- */

test('median() ignores non-numbers and averages an even count', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([undefined, 5, null]), 5);
  assert.equal(median([]), null);
});

test('sameWeights() compares every key, not identity', () => {
  assert.ok(sameWeights(WEIGHTS_DEFAULT, { ...WEIGHTS_DEFAULT }));
  assert.ok(!sameWeights(WEIGHTS_DEFAULT, { ...WEIGHTS_DEFAULT, rights: 9 }));
  assert.ok(!sameWeights(WEIGHTS_DEFAULT, null));
});

/* ------------------------------ fromSnapshots ------------------------------ */

test('fromSnapshots() sorts oldest-first and keys series by id', () => {
  const hist = fromSnapshots(synthetic().reverse(), '2026-10-08T06:20:00Z');
  assert.equal(hist.snaps.length, 8);
  assert.equal(hist.snaps[0].date, day(1));
  assert.equal(hist.latest.date, day(8));
  assert.equal(hist.series.get('riser').length, 8);
  assert.equal(hist.series.get('new').length, 1);
  assert.equal(hist.updatedAt, '2026-10-08T06:20:00Z');
  assert.equal(hist.skipped, 0);
});

test('fromSnapshots() drops ungated snapshots and ones scored under other weights', () => {
  const snaps = synthetic();
  delete snaps[0].sources;                                   // pre-gate file
  snaps[1] = { ...snaps[1], weights: { ...WEIGHTS_DEFAULT, momentum: 30, rights: 3 } };
  const hist = fromSnapshots(snaps);
  assert.equal(hist.snaps.length, 6);
  assert.equal(hist.snaps[0].date, day(3));
  assert.equal(hist.skipped, 1);                             // the weights mismatch; the ungated one never counted
  assert.deepEqual(hist.weights, WEIGHTS_DEFAULT);
  assert.equal(fromSnapshots([]), null);
  assert.equal(fromSnapshots([null, undefined]), null);
});

/* ---------------------------------- delta ---------------------------------- */

test('delta() uses the median of the first and last three snapshots', () => {
  const d = delta(fromSnapshots(synthetic()), 'riser');
  // head median(50, 51, 52) = 51; tail median(55, 56, 70) = 56 — the spike does not count.
  assert.equal(d.from, 51);
  assert.equal(d.to, 56);
  assert.equal(d.change, 5);
  assert.equal(d.span, 8);
  assert.equal(d.ends, 3);
  assert.equal(d.days, 7);
  assert.deepEqual(d.points, [50, 51, 52, 53, 54, 55, 56, 70]);
  // A one-day dip in the middle is not movement.
  assert.equal(delta(fromSnapshots(synthetic()), 'flat').change, 0);
});

test('delta() names the driver by weighted contribution, not raw factor change', () => {
  const hist = fromSnapshots(synthetic());
  const r = delta(hist, 'riser');
  assert.equal(r.driver, 'momentum');
  assert.equal(r.driverFactorChange, 14.3);    // 20 × 5/7 on the factor's own scale
  assert.equal(r.driverChange, 3.6);           // × 25 / 100, in APS points
  assert.ok(r.driverChange >= DRIVER_MIN);

  const t = delta(hist, 'rights');
  assert.equal(t.driver, 'momentum');          // rights moved further on its own scale (35.7), but weighs 8
  assert.equal(t.driverFactorChange, 17.1);
  assert.equal(t.driverChange, 4.3);
});

test('delta() leaves the driver unnamed below the 3-point threshold', () => {
  const d = delta(fromSnapshots(synthetic()), 'small');
  assert.equal(d.driver, null);
  assert.ok(Math.abs(d.driverChange) < DRIVER_MIN);
});

test('delta() refuses a window shorter than 7 days', () => {
  const short = synthetic().slice(0, 7);                     // 10-01 … 10-07 is six days
  assert.equal(delta(fromSnapshots(short), 'riser'), null);
  const exact = [snap(day(1), [{ id: 'x', aps: 50, factors: { momentum: 40 } }]),
                 snap(day(1 + MIN_DAYS), [{ id: 'x', aps: 60, factors: { momentum: 80 } }])];
  const d = delta(fromSnapshots(exact), 'x');
  assert.equal(d.change, 10);
  assert.equal(d.ends, 1);                                   // two points: last minus first
  assert.equal(d.driver, 'momentum');
  assert.equal(d.driverChange, 10);                          // 40 × 25 / 100
});

test('delta() never lets the end pools overlap on a short window', () => {
  const books = (aps) => [{ id: 'x', aps, factors: { momentum: aps } }];
  const four = [snap(day(1), books(50)), snap(day(4), books(52)), snap(day(7), books(58)), snap(day(10), books(60))];
  const d = delta(fromSnapshots(four), 'x');
  assert.equal(d.ends, 2);                                   // mean of two at each end
  assert.equal(d.from, 51);
  assert.equal(d.to, 59);
  assert.equal(d.change, 8);
});

test('delta() treats a factor missing from a snapshot as unknown, not zero', () => {
  const snaps = synthetic();
  for (const s of snaps.slice(0, 3)) delete s.books[0].factors.readership;   // riser loses readership early on
  const d = delta(fromSnapshots(snaps), 'riser');
  assert.equal(d.driver, 'momentum');                        // readership cannot be "+70 from zero"
});

test('delta() returns null without a series', () => {
  const hist = fromSnapshots(synthetic());
  assert.equal(delta(hist, 'new'), null);
  assert.equal(delta(hist, 'missing'), null);
  assert.equal(delta(null, 'riser'), null);
});

/* --------------------------------- movers ---------------------------------- */

test('movers() ranks by absolute change and drops small moves', () => {
  const list = movers(fromSnapshots(synthetic()), 5, 2);
  assert.deepEqual(list.map((m) => [m.id, m.change]), [['rights', 7.1], ['riser', 5], ['small', 2.1]]);
  assert.equal(list[1].title, 'Riser');
  assert.equal(list[0].driver, 'momentum');
  assert.deepEqual(movers(null), []);
  assert.equal(movers(fromSnapshots(synthetic()), 1).length, 1);
});

/* ------------------------------ clean-history ------------------------------ */

test('isSuspect() flags ungated snapshots with mostly-zero momentum, nothing else', () => {
  const books = (zeros, n = 4) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, aps: 50, factors: { momentum: i < zeros ? 0 : 30 } }));
  assert.ok(isSuspect({ date: day(1), books: books(3) }));                     // 75% zeros, no sources
  assert.ok(!isSuspect({ date: day(1), books: books(2) }));                    // exactly half is not "more than"
  assert.ok(!isSuspect({ date: day(1), sources: SOURCES, books: books(4) }));  // gated: trusted as written
  assert.ok(isSuspect({ date: day(1), books: [] }));
  assert.ok(isSuspect(null));
});
