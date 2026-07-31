import { getApiKey } from './store.js';
import { FACTOR_LABELS } from './score.js';

/**
 * Two pitch generators:
 *
 *  1. buildTemplatedPitch — deterministic, derived entirely from the fetched
 *     signal data. Always available, clearly labelled as templated.
 *  2. generateAIPitch — a real Claude call, only if the user supplies their
 *     own API key. The key stays in this browser's localStorage.
 */

/* ------------------------------ templated --------------------------------- */

export function buildTemplatedPitch(book) {
  const { signals, score, format } = book;
  const { ol, wiki, gb, pv } = signals;
  const title = ol?.title || book.seed.title;
  const author = ol?.authors?.[0] || book.seed.author || 'Unknown';
  const year = ol?.year;

  const genres = (ol?.subjects || [])
    .filter((s) => !/^nyt:|bestseller|accessible book|protected daisy|in library/i.test(s))
    .slice(0, 3);

  const hookSource = (gb?.description || wiki?.extract || '').trim();
  const firstSentence = hookSource.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  const logline = firstSentence
    ? firstSentence.replace(/\s+/g, ' ').slice(0, 260)
    : `A ${genres[0] || 'literary'} work by ${author}${year ? ` first published in ${year}` : ''}.`;

  const strongest = Object.entries(score.factors)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 2)
    .map(([k, v]) => `${FACTOR_LABELS[k].toLowerCase()} (${Math.round(v.score)})`);
  const weakest = Object.entries(score.factors).sort((a, b) => a[1].score - b[1].score)[0];

  const whyNow = pv && pv.last30
    ? `Wikipedia attention is running at ${pv.last30.toLocaleString()} views over the last 30 days` +
      (pv.priorAvg30 ? `, ${pv.last30 > pv.priorAvg30 ? 'up' : 'down'} against a prior baseline of ${Math.round(pv.priorAvg30).toLocaleString()}.` : '.')
    : 'No live attention spike detected — this is a catalogue play rather than a moment play.';

  const risk = `${FACTOR_LABELS[weakest[0]]} is the weak leg at ${Math.round(weakest[1].score)}/100 — ${weakest[1].detail.toLowerCase()}.`;

  return {
    kind: 'templated',
    title,
    author,
    logline,
    format: format.format,
    formatWhy: format.why,
    whyNow,
    strengths: `Leads on ${strongest.join(' and ')}.`,
    risk,
    genres,
  };
}

/* -------------------------------- Claude ---------------------------------- */

const MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You are a development executive writing internal coverage for a studio's book-scouting desk.

You will be given a book plus quantitative signal data gathered from public sources. Write coverage for a development executive deciding whether to chase the rights.

Rules:
- Be specific and grounded in the data provided. Do not invent plot details, characters, sales figures, or awards that are not in the input.
- If the input is thin, say what is unknown rather than filling the gap.
- No hype language, no "in a world where", no exclamation marks.

Return ONLY valid JSON matching this shape, with no markdown fence:
{
  "logline": "one sentence, max 40 words",
  "format": "Feature film | Limited series | Returning series | Animated",
  "format_rationale": "one sentence",
  "why_now": "two sentences grounded in the signal data",
  "comparables": "one sentence naming 2-3 real comparable titles and why",
  "risks": "two sentences on the honest case against",
  "verdict": "PURSUE | WATCH | PASS"
}`;

function buildUserPrompt(book) {
  const { signals, score, format } = book;
  const { ol, wiki, pv, hn, gb } = signals;
  const facts = [
    `Title: ${ol?.title || book.seed.title}`,
    `Author: ${ol?.authors?.join(', ') || book.seed.author || 'unknown'}`,
    `First published: ${ol?.year ?? 'unknown'}`,
    `Page count (median edition): ${ol?.pages ?? gb?.pages ?? 'unknown'}`,
    `Open Library subjects: ${(ol?.subjects || []).slice(0, 15).join(', ') || 'none'}`,
    `Reader signals: ${ol?.wantToRead ?? 0} want-to-read, ${ol?.alreadyRead ?? 0} finished, ${ol?.ratingsCount ?? 0} ratings, average ${ol?.ratingsAvg ?? 'n/a'}`,
    `Wikipedia pageviews: ${pv ? `${pv.last30} in last 30 days vs prior 30-day baseline of ${Math.round(pv.priorAvg30)}` : 'no article found'}`,
    `Discussion mentions: ${hn ? `${hn.total} all-time, ${hn.recent} in last 12 months` : 'unknown'}`,
    `Existing adaptation status: ${score.factors.whitespace.detail}`,
    `Rights inference: ${score.factors.rights.detail}`,
    `Description: ${(gb?.description || wiki?.extract || 'none available').slice(0, 1200)}`,
    '',
    `Computed Adaptation Potential Score: ${score.aps}/100 (data confidence ${Math.round(score.confidence * 100)}%)`,
    ...Object.entries(score.factors).map(([k, v]) => `  - ${FACTOR_LABELS[k]}: ${Math.round(v.score)} — ${v.detail}`),
    `Heuristic format suggestion: ${format.format} (${format.why})`,
  ];
  return `Write development coverage for this book.\n\n${facts.join('\n')}`;
}

export async function generateAIPitch(book) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key set.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required opt-in for calling the API directly from a browser.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      // Generous ceiling: on Opus 5 thinking is on by default and max_tokens
      // caps thinking plus response text together.
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(book) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    let msg = `${res.status} ${res.statusText}`;
    try { msg = JSON.parse(body).error?.message || msg; } catch { /* keep status text */ }
    throw new Error(msg);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('The model declined this request.');

  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('Empty response — try again.');

  const json = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: 'ai', raw: text };
  }
  return { kind: 'ai', ...parsed };
}
