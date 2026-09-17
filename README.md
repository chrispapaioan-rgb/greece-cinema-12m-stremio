# Greece Cinema 12M — Stremio addon

Production manifest: https://greece-cinema-12m-stremio.onrender.com/manifest.json

Two Discover catalogs contain the same rolling set of Greek theatrical releases:

- **Νεότερη προβολή**: latest official Greek theatrical release/re-release date descending; title and ID break ties.
- **Υψηλότερη βαθμολογία**: TMDB vote average descending, then vote count, then Greek date. Unrated films are last. Scores are not IMDb scores and there is no minimum vote threshold.

The description shows the TMDB score, vote count and Greek theatrical date. Addon-specific metadata IDs prevent Cinemeta from replacing that description; the movie's `videos[0].id` and `behaviorHints.defaultVideoId` retain its IMDb ID (or TMDB ID when IMDb is unavailable) for stream-provider compatibility. The addon does not supply streams.

## Rolling dates and refresh

Every request calculates today's calendar date in **Europe/Athens** and the same date 12 calendar months earlier, both bounds inclusive. February 29 clamps to February 28 in a non-leap year. Old films are removed at read time, even if an upstream refresh fails. Future releases are excluded until their Greek date arrives. The window is never fixed to a deployment date.

A refresh runs at startup, at most every six hours, and on the first request after the Greek day changes or the data becomes stale. Calls are coalesced; failures retry on subsequent requests after five minutes. Free Render services may sleep, so no background process executes while asleep: the next request wakes the service and starts refresh. The checked-in snapshot provides a fallback during cold starts, with its real generation timestamp. The GitHub Actions workflow `.github/workflows/catalog-monitor.yml` requests production every six hours, wakes a sleeping instance, waits for refresh, and verifies both complete catalogs. Scheduled GitHub runs may be delayed; GitHub may disable schedules on inactive public repositories after 60 days. Request-time refresh remains the fallback.

## Sources and coverage

TMDB discovery is partitioned into calendar months and fully paginated (oversized results split further rather than silently truncating). Each movie is checked against its own **GR** release records, types **2/3** only. Known films are rechecked for re-releases even if discovery omits them. No original-production-year or popularity filter is applied. Missing IMDb IDs do not drop films.

`data/overrides.json` supplements/corrects source records using explicit Greek release dates and evidence URLs. It includes the September 17, 2026 release slate, Odyssey (July 16), and dated exclusions for three DISFF festival screenings. These are source corrections, not a static catalog. All entries still obey the daily rolling window. Festival-labeled records are rejected.

TMDB is community-maintained, not an exhaustive official national release registry. Source-backed corrections repair known gaps but cannot establish that no unknown gap exists. Repeated cinema showtimes do not count as new releases. A film with multiple qualifying Greek dates appears once, using its latest qualifying date.

## Reliability and protocol

- CORS on all routes, OPTIONS support, cache lifetime no longer than 60 seconds.
- 100 items per page; validated `skip`; Greek/English accent-insensitive search.
- Stable catalog IDs; legacy chronological routes remain supported.
- Bounded upstream timeouts and retries for throttling/transient failures.
- Atomic file replacement only after the entire refresh succeeds; upstream errors never become movie records or a partial-success catalog.
- `/health`: 200 only for a valid fresh snapshot; otherwise 503 with the error/staleness state.
- `/ready`: process readiness, independent of TMDB.
- `/catalog.json`: public catalog plus generation time and source audit, no credentials.

## Run and verify

Node >=20. Set `TMDB_TOKEN` to a TMDB read-access token. Optional: `PORT`, `CATALOG_FILE`, `OVERRIDES_FILE`, `REFRESH_HOURS` (clamped to 1–6). `WINDOW_DAYS` is obsolete; the window is always 12 calendar months.

```
npm ci
npm test
npm start
npm run check -- https://greece-cinema-12m-stremio.onrender.com
```

Tests cover daily rollover, leap years, release types, re-releases, ranking/unrated films, all-page pagination, source failures, CORS, and metadata/IMDb video identity. Production checks compare every page of both catalogs to the source snapshot and verify Odyssey and its description.

This product uses the TMDB API but is not endorsed or certified by TMDB.
