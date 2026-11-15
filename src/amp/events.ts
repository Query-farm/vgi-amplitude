/** The raw-event objects: `main.events(...)` and the shared-shape `unified.events` table. */

import { defineExportScan, defineExportTable, NATIVE_EVENT_COLUMNS, UNIFIED_EVENT_COLUMNS } from "./export.ts";

const PUSHDOWN =
  "`server_upload_time` bounds → the Export API's upload-hour range (exact to the hour); `event_time` " +
  "bounds → upload hours [lower − 1 h, upper + late_hours]; no lower bound → the last lookback_hours. " +
  "All predicates are re-applied exactly to the rows.";

export const events = defineExportScan(
  {
    name: "events",
    description: "Raw Amplitude events from the Export API, streamed hour by hour with time-range pushdown",
    title: "Amplitude Raw Events",
    keywords: "amplitude, events, raw events, export api, event stream, clickstream, product analytics",
    docLlm:
      "Every raw event of the project from the Export API (GET /api/2/export), one row per event with all " +
      "47 export fields typed: uuid, event_type, event_time, server_upload_time and the other timestamps, " +
      "user_id, device_id, amplitude_id, session_id, insert_id, platform/os/device/location fields, " +
      "version_name, library, paying, revenue, and event_properties / user_properties / group_properties / " +
      "groups / data as JSON. ALWAYS filter on event_time (or server_upload_time): the bounds become the " +
      "Export API's UTC upload-hour range; with no lower bound only the last lookback_hours (named, default " +
      "24) are read. Named late_hours (default 24) is how long after event_time an upload may arrive, and " +
      "chunk_hours (default 24) sets hours per request. Exports lag real time by up to 2 hours. Filters on " +
      "event_type and properties are applied after download (the Export API has no event filter), so " +
      "prefer segmentation()/funnel() for aggregates over long ranges.",
    docMd:
      "## events\n\nRaw events from Amplitude's Export API, streamed hour by hour.\n\n" +
      "Filter on `event_time` or `server_upload_time` so only the matching upload hours are exported.",
    pushdown: PUSHDOWN,
    columns: NATIVE_EVENT_COLUMNS,
    withArgs: true,
    examples: [
      {
        sql: "SELECT event_type, count(*) AS n FROM amplitude.main.events() WHERE event_time >= TIMESTAMPTZ '2026-11-14 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-11-15 00:00:00+00' GROUP BY event_type ORDER BY n DESC",
        description: "Event counts for one day (only that day's upload hours are exported)",
      },
      {
        sql: "SELECT user_id, sum(revenue) AS revenue FROM amplitude.main.events(late_hours := 0) WHERE server_upload_time >= TIMESTAMPTZ '2026-11-14 00:00:00+00' AND revenue > 0 GROUP BY user_id ORDER BY revenue DESC LIMIT 10",
        description: "Top spenders among events uploaded since a time",
      },
    ],
  },
  "events",
);

export const unifiedEvents = defineExportTable(
  {
    name: "events",
    description: "Raw events in the shared product-analytics shape (tool, event_name, event_time, ids, properties)",
    title: "Events (Shared Shape)",
    keywords: "product analytics, events, unified, amplitude, mixpanel, segment, posthog, union",
    docLlm:
      "Amplitude raw events (Export API) in the shared product-analytics shape: tool ('amplitude'), " +
      "event_id, event_name, event_time, received_time, user_id, device_id, distinct_id (Amplitude id as " +
      "text), session_id, insert_id, properties (JSON), user_properties (JSON), platform, os, country, city, " +
      "app_version, library, revenue. The same columns as the events table of the other analytics workers, " +
      "so they UNION ALL. Filter on event_time: it becomes the export's upload-hour range (late arrivals up " +
      "to 24 h are read); with no lower bound only the last 24 hours are read. For tuning arguments use " +
      "amplitude.main.events().",
    docMd: "## unified.events\n\nAmplitude events in the shared product-analytics shape.",
    pushdown: PUSHDOWN.replace("last lookback_hours", "last 24 hours").replace("late_hours", "24 h"),
    columns: UNIFIED_EVENT_COLUMNS,
    withArgs: false,
    category: "unified",
    examples: [
      {
        sql: "SELECT event_name, count(DISTINCT distinct_id) AS users FROM amplitude.unified.events WHERE event_time >= TIMESTAMPTZ '2026-11-14 00:00:00+00' AND event_time < TIMESTAMPTZ '2026-11-15 00:00:00+00' GROUP BY event_name ORDER BY users DESC",
        description: "Unique users per event for one day",
      },
    ],
  },
  ["unified"],
);
