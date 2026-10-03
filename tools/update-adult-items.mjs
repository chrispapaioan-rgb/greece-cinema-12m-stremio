import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';

const cwd = process.cwd();
const dataDir = path.resolve(cwd, 'data');
const curatedPath = path.join(dataDir, 'adult-curated.json');
const outputPath = path.join(dataDir, 'adult-items.json');
const basicsUrl = 'https://datasets.imdbws.com/title.basics.tsv.gz';
const ratingsUrl = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const filmIndexBase = 'https://moviesranking.com/api/film/';
const currentYear = new Date().getUTCFullYear();
const recentFromYear = currentYear - 2;

function clean(v='') { return v === '\\N' ? '' : String(v || '').trim(); }
function round1(n) { return Math.round(Number(n) * 10) / 10; }
function q(v='') { return encodeURIComponent(v); }

async function linesFromGzipUrl(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Cine75AdultCatalog/1.0' },
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok || !r.body) throw new Error(`${url} -> ${r.status}`);
  const gunzip = zlib.createGunzip();
  Readable.fromWeb(r.body).pipe(gunzip);
  return readline.createInterface({ input: gunzip, crlfDelay: Infinity });
}

async function loadRecentImdbAdult() {
  const map = new Map();
  const rl = await linesFromGzipUrl(basicsUrl);
  let first = true;
  for await (const line of rl) {
    const c = line.split('\t');
    if (first) { first = false; continue; }
    const imdbId = c[0], type = c[1], primaryTitle = clean(c[2]), originalTitle = clean(c[3]);
    const isAdult = c[4], year = Number(c[5]), genres = clean(c[8]);
    if (type !== 'movie' || isAdult !== '1' || !Number.isFinite(year)) continue;
    if (year < recentFromYear || year > currentYear) continue;
    map.set(imdbId, {
      imdbId, title: primaryTitle || originalTitle, originalTitle,
      year, genres: genres ? genres.split(',').filter(Boolean) : [],
      adultExplicit: true, curatedException: false, discoverySource: 'IMDb isAdult=1'
    });
  }
  return map;
}

async function applyImdbRatings(candidates) {
  const wanted = new Set(candidates.keys());
  const rl = await linesFromGzipUrl(ratingsUrl);
  let first = true;
  for await (const line of rl) {
    const c = line.split('\t');
    if (first) { first = false; continue; }
    if (!wanted.has(c[0])) continue;
    const x = candidates.get(c[0]);
    x.imdbRating = Number(c[1]);
    x.imdbVotes = Number(c[2]) || 0;
  }
}

async function filmIndex(imdbId) {
  try {
    const r = await fetch(filmIndexBase + imdbId + '/bundle', {
      headers: { 'user-agent': 'Cine75AdultCatalog/1.0' },
      signal: AbortSignal.timeout(20000)
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    return j?.movie || null;
  } catch (e) {
    console.warn('Film Index lookup failed', imdbId, e.message);
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}

const curated = JSON.parse(await fs.readFile(curatedPath, 'utf8'));
const candidates = await loadRecentImdbAdult();
for (const x of curated.entries || []) {
  if (!x.imdbId) continue;
  const old = candidates.get(x.imdbId) || {};
  candidates.set(x.imdbId, {
    ...old, ...x,
    imdbId: x.imdbId,
    title: x.title || old.title || '',
    year: Number(x.year || old.year || 0),
    genres: old.genres || [],
    adultExplicit: Boolean(x.adultExplicit ?? old.adultExplicit ?? true),
    curatedException: Boolean(x.curatedException),
    discoverySource: old.discoverySource ? old.discoverySource + ' + curated' : 'curated'
  });
}
await applyImdbRatings(candidates);

const entries = [...candidates.values()];
const enriched = await mapLimit(entries, 5, async x => ({ x, fi: await filmIndex(x.imdbId) }));

const items = [];
const excludedLowScore = [];
for (const {x, fi} of enriched) {
  const hasFilmScore = fi && Number.isFinite(Number(fi.overallScore));
  const score = hasFilmScore ? round1(fi.overallScore) : null;
  if (hasFilmScore && score <= 50) {
    excludedLowScore.push({ imdbId: x.imdbId, title: fi.title || x.title, score });
    continue;
  }

  const title = clean(fi?.title) || clean(x.title) || clean(x.originalTitle) || x.imdbId;
  const year = Number(fi?.year || x.year || 0);
  const tmdbId = Number(fi?.tmdbId) || null;
  const sourceParts = [];
  if (x.discoverySource) sourceParts.push(x.discoverySource);
  if (hasFilmScore) sourceParts.push('Film Index');
  else sourceParts.push('UNRATED 18+');

  items.push({
    id: 'adult:' + x.imdbId,
    imdbId: x.imdbId,
    tmdbId,
    title,
    greekTitle: '',
    year,
    score,
    scoreBand: hasFilmScore ? (score >= 87 ? '87–100 | ΕΞΑΙΡΕΤΙΚΕΣ' : score >= 80 ? '80–87 | ΠΟΛΥ ΚΑΛΕΣ' : score >= 75 ? '75–80 | ΚΑΛΕΣ' : '50–75 | ADULT ART') : 'UNRATED 18+',
    scoreSources: hasFilmScore ? `${Number(fi.sourcesCount) || 0}/8` : 'UNRATED 18+',
    imdbRating: Number.isFinite(x.imdbRating) ? x.imdbRating : null,
    imdbVotes: Number.isFinite(x.imdbVotes) ? x.imdbVotes : 0,
    director: clean(fi?.director) || clean(x.director),
    genres: Array.isArray(fi?.genres) ? fi.genres : (x.genres || []),
    categories: ['18+ / Adult Art'],
    description: clean(fi?.overview),
    overview: clean(fi?.overview),
    runtime: Number(fi?.runtime) || null,
    cast: Array.isArray(fi?.castMembers) ? fi.castMembers : [],
    poster: '',
    background: '',
    greekTheatricalDate: '',
    isRerelease: false,
    source: sourceParts.join(' + '),
    adultCategory: 'ADULT_ART',
    adultExplicit: Boolean(x.adultExplicit),
    adultExclusive: true,
    adultCuratedException: Boolean(x.curatedException && !hasFilmScore),
    adultUnrated: !hasFilmScore,
    filmIndexUrl: hasFilmScore ? `https://moviesranking.com/top?from=${year}&to=${year}` : '',
    stremioAppUri: `stremio:///detail/movie/${x.imdbId}/${x.imdbId}?autoPlay=true`,
    stremioWebUrl: `https://web.stremio.com/#/detail/movie/${x.imdbId}/${x.imdbId}`,
    greekSubsStatus: '',
    greekSubsUrl: '',
    imdbUrl: `https://www.imdb.com/title/${x.imdbId}/`,
    letterboxdUrl: `https://letterboxd.com/imdb/${x.imdbId}`,
    justWatchUrl: `https://www.justwatch.com/gr/search?q=${q(title)}`,
    tmdbUrl: tmdbId ? `https://www.themoviedb.org/movie/${tmdbId}` : '',
    mubiUrl: `https://www.google.com/search?q=${q('site:mubi.com/en/films "' + title + '" ' + year)}`
  });
}

items.sort((a,b) => {
  const ar = a.score == null ? -1 : a.score, br = b.score == null ? -1 : b.score;
  return br - ar || b.year - a.year || a.title.localeCompare(b.title, 'en');
});

const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  category: 'ADULT_ART',
  hiddenByDefault: true,
  rules: {
    recentDiscovery: `IMDb isAdult=1 feature films, ${recentFromYear}–${currentYear}`,
    rated: 'Film Index combined score must be > 50',
    unrated: 'Included as UNRATED 18+ when no Film Index combined score exists',
    curated: 'Curated seeds are also checked against the same >50 rule when Film Index has a score'
  },
  count: items.length,
  excludedLowScore,
  items
};
await fs.writeFile(outputPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`adultItems=${items.length}; recentIMDb=${[...candidates.values()].filter(x=>String(x.discoverySource).includes('IMDb isAdult=1')).length}; excludedScore<=50=${excludedLowScore.length}`);
console.log('scored=', items.filter(x=>x.score!=null).length, 'unrated=', items.filter(x=>x.score==null).length);