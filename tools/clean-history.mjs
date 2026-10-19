#!/usr/bin/env node
/**
 * One-off history cleanup.
 *
 * Before 2026-10-19 the harvester identified itself to nobody and had no
 * per-source gate, so on the days Wikimedia rate-limited it a snapshot was
 * still written: every book resolved through Open Library and HN, momentum was
 * recorded as 0 and the adaptation lane as "clear" across the slate. Those
 * files are indistinguishable from a real reading by their shape, and the
 * trend line built on them is noise. This script finds them by their symptoms
 * — no `sources` block (the gate that would have caught the outage did not
 * exist yet) and momentum 0 for more than half the titles — and moves them
 * out of the window, into `data/history/excluded/`, where neither the
 * harvester's index nor the board will read them. They stay in the repository
 * (and in git history) so the decision can be audited or reversed: move a
 * file back up one level and rerun the harvester, or this script, to re-index.
 *
 *   node tools/clean-history.mjs [--dir data/history] [--dry-run]
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DIR = path.resolve(ROOT, arg('dir', 'data/history'));
const DRY = argv.includes('--dry-run');

/** More than half the slate at momentum 0 is an outage, not a quiet week. */
const ZERO_SHARE = 0.5;

/**
 * Exported so the test can check the rule without touching the filesystem.
 * A snapshot is suspect when it predates the per-source gate (no `sources`)
 * *and* shows the gate's symptom. Either alone is not enough: a gated snapshot
 * that passed its own checks is trusted even on a dull day, and an ungated
 * one with real momentum numbers was a good day and stays.
 */
export function isSuspect(snap, zeroShare = ZERO_SHARE) {
  if (!snap || !Array.isArray(snap.books) || !snap.books.length) return true;
  if (snap.sources) return false;
  const zeros = snap.books.filter((b) => !(Number(b.factors?.momentum) > 0)).length;
  return zeros / snap.books.length > zeroShare;
}

async function main() {
  const files = (await readdir(DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const EXCLUDED = path.join(DIR, 'excluded');
  if (!DRY) await mkdir(EXCLUDED, { recursive: true });
  const removed = [], kept = [];
  for (const f of files) {
    let snap = null;
    try { snap = JSON.parse(await readFile(path.join(DIR, f), 'utf8')); } catch { /* unreadable counts as suspect */ }
    const n = snap?.books?.length || 0;
    const zeros = snap?.books?.filter((b) => !(Number(b.factors?.momentum) > 0)).length ?? 0;
    const why = `${zeros}/${n} at momentum 0, sources ${snap?.sources ? 'recorded' : 'absent'}`;
    if (isSuspect(snap)) {
      removed.push(f);
      console.log(`${DRY ? 'would exclude' : 'excluded'}  ${f}  (${why})`);
      if (!DRY) await rename(path.join(DIR, f), path.join(EXCLUDED, f));
    } else {
      kept.push(f);
      console.log(`kept     ${f}  (${why})`);
    }
  }
  if (!DRY) {
    await writeFile(
      path.join(DIR, 'index.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), snapshots: kept.slice().reverse() }) + '\n'
    );
  }
  console.log(`${removed.length} excluded, ${kept.length} kept${kept.length ? `; history now starts ${kept[0].slice(0, 10)}` : ''}${DRY ? ' (dry run, nothing written)' : ''}`);
}

// Run only as a script, so the test can import `isSuspect` without side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
