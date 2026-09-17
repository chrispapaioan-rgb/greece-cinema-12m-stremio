const fs = require('node:fs');
const path = require('node:path');
function validDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
}
function windowAt(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  const y = Number(part('year')), m = Number(part('month')), d = Number(part('day'));
  const lastDay = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return { from: `${y - 1}-${part('month')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`, to: `${y}-${part('month')}-${part('day')}`, months: 12, timeZone: 'Europe/Athens' };
}
function compare(a, b) {
  return b.greekTheatricalDate.localeCompare(a.greekTheatricalDate) || a.name.localeCompare(b.name, 'el') || a.id.localeCompare(b.id);
}
function compareRating(a, b) {
  const rated = x => Number.isFinite(x.rating) && x.ratingVotes > 0;
  return Number(rated(b)) - Number(rated(a)) || (rated(a) && rated(b) ? b.rating - a.rating || b.ratingVotes - a.ratingVotes : 0) || compare(a, b);
}
function ratingLabel(x) {
  return Number.isFinite(x.rating) && x.ratingVotes > 0
    ? `Βαθμολογία TMDB: ${x.rating.toFixed(1)}/10 (${x.ratingVotes} ψήφοι).`
    : 'Βαθμολογία TMDB: Δεν υπάρχει ακόμη.';
}
function validItem(x) {
  return x && typeof x.id === 'string' && /^(tt\d+|tmdb:\d+)$/.test(x.id) && x.type === 'movie' && typeof x.name === 'string' && x.name.trim() && validDate(x.greekTheatricalDate);
}
function selectItems(items, window = windowAt()) {
  const byId = new Map();
  for (const x of items || []) {
    if (!validItem(x) || x.greekTheatricalDate < window.from || x.greekTheatricalDate > window.to) continue;
    const old = byId.get(x.id);
    if (!old || x.greekTheatricalDate > old.greekTheatricalDate) byId.set(x.id, x);
  }
  return [...byId.values()].sort(compare);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
function normalize(v) {
  return String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function meta(x) {
  const date = x.greekTheatricalDate.split('-').reverse().join('/');
  return {
    id: `grcinema:${x.id}`, type: 'movie', name: x.name, posterShape: 'poster',
    behaviorHints: { defaultVideoId: x.id },
    videos: [{ id: x.id, title: x.name, released: `${validDate(x.originalReleaseDate) ? x.originalReleaseDate : x.greekTheatricalDate}T00:00:00.000Z` }],
    poster: x.poster || (/^tt/.test(x.id) ? `https://images.metahub.space/poster/medium/${x.id}/img` : undefined),
    releaseInfo: x.year ? String(x.year) : undefined,
    description: `${ratingLabel(x)}\nΕλληνική κινηματογραφική κυκλοφορία: ${date}${x.isRerelease ? ' (επανακυκλοφορία)' : ''}.` + (x.overview ? `\n\n${x.overview}` : ''),
    released: validDate(x.originalReleaseDate) ? `${x.originalReleaseDate}T00:00:00.000Z` : undefined,
    greekTheatricalDate: x.greekTheatricalDate,
    background: x.background || undefined, genres: x.genres || [], director: x.director || [], cast: x.cast || [],
    runtime: x.runtime ? `${x.runtime} min` : undefined
  };
}
module.exports = { validDate, validItem, windowAt, compare, compareRating, ratingLabel, selectItems, readJson, writeAtomic, normalize, meta };
