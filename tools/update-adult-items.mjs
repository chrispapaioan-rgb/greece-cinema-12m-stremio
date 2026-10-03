import fs from 'node:fs/promises';
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
const startYear = 1980;
const currentYear = new Date().getUTCFullYear();
const provisionalFromYear = currentYear - 2;
const minImdbRatingForHistoricalUnrated = 6.0;
const minImdbVotesForHistoricalUnrated = 50;

function clean(v='') { return v === '\\N' ? '' : String(v || '').trim(); }
function round1(n) { return Math.round(Number(n) * 10) / 10; }
function q(v='') { return encodeURIComponent(v); }
function scoreBand(score) {
  if (score >= 87) return '87–100 | ΕΞΑΙΡΕΤΙΚΕΣ';
  if (score >= 80) return '80–87 | ΠΟΛΥ ΚΑΛΕΣ';
  if (score >= 75) return '75–80 | ΚΑΛΕΣ';
  return '50–75 | ADULT ART';
}

async function linesFromGzipUrl(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Cine75AdultCatalog/1.1' },
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok || !r.body) throw new Error(`${url} -> ${r.status}`);
  const gunzip = zlib.createGunzip();
  Readable.fromWeb(r.body).pipe(gunzip);
  return readline.createInterface({ input: gunzip, crlfDelay: Infinity });
}

async function loadImdbAdult() {
  const map = new Map();
  const rl = await linesFromGzipUrl(basicsUrl);
  let first = true;
  for await (const line of rl) {
    const c = line.split('\t');
    if (first) { first = false; continue; }
    const imdbId = c[0], type = c[1], primaryTitle = clean(c[2]), originalTitle = clean(c[3]);
    const isAdult = c[4], year = Number(c[5]), genres = clean(c[8]);
    if (type !== 'movie' || isAdult !== '1' || !Number.isFinite(year)) continue;
    if (year < startYear || year > currentYear) continue;
    map.set(imdbId, {
      imdbId, title: primaryTitle || originalTitle, originalTitle, year,
      genres: genres ? genres.split(',').filter(Boolean) : [],
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

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Cine75AdultCatalog/1.1' },
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function filmIndexYear(year) {
  const rows = [];
  let offset = 0, hasMore = true;
  while (hasMore && offset < 1000) {
    const page = await fetchJson(`https://moviesranking.com/api/top?from=${year}&to=${year}&offset=${offset}&count=100`);
    const batch = Array.isArray(page.rows) ? page.rows : [];
    if (!batch.length) break;
    for (const row of batch) {
      const score = round1(row.overallScore);
      if (row.imdbId && Number.isFinite(score) && score > 50) rows.push({
        imdbId: row.imdbId, title: clean(row.title), year: Number(row.year) || year,
        director: clean(row.director), score, sourcesCount: Number(row.sourcesCount) || 0,
        poster: clean(row.poster)
      });
    }
    const lastScore = Number(batch[batch.length - 1]?.overallScore);
    hasMore = Boolean(page.hasMore) && Number.isFinite(lastScore) && lastScore > 50;
    offset += batch.length;
  }
  return rows;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  async function worker(){ while(next < items.length){ const i=next++; out[i]=await fn(items[i],i); } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

const curated = JSON.parse(await fs.readFile(curatedPath, 'utf8'));
const candidates = await loadImdbAdult();

for (const x of curated.entries || []) {
  const year = Number(x.year || 0);
  if (!x.imdbId || year < startYear || year > currentYear) continue;
  const old = candidates.get(x.imdbId) || {};
  candidates.set(x.imdbId, {
    ...old, ...x,
    imdbId: x.imdbId, year,
    title: x.title || old.title || '', genres: old.genres || [],
    adultExplicit: Boolean(x.adultExplicit ?? old.adultExplicit ?? true),
    curatedException: Boolean(x.curatedException),
    discoverySource: old.discoverySource ? old.discoverySource + ' + curated' : 'curated'
  });
}

await applyImdbRatings(candidates);

const years = Array.from({length: currentYear-startYear+1},(_,i)=>startYear+i);
const yearly = await mapLimit(years, 5, async y => {
  try { return await filmIndexYear(y); }
  catch(e){ console.warn('Film Index year failed',y,e.message); return []; }
});
const filmByImdb = new Map(yearly.flat().map(x=>[x.imdbId,x]));

const items = [];
let scored = 0, unrated = 0, historicalQualityUnrated = 0, provisionalNew = 0, curatedUnrated = 0;
for (const x of candidates.values()) {
  const fi = filmByImdb.get(x.imdbId);
  const hasFilmScore = Boolean(fi && Number.isFinite(fi.score));
  if (hasFilmScore && fi.score <= 50) continue;

  let include = hasFilmScore;
  let admission = hasFilmScore ? 'Film Index >50' : '';
  if (!hasFilmScore) {
    const curatedKeep = Boolean(x.curatedException || String(x.discoverySource||'').includes('curated'));
    const isProvisionalNew = x.year >= provisionalFromYear;
    const hasQualitySignal = Number.isFinite(x.imdbRating) && x.imdbRating >= minImdbRatingForHistoricalUnrated
      && Number(x.imdbVotes) >= minImdbVotesForHistoricalUnrated;
    include = curatedKeep || isProvisionalNew || hasQualitySignal;
    if (curatedKeep) { admission='CURATED 18+'; curatedUnrated++; }
    else if (isProvisionalNew) { admission='PROVISIONAL UNRATED 18+'; provisionalNew++; }
    else if (hasQualitySignal) { admission='IMDb quality signal'; historicalQualityUnrated++; }
  }
  if (!include) continue;

  const title = clean(fi?.title) || clean(x.title) || clean(x.originalTitle) || x.imdbId;
  const year = Number(fi?.year || x.year || 0);
  const score = hasFilmScore ? fi.score : null;
  if (hasFilmScore) scored++; else unrated++;

  items.push({
    id: 'adult:' + x.imdbId,
    imdbId: x.imdbId,
    title, greekTitle: '', year,
    score,
    scoreBand: hasFilmScore ? scoreBand(score) : 'UNRATED 18+',
    scoreSources: hasFilmScore ? `${fi.sourcesCount}/8` : 'UNRATED 18+',
    imdbRating: Number.isFinite(x.imdbRating) ? x.imdbRating : null,
    imdbVotes: Number.isFinite(x.imdbVotes) ? x.imdbVotes : 0,
    director: clean(fi?.director) || clean(x.director),
    genres: Array.isArray(x.genres) ? x.genres : [],
    categories: ['18+ / Adult Art'],
    description: '', overview: '', runtime: null, cast: [],
    poster: '', background: '', greekTheatricalDate: '', isRerelease: false,
    source: [x.discoverySource, admission].filter(Boolean).join(' + '),
    adultCategory: 'ADULT_ART', adultExplicit: Boolean(x.adultExplicit),
    adultExclusive: true, adultCuratedException: !hasFilmScore && admission==='CURATED 18+',
    adultUnrated: !hasFilmScore, adultAdmission: admission,
    filmIndexUrl: hasFilmScore ? `https://moviesranking.com/top?from=${year}&to=${year}` : '',
    stremioAppUri: `stremio:///detail/movie/${x.imdbId}/${x.imdbId}?autoPlay=true`,
    stremioWebUrl: `https://web.stremio.com/#/detail/movie/${x.imdbId}/${x.imdbId}`,
    greekSubsStatus: '', greekSubsUrl: '',
    imdbUrl: `https://www.imdb.com/title/${x.imdbId}/`,
    letterboxdUrl: `https://letterboxd.com/imdb/${x.imdbId}`,
    justWatchUrl: `https://www.justwatch.com/gr/search?q=${q(title)}`,
    tmdbUrl: '', mubiUrl: `https://www.google.com/search?q=${q('site:mubi.com/en/films "'+title+'" '+year)}`
  });
}

items.sort((a,b)=>{
  const ar=a.score==null?-1:a.score, br=b.score==null?-1:b.score;
  return br-ar || b.year-a.year || a.title.localeCompare(b.title,'en');
});

const out = {
  schemaVersion: 2, generatedAt: new Date().toISOString(), category: 'ADULT_ART',
  hiddenByDefault: true, startYear, currentYear,
  rules: {
    discovery: `IMDb isAdult=1 feature films, ${startYear}–${currentYear}, plus curated adult-art titles`,
    rated: 'Film Index combined score must be >50',
    newUnrated: `All IMDb adult feature films from ${provisionalFromYear} onward are admitted provisionally when Film Index has no score`,
    historicalUnrated: `IMDb >=${minImdbRatingForHistoricalUnrated} with >=${minImdbVotesForHistoricalUnrated} votes, or curated exception`,
    posters: 'Explicit adult items use neutral/no poster in Cine75'
  },
  stats: { candidates:candidates.size, count:items.length, scored, unrated, historicalQualityUnrated, provisionalNew, curatedUnrated },
  count: items.length, items
};
await fs.writeFile(outputPath, JSON.stringify(out,null,2)+'\n','utf8');
console.log(JSON.stringify(out.stats,null,2));