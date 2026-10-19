import { SOURCES } from './config.js';
import { getJSON, cacheGet, cacheSet, isoDaysAgo, slug } from './util.js';

/**
 * Every adapter here talks to a keyless, CORS-open public API directly from
 * the browser. Each one returns a plain object on success and `null` on
 * failure, so one dead source degrades a book's confidence rather than
 * killing the scan.
 *
 * "Failed" and "found nothing" are tracked separately, though: `stats` counts
 * requests per source that answered (ok) or did not (fail), and each
 * `gatherSignals` result lists the sources that failed for that book. A
 * failure is never cached, and never turned into a confident answer.
 */

const SOURCE_KEYS = ['wiki', 'pv', 'ol', 'hn', 'gb', 'adapt'];

/** Per-source request outcomes since the last reset: `{ wiki: { ok, fail }, ... }`. */
export const stats = {};

/**
 * Runtime switches. In the browser Google Books runs keyless and best-effort:
 * the shared anonymous quota is often exhausted, and a miss only costs a
 * description. The harvester runs from a shared CI address where that quota is
 * exhausted every day, so it turns the adapter off unless a key is configured
 * (`GOOGLE_BOOKS_KEY`, see tools/harvest.mjs): a source that is not asked
 * records no failures, and a book without it scores the same as one whose
 * lookup found nothing — missing, never zero.
 */
export const sourceOptions = { googleBooks: true, googleBooksKey: null };

export function configureSources(opts = {}) {
  Object.assign(sourceOptions, opts);
  return { ...sourceOptions };
}

export function resetStats() {
  for (const k of SOURCE_KEYS) stats[k] = { ok: 0, fail: 0 };
  return stats;
}
resetStats();

/** MediaWiki's api.php reports some failures (ratelimited, maxlag) as HTTP 200. */
const isApiError = (data) => Boolean(data && typeof data === 'object' && !Array.isArray(data) && data.error);

/**
 * A fetch function bound to one source. It counts each request in `stats`,
 * and remembers whether any request failed — both on itself (so `cached` can
 * refuse to store a half-built value) and on the per-book `ctx`.
 */
function fetcher(source, ctx) {
  const get = async (url, opts) => {
    const r = await getJSON(url, opts);
    const ok = r.ok && !isApiError(r.data);
    stats[source][ok ? 'ok' : 'fail']++;
    if (!ok) {
      get.failed = true;
      ctx?.failed?.add(source);
    }
    return { ok, data: ok ? r.data : null };
  };
  get.failed = false;
  return get;
}

async function cached(key, get, fn) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const val = await fn();
  // Never cache a null: it is indistinguishable from a cache miss on read.
  // And never cache anything built while a request failed: persisting a
  // transient failure would freeze a book's missing factor for the whole TTL.
  if (val !== undefined && val !== null && !get.failed) cacheSet(key, val);
  return val;
}

/* ---------------- Open Library: bibliographic + reader signals ------------- */

/**
 * Open Library relevance ranking is not title-matching: a search for
 * "Jonathan Strange & Mr Norrell" happily returns an academic study *about*
 * the novel, and "The Vegetarian" returns the Korean-language original.
 * Score candidates explicitly instead of trusting position 0.
 */
const norm = (s) => slug(String(s).replace(/&/g, ' and ')).replace(/^(the|a|an)-/, '');

/** Strip diacritics so "Brontë" matches "Bronte". */
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Author matching has to tolerate the several ways catalogues disagree about
 * names: diacritics (Brontë vs Bronte), transliteration (Strugatsky vs
 * Strugatskii), generational suffixes, and inverted "Miller, Walter M., Jr."
 * ordering. Punctuation is dropped before tokenising, so a trailing "." from a
 * stripped suffix cannot end up standing in as the surname.
 */
function authorMatches(names, author) {
  const parts = fold(author)
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const surname = parts[parts.length - 1] || '';
  if (surname.length < 3) return false;
  return (names || []).some((n) => {
    const f = fold(n).replace(/[^a-z\s]/g, ' ');
    if (f.includes(surname)) return true;
    // Transliteration differs in the tail ("strugatsky" / "strugatskii"), so
    // fall back to a shared stem rather than exact containment.
    const stem = surname.slice(0, 6);
    return stem.length >= 5 && f.split(/\s+/).some((tok) => tok.startsWith(stem));
  });
}

// Artifacts that are definitively not the single work being scored. These are
// rejected outright rather than penalised: an omnibus aggregates several books
// and a later volume is a different book, so scoring either produces a
// confidently wrong number. Returning nothing is the better failure — the UI
// then shows the title as thin data instead of quietly mis-attributing it.
const WRONG_ARTIFACT_RE = /\b(set of|box(?:ed)? set|collection|omnibus|complete series|bundle|\d+ books?|book (?:two|three|four|2|3|4)|vol(?:ume|\.)? ?(?:ii|iii|2|3))\b/i;

const hasLatin = (s) => /[a-z]/.test(s);
const isAscii = (s) => /^[\x20-\x7e]*$/.test(String(s));

export function pickWork(docs, title, author) {
  const want = norm(title);
  const wantTokens = new Set(want.split('-').filter((t) => t.length > 2));
  const hasAuthor = Boolean((author || '').trim());
  const latinSeed = hasLatin(want);
  const asciiSeed = isAscii(title);

  let candidates = docs.filter((d) => !WRONG_ARTIFACT_RE.test(d.title || ''));

  // If we were given an author, the record must actually be by them. This is
  // what keeps a search for a novel from landing on an academic study of it,
  // or on an unrelated physics textbook that shares the title.
  if (hasAuthor) {
    const byAuthor = candidates.filter((d) => authorMatches(d.author_name, author));
    if (!byAuthor.length) return null;
    candidates = byAuthor;
  }
  if (!candidates.length) return null;

  // `norm()` keeps only [a-z0-9], so a Hangul or Cyrillic title normalises to
  // "" — and every string starts with "", which used to hand any non-Latin
  // record the prefix-match bonus. For a Latin-script seed such a record
  // cannot be compared by title, so it is set aside and only used as a
  // fallback (below).
  let setAside = [];
  if (latinSeed) {
    setAside = candidates.filter((d) => !hasLatin(norm(d.title || '')));
    candidates = candidates.filter((d) => hasLatin(norm(d.title || '')));
  }
  // Open Library files translations under the original-language work, so for
  // a translated novel (The Vegetarian -> 채식주의자) the only record by this
  // author that is actually this book can be the non-Latin one. Take the one
  // Open Library ranked highest — the search matched it on edition titles —
  // but only when the author is known to be right.
  const fallback = () => (hasAuthor && setAside.length ? setAside[0] : null);
  if (!candidates.length) return fallback();

  const scored = candidates.map((d) => {
    const got = norm(d.title || '');
    let s = 0;
    let titled = false;   // any title evidence at all, beyond author and language
    if (!latinSeed) {
      // A non-Latin seed has nothing to normalise; only an exact match counts.
      if (fold(d.title || '').trim() === fold(title).trim()) s += 100;
    } else if (got === want) s += 100;
    else if (got.startsWith(want) || want.startsWith(got)) s += 60;
    else if (got.includes(want)) s += 25;
    titled = s > 0;

    // Token overlap, so near-misses still rank above unrelated records.
    if (wantTokens.size) {
      const gotTokens = new Set(got.split('-'));
      let shared = 0;
      for (const t of wantTokens) if (gotTokens.has(t)) shared++;
      s += (shared / wantTokens.size) * 30;
      if (shared) titled = true;
    }

    if (hasAuthor) s += 45; // candidates are already filtered to this author
    // Prefer the English edition — this is a scouting tool for English-language
    // screen rights. An ASCII seed is an English title, so a record with no
    // English edition at all is probably the original-language work.
    const langs = d.language || [];
    if (langs.includes('eng')) s += 18;
    else if (asciiSeed && langs.length) s -= 18;
    if (d.cover_i) s += 4;
    if (d.ratings_count || d.want_to_read_count) s += 4;
    // Studies and companions carry long titles; the work itself is usually terse.
    s -= Math.max(0, got.length - want.length) * 0.08;
    return { d, s, titled };
  });

  scored.sort((a, b) => b.s - a.s);
  // When original-language records were set aside above, the best remaining
  // same-author record with no title in common is far more likely to be a
  // different book (Greek Lessons for The Vegetarian) than this one, so the
  // original-language record wins.
  if (setAside.length && !scored[0].titled) return fallback();
  return scored[0].s > 15 ? scored[0].d : null;
}

const OL_FIELDS = [
  'key', 'title', 'author_name', 'first_publish_year', 'ratings_average',
  'ratings_count', 'want_to_read_count', 'already_read_count', 'currently_reading_count',
  'subject', 'number_of_pages_median', 'cover_i', 'first_sentence', 'language',
].join(',');

/**
 * The title to show for a book. Open Library sometimes resolves to the
 * original-language work record (채식주의자 for The Vegetarian); a title with
 * no Latin letters is useless on an English-language board, so fall back to
 * the seed the user typed.
 */
export function displayTitle(signals) {
  const t = signals?.ol?.title;
  return t && /[a-z]/.test(fold(t)) ? t : signals?.seed?.title || t || '';
}

export function openLibrary({ title, author }, ctx) {
  const key = `ol:${slug(title)}:${slug(author || '')}`;
  const get = fetcher('ol', ctx);
  return cached(key, get, async () => {
    // Two queries, pooled. The fielded search is precise but brittle (it
    // returns nothing for some author spellings); the free-text search has
    // better recall but ranks studies and companions alongside the work.
    // Together they give the picker enough candidates to choose correctly.
    const fielded = `${SOURCES.openLibrary}?title=${encodeURIComponent(title)}` +
      (author ? `&author=${encodeURIComponent(author)}` : '') +
      `&limit=10&fields=${OL_FIELDS}`;
    const freeText = `${SOURCES.openLibrary}?q=${encodeURIComponent(author ? `${title} ${author}` : title)}` +
      `&limit=10&fields=${OL_FIELDS}`;

    const [a, b] = await Promise.all([get(fielded), get(freeText)]);
    const pooled = new Map();
    for (const d of [...(a.data?.docs || []), ...(b.data?.docs || [])]) {
      if (d?.key && !pooled.has(d.key)) pooled.set(d.key, d);
    }
    if (!pooled.size) return null;

    const doc = pickWork([...pooled.values()], title, author);
    if (!doc) return null;

    return {
      workKey: doc.key,
      title: doc.title,
      authors: doc.author_name || [],
      year: doc.first_publish_year || null,
      ratingsAvg: doc.ratings_average || null,
      ratingsCount: doc.ratings_count || 0,
      wantToRead: doc.want_to_read_count || 0,
      alreadyRead: doc.already_read_count || 0,
      reading: doc.currently_reading_count || 0,
      subjects: (doc.subject || []).slice(0, 40),
      pages: doc.number_of_pages_median || null,
      coverId: doc.cover_i || null,
      firstSentence: Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : null,
    };
  });
}

export const coverUrl = (coverId, size = 'M') =>
  coverId ? `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg` : null;

/* -------- Wikipedia: cultural footprint + existing-adaptation detection ----- */

export function wikipedia({ title, author }, ctx) {
  const key = `wiki:${slug(title)}:${slug(author || '')}`;
  const get = fetcher('wiki', ctx);
  return cached(key, get, async () => {
    const search = `${title} ${author || ''} novel`.trim();
    const url =
      `${SOURCES.wikiApi}?action=query&list=search&format=json&origin=*` +
      `&srlimit=5&srsearch=${encodeURIComponent(search)}`;
    const { data } = await get(url);
    const hits = data?.query?.search || [];
    if (!hits.length) return null;

    const wanted = slug(title);
    const hit =
      hits.find((h) => slug(h.title).replace(/-novel$|-book$/, '') === wanted) ||
      hits.find((h) => slug(h.title).startsWith(wanted)) ||
      hits[0];

    const { data: summary } = await get(SOURCES.wikiSummary + encodeURIComponent(hit.title));
    return {
      page: hit.title,
      pageKey: (summary?.titles?.canonical) || hit.title.replace(/ /g, '_'),
      extract: summary?.extract || '',
      description: summary?.description || '',
      url: summary?.content_urls?.desktop?.page || null,
      // Loose relevance check: did we land on an article about this book at all?
      confident: slug(hit.title).includes(wanted.slice(0, 12)),
    };
  });
}

/* ------------- Adaptation detection: is the screen lane already taken? ----- */

/**
 * Two independent checks, because either alone is unreliable:
 *
 *  1. Sibling-article detection — does Wikipedia have a "<Title> (film)" /
 *     "(TV series)" / "(miniseries)" article? Very precise, but misses
 *     adaptations that were retitled (Roadside Picnic → Stalker).
 *  2. Section-scoped text scan — pull the FULL plaintext article and read only
 *     its Adaptation / Film / Television sections. Catches retitles, and
 *     scoping to those sections avoids the false positives you get scanning
 *     the whole article (a Themes section comparing the book to Roots is not
 *     evidence that the book was adapted).
 *
 * A hit from both is treated as confirmed; one alone as likely-but-unverified.
 */

const SIBLING_RE = /\((?:[0-9]{4} )?(?:film|TV series|television series|miniseries|mini-series|film series|TV film|anime|animated series)\)$/i;
// Matches on a keyword *within* the heading, not the whole heading — real
// articles use "Adaptations and cultural influence", "Film and television
// adaptations", "In other media", and so on.
const SECTION_RE = /^==+[^=]*\b(adaptation|adaptations|other media|popular culture|film|television|screen|media|legacy)\b[^=]*==+/i;
// Deliberately tolerant of intervening words: "adapted into works in a variety
// of media, including ... television series" should count (Roadside Picnic →
// Stalker), while still requiring a screen noun rather than any adaptation.
const ADAPTED_TEXT_RE = /(?:film|television|tv|screen) adaptation|adapted (?:into|for|as)[^.]{0,90}\b(?:film|movie|television|tv|miniseries|series|screen)\b|was (?:adapted|released) as[^.]{0,40}\b(?:film|series|miniseries)\b|(?:film|miniseries|television series) of the same name/i;
const INDEV_TEXT_RE = /in development|option(?:ed|s)? (?:by|to|for)|rights (?:were|have been) (?:acquired|optioned|sold)|is (?:being|set to be) (?:developed|adapted)/i;

function adaptationSections(extract) {
  if (!extract) return '';
  const lines = extract.split('\n');
  const out = [];
  // Start capturing: the lead (everything before the first heading) is about
  // this book specifically, so it is safe to scan and often states the
  // adaptation outright.
  let capturing = true;
  for (const line of lines) {
    if (/^==+ .* ==+/.test(line.trim())) {
      capturing = SECTION_RE.test(line.trim());
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join(' ').trim();
}

export function adaptations({ title, author }, wikiPage, ctx) {
  const key = `adapt:${slug(title)}:${slug(wikiPage || '')}`;
  const get = fetcher('adapt', ctx);
  return cached(key, get, async () => {
    const siblingUrl =
      `${SOURCES.wikiApi}?action=query&list=search&format=json&origin=*&srlimit=20` +
      `&srsearch=${encodeURIComponent(`intitle:"${title}"`)}`;
    const extractUrl = wikiPage
      ? `${SOURCES.wikiApi}?action=query&prop=extracts&explaintext=1&format=json&origin=*&redirects=1` +
        `&titles=${encodeURIComponent(wikiPage)}`
      : null;

    const [sibRes, extRes] = await Promise.all([
      get(siblingUrl),
      extractUrl ? get(extractUrl) : Promise.resolve({ ok: true, data: null }),
    ]);
    // Half a check is not a check. With either lookup missing, "no adaptation
    // found" would be a fact about the outage rather than the book, so the
    // status is unknown — and, being null, it is not cached.
    if (!sibRes.ok || !extRes.ok) return null;
    const sib = sibRes.data;
    const ext = extRes.data;

    // A common title ("The Deep") will match an unrelated "(1977 film)". The
    // search snippet is already in the response, so check it for the author's
    // surname — a match ties the adaptation to *this* book rather than a
    // same-named one.
    const surname = (author || '').trim().split(/\s+/).pop() || '';
    const hits = (sib?.query?.search || []).filter((h) => SIBLING_RE.test(h.title));
    const siblings = hits.map((h) => h.title);
    const authorLinked = surname.length > 2 &&
      hits.some((h) => new RegExp(surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        .test(h.snippet || ''));

    const pages = ext?.query?.pages;
    const fullExtract = pages ? Object.values(pages)[0]?.extract || '' : '';
    const section = adaptationSections(fullExtract);

    const textAdapted = ADAPTED_TEXT_RE.test(section);
    const textInDev = !textAdapted && INDEV_TEXT_RE.test(section);

    let status = 'clear';
    const evidence = [];
    if (siblings.length) { status = 'adapted'; evidence.push(siblings[0]); }
    if (textAdapted) {
      status = 'adapted';
      evidence.push(section.slice(0, 180).trim());
    } else if (textInDev && status === 'clear') {
      status = 'in-dev';
      evidence.push(section.slice(0, 180).trim());
    }

    // Confirmed when two independent checks agree, or when the sibling article
    // itself names this book's author.
    const confirmed = (siblings.length > 0 && textAdapted) || authorLinked;
    return { status, confirmed, siblings, authorLinked, evidence, hasSection: Boolean(section) };
  });
}

/* ------------- Wikimedia Pageviews: the real momentum signal --------------- */

/**
 * Reduce a daily view series to the momentum inputs: the last 30 days, and the
 * days before that scaled to a 30-day average. The prior window is whatever
 * the API returned beyond the last 30 days (about 61 days for the 92-day
 * request, fewer for a young article), so it is divided by its actual length.
 */
export function summarizePageviews(views) {
  const last30 = views.slice(-30).reduce((a, b) => a + b, 0);
  const prior = views.slice(0, Math.max(0, views.length - 30));
  const priorSum = prior.reduce((a, b) => a + b, 0);
  const priorAvg30 = prior.length ? priorSum / (prior.length / 30) : 0;
  const peak = Math.max(...views);
  return { days: views.length, last30, priorAvg30, total: views.reduce((a, b) => a + b, 0), peak, series: views };
}

export function pageviews(pageKey, ctx) {
  if (!pageKey) return Promise.resolve(null);
  const key = `pv:${pageKey}`;
  const get = fetcher('pv', ctx);
  return cached(key, get, async () => {
    // Pageviews lag ~1–2 days, so end the window a couple of days back.
    const url =
      SOURCES.pageviews + encodeURIComponent(pageKey) +
      `/daily/${isoDaysAgo(92)}/${isoDaysAgo(2)}`;
    const { data } = await get(url);
    const items = data?.items;
    if (!items?.length) return null;
    return summarizePageviews(items.map((i) => i.views));
  });
}

/* ------------------- Hacker News / Algolia: discussion heat ---------------- */

export function hackerNews({ title }, ctx) {
  const key = `hn:${slug(title)}`;
  const get = fetcher('hn', ctx);
  return cached(key, get, async () => {
    const q = encodeURIComponent(`"${title}"`);
    const yearAgo = Math.floor(Date.now() / 1000) - 365 * 86400;
    const [{ data: all }, { data: recent }] = await Promise.all([
      get(`${SOURCES.hn}?query=${q}&tags=(story,comment)&hitsPerPage=1`),
      get(`${SOURCES.hn}?query=${q}&tags=(story,comment)&hitsPerPage=1&numericFilters=created_at_i>${yearAgo}`),
    ]);
    if (!all) return null;
    return { total: all.nbHits || 0, recent: recent?.nbHits || 0 };
  });
}

/* --------- Google Books: best-effort enrichment, degrades silently --------- */
/* The keyless quota is a shared anonymous pool that is frequently exhausted,
   so this is never load-bearing — it only ever adds a description/categories. */

export function googleBooks({ title, author }, ctx) {
  if (!sourceOptions.googleBooks) return Promise.resolve(null);
  const cacheKey = `gb:${slug(title)}:${slug(author || '')}`;
  const get = fetcher('gb', ctx);
  return cached(cacheKey, get, async () => {
    const q = `intitle:${title}` + (author ? `+inauthor:${author}` : '');
    const apiKey = sourceOptions.googleBooksKey ? `&key=${encodeURIComponent(sourceOptions.googleBooksKey)}` : '';
    const { data } = await get(`${SOURCES.googleBooks}?q=${encodeURIComponent(q)}&maxResults=3${apiKey}`, { timeout: 6000 });
    const v = data?.items?.[0]?.volumeInfo;
    if (!v) return null;
    return {
      description: v.description || '',
      categories: v.categories || [],
      pages: v.pageCount || null,
      ratingsCount: v.ratingsCount || 0,
      ratingsAvg: v.averageRating || null,
    };
  });
}

/** Fetch every signal for one book. Sources run in parallel; pageviews chains
 *  off the Wikipedia lookup because it needs the resolved article title.
 *
 *  `failed` lists the sources with at least one failed request for this book,
 *  which is how a caller tells "no Wikipedia article" from "Wikipedia did not
 *  answer". */
export async function gatherSignals(seed) {
  const ctx = { failed: new Set() };
  const [ol, wiki, hn, gb] = await Promise.all([
    openLibrary(seed, ctx),
    wikipedia(seed, ctx),
    hackerNews(seed, ctx),
    googleBooks(seed, ctx),
  ]);
  // Both of these need the resolved Wikipedia article title, so they chain.
  // If the lookup failed there is no title to chain from, and an adaptation
  // check run without the article would read "clear" off half the evidence —
  // so both stay unknown rather than guessed.
  const wikiDown = !wiki && ctx.failed.has('wiki');
  const [pv, adapt] = wikiDown
    ? [null, null]
    : await Promise.all([
      pageviews(wiki?.pageKey, ctx),
      adaptations(seed, wiki?.page, ctx),
    ]);
  return { seed, ol, wiki, pv, hn, gb, adapt, failed: [...ctx.failed], fetchedAt: Date.now() };
}
