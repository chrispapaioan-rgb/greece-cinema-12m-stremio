const path = require('node:path');
module.exports = {
  port: Number(process.env.PORT || 7000), tmdbToken: process.env.TMDB_TOKEN || '',
  refreshHours: Math.min(6, Math.max(1, Number(process.env.REFRESH_HOURS) || 6)),
  catalogFile: process.env.CATALOG_FILE || path.join(__dirname, '..', 'data', 'catalog.json'),
  overridesFile: process.env.OVERRIDES_FILE || path.join(__dirname, '..', 'data', 'overrides.json'),
  userAgent: 'GreeceCinema12MStremio/2.2'
};
