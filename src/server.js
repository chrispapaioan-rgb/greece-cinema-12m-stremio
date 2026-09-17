const express = require('express');
const config = require('./config');
const { main: refresh } = require('./refresh');
const { readJson, windowAt, selectItems, compareRating, normalize, meta } = require('./catalog');
const CATALOG_ID = 'greece-theatrical-12m-v2';
const RATING_ID = 'greece-theatrical-12m-rating';
const LEGACY_IDS = new Set([CATALOG_ID, 'greece-theatrical-12m', 'greece-cinema-12m']);
const manifest = {
  id: 'gr.cinema.rolling12m.v2', version: '2.2.0', name: 'Ελλάδα • Κυκλοφορίες 12μήνου',
  description: 'Ελληνικές κινηματογραφικές ημερομηνίες, νεότερες πρώτες. Περιλαμβάνει επανακυκλοφορίες. Δεδομένα TMDB και τεκμηριωμένες διορθώσεις ελληνικών πηγών.',
  resources: ['catalog', { name: 'meta', types: ['movie'], idPrefixes: ['grcinema:'] }], types: ['movie'],
  catalogs: [{ id: CATALOG_ID, name: '🇬🇷 Ελλάδα • Νεότερη προβολή' }, { id: RATING_ID, name: '🇬🇷 Ελλάδα • Υψηλότερη βαθμολογία' }].map(c => ({ ...c, type: 'movie', extra: [{ name: 'skip', isRequired: false }, { name: 'search', isRequired: false }] })),
  behaviorHints: { configurable: false, configurationRequired: false }
};
const cache = { cacheMaxAge: 60, staleRevalidate: 0, staleError: 0 };
function createApp({ catalogFile = config.catalogFile, refreshFn = refresh, now = () => new Date(), token = config.tmdbToken, refreshHours = config.refreshHours } = {}) {
  const app = express();
  app.disable('x-powered-by'); app.disable('etag');
  let snapshot = { items: [], generatedAt: null }, error = null, refreshing = null, lastAttempt = 0;
  try { snapshot = readJson(catalogFile, snapshot); } catch (e) { error = 'Stored catalog could not be read'; }
  const ageMs = () => now().getTime() - Date.parse(snapshot.generatedAt || '');
  const isStale = () => !Number.isFinite(ageMs()) || ageMs() > refreshHours * 3600000 || snapshot.window?.to !== windowAt(now()).to;
  function status() {
    const items = selectItems(snapshot.items, windowAt(now()));
    const odyssey = items.find(x => x.id === 'tt33764258');
    return { ok: !!snapshot.generatedAt && !!items.length && !isStale() && !error && snapshot.schemaVersion === 2,
      version: manifest.version, catalogId: CATALOG_ID, generatedAt: snapshot.generatedAt,
      count: items.length, window: windowAt(now()), stale: isStale(), refreshing: !!refreshing,
      lastRefreshError: error, sourceConfigured: Boolean(token), audit: snapshot.audit || null,
      first10: items.slice(0, 10).map(x => ({ id: x.id, name: x.name, greekTheatricalDate: x.greekTheatricalDate })),
      odyssey: odyssey ? { ...odyssey, position: items.indexOf(odyssey) + 1 } : null };
  }
  async function safeRefresh() {
    if (refreshing) return refreshing;
    if (!token) { error = 'TMDB_TOKEN is not configured'; return; }
    lastAttempt = now().getTime();
    refreshing = (async () => {
      try { snapshot = await refreshFn(); error = null; }
      catch (e) { error = e.message; console.error('Refresh failed:', e.message); }
    })();
    try { await refreshing; } finally { refreshing = null; }
  }
  app.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Expose-Headers': 'X-Catalog-Generated-At, X-Catalog-Stale',
      'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (isStale() && now().getTime() - lastAttempt > 300000) void safeRefresh();
    next();
  });
  app.get('/manifest.json', (req, res) => res.json(manifest));
  app.get('/health', (req, res) => { const s = status(); res.status(s.ok ? 200 : 503).json(s); });
  app.get('/ready', (req, res) => res.json({ ready: true, version: manifest.version }));
  app.get('/catalog.json', (req, res) => res.json({ ...snapshot, items: selectItems(snapshot.items, windowAt(now())), status: status() }));
  function available(res) {
    res.set('X-Catalog-Generated-At', snapshot.generatedAt || 'pending');
    res.set('X-Catalog-Stale', String(isStale()));
    if (!snapshot.generatedAt) { res.set('Retry-After', '15').status(503).json({ error: 'Catalog is loading. Please retry shortly.', ...cache, cacheMaxAge: 0 }); return false; }
    return true;
  }
  app.get(['/catalog/movie/:id.json', '/catalog/movie/:id/:extra.json'], (req, res) => {
    if (!LEGACY_IDS.has(req.params.id) && req.params.id !== RATING_ID) return res.status(404).json({ error: 'Unknown catalog' });
    const args = new URLSearchParams(req.params.extra || '');
    const skipText = args.get('skip') ?? String(req.query.skip ?? '0');
    if (!/^\d+$/.test(skipText) || !Number.isSafeInteger(Number(skipText))) return res.status(400).json({ error: 'skip must be a nonnegative integer' });
    if (!available(res)) return;
    let items = selectItems(snapshot.items, windowAt(now()));
    const search = normalize(args.get('search') || req.query.search || '');
    if (search) items = items.filter(x => normalize(`${x.name} ${x.originalName || ''}`).includes(search));
    if (req.params.id === RATING_ID) items.sort(compareRating);
    const skip = Number(skipText);
    res.json({ metas: items.slice(skip, skip + 100).map(meta), ...cache });
  });
  app.get('/meta/movie/:id.json', (req, res) => {
    if (!available(res)) return;
    const sourceId = req.params.id.replace(/^grcinema:/, '');
    const item = selectItems(snapshot.items, windowAt(now())).find(x => x.id === sourceId);
    if (!item) return res.status(404).json({ meta: null, ...cache });
    res.json({ meta: meta(item), ...cache });
  });
  app.get('/', (req, res) => res.type('html').send(`<!doctype html><html lang="el"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ελλάδα • Κυκλοφορίες 12μήνου</title><style>body{font:17px/1.6 system-ui;max-width:900px;margin:40px auto;padding:0 20px;background:#111827;color:#e5e7eb}a{color:#93c5fd}.button{display:inline-block;padding:12px 20px;background:#2563eb;color:white;border-radius:8px;text-decoration:none}input{padding:10px;font:inherit;width:90%;max-width:500px}td,th{text-align:left;padding:8px;border-bottom:1px solid #374151}small{color:#9ca3af}</style><h1>🇬🇷 Ελλάδα • Κυκλοφορίες 12μήνου</h1><p>Ταινίες με ελληνική κινηματογραφική κυκλοφορία τους τελευταίους 12 μήνες, με τις νεότερες πρώτες. Οι επανακυκλοφορίες ταξινομούνται με τη νέα ελληνική ημερομηνία.</p><p><a class="button" id="install">Εγκατάσταση στο Stremio</a> · <a id="web">Άνοιγμα στο Stremio Web</a></p><p>Στο Discover επίλεξε Movies → 🇬🇷 Ελλάδα • Νεότερη προβολή ή Υψηλότερη βαθμολογία. Αν έχεις παλιότερο αντίγραφο του ίδιου addon, αφαίρεσέ το μία φορά πριν την εγκατάσταση.</p><p>Manifest: <a href="/manifest.json" id="manifest"></a></p><p id="status">Φόρτωση καταλόγου…</p><input id="search" aria-label="Αναζήτηση ταινίας" placeholder="Αναζήτηση, π.χ. Οδύσσεια"><table><thead><tr><th>Θέση</th><th>Ταινία</th><th>Ελληνική κυκλοφορία</th></tr></thead><tbody id="movies"></tbody></table><p><small>Πηγές: TMDB και τεκμηριωμένες διορθώσεις ελληνικών πηγών. Η πληρότητα εξαρτάται από τα στοιχεία των πηγών. This product uses the TMDB API but is not endorsed or certified by TMDB.</small></p><script>
const manifestUrl=location.origin+'/manifest.json';
document.getElementById('manifest').textContent=manifestUrl;
document.getElementById('install').href='stremio://'+location.host+'/manifest.json';
document.getElementById('web').href='https://web.stremio.com/#/addons?addon='+encodeURIComponent(manifestUrl);
let items=[];const normal=s=>s.normalize('NFD').replace(/\\p{M}/gu,'').toLowerCase();
function draw(){const q=normal(document.getElementById('search').value);const body=document.getElementById('movies');body.replaceChildren();items.forEach((x,i)=>{if(q&&!normal(x.name+' '+(x.originalName||'')).includes(q))return;const tr=document.createElement('tr');[i+1,x.name,x.greekTheatricalDate.split('-').reverse().join('/')].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td)});body.append(tr)})}
document.getElementById('search').addEventListener('input',draw);
fetch('/catalog.json').then(r=>r.json()).then(c=>{items=c.items;document.getElementById('status').textContent=items.length+' ταινίες · '+(c.status.ok?'Ενημερωμένος κατάλογος':'Η ανανέωση εκκρεμεί ή χρειάζεται έλεγχο')+' · Έκδοση '+c.status.version;draw()}).catch(()=>{document.getElementById('status').textContent='Ο κατάλογος δεν είναι διαθέσιμος αυτή τη στιγμή.'});
</script></html>`));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => res.status(err.status === 400 ? 400 : 500).json({ error: err.status === 400 ? 'Malformed request' : 'Request failed' }));
  return { app, safeRefresh, status };
}
if (require.main === module) {
  const { app, safeRefresh } = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => { console.log(`Listening on ${config.port}`); void safeRefresh(); });
  const timer = setInterval(() => void safeRefresh(), config.refreshHours * 3600000); timer.unref();
  process.on('SIGTERM', () => { clearInterval(timer); server.close(() => process.exit(0)); });
}
module.exports = { createApp, manifest, CATALOG_ID, RATING_ID };
