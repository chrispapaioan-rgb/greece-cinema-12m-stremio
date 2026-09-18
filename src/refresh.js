const { catalogFile, overridesFile } = require('./config');
const tmdb = require('./tmdb');
const { windowAt, validDate, validItem, selectItems, readJson, writeAtomic, normalize } = require('./catalog');
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  async function worker() { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
function splitMonths(from, to) {
  const out = []; let start = from;
  while (start <= to) {
    const d = new Date(start);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    out.push([start, end < to ? end : to]);
    start = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
  }
  return out;
}
async function discoverRange(client, from, to) {
  const first = await client.discover(from, to, 1);
  if (!Array.isArray(first.results) || !Number.isInteger(first.total_pages)) throw new Error('Invalid TMDB discovery response');
  if (first.total_pages > 500) {
    if (from === to) throw new Error(`TMDB limit exceeded on ${from}; refusing truncation`);
    const days = Math.floor((Date.parse(to) - Date.parse(from)) / 86400000);
    const mid = new Date(Date.parse(from) + Math.floor(days / 2) * 86400000).toISOString().slice(0, 10);
    const after = new Date(Date.parse(mid) + 86400000).toISOString().slice(0, 10);
    return [...await discoverRange(client, from, mid), ...await discoverRange(client, after, to)];
  }
  const rest = await mapLimit(Array.from({ length: Math.max(0, first.total_pages - 1) }, (_, i) => i + 2), 3, async page => {
    const r = await client.discover(from, to, page);
    if (!Array.isArray(r.results)) throw new Error(`Invalid TMDB page ${page}`);
    return r.results;
  });
  return [first.results, ...rest].flat();
}
function movieItem(det, release) {
  const english = (det.translations?.translations || []).find(x => x.iso_639_1 === 'en' && x.data?.overview?.trim());
  const overview = det.overview?.trim() || english?.data.overview?.trim() || '';
  return {
    id: det.imdb_id || det.external_ids?.imdb_id || `tmdb:${det.id}`, tmdbId: det.id, type: 'movie', name: det.title || det.original_title,
    originalName: det.original_title || det.title, greekTheatricalDate: release.date, releaseType: release.type, releaseNote: release.note,
    originalReleaseDate: det.release_date, year: Number((det.release_date || '').slice(0, 4)) || null,
    poster: det.poster_path ? `https://image.tmdb.org/t/p/w500${det.poster_path}` : null,
    background: det.backdrop_path ? `https://image.tmdb.org/t/p/w1280${det.backdrop_path}` : null,
    rating: Number.isFinite(det.vote_average) ? det.vote_average : null, ratingVotes: Number.isInteger(det.vote_count) ? det.vote_count : 0,
    overview, overviewLanguage: det.overview?.trim() ? 'el' : (overview ? 'en' : null), runtime: det.runtime || null, genres: (det.genres || []).map(x => x.name),
    director: (det.credits?.crew || []).filter(x => x.job === 'Director').map(x => x.name), cast: (det.credits?.cast || []).slice(0, 8).map(x => x.name),
    source: 'tmdb-gr-theatrical', sources: [`https://www.themoviedb.org/movie/${det.id}/releases`], isRerelease: /re.?release|επανέκδ|επανακυκ/i.test(release.note || '')
  };
}
function excludedRelease(exclusions, id, date) {
  return exclusions.some(x => typeof x === 'string' ? x === id : x.id === id && (!x.date || x.date === date));
}
async function resolveCurated(client, x, getDetails) {
  if (x.tmdbId) return getDetails(x.tmdbId);
  if (x.id?.startsWith('tt')) {
    const r = await client.find(x.id);
    if (r.movie_results?.length === 1) return getDetails(r.movie_results[0].id);
    throw new Error(`Cannot resolve curated IMDb ID ${x.id}`);
  }
  const r = await client.search(x.originalName || x.name);
  const names = [x.name, x.originalName, ...(x.aliases || [])].map(normalize);
  const candidates = (r.results || []).filter(m => [m.title, m.original_title].some(n => names.includes(normalize(n))) && (!x.year || Number((m.release_date || '').slice(0, 4)) === x.year));
  if (candidates.length !== 1) throw new Error(`Curated title needs unambiguous ID: ${x.originalName} (${candidates.length} matches)`);
  return getDetails(candidates[0].id);
}
async function buildCatalog({ client = tmdb, now = new Date(), overrides = { include: [], exclude: [] }, previous = {} } = {}) {
  const window = windowAt(now), allCandidates = [];
  for (const [from, to] of splitMonths(window.from, window.to)) allCandidates.push(...await discoverRange(client, from, to));
  const ids = new Set(allCandidates.map(x => x.id));
  // Recheck known titles, including re-releases discovery may omit.
  for (const x of previous.items || []) if (x.tmdbId) ids.add(x.tmdbId);
  for (const x of overrides.include || []) if (x.tmdbId) ids.add(x.tmdbId);
  const cache = new Map();
  const getDetails = id => { if (!cache.has(id)) cache.set(id, client.details(id)); return cache.get(id); };
  const exclusions = overrides.exclude || [];
  const checked = await mapLimit([...ids], 5, async id => {
    const det = await getDetails(id);
    if (!det || det.id !== id || !det.release_dates?.results || !det.external_ids) throw new Error(`Incomplete TMDB movie ${id}`);
    const imdb = det.imdb_id || det.external_ids.imdb_id || `tmdb:${id}`;
    const dates = tmdb.greekTheatricalDates(det.release_dates).filter(x => x.date >= window.from && x.date <= window.to && !excludedRelease(exclusions, imdb, x.date)).sort((a, b) => b.date.localeCompare(a.date));
    return dates.length ? movieItem(det, dates[0]) : null;
  });
  const items = checked.filter(Boolean), curated = [];
  for (const x of overrides.include || []) {
    if (!validDate(x.greekTheatricalDate) || !x.sources?.length) throw new Error(`Curated release lacks date or sources: ${x.name}`);
    if (x.greekTheatricalDate < window.from || x.greekTheatricalDate > window.to) continue;
    const det = await resolveCurated(client, x, getDetails);
    const item = { ...movieItem(det, { date: x.greekTheatricalDate, type: 3, note: x.releaseNote || '' }), name: x.name || det.title, source: 'curated-gr-theatrical', sources: x.sources, isRerelease: Boolean(x.isRerelease) };
    if (x.id && item.id !== x.id) throw new Error(`Curated identity mismatch: ${x.id}`);
    if (!excludedRelease(exclusions, item.id, item.greekTheatricalDate)) {
      const i = items.findIndex(v => v.id === item.id);
      if (i < 0) items.push(item);
      else if (items[i].greekTheatricalDate <= item.greekTheatricalDate || x.correctDate) items[i] = item;
      curated.push({ id: item.id, name: item.name, date: item.greekTheatricalDate });
    }
  }
  if (items.some(x => !validItem(x))) throw new Error('Invalid movie metadata; refusing catalog replacement');
  const result = selectItems(items, window);
  if (ids.size && !result.length) throw new Error('No validated movies; refusing empty replacement');
  return { schemaVersion: 2, generatedAt: now.toISOString(), window, count: result.length,
    audit: { candidateCount: ids.size, checkedCount: checked.length, curated, failedCount: 0, coverage: 'TMDB GR theatrical records plus source-backed corrections; not an exhaustive national registry' }, items: result };
}
async function main() {
  const previous = readJson(catalogFile, { items: [] }), overrides = readJson(overridesFile);
  const result = await buildCatalog({ previous, overrides });
  writeAtomic(catalogFile, result);
  console.log(`Updated ${result.count} movies (${result.window.from} → ${result.window.to}); ${result.audit.checkedCount} checked`);
  return result;
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main, buildCatalog, mapLimit, splitMonths, discoverRange, movieItem, resolveCurated };
