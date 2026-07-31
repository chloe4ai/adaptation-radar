import { GENRE_AFFINITY, HIGH_CONCEPT_MARKERS } from './config.js';
import { clamp, logScale, round } from './util.js';

/**
 * The Adaptation Potential Score (APS).
 *
 * Six independent 0–100 subscores, combined with user-adjustable weights.
 * Each subscore also reports which sources fed it, so a book scored on thin
 * data is visibly thin rather than quietly wrong.
 */

/* 1. MOMENTUM — is attention rising right now (Wikipedia pageviews) */
function momentum({ pv }) {
  if (!pv || pv.last30 === 0) {
    return { score: 0, confidence: 0, detail: 'No Wikipedia pageview data', parts: {} };
  }
  const volume = logScale(pv.last30, 60000);
  const ratio = pv.last30 / Math.max(pv.priorAvg30, 1);
  // ratio 1.0 → 50, 2.0 → 100, 0.5 → 0. Flat interest sits mid-scale.
  const trend = clamp(50 + 50 * Math.log2(Math.max(ratio, 0.05)));
  const score = 0.55 * volume + 0.45 * trend;
  const pct = Math.round((ratio - 1) * 100);
  return {
    score,
    confidence: pv.days >= 60 ? 1 : 0.6,
    detail: `${pv.last30.toLocaleString()} views/30d · ${pct >= 0 ? '+' : ''}${pct}% vs prior baseline`,
    parts: { volume, trend, ratio },
  };
}

/* 2. READERSHIP — how many people actually read it (Open Library) */
function readership({ ol, gb }) {
  if (!ol) return { score: 0, confidence: 0, detail: 'No Open Library record', parts: {} };
  // Finished readers and raters are worth more than shelf-adds.
  const raw = ol.wantToRead + ol.alreadyRead * 2.5 + ol.ratingsCount * 3 + ol.reading * 1.5;
  const base = logScale(raw, 25000);

  const avg = ol.ratingsAvg || gb?.ratingsAvg || null;
  const enoughRatings = (ol.ratingsCount || 0) + (gb?.ratingsCount || 0) >= 5;
  // A 4.5 average lifts, a 2.5 drags — but only once enough people have voted.
  const quality = avg && enoughRatings ? 0.8 + ((avg - 2.5) / 2.5) * 0.35 : 1;

  return {
    score: clamp(base * quality),
    confidence: raw > 50 ? 1 : 0.5,
    detail: `${ol.wantToRead.toLocaleString()} want-to-read · ${ol.alreadyRead.toLocaleString()} read` +
            (avg ? ` · ${round(avg, 1)}★` : ''),
    parts: { raw, base, quality },
  };
}

/* 3. DISCUSSION — cultural chatter volume (HN/Algolia full-text index) */
function discussion({ hn }) {
  if (!hn) return { score: 0, confidence: 0, detail: 'No discussion data', parts: {} };
  const all = logScale(hn.total, 600);
  const recent = logScale(hn.recent, 120);
  const score = 0.55 * all + 0.45 * recent;
  return {
    score,
    confidence: hn.total > 3 ? 1 : 0.4,
    detail: `${hn.total} mentions (${hn.recent} in last 12mo)`,
    parts: { all, recent },
  };
}

/* 4. ADAPTABILITY — structural fit for the screen */
function adaptability({ ol, gb, wiki }) {
  const subjects = (ol?.subjects || []).concat(gb?.categories || []).join(' | ');
  const text = [gb?.description, wiki?.extract, ol?.firstSentence].filter(Boolean).join(' ');
  if (!subjects && !text) {
    return { score: 40, confidence: 0.2, detail: 'No subject or description data — neutral default', parts: {} };
  }

  let score = 45; // neutral baseline
  const reasons = [];

  // Genre affinity: the strongest single matching signal, plus a small bonus
  // for a second matching genre (crossover concepts pitch well).
  const hits = GENRE_AFFINITY.filter((g) => g.match.test(subjects)).sort((a, b) => b.weight - a.weight);
  if (hits.length) {
    score += hits[0].weight + (hits[1] ? hits[1].weight * 0.3 : 0);
    reasons.push(hits.slice(0, 2).map((h) => h.match.source.split('|')[0]).join(' + '));
  }

  // Page count: the sweet spots differ by target format, but the extremes are
  // hard either way — a 120-page novella has to be inflated, an 900-page epic cut.
  const pages = ol?.pages || gb?.pages || null;
  if (pages) {
    if (pages >= 280 && pages <= 520) { score += 8; reasons.push('feature/limited-length'); }
    else if (pages > 520 && pages <= 800) { score += 5; reasons.push('series-length'); }
    else if (pages < 180) { score -= 6; reasons.push('very short'); }
    else if (pages > 900) { score -= 8; reasons.push('very long'); }
  }

  // High-concept markers in the prose: a hook you can say in one sentence.
  const concept = HIGH_CONCEPT_MARKERS.filter((m) => m.test(text)).length;
  if (concept) { score += Math.min(concept * 4, 12); reasons.push(`${concept} concept marker${concept > 1 ? 's' : ''}`); }

  // Series potential — built-in seasons.
  if (/series|trilogy|book (?:one|1|two|2)|sequel|saga/i.test(subjects + ' ' + text)) {
    score += 6; reasons.push('series potential');
  }
  // Award pedigree travels well to prestige buyers.
  if (/award|prize|booker|hugo|nebula|pulitzer|bestseller/i.test(subjects + ' ' + text)) {
    score += 5; reasons.push('award/bestseller pedigree');
  }

  return {
    score: clamp(score),
    confidence: subjects ? 0.9 : 0.5,
    detail: reasons.length ? reasons.join(' · ') : 'No strong structural signals',
    parts: { pages, concept, genreHits: hits.length },
  };
}

/* 5. WHITESPACE — is the screen lane empty */
function whitespace({ adapt, ol, wiki }) {
  // Open Library sometimes tags adaptations explicitly on older works — a
  // useful third opinion, but on its own only suggestive.
  const olTagged = /film adaptation|motion picture|television adaptation|filmed/i
    .test((ol?.subjects || []).join(' '));

  if (!adapt) {
    return {
      score: 60,
      confidence: 0.2,
      detail: 'Adaptation status unknown — check manually',
      parts: { status: 'unknown', penalty: 40 },
    };
  }

  let status = adapt.status;
  if (status === 'clear' && olTagged) status = 'adapted';

  // A confirmed adaptation is close to disqualifying. A single-source hit is
  // treated as likely but is scored — and labelled — less absolutely, because
  // a same-titled unrelated film is a real failure mode of the sibling check.
  let penalty, detail, confidence;
  if (status === 'adapted') {
    const confirmed = adapt.confirmed || (adapt.siblings.length > 0 && olTagged);
    penalty = confirmed ? 85 : 62;
    confidence = confirmed ? 0.95 : 0.6;
    detail = confirmed
      ? `Already adapted — ${adapt.siblings[0] || 'confirmed in article'}`
      : `Likely adapted (single source: ${adapt.siblings[0] || 'article text'}) — verify`;
  } else if (status === 'in-dev') {
    penalty = 42;
    confidence = 0.7;
    detail = 'Rights optioned or adaptation in development';
  } else {
    penalty = 0;
    // "Clear" is only meaningful if we actually had something to read. No
    // Wikipedia article means no evidence, not an empty lane.
    confidence = wiki ? (adapt.hasSection ? 0.85 : 0.65) : 0.3;
    detail = wiki
      ? 'No screen adaptation found on Wikipedia'
      : 'No Wikipedia article — adaptation status unverified';
  }

  return {
    score: clamp(100 - penalty),
    confidence,
    detail,
    parts: { status, penalty, siblings: adapt.siblings, confirmed: adapt.confirmed },
  };
}

/* 6. RIGHTS — likely availability, inferred from publication year */
function rights({ ol }) {
  const year = ol?.year;
  const nowYear = new Date().getFullYear();
  if (!year) return { score: 50, confidence: 0.2, detail: 'Publication year unknown', parts: {} };
  const age = nowYear - year;

  // US public domain currently covers works published 96+ years ago.
  if (age >= 96) {
    return { score: 100, confidence: 0.9, detail: `Published ${year} — likely US public domain`, parts: { age } };
  }
  if (age <= 2) {
    return { score: 55, confidence: 0.6, detail: `Published ${year} — hot, likely already shopped`, parts: { age } };
  }
  if (age <= 6) {
    return { score: 65, confidence: 0.6, detail: `Published ${year} — recent, rights likely still with author/agent`, parts: { age } };
  }
  if (age <= 15) {
    return { score: 78, confidence: 0.6, detail: `Published ${year} — past the initial option window`, parts: { age } };
  }
  // The dormant-backlist sweet spot: old enough that options have lapsed,
  // new enough that the audience still exists.
  return { score: 88, confidence: 0.6, detail: `Published ${year} — dormant backlist, options likely lapsed`, parts: { age } };
}

const FACTORS = { momentum, readership, discussion, adaptability, whitespace, rights };

export const FACTOR_LABELS = {
  momentum: 'Momentum',
  readership: 'Readership',
  discussion: 'Discussion',
  adaptability: 'Adaptability',
  whitespace: 'Whitespace',
  rights: 'Rights',
};

export const FACTOR_BLURBS = {
  momentum: 'Wikipedia pageview volume and 30-day trend vs the prior baseline.',
  readership: 'Open Library want-to-read, finished-reader and rating counts, quality-adjusted.',
  discussion: 'Full-text mention volume across Hacker News stories and comments.',
  adaptability: 'Structural fit: genre, length, high-concept markers, series and award signals.',
  whitespace: 'Whether a screen adaptation already exists or is in development.',
  rights: 'Likely rights availability inferred from publication year.',
};

export function scoreBook(signals, weights) {
  const factors = {};
  for (const [name, fn] of Object.entries(FACTORS)) factors[name] = fn(signals);

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  let sum = 0;
  for (const [name, w] of Object.entries(weights)) sum += (factors[name]?.score || 0) * w;
  const aps = sum / totalWeight;

  // Confidence is the weighted average of per-factor confidence — a book
  // scored off two working sources should not read as authoritative.
  let cSum = 0;
  for (const [name, w] of Object.entries(weights)) cSum += (factors[name]?.confidence ?? 0) * w;
  const confidence = cSum / totalWeight;

  return { aps: round(aps, 1), confidence: round(confidence, 2), factors };
}

/* ------------------------- format recommendation -------------------------- */

export function recommendFormat(signals, factors) {
  const { ol, gb, wiki } = signals;
  const pages = ol?.pages || gb?.pages || 0;
  const subjects = ((ol?.subjects || []).concat(gb?.categories || [])).join(' ');
  const text = [gb?.description, wiki?.extract].filter(Boolean).join(' ');
  const isSeries = /series|trilogy|saga|book (?:one|1)/i.test(subjects + ' ' + text);
  const scores = [];

  scores.push({
    format: 'Feature film',
    score: (pages && pages < 350 ? 30 : 10) + (isSeries ? -15 : 12) +
           (/thriller|crime|horror|suspense/i.test(subjects) ? 18 : 0) +
           (factors.adaptability.parts.concept ? 12 : 0),
    why: 'Single contained arc, tight page count, high-concept hook',
  });
  scores.push({
    format: 'Limited series',
    score: 22 + (pages >= 300 && pages <= 650 ? 25 : 5) +
           (/literary|historical|family|domestic/i.test(subjects) ? 16 : 0) +
           (isSeries ? -6 : 8),
    why: 'Novel-length interiority that needs room but has a finite ending',
  });
  scores.push({
    format: 'Returning series',
    score: (isSeries ? 34 : 2) + (pages > 500 ? 16 : 0) +
           (/fantasy|science fiction|space opera|mystery|detective/i.test(subjects) ? 18 : 0),
    why: 'Built-in sequels and an episodic world that can sustain seasons',
  });
  scores.push({
    format: 'Animated',
    score: (/fantasy|mytholog|fairy|juvenile|young adult|anime/i.test(subjects) ? 26 : 2) +
           (/creature|beast|dragon|talking|magic/i.test(text) ? 14 : 0),
    why: 'Imagery that is cheaper drawn than built',
  });

  scores.sort((a, b) => b.score - a.score);
  return scores[0];
}

/* ------------------------------- comp titles ------------------------------ */

/** Comps are drawn from the scanned slate itself — shared Open Library
 *  subjects, weighted toward rarer subjects that actually mean something. */
export function findComps(target, allBooks, limit = 3) {
  const targetSubjects = new Set((target.signals.ol?.subjects || []).map((s) => s.toLowerCase()));
  if (!targetSubjects.size) return [];

  // Document frequency, so "fiction" counts for almost nothing.
  const df = new Map();
  for (const b of allBooks) {
    for (const s of new Set((b.signals.ol?.subjects || []).map((x) => x.toLowerCase()))) {
      df.set(s, (df.get(s) || 0) + 1);
    }
  }
  const n = allBooks.length || 1;

  return allBooks
    .filter((b) => b.id !== target.id && b.signals.ol)
    .map((b) => {
      const subs = new Set(b.signals.ol.subjects.map((s) => s.toLowerCase()));
      let sim = 0;
      const shared = [];
      for (const s of subs) {
        if (!targetSubjects.has(s)) continue;
        const idf = Math.log(n / (df.get(s) || 1)) + 0.1;
        sim += idf;
        shared.push(s);
      }
      return { book: b, sim, shared: shared.slice(0, 4) };
    })
    .filter((c) => c.sim > 0.4)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
}
