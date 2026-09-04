# Adaptation Radar

**Rank by the slope of attention, not the level. The level is already priced in.**

A scoring problem: fuse six noisy, partly-missing public signals into one 0–100 ranking and make movement in that ranking legible — in the browser, no backend, no dataset, no API key. The test case is books that could travel to film or television; the books are the fixture, the method is the point.

▶ **[Live demo](https://chloe4ai.github.io/adaptation-radar/)** — 48 titles, every number computed in your browser at load

---

## The product argument

**1. The score is the level; the edge is the slope.**
A book at 71 that was 52 three weeks ago is a different call from one that has sat at 71 since spring. So a scheduled job (`harvest.yml`, 06:20 UTC Mondays and Thursdays) commits a dated snapshot to `data/history/` and the board reads the last 12 — twice weekly, not daily, because these signals move on the order of weeks. Deltas are always attributed: a factor is named as driver only when it supplied 3+ points of the change, because "+9" is trivia and "+9, mostly momentum" is a lead.

**2. The harvester imports the browser's own modules.**
`tools/harvest.mjs` shims `localStorage` and calls the real `gatherSignals` and `scoreBook`. A trend line computed by different code than the current score drifts, and a drifting trend line is worse than none.

**3. A snapshot is refused rather than written thin.**
`gatherSignals` resolves even when every adapter returned `null`, which is right in the browser: one dead source should only dent a book's confidence. On a schedule it is a trap: a blip yields a slate of well-formed zeros the chart renders as the day the book market collapsed. So the harvester exits non-zero under three checks — 60% of the slate resolved, 60% of those carrying a live signal, mean confidence 0.35. A missing day is honest; a day of zeros is a lie the chart keeps telling.

**4. Missing data lowers confidence. It is never imputed.**
Every factor returns a 0–1 confidence beside its score and composite confidence is their weighted average, so a book scored off two working sources reads as thin — flagged below 55% — not authoritative. Weights are sliders, and each snapshot stores the weights that made it: a delta is only comparable inside one weights regime.

**5. Source resolution is scored, not trusted.**
Open Library's ranking is not title matching: search a novel and it returns an academic study about it, or a boxed set. Candidates are pooled from two queries, filtered to the named author, rejected on omnibus and later-volume patterns, then scored — exact title +100, English edition +18 — and anything under the cutoff resolves to nothing. Thin data beats a number attached to the wrong book.

## What it scores

| Factor | Weight | What it measures |
|---|---|---|
| **Momentum** | 25 | Wikimedia pageviews: 30-day volume against the prior 60-day baseline; a doubling tops out |
| **Readership** | 20 | Open Library want-to-read, finished and rating counts, quality-adjusted above 5 votes |
| **Discussion** | 15 | HN Algolia mention volume, all-time and last 12 months |
| **Adaptability** | 20 | Genre, length, high-concept markers, series and award signals |
| **Whitespace** | 12 | Whether a Wikipedia-visible adaptation exists or is in development |
| **Rights** | 8 | Likely availability, inferred from publication year |

Also per title: a format read, subject-rarity comps, a movers panel, a trend line.

## Why these sources

A static site can only call APIs that are CORS-open and keyless, which rules most of the obvious ones out — Reddit included, since it no longer permits browser-origin requests. **Open Library** survived: no key, generous, reader counts sparser than Goodreads was but real. **Wikimedia Pageviews** is the best momentum signal available without a contract: daily granularity, 92-day window, ending two days back for reporting lag. **HN Algolia** proxies one kind of chatter, not a general population — what the 15% weight says. **Google Books** is best-effort: its keyless quota is a shared anonymous pool, frequently exhausted, so nothing load-bearing depends on it.

## Run it

No build step; GitHub Pages serves it as-is (`.nojekyll` included). Signals cache in `localStorage` for 6 hours, scanned 4 at a time on a 12s fetch timeout.

```bash
python3 -m http.server 4788                  # then open localhost:4788
node tools/harvest.mjs                       # snapshot -> data/history/ (Node 18+, no deps)
node tools/harvest.mjs --limit 8 --keep 30   # subset while iterating; shorter window
```

Edit [`data/slate.json`](data/slate.json) for the default slate, or add titles from the UI. Coverage text is templated and labelled as such; an Anthropic key in Settings swaps in a live `claude-opus-5` call from the browser — local use only, since a browser-side key is visible to anyone at that browser.

## Known limits

- **Reader counts are thin for new releases.** A 2024 title may show 40 want-to-reads against a six-figure audience, so recent books are underscored on Readership.
- **Adaptation detection is graded, not binary.** Two independent checks — a sibling Wikipedia article, and the article's own adaptation sections. Both agreeing reads `adapted`, one alone `likely adapted`, since a common title matches unrelated films, and `lane clear` means *no evidence found*.
- **Rights inference is a publication-year heuristic** (96+ years reads as likely US public domain) — a prompt to check, not an answer.
- **A book with no Wikipedia article scores 0 on Momentum** — a real penalty against under-covered and non-Anglophone work. A fresh fork also shows no movement until the job has run a few times.

## What I'd build next

- **Backtest the headline claim.** "Slope beats level" is asserted here, not tested: hold out snapshots and measure whether the top decile by three-week slope precedes announced options more often than the top decile by level.
- **Fit the weights rather than assert them.** The 25/20/15/20/12/8 split is judgment; measure rank correlation against announced deals, fitted versus hand-set.
- **Per-source ablation.** Drop each adapter and measure how far the top-20 ordering moves. A factor that never changes the ranking is dead weight, and holding 8% of a score is not a defense.

## License

MIT
