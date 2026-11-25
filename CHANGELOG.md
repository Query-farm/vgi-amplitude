# Changelog

## 0.2.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52 and @query-farm/vgi-rpc to 0.30. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.1.3 (2026-11-16)

- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.2 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

First release: Amplitude product analytics as SQL (read-only).

- `main.events()`: raw events from the Export API, streamed hour by hour from spooled ZIP archives
  (ZIP64 supported) with `event_time` / `server_upload_time` pushed into the upload-hour range,
  automatic chunk halving on Amplitude's size limit, and a resumable entry/line cursor.
- Dashboard REST charts as long rows: `segmentation`, `funnel`, `retention`, `active_users`,
  `average_session_length`, `sessions_per_user`, `session_length_distribution`, `user_composition`,
  `revenue_ltv`, `realtime_active_users`.
- Users: `user_search`, `user_activity`, `user_profile`.
- Cohorts: `cohorts`, `cohort_members` (async export job with polling).
- Tracking plan: `event_types`, `event_properties`, `user_properties`, `group_properties`,
  `event_categories`, `event_totals`; chart `annotations`.
- Schema `unified`: the shared product-analytics vocabulary (`events`, `users`, `cohorts`,
  `event_definitions`, `property_definitions`).

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)
