<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Amplitude Events, Funnels, Retention and Cohorts in DuckDB

> **vgi-amplitude** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-amplitude/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-amplitude/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

[Amplitude](https://amplitude.com) product analytics as SQL, read-only: raw events streamed from the
[Export API](https://amplitude.com/docs/apis/analytics/export) with the time range pushed down, the
[Dashboard REST API](https://amplitude.com/docs/apis/analytics/dashboard-rest) charts (event
segmentation, funnels, retention, active users, sessions, revenue LTV) as long rows, user search,
activity and profiles, behavioral cohorts and their members, the tracking plan
([Taxonomy API](https://amplitude.com/docs/apis/analytics/taxonomy)) and chart annotations. Works with
US and EU data residency projects.

```sql
CREATE SECRET amp (TYPE amplitude, API_KEY '…', SECRET_KEY '…');   -- add REGION 'eu' for EU projects

-- Yesterday's revenue by country, from raw events (only the matching upload hours are exported).
SELECT country, sum(revenue) AS revenue, count(DISTINCT user_id) AS buyers
FROM amplitude.main.events()
WHERE event_time >= TIMESTAMPTZ '2026-11-14 00:00Z' AND event_time < TIMESTAMPTZ '2026-11-15 00:00Z'
  AND event_type = 'Purchase'
GROUP BY country ORDER BY revenue DESC;

-- Sign-up → purchase conversion, computed inside Amplitude.
SELECT step, event_type, users, round(conversion_rate, 3) AS conversion
FROM amplitude.main.funnel(['Sign Up', 'Purchase'], DATE '2026-11-01', DATE '2026-11-07')
ORDER BY step;
```

## Functions and tables

### `amplitude.main`

| Object | What it returns | Amplitude API |
|---|---|---|
| `events(lookback_hours := 24, late_hours := 24, chunk_hours := 24)` | Raw events, all 47 export fields typed (`event_time` `TIMESTAMPTZ`, ids `BIGINT`, `event_properties` / `user_properties` / `groups` `JSON`, `revenue` `DOUBLE`) | `GET /api/2/export` |
| `segmentation(event_json, start_date, end_date, metric :=, granularity :=, group_by :=, segments :=, second_event :=, formula :=, group_limit :=, user_type :=)` | One row per (series, period): `series_label`, `period`, `value`, `series_total` | `/api/2/events/segmentation` |
| `funnel(events, start_date, end_date, mode :=, user_type :=, conversion_seconds :=, granularity :=, group_by :=, segments :=, group_limit :=)` | One row per (group, step): `users`, `conversion_rate`, `step_conversion_rate`, `median_seconds`, `avg_seconds` | `/api/2/funnels` |
| `retention(start_event, return_event, start_date, end_date, mode :=, brackets :=, granularity :=, group_by :=, segments :=)` | One row per (cohort, day): `cohort_size`, `retained`, `retention_rate`, `incomplete` (`cohort` NULL = combined) | `/api/2/retention` |
| `active_users(start_date, end_date, metric := 'active'\|'new', granularity :=, group_by :=, segments :=)` | Users per period and group | `/api/2/users` |
| `average_session_length(start_date, end_date)`, `sessions_per_user(...)`, `session_length_distribution(..., bin_unit :=, bin_min :=, bin_max :=, bin_size :=)` | Session charts | `/api/2/sessions/*` |
| `user_composition(start_date, end_date, property)` | Users per value of one property | `/api/2/composition` |
| `revenue_ltv(start_date, end_date, metric := 'arpu'\|'arppu'\|'total_revenue'\|'paying_users', ...)` | One row per (cohort date, day N) with the cohort's users, payers and total | `/api/2/revenue/ltv` |
| `realtime_active_users` (table) | Active users per 5-minute bucket, today and yesterday | `/api/2/realtime` |
| `user_search(query)` | `amplitude_id`, `user_id` matches for a user id, device id, Amplitude id or prefix | `/api/2/usersearch` |
| `user_activity(amplitude_id, max_events := 1000, direction := 'latest')` | One user's events (same columns as `events`), paged 1,000 at a time | `/api/2/useractivity` |
| `user_profile(query)` | Usage totals, first/last seen, devices, location and user properties of each match | usersearch + useractivity |
| `cohort_members(cohort_id, include_properties :=, property_keys :=, max_wait_seconds :=, poll_seconds :=)` | Members of a cohort (async export job) | `/api/5/cohorts/request…` |
| `cohorts` | Every behavioral cohort with size, definition (`JSON`), owners, sync targets | `/api/3/cohorts` |
| `event_types`, `event_properties`, `user_properties`, `group_properties`, `event_categories` | The tracking plan | Taxonomy API |
| `event_totals` | Visible event types with this week's count | `/api/2/events/list` |
| `annotations` | Chart annotations (releases, incidents …) | `/api/3/annotations` |

Chart functions take `start_date` / `end_date` as `DATE`s (project time zone) and Amplitude's own
parameters as named arguments, validated at bind time (`metric`, `granularity`, `mode` … have declared
choices). An event argument is an event name (`'Purchase'`, or Amplitude's `'_active'` / `'_all'` /
`'_new'`) or Amplitude event JSON (`'{"event_type":"Purchase","filters":[…],"group_by":[…]}'`).

`granularity` replaces Amplitude's `i` parameter (`interval` and `end` are DuckDB keywords and cannot be
used as named-argument names): `'day'`, `'week'`, `'month'`, plus `'hour'` and `'realtime'` for
segmentation and funnels.

Amplitude's Releases API is write-only; releases appear in `annotations`.

### `amplitude.unified`: the shared product-analytics vocabulary

The same objects, column names and types exist in the other Query.Farm analytics workers
(vgi-mixpanel, vgi-segment, and the shape PostHog's events map onto), so `UNION ALL` combines tools.
Every row carries `tool`.

| Object | Columns |
|---|---|
| `events` (table) | `tool`, `uuid`, `event_name`, `event_time`, `received_time`, `user_id`, `device_id`, `distinct_id`, `session_id`, `insert_id`, `properties`, `user_properties`, `platform`, `os`, `country`, `city`, `app_version`, `library`, `revenue` |
| `users(query)` | `tool`, `user_id`, `distinct_id`, `device_ids`, `first_seen`, `last_seen`, `properties`, `platform`, `os`, `country`, `city`, `app_version` |
| `cohorts` (table) | `tool`, `id`, `name`, `description`, `size`, `created_at`, `updated_at`, `is_archived`, `definition` |
| `event_definitions` (table) | `tool`, `event_name`, `display_name`, `description`, `category`, `is_hidden`, `is_active`, `volume`, `tags` |
| `property_definitions` (table) | `tool`, `property_name`, `scope`, `event_name`, `data_type`, `description`, `is_array`, `is_required`, `is_hidden`, `enum_values` |

## Shared product-analytics vocabulary

The contract the analytics workers (Amplitude, Mixpanel, Segment, PostHog-compatible) implement in their
`unified` schema. Types are DuckDB types; columns appear in this order; a tool that lacks a field returns
`NULL` (never omits the column).

**`events`**

| Column | Type | Meaning | Amplitude source |
|---|---|---|---|
| `tool` | `VARCHAR NOT NULL` | `'amplitude'`, `'mixpanel'`, `'segment'`, `'posthog'` | constant |
| `uuid` | `VARCHAR NOT NULL` | The tool's unique event id | `uuid` |
| `event_name` | `VARCHAR NOT NULL` | Event name as sent | `event_type` |
| `event_time` | `TIMESTAMPTZ NOT NULL` | When it happened (UTC) | `event_time` |
| `received_time` | `TIMESTAMPTZ` | When the tool received it | `server_upload_time` |
| `user_id` | `VARCHAR` | Your user id; NULL when anonymous | `user_id` |
| `device_id` | `VARCHAR` | Device / anonymous id | `device_id` |
| `distinct_id` | `VARCHAR` | The id the tool resolves people by (Mixpanel/PostHog `distinct_id`, Segment `coalesce(userId, anonymousId)`) | `amplitude_id` as text |
| `session_id` | `VARCHAR` | Session id as text | `session_id` (NULL for -1) |
| `insert_id` | `VARCHAR` | Client deduplication id | `$insert_id` |
| `properties` | `JSON` | Event properties | `event_properties` |
| `user_properties` | `JSON` | Person/user properties at event time | `user_properties` |
| `platform` | `VARCHAR` | Platform (`iOS`, `Android`, `Web` …) | `platform` |
| `os` | `VARCHAR` | Operating system name | `os_name` |
| `country`, `city` | `VARCHAR` | Geolocation | `country`, `city` |
| `app_version` | `VARCHAR` | App version | `version_name` |
| `library` | `VARCHAR` | Sending SDK | `library` |
| `revenue` | `DOUBLE` | Revenue on the event | `revenue` / `$revenue` / `$price × $quantity` |

**`users(query)`** (a function where the tool cannot enumerate users, a table where it can):
`tool`, `user_id`, `distinct_id`, `device_ids VARCHAR[]`, `first_seen TIMESTAMPTZ`, `last_seen TIMESTAMPTZ`,
`properties JSON`, `platform`, `os`, `country`, `city`, `app_version`. Amplitude's first/last seen are
dates (midnight UTC).

**`cohorts`**: `tool`, `id VARCHAR NOT NULL`, `name`, `description`, `size BIGINT`, `created_at TIMESTAMPTZ`,
`updated_at TIMESTAMPTZ`, `is_archived BOOLEAN`, `definition JSON` (tool-specific).

**`event_definitions`**: `tool`, `event_name VARCHAR NOT NULL`, `display_name`, `description`, `category`,
`is_hidden BOOLEAN`, `is_active BOOLEAN`, `volume BIGINT` (the tool's recent volume figure; Amplitude:
events this week), `tags VARCHAR[]`.

**`property_definitions`**: `tool`, `property_name VARCHAR NOT NULL`, `scope VARCHAR NOT NULL` (`'event'`,
`'user'` or `'group'`), `event_name` (event scope only; NULL for shared properties), `data_type`,
`description`, `is_array BOOLEAN`, `is_required BOOLEAN`, `is_hidden BOOLEAN`, `enum_values VARCHAR[]`.

## Pushdown

| Object | What is sent to Amplitude |
|---|---|
| `events()`, `unified.events` | `server_upload_time` (`received_time`) bounds → the Export API's `start`/`end` upload hours, exactly; `event_time` bounds → upload hours `[lower − 1 h, upper + late_hours]`; no lower bound → the last `lookback_hours` (24 for the table). The end is clamped to the current hour. Every predicate is re-applied exactly. `event_type` and property filters are applied after download: the Export API has no event filter. |
| chart functions | their arguments are Amplitude's parameters (`e`, `start`, `end`, `m`, `i`, `g`, `s`, `mode`, `cs`, `rm`, `rb` …) |
| `event_properties` | `event_type =` / `IN` → one `event_type=` request each instead of one per event type |
| `group_properties` | `group_type =` / `IN` → `group_type=` |
| `unified.property_definitions` | `scope =` skips the other property families; `event_name =` reads only those event types |
| `annotations` | `chart_id =` → `chart_id=`, else `category_name =` → `category=`; `start_time >=` → `start=` (minute precision, widened a minute) |

The Export API filters on **upload** time. An event recorded offline and uploaded later lands in a later
hour, which is why an `event_time` upper bound reads `late_hours` (default 24) beyond it; set
`late_hours := 0` to read only the same hours, or filter on `server_upload_time` for Amplitude's exact
export semantics. Exports lag real time by up to two hours.

## Export streaming, limits and cursors

- **Chunks.** The window is fetched `chunk_hours` at a time (≤ 8,760, Amplitude's 365-day limit). A
  `400 … too large` (Amplitude's 6 GB export limit; older docs say 4 GB) or a `504` halves the chunk and
  retries, down to one hour; a single hour over the limit fails with a pointer to Amplitude's S3 export.
  A `404` (no export files for the range) is zero rows.
- **Streaming.** Each chunk's ZIP is spooled to a temporary file (`$TMPDIR/vgi-amplitude-<pid>-…`, mode
  0600, deleted when the chunk is done, after 10 idle minutes, or at exit) and read entry by entry through
  inflate → gunzip → line splitting. Memory stays bounded by one read chunk and one 10,000-row batch,
  whatever the export size. ZIP64 archives are supported. Disk use peaks at one chunk's compressed size.
- **Cursor.** The scan state is the window, the current chunk, the archive entry and the lines consumed
  within it. One Arrow batch goes out per call; the same process keeps the archive open for the next
  call, and another process (HTTP transport) re-downloads the chunk and skips to the cursor.

## Rate limits and costs

- 429s (rate, concurrency or cost budget) are retried with `Retry-After` or jittered exponential back-off,
  up to 6 attempts; 5xx and network errors likewise. An exhausted hourly **cost** budget only clears with
  time: shorten date ranges or drop group-bys (cost = days × conditions × endpoint cost; each group-by
  counts as 4 segments).
- Concurrency per project and API family is capped in-process: 4 Export API requests, 5 Dashboard REST
  requests (cohort downloads share them), 4 Taxonomy requests. Separate worker processes do not
  coordinate.
- User search and user activity share 360 queries an hour per project. `user_profile` and
  `unified.users` cost one search plus one activity call per match.
- **Cohort downloads** (`cohort_members`) are asynchronous jobs: request → poll status every
  `poll_seconds` up to `max_wait_seconds` → download (a 302 to a pre-signed link, valid one minute, fetched
  at once *without* the API keys). Each call counts against Amplitude's quota: **500 cohort downloads a
  month** (Growth/Enterprise), 60 per 10 minutes per project, cohorts up to **2 million users**. The file is
  spooled and parsed incrementally (CSV with a header; JSON Lines accepted). The state keeps the request
  id, so a resumed scan re-downloads the same file instead of starting a second job.

## Authentication

```sql
CREATE SECRET amp (TYPE amplitude, API_KEY '…', SECRET_KEY '…');                 -- US (https://amplitude.com)
CREATE SECRET amp_eu (TYPE amplitude, API_KEY '…', SECRET_KEY '…', REGION 'eu');  -- https://analytics.eu.amplitude.com
CREATE SECRET amp_px (TYPE amplitude, API_KEY '…', SECRET_KEY '…', BASE_URL 'https://amplitude-proxy.example.com');
```

The project's API key and secret key (Project settings → General) are sent as HTTP Basic auth. Both are
marked `redact`, so `duckdb_secrets()` never shows them. They are read from the secret on every call and
never enter table-function state, logs or error messages, and are sent only to the configured origin
(`http://` is accepted only for `127.0.0.1`/`localhost`). One secret = one project.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone --branch v0.1.0 https://github.com/Query-farm/vgi-amplitude.git && cd vgi-amplitude
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'amplitude' (TYPE vgi, LOCATION '/abs/path/to/vgi-amplitude/bin/vgi-amplitude-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'amplitude' (TYPE vgi, LOCATION '/abs/path/to/vgi-amplitude/bin/vgi-amplitude-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship signed standalone
executables (no Bun needed); point `LOCATION` at the downloaded binary. The same binary serves HTTP with
`--http --port 8000` (see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests: export window, ZIP/ZIP64 parsing and resume, chart shapes, CSV
make test-sql                  # test/sql/amplitude.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Amplitude project. `test/mock_api/server.py` is a stdlib-only,
strict replay server over the fictional project in `test/fixtures/build_fixture.py` (Amplitude's
documented response shapes). It enforces Basic auth (401 without, 403 with wrong keys), rejects unknown
or malformed parameters, and builds a **real ZIP of gzip JSON Lines files** per Export API request from
the fixture's upload hours (25,000 events in one hour across three files, a late upload, an empty hour
that answers 404). Ranges over 12 hours answer `400 too large` so chunk halving runs; the first export
and segmentation requests answer 429. Cohort downloads go through request → in-progress → completed →
302 to a pre-signed link on another origin that rejects credentials. The SQL tests read its
`/__requests` log to check exactly what was pushed down. `test/fixtures/export-sample.zip` is a
committed archive from the same builder for the unit tests.

The metadata check runs with `execute: false` in CI: every object needs an `amplitude` secret for a live
project.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
