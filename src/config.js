const path = require("path");
module.exports = {
  port: Number(process.env.PORT || 7000), tmdbToken: process.env.TMDB_TOKEN || "",
  refreshHours: Number(process.env.REFRESH_HOURS || 12), windowDays: Number(process.env.WINDOW_DAYS || 365),
  catalogFile: process.env.CATALOG_FILE || path.join(__dirname, "..", "data", "catalog.json"),
  overridesFile: process.env.OVERRIDES_FILE || path.join(__dirname, "..", "data", "overrides.json"),
  userAgent: "GreeceCinema12MStremio/2.0"
};
