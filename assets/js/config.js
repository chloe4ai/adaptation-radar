// Tunable constants for the Adaptation Potential Score.
// Everything here is deliberately visible and editable — the scoring model is
// the product, so it should be inspectable rather than buried.

export const WEIGHTS_DEFAULT = {
  momentum: 25,    // Wikipedia attention trend — is interest rising right now
  readership: 20,  // Open Library reader signals — how many people actually read it
  discussion: 15,  // Hacker News / forum mention volume — cultural chatter
  adaptability: 20,// structural fit for screen, from subjects + shape of the book
  whitespace: 12,  // is the adaptation lane empty (heavy penalty if already adapted)
  rights: 8,       // likely rights availability, inferred from publication year
};

export const SOURCES = {
  openLibrary: 'https://openlibrary.org/search.json',
  wikiApi: 'https://en.wikipedia.org/w/api.php',
  wikiSummary: 'https://en.wikipedia.org/api/rest_v1/page/summary/',
  pageviews: 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/',
  hn: 'https://hn.algolia.com/api/v1/search',
  googleBooks: 'https://www.googleapis.com/books/v1/volumes',
};

// Cache TTL for fetched signals. Live sources, but no need to re-hammer them
// on every reload while you are working through a slate.
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// How many books to scan concurrently. Public APIs, so stay polite.
export const SCAN_CONCURRENCY = 4;

export const FETCH_TIMEOUT_MS = 12000;

// Genre → adaptability affinity. Positive terms lift the structural score,
// negative terms sink it. Matched against Open Library subject strings.
export const GENRE_AFFINITY = [
  { match: /science fiction|sci-fi|dystopia|cyberpunk|space opera/i, weight: 18 },
  { match: /fantasy|magic|mytholog|fairy tale/i, weight: 16 },
  { match: /thriller|suspense|crime|detective|mystery|noir/i, weight: 18 },
  { match: /horror|gothic|supernatural/i, weight: 14 },
  { match: /historical fiction|historical novel|war stories/i, weight: 12 },
  { match: /romance|love stories/i, weight: 10 },
  { match: /young adult|juvenile fiction|coming of age/i, weight: 10 },
  { match: /adventure|survival/i, weight: 12 },
  { match: /biograph|memoir|true crime/i, weight: 8 },
  { match: /literary|domestic fiction|family/i, weight: 4 },
  { match: /poetry|poems/i, weight: -30 },
  { match: /essays|criticism|reference|handbook|textbook|dictionary/i, weight: -35 },
  { match: /philosophy|theolog/i, weight: -18 },
];

// Concept markers in a description that suggest a pitchable hook.
export const HIGH_CONCEPT_MARKERS = [
  /must (?:choose|decide|survive|escape|stop|find)/i,
  /the only (?:one|person|way|thing)/i,
  /(?:when|after) (?:a|an|the) [^.]{0,60} (?:arrives|appears|vanishes|dies|returns)/i,
  /secret|conspiracy|betrayal|revenge|heist|island|expedition/i,
  /decades? later|years later|generations/i,
  /time (?:travel|loop)|parallel|alternate (?:history|world)/i,
];
// Adaptation detection lives in sources.js — it needs two live API calls
// (sibling-article lookup plus a section-scoped article scan) rather than a
// keyword table, because scanning a whole article produces false positives.
