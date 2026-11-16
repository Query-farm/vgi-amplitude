# Changelog

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

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
