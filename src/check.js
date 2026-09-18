const assert = require('node:assert/strict');
const { windowAt, compareRating, selectItems } = require('./catalog');
async function check(base = 'https://greece-cinema-12m-stremio.onrender.com') {
  async function get(route) {
    const res = await fetch(base + route, { signal: AbortSignal.timeout(90000) });
    assert.equal(res.status, 200, `${route}: HTTP ${res.status}`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', `CORS missing: ${route}`);
    return res.json();
  }
  const manifest = await get('/manifest.json'), snapshot = await get('/catalog.json');
  assert.equal(manifest.catalogs.length, 2);
  assert.ok(snapshot.status.ok, JSON.stringify(snapshot.status));
  assert.equal(snapshot.status.window.to, windowAt().to);
  const items = selectItems(snapshot.items), results = [];
  for (const catalog of manifest.catalogs) {
    const metas = [], pages = [];
    for (let skip = 0; skip < items.length + 100; skip += 100) {
      const r = await get(`/catalog/movie/${catalog.id}/skip=${skip}.json`);
      pages.push(r.metas.length); metas.push(...r.metas);
      assert.ok(r.cacheMaxAge <= 60);
      if (!r.metas.length) break;
    }
    const expected = catalog.id.endsWith('-rating') ? [...items].sort(compareRating) : items;
    assert.deepEqual(metas.map(x => x.id), expected.map(x => `grcinema:details3:${x.id}`));
    assert.equal(new Set(metas.map(x => x.id)).size, items.length);
    assert.ok(metas.every(x => x.description.includes('Βαθμολογία TMDB:')));
    results.push({ catalog: catalog.id, count: metas.length, pages });
  }
  const odyssey = items.find(x => x.id === 'tt33764258');
  if (windowAt().from <= '2026-07-16' && windowAt().to >= '2026-07-16') {
    assert.ok(odyssey, 'Odyssey missing'); assert.equal(odyssey.greekTheatricalDate, '2026-07-16');
    const detail = await get('/meta/movie/grcinema:details3:tt33764258.json');
    assert.match(detail.meta.description, /16\/07\/2026/);
    assert.match(detail.meta.description, /Βαθμολογία TMDB:/);
    assert.equal(detail.meta.videos[0].id, 'tt33764258'); assert.equal(detail.meta.videos[0].overview, detail.meta.description);
  }
  const report = { checkedAt: new Date().toISOString(), version: manifest.version, window: snapshot.status.window,
    generatedAt: snapshot.generatedAt, catalogs: results, odysseyPosition: odyssey ? items.indexOf(odyssey) + 1 : null,
    curatedChecks: snapshot.audit?.curated, pass: true };
  console.log(JSON.stringify(report, null, 2)); return report;
}
if (require.main === module) check(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { check };
