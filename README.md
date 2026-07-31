# Adaptation Radar

A book-to-screen scouting board. It ranks books by how well they'd travel to film or
television, using **live public data** — no pre-baked dataset, no backend, no API key
required.

Built as a static site: open it and every number on screen is computed in your browser
from public APIs at load time.

---

## What it does

For each book on the slate it pulls live signals from four public sources and combines
them into an **Adaptation Potential Score (APS)** out of 100:

| Factor | Weight | Source | What it measures |
|---|---|---|---|
| **Momentum** | 25 | Wikimedia Pageviews | 30-day attention volume and its trend against the prior 60-day baseline |
| **Readership** | 20 | Open Library | Want-to-read, finished-reader and rating counts, quality-adjusted |
| **Discussion** | 15 | HN Algolia | Full-text mention volume, all-time and last 12 months |
| **Adaptability** | 20 | Open Library + Google Books | Genre affinity, page count, high-concept markers, series and award signals |
| **Whitespace** | 12 | Wikipedia | Whether a screen adaptation already exists or is in development |
| **Rights** | 8 | Open Library | Likely rights availability inferred from publication year |

Every weight is a slider. The board re-ranks live as you drag, so the model is something
you argue with rather than something you accept.

It also produces, per title:

- a **format read** (feature / limited series / returning series / animated) with the reasoning
- **comparables** drawn from the rest of the scanned slate, weighted by subject rarity
- **development coverage** — a logline, why-now, risks and a verdict
- watchlist / pass verdicts and free-text notes, saved locally
- CSV export of the whole board

## Why these sources

The constraint that shaped the build: a static site can only call APIs that are
**CORS-open and keyless**. That rules a lot out, and it's worth being explicit about what
survived:

- **Open Library** — `Access-Control-Allow-Origin: *`, no key, generous. Reader counts are
  sparser than Goodreads was, but they're real and they're free. Note that its relevance
  ranking is not title matching: searching a novel's title will happily return an academic
  study *about* the novel, or a foreign-language edition. Two queries (fielded and
  free-text) are pooled and scored explicitly to pick the right work.
- **Wikipedia + Wikimedia Pageviews** — both fully open. Pageviews is the single best
  momentum signal available without a contract: daily granularity, 90-day history, and it
  reflects actual public attention rather than publisher marketing.
- **HN Algolia** — open, fast, and a decent proxy for a specific kind of cultural chatter.
  It is *not* a general-population signal, and the score treats it accordingly (15%).
- **Google Books** — included as best-effort enrichment only. Its keyless quota is a
  *shared anonymous pool* that is frequently exhausted, so it returns 429 for everyone at
  unpredictable times. Nothing load-bearing depends on it; when it fails the UI says so.

Reddit was evaluated and dropped — it no longer permits browser-origin requests.

## Known limits

Worth stating plainly, since a scouting tool that overstates its confidence is worse than
no tool:

- **Open Library reader counts are thin for new releases.** A 2024 title may show 40
  want-to-reads where the real audience is six figures. Momentum (Wikipedia) partly
  compensates, but recent books are systematically underscored on the Readership axis.
- **Adaptation detection uses two independent checks and is graded, not binary.** It looks
  for a sibling Wikipedia article (`Annihilation (film)`, `Kindred (TV series)`) *and* scans
  the article's own adaptation sections. Both agreeing — or the sibling article naming this
  book's author — reads as `adapted`. One signal alone reads as `likely adapted` and should
  be verified, because a common title (*The Deep*) will match an unrelated same-named film.
  `lane clear` means *no evidence found*, not *verified clear*, and a book with no Wikipedia
  article is marked unverified rather than clear.
- **Rights inference is a publication-year heuristic**, not a rights database. It is a
  prompt to check, not an answer.
- **Books without a Wikipedia article score 0 on Momentum**, which is a real penalty against
  under-covered and non-Anglophone work. The per-factor confidence readout exists so you can
  see when this is happening — titles below 55% confidence are flagged `thin data`.

## Running it

No build step. Any static server:

```bash
python3 -m http.server 4788 --directory .
```

Then open <http://localhost:4788>.

Signals are cached in `localStorage` for 6 hours so you aren't re-hammering public APIs
while you work through a slate. Clear it from Settings.

## Optional: AI-written coverage

By default the coverage panel is **templated** — assembled deterministically from the
fetched data, with no model involved, and labelled as such.

If you paste an Anthropic API key into Settings, the panel will instead call Claude
(`claude-opus-5`) directly from the browser to write real development coverage grounded in
the signal data. The key is stored in your browser's `localStorage` and is sent only to
`api.anthropic.com`.

Be aware this is a bring-your-own-key convenience for a local tool: a browser-side key is
visible to anyone with access to the browser. Don't deploy a shared instance with a key in it.

## Adding your own titles

Use the "Add a title" form — it scans and scores immediately, and persists to your local
slate. To change the default slate for everyone, edit [`data/slate.json`](data/slate.json).

## Deploying

It's a static site, so GitHub Pages serves it as-is (`.nojekyll` is included so the
`assets/` directory isn't mangled). Push, then enable Pages on the `main` branch, root folder.

## Layout

```
index.html
assets/css/app.css
assets/js/
  config.js    weights, source URLs, genre affinity tables
  util.js      fetch/cache/concurrency helpers
  sources.js   one adapter per public API
  score.js     the six-factor model, format read, comps
  pitch.js     templated coverage + optional Claude call
  store.js     localStorage: slate, verdicts, notes, weights, key
  app.js       state, scan orchestration, rendering
data/slate.json
```

## License

MIT.
