const { tmdbToken, userAgent } = require('./config');
const { validDate } = require('./catalog');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, params = {}, { fetcher = fetch, sleep = delay, token = tmdbToken } = {}) {
  if (!token) throw new Error('TMDB_TOKEN is not configured');
  const url = new URL('https://api.themoviedb.org/3' + path);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': userAgent }, signal: AbortSignal.timeout(20000) });
      if (response.ok) return await response.json();
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const seconds = Number(response.headers.get('retry-after'));
        await sleep(Math.min(15000, Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0)));
        continue;
      }
      const error = new Error(`TMDB ${response.status} at ${path}`);
      error.permanent = response.status !== 429 && response.status < 500;
      throw error;
    } catch (error) {
      if (error.permanent || attempt === 3) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}
const discover = (from, to, page) => api('/discover/movie', { region: 'GR', 'release_date.gte': from, 'release_date.lte': to, with_release_type: '2|3', sort_by: 'primary_release_date.desc', include_adult: false, include_video: false, language: 'el-GR', page });
const details = id => api(`/movie/${id}`, { language: 'el-GR', append_to_response: 'external_ids,release_dates,credits' });
const find = id => api(`/find/${id}`, { external_source: 'imdb_id', language: 'el-GR' });
const search = query => api('/search/movie', { query, language: 'el-GR', include_adult: false });
function greekTheatricalDates(payload) {
  return (payload.results || []).filter(x => x.iso_3166_1 === 'GR').flatMap(x => x.release_dates || [])
    .filter(x => [2, 3].includes(x.type))
    .filter(x => !/festival|φεστιβ|disff|tiff|νύχτες πρεμιέρας|athens international|drama international/i.test(x.note || ''))
    .map(x => ({ date: String(x.release_date || '').slice(0, 10), type: x.type, note: x.note || '' })).filter(x => validDate(x.date));
}
module.exports = { api, discover, details, find, search, greekTheatricalDates };
