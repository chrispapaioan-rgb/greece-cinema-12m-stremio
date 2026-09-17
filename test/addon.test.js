const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { windowAt, selectItems, compareRating, meta } = require('../src/catalog');
const { api, greekTheatricalDates } = require('../src/tmdb');
const { buildCatalog, discoverRange } = require('../src/refresh');
const { createApp, CATALOG_ID, RATING_ID } = require('../src/server');
const now = new Date('2026-09-17T12:00:00Z');
const movie = (id, date, extra = {}) => ({ id: `tt${id}`, type: 'movie', name: `Movie ${id}`, greekTheatricalDate: date, ...extra });

test('12 calendar months follow Athens date, including midnight and leap years', () => {
  assert.equal(windowAt(new Date('2026-09-16T21:30:00Z')).to, '2026-09-17');
  assert.equal(windowAt(new Date('2024-02-29T12:00:00Z')).from, '2023-02-28');
  assert.equal(windowAt(new Date('2025-02-28T12:00:00Z')).from, '2024-02-28');
});
test('window filters future/expired/invalid releases and deduplicates using latest Greek date', () => {
  const items = [movie(1, '2026-01-01'), movie(1, '2026-09-17'), movie(2, '2025-09-16'), movie(3, '2026-09-18'), movie(4, '2025-09-17'), movie(5, '2026-02-30')];
  assert.deepEqual(selectItems(items, windowAt(now)).map(x => x.id), ['tt1', 'tt4']);
});
test('ranking uses rating descending; votes break ties; unrated titles last', () => {
  const items = [movie(1, '2026-09-01', { rating: 9, ratingVotes: 0 }), movie(2, '2026-09-01', { rating: 8.5, ratingVotes: 100 }), movie(3, '2026-09-01', { rating: 9, ratingVotes: 1 }), movie(4, '2026-09-01', { rating: 8.5, ratingVotes: 200 })];
  assert.deepEqual(items.sort(compareRating).map(x => x.id), ['tt3', 'tt4', 'tt2', 'tt1']);
  assert.match(meta(items[0]).description, /TMDB: 9.0\/10 \(1 ψήφοι\)/);
  assert.match(meta(items[3]).description, /Δεν υπάρχει/);
});
test('metadata owns description but retains IMDb video ID for stream addons', () => {
  const m = meta(movie(33764258, '2026-07-16', { year: 2026, name: 'Οδύσσεια', rating: 8.2, ratingVotes: 500 }));
  assert.equal(m.id, 'grcinema:tt33764258'); assert.equal(m.behaviorHints.defaultVideoId, 'tt33764258');
  assert.equal(m.videos[0].id, 'tt33764258'); assert.match(m.description, /16\/07\/2026/);
  assert.equal(m.releaseInfo, '2026'); assert.equal(m.imdbRating, undefined);
});
test('only Greek theatrical records, excluding festival/digital/foreign records', () => {
  const payload = { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-09-17' }] }, { iso_3166_1: 'GR', release_dates: [
    { type: 1, release_date: '2026-09-01' }, { type: 4, release_date: '2026-09-02' },
    { type: 3, release_date: '2026-09-03', note: 'Drama International Film Festival' }, { type: 2, release_date: '2026-09-04' }, { type: 3, release_date: '2026-09-10', note: 'Re-release' }
  ] }] };
  assert.deepEqual(greekTheatricalDates(payload).map(x => x.date), ['2026-09-04', '2026-09-10']);
});
test('TMDB throttling retries without exposing bearer token', async () => {
  let calls = 0;
  const result = await api('/test', {}, { token: 'private', sleep: async () => {}, fetcher: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : Response.json({ ok: true }) });
  assert.deepEqual(result, { ok: true }); assert.equal(calls, 2);
  await assert.rejects(api('/test', {}, { token: 'private', fetcher: async () => new Response('secret', { status: 401 }) }), /TMDB 401 at \/test/);
});
test('discovery includes every page and refuses unrepresentable single-day truncation', async () => {
  const calls = [];
  const client = { discover: async (a, b, page) => { calls.push(page); return { total_pages: 3, results: [{ id: page }] }; } };
  assert.equal((await discoverRange(client, '2026-09-01', '2026-09-17')).length, 3);
  assert.deepEqual(calls.sort(), [1, 2, 3]);
  await assert.rejects(discoverRange({ discover: async () => ({ results: [], total_pages: 501 }) }, '2026-09-17', '2026-09-17'), /refusing truncation/);
});
function fixtureClient() {
  return {
    discover: async () => ({ total_pages: 1, results: [{ id: 1 }, { id: 2 }] }),
    details: async id => ({ id, title: `Film ${id}`, original_title: `Film ${id}`, release_date: '1966-01-01',
      external_ids: { imdb_id: id === 2 ? null : `tt${id}` }, vote_average: 8, vote_count: 50,
      release_dates: { results: [{ iso_3166_1: 'GR', release_dates: [{ type: 3, release_date: '1966-01-01' }, { type: 3, release_date: '2026-09-17', note: 'Re-release' }] }] } })
  };
}
test('build retains old films with new releases and movies without IMDb IDs', async () => {
  const c = await buildCatalog({ client: fixtureClient(), now });
  assert.equal(c.count, 2); assert.equal(c.items[0].greekTheatricalDate, '2026-09-17');
  assert.equal(c.items[0].year, 1966); assert.ok(c.items.some(x => x.id === 'tmdb:2')); assert.equal(c.audit.failedCount, 0);
});
test('failed metadata aborts refresh instead of writing a partial catalog', async () => {
  const client = fixtureClient(); client.details = async () => { throw new Error('upstream unavailable'); };
  await assert.rejects(buildCatalog({ client, now }), /upstream unavailable/);
});
test('curated source recovers absent release, corrections preserve newer re-release, date exclusions are scoped', async () => {
  const client = fixtureClient();
  const c = await buildCatalog({ client, now, overrides: { include: [{ tmdbId: 3, name: 'Οδύσσεια', greekTheatricalDate: '2026-07-16', sources: ['https://example.org/release'] }], exclude: [{ id: 'tt1', date: '2026-09-17' }] } });
  assert.ok(!c.items.some(x => x.id === 'tt1'));
  assert.equal(c.items.find(x => x.id === 'tt3').greekTheatricalDate, '2026-09-17');
});
test('HTTP: both catalogs same set, paging, search, CORS, metadata, stale and failed refresh', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grcinema-test-'));
  const file = path.join(dir, 'catalog.json');
  const items = Array.from({ length: 217 }, (_, i) => movie(i + 1, i < 110 ? '2026-09-17' : '2026-09-10', { rating: (i % 10) + 0.1, ratingVotes: i + 1 }));
  items[73] = movie(33764258, '2026-07-16', { name: 'Οδύσσεια', originalName: 'The Odyssey', rating: 8.2, ratingVotes: 500 });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, generatedAt: now.toISOString(), window: windowAt(now), items }));
  const serverApp = createApp({ catalogFile: file, now: () => now, token: 'test', refreshFn: async () => { throw new Error('test failure'); } });
  const server = serverApp.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(p) { const r = await fetch(base + p); return { status: r.status, headers: r.headers, body: await r.json() }; }
  const m = await get('/manifest.json'); assert.equal(m.headers.get('access-control-allow-origin'), '*'); assert.equal(m.body.catalogs.length, 2);
  const collect = async id => {
    const out = [];
    for (let skip = 0; skip <= 300; skip += 100) { const r = await get(`/catalog/movie/${id}/skip=${skip}.json`); assert.equal(r.status, 200); assert.ok(r.body.cacheMaxAge <= 60); out.push(...r.body.metas); }
    return out;
  };
  const byDate = await collect(CATALOG_ID), byRating = await collect(RATING_ID);
  assert.equal(byDate.length, 217); assert.equal(new Set(byDate.map(x => x.id)).size, 217);
  assert.deepEqual(byDate.map(x => x.id).sort(), byRating.map(x => x.id).sort());
  assert.equal(byRating[0].id, 'grcinema:tt210');
  assert.equal((await get(`/catalog/movie/${CATALOG_ID}/skip=-1.json`)).status, 400);
  assert.equal((await get(`/catalog/movie/${CATALOG_ID}/skip=999999999999999999999.json`)).status, 400);
  const search = await get(`/catalog/movie/${CATALOG_ID}/search=${encodeURIComponent('οδυσσεια')}.json`);
  assert.equal(search.body.metas[0].id, 'grcinema:tt33764258');
  const detail = await get('/meta/movie/grcinema:tt33764258.json'); assert.match(detail.body.meta.description, /TMDB: 8.2/);
  assert.equal(detail.body.meta.behaviorHints.defaultVideoId, 'tt33764258');
  assert.equal((await fetch(base + '/manifest.json', { method: 'OPTIONS' })).status, 204);
  assert.equal((await get('/health')).status, 200);
  await serverApp.safeRefresh(); assert.equal((await get('/health')).status, 503);
  assert.equal((await collect(CATALOG_ID)).length, 217);
});
test('the rolling window advances daily in both catalogs even before refresh completes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grcinema-day-'));
  const file = path.join(dir, 'catalog.json');
  const items = [movie(1, '2025-09-17', { rating: 10, ratingVotes: 20 }), movie(2, '2026-09-17', { rating: 7, ratingVotes: 20 })];
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, generatedAt: now.toISOString(), window: windowAt(now), items }));
  let today = now, refreshCount = 0;
  const instance = createApp({ catalogFile: file, now: () => today, token: 'test', refreshFn: async () => {
    refreshCount++;
    return { schemaVersion: 2, generatedAt: today.toISOString(), window: windowAt(today), items: [...items, movie(3, '2026-09-18', { rating: 8, ratingVotes: 40 })] };
  } });
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  today = new Date('2026-09-17T21:01:00Z'); // September 18 in Greece.
  await fetch(base + '/manifest.json'); // First request starts refresh after local midnight.
  await instance.safeRefresh();
  for (const id of [CATALOG_ID, RATING_ID]) {
    const body = await (await fetch(`${base}/catalog/movie/${id}.json`)).json();
    assert.deepEqual(new Set(body.metas.map(x => x.id)), new Set(['grcinema:tt2', 'grcinema:tt3']));
  }
  assert.ok(refreshCount >= 1); assert.equal(instance.status().window.from, '2025-09-18');
});
