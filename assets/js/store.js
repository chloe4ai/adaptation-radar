import { WEIGHTS_DEFAULT } from './config.js';

/** Local, per-browser state: slate, verdicts, notes, weights, API key.
 *  Nothing here leaves the machine. */

const K = {
  slate: 'ar:slate',
  verdicts: 'ar:verdicts',
  notes: 'ar:notes',
  weights: 'ar:weights',
  apiKey: 'ar:apikey',
};

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key, val) => {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* quota — non-fatal */ }
};

/* slate: the list of {title, author} seeds being tracked */
export const getSlate = () => read(K.slate, null);
export const setSlate = (list) => write(K.slate, list);

/* verdicts: id → 'watchlist' | 'pass' */
export const getVerdicts = () => read(K.verdicts, {});
export function setVerdict(id, verdict) {
  const v = getVerdicts();
  if (verdict) v[id] = verdict; else delete v[id];
  write(K.verdicts, v);
  return v;
}

/* notes: id → free text */
export const getNotes = () => read(K.notes, {});
export function setNote(id, text) {
  const n = getNotes();
  if (text?.trim()) n[id] = text; else delete n[id];
  write(K.notes, n);
  return n;
}

/* weights */
export const getWeights = () => ({ ...WEIGHTS_DEFAULT, ...read(K.weights, {}) });
export const setWeights = (w) => write(K.weights, w);
export const resetWeights = () => localStorage.removeItem(K.weights);

/* API key — optional, only used for the Claude-backed pitch generator */
export const getApiKey = () => {
  try { return localStorage.getItem(K.apiKey) || ''; } catch { return ''; }
};
export const setApiKey = (key) => {
  try {
    if (key) localStorage.setItem(K.apiKey, key);
    else localStorage.removeItem(K.apiKey);
  } catch { /* ignore */ }
};
