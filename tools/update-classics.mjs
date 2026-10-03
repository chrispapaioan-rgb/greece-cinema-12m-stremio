import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';

const cwd = process.cwd();
const dataDir = path.resolve(cwd, 'data');
const curatedPath = path.join(dataDir, 'classics-curated.json');
const outputPath = path.join(dataDir, 'classics-items.json');

const classicEndYear = 2015;
const filmIndexFloor = 80;
const autoExcellentFloor = 82;
const masterpieceFloor = 85;
const imdbHighFloor = 7.5;
const imdbHighVotes = 5000;
const imdbConsensusFloor = 7.0;
const imdbConsensusVotes = 1000;
const strongSourceCount = 7;

const basicsUrl = 'https://datasets.imdbws.com/title.basics.tsv.gz';
const ratingsUrl = 'https://datasets.imdbws.com/title.ratings.tsv.gz';

function clean(v='') { return v === '\\N' ? '' : String(v || '').trim(); }
function round1(n) { return Math.round(Number(n) * 10) / 10; }
function q(v='') { return encodeURIComponent(v); }
function cineCategories(genres=[]) {
  const out=['Κλασικά / Διαχρονικά'];
  const add=x=>{ if(!out.includes(x)) out.push(x); };
  for(const g of genres){
    const x=String(g).toLowerCase();
    if(x.includes('thriller')) add('Θρίλερ');
    if(x.includes('drama')) { add('Δράμα'); add('Κοινωνικές'); }
    if(x.includes('romance')) add('Ερωτικές / Ρομαντικές');
    if(x.includes('comedy')) add('Κωμωδίες');
    if(x.includes('sci-fi')||x.includes('science fiction')) add('Sci-Fi');
    if(x.includes('action')) add('Δράση');
    if(x.includes('mystery')) add('Μυστήριο');
    if(x.includes('horror')) add('Τρόμου');
    if(x.includes('adventure')) add('Περιπέτεια');
    if(x.includes('animation')) add('Animation');
    if(x.includes('documentary')) add('Ντοκιμαντέρ');
    if(x.includes('history')) add('Ιστορικές');
    if(x.includes('biography')) add('Βιογραφικές');
    if(x.includes('crime')) add('Εγκλήματος / Αστυνομικές');
    if(x.includes('fantasy')) add('Fantasy');
    if(x.includes('music')||x.includes('musical')) add('Μουσικές');
  }
  return out;
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Cine75Classics/1.0' },
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function gzipLines(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Cine75Classics/1.0' },
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok || !r.body) throw new Error(`${url} -> ${r.status}`);
  const gunzip = zlib.createGunzip();
  Readable.fromWeb(r.body).pipe(gunzip);
  return readline.createInterface({ input: gunzip, crlfDelay: Infinity });
}

async function filmIndexCandidates() {
  const rows = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore && offset < 3000) {
    const page = await fetchJson(
      `https://moviesranking.com/api/top?from=1888&to=${classicEndYear}&offset=${offset}&count=100`
    );
    const batch = Array.isArray(page.rows) ? page.rows : [];
    if (!batch.length) break;
    for (const row of batch) {
      const score = round1(row.overallScore);
      if (!row.imdbId || !Number.isFinite(score)) continue;
      rows.push({
        imdbId: row.imdbId,
        title: clean(row.title),
        year: Number(row.year) || 0,
        director: clean(row.director),
        score,
        scoreSources: Number(row.sourcesCount) || 0,
        filmIndexUrl: row.href
          ? `https://moviesranking.com${row.href}`
          : `https://moviesranking.com/top?from=1888&to=${classicEndYear}`,
        poster: clean(row.poster)
      });
    }
    const lastScore = Number(batch[batch.length - 1]?.overallScore);
    hasMore = Boolean(page.hasMore) && Number.isFinite(lastScore) && lastScore >= filmIndexFloor;
    offset += batch.length;
  }
  return rows;
}

async function attachImdbSignals(byId) {
  let rl = await gzipLines(basicsUrl);
  let first = true;
  for await (const line of rl) {
    const c = line.split('\t');
    if (first) { first = false; continue; }
    const hit = byId.get(c[0]);
    if (!hit) continue;
    hit.imdbIsAdult = c[4] === '1';
    hit.imdbType = clean(c[1]);
    hit.imdbPrimaryTitle = clean(c[2]);
    hit.imdbOriginalTitle = clean(c[3]);
    hit.imdbGenres = clean(c[8]) ? clean(c[8]).split(',').filter(Boolean) : [];
  }

  rl = await gzipLines(ratingsUrl);
  first = true;
  for await (const line of rl) {
    const c = line.split('\t');
    if (first) { first = false; continue; }
    const hit = byId.get(c[0]);
    if (!hit) continue;
    hit.imdbRating = Number(c[1]);
    hit.imdbVotes = Number(c[2]) || 0;
  }
}

async function filmIndexOne(imdbId) {
  try {
    const j = await fetchJson(`https://moviesranking.com/api/film/${imdbId}/bundle`);
    const m = j?.movie;
    if (!m) return null;
    const score = Number(m.overallScore);
    return {
      imdbId,
      title: clean(m.title),
      year: Number(m.year) || 0,
      director: clean(m.director),
      score: Number.isFinite(score) ? round1(score) : null,
      scoreSources: Number(m.sourcesCount) || 0,
      filmIndexUrl: `https://moviesranking.com/top?from=${Number(m.year)||1888}&to=${Number(m.year)||classicEndYear}`,
      poster: clean(m.poster)
    };
  } catch { return null; }
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

function tierFor(score, row, forceInclude=false) {
  if (forceInclude) return 'CLASSIC_MASTERPIECE_EXCEPTION';
  if (score >= masterpieceFloor) return 'CLASSIC_MASTERPIECE';
  if (score >= autoExcellentFloor) return 'CLASSIC_EXCELLENT';
  if (score >= filmIndexFloor) {
    const strongImdb = Number.isFinite(row.imdbRating)
      && row.imdbRating >= imdbHighFloor
      && row.imdbVotes >= imdbHighVotes;
    const strongConsensus = row.scoreSources >= strongSourceCount
      && Number.isFinite(row.imdbRating)
      && row.imdbRating >= imdbConsensusFloor
      && row.imdbVotes >= imdbConsensusVotes;
    if (strongImdb || strongConsensus) return 'CLASSIC_EXCEPTION';
  }
  return '';
}

const rows = await filmIndexCandidates();
const byId = new Map(rows.map(x => [x.imdbId, x]));
await attachImdbSignals(byId);

const curated = JSON.parse(await fs.readFile(curatedPath, 'utf8'));
const curatedById = new Map((curated.entries || []).filter(x => x.imdbId).map(x => [x.imdbId, x]));

const missingCurated = [...curatedById.keys()].filter(id => !byId.has(id));
const extraRows = await mapLimit(missingCurated, 4, filmIndexOne);
for (const row of extraRows) if (row) byId.set(row.imdbId, row);

// Curated items that were fetched after the IMDb pass need their IMDb signals too.
if (missingCurated.length) await attachImdbSignals(byId);

const items = [];
const rejected = [];
for (const row of byId.values()) {
  const curatedEntry = curatedById.get(row.imdbId);
  const forceInclude = Boolean(curatedEntry?.forceInclude && clean(curatedEntry?.reason));
  const score = Number.isFinite(Number(row.score)) ? round1(row.score) : null;

  // General classics must never leak IMDb adult titles into the normal catalog.
  if (row.imdbIsAdult === true) {
    rejected.push({imdbId:row.imdbId,title:row.title,reason:'IMDb isAdult=1'});
    continue;
  }

  if (!forceInclude && (!Number.isFinite(score) || score < filmIndexFloor)) {
    rejected.push({imdbId:row.imdbId,title:row.title,reason:'below automatic floor'});
    continue;
  }

  const tier = tierFor(score ?? -1, row, forceInclude);
  if (!tier) {
    rejected.push({imdbId:row.imdbId,title:row.title,reason:'80–81.9 confidence gate failed'});
    continue;
  }

  const title = clean(row.title) || clean(row.imdbPrimaryTitle) || row.imdbId;
  const year = Number(row.year) || Number(curatedEntry?.year) || 0;
  if (year >= 2016 || year <= 0) continue;

  items.push({
    id: 'classic:' + row.imdbId,
    imdbId: row.imdbId,
    title,
    greekTitle: '',
    year,
    score,
    scoreBand: tier === 'CLASSIC_MASTERPIECE' ? 'CLASSIC MASTERPIECE'
      : tier === 'CLASSIC_EXCELLENT' ? 'CLASSIC EXCELLENT'
      : tier === 'CLASSIC_EXCEPTION' ? 'CLASSIC EXCEPTION'
      : 'CLASSIC MASTERPIECE EXCEPTION',
    scoreSources: Number(row.scoreSources) ? `${row.scoreSources}/8` : '',
    director: clean(row.director) || clean(curatedEntry?.director),
    genres: Array.isArray(row.imdbGenres) ? row.imdbGenres : [],
    categories: cineCategories(Array.isArray(row.imdbGenres) ? row.imdbGenres : []),
    description: '',
    overview: '',
    poster: clean(row.poster),
    background: '',
    cast: [],
    runtime: null,
    greekTheatricalDate: '',
    isRerelease: false,
    source: forceInclude ? 'Film Index + curated classic exception' : 'Film Index classics algorithm',
    classicCategory: 'CLASSICS',
    classicTier: tier,
    classicException: tier === 'CLASSIC_EXCEPTION' || tier === 'CLASSIC_MASTERPIECE_EXCEPTION',
    classicReason: forceInclude ? clean(curatedEntry.reason) : '',
    imdbRating: Number.isFinite(row.imdbRating) ? row.imdbRating : null,
    imdbVotes: Number(row.imdbVotes) || 0,
    imdbUrl: `https://www.imdb.com/title/${row.imdbId}/`,
    letterboxdUrl: `https://letterboxd.com/imdb/${row.imdbId}`,
    justWatchUrl: `https://www.justwatch.com/gr/search?q=${q(title)}`,
    filmIndexUrl: row.filmIndexUrl || '',
    stremioAppUri: `stremio:///detail/movie/${row.imdbId}/${row.imdbId}?autoPlay=true`,
    stremioWebUrl: `https://web.stremio.com/#/detail/movie/${row.imdbId}/${row.imdbId}`
  });
}

items.sort((a,b) => b.score - a.score || b.year - a.year || a.title.localeCompare(b.title,'en'));

const stats = {
  fetchedFilmIndex: rows.length,
  admitted: items.length,
  masterpiece: items.filter(x=>x.classicTier==='CLASSIC_MASTERPIECE').length,
  excellent: items.filter(x=>x.classicTier==='CLASSIC_EXCELLENT').length,
  exception: items.filter(x=>x.classicTier==='CLASSIC_EXCEPTION').length,
  curatedException: items.filter(x=>x.classicTier==='CLASSIC_MASTERPIECE_EXCEPTION').length,
  rejectedAdult: rejected.filter(x=>x.reason==='IMDb isAdult=1').length,
  rejectedConfidence: rejected.filter(x=>x.reason==='80–81.9 confidence gate failed').length
};

const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  category: 'CLASSICS',
  hiddenByDefault: false,
  endYear: classicEndYear,
  rules: {
    masterpiece: 'Film Index >=85',
    excellent: 'Film Index 82–84.9',
    exception: 'Film Index 80–81.9 plus IMDb >=7.5/5000 votes OR Film Index sources >=7/8 plus IMDb >=7.0/1000 votes',
    curated: 'Below automatic rules only via forceInclude=true with non-empty reason',
    adultIsolation: 'IMDb isAdult=1 excluded from general classics'
  },
  stats,
  count: items.length,
  items
};

await fs.writeFile(outputPath, JSON.stringify(out,null,2)+'\n','utf8');
console.log(JSON.stringify(stats,null,2));