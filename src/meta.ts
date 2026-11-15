/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "amplitude";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-amplitude";

/** Categories of the `main` schema. Every object's `vgi.category` must name one of its schema's. */
export const MAIN_CATEGORIES = [
  { name: "events", title: "Raw Events", description: "Raw event streams from the Export API." },
  {
    name: "charts",
    title: "Charts",
    description: "Dashboard REST API charts: segmentation, funnels, retention, users, sessions, revenue.",
  },
  { name: "users", title: "Users", description: "User search, user activity and user profiles." },
  { name: "cohorts", title: "Cohorts", description: "Behavioral cohorts and their members." },
  { name: "taxonomy", title: "Taxonomy", description: "The tracking plan: event types, properties, categories." },
  { name: "annotations", title: "Annotations", description: "Chart annotations (releases, incidents, campaigns)." },
] as const;

export const UNIFIED_CATEGORIES = [
  {
    name: "unified",
    title: "Shared Product Analytics",
    description: "Objects in the cross-tool product-analytics vocabulary shared with other analytics workers.",
  },
] as const;

export type Category = (typeof MAIN_CATEGORIES)[number]["name"] | (typeof UNIFIED_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Export API](https://amplitude.com/docs/apis/analytics/export) — raw events, hourly ZIP of gzip JSON Lines\n" +
  "- [Dashboard REST API](https://amplitude.com/docs/apis/analytics/dashboard-rest) — segmentation, funnels, retention, users, sessions, revenue, user search and activity\n" +
  "- [Taxonomy API](https://amplitude.com/docs/apis/analytics/taxonomy) — event types, properties, categories\n" +
  "- [Behavioral Cohorts API](https://amplitude.com/docs/apis/analytics/behavioral-cohorts) — cohorts and member downloads\n" +
  "- [Chart annotations API](https://amplitude.com/docs/apis/analytics/chart-annotations)";

export const CATALOG_COMMENT =
  "Amplitude product analytics as SQL: raw events from the Export API, segmentation, funnel, retention and revenue charts, user lookups, cohorts and the tracking plan, read-only.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to one Amplitude project. Reach for it to answer: what happened, event by event " +
  "(amplitude.main.events() over the Export API; ALWAYS bound event_time, which becomes the export's " +
  "upload-hour range), how many users did X per day/week and by which property (segmentation(event, " +
  "start_date, end_date, metric :=, granularity :=, group_by :=)), how users convert through steps " +
  "(funnel([steps], start_date, end_date)), whether they come back (retention(start_event, return_event, " +
  "start_date, end_date)), DAU/new users (active_users), sessions (average_session_length, " +
  "sessions_per_user, session_length_distribution), right-now traffic (realtime_active_users), lifetime " +
  "value (revenue_ltv), breakdowns (user_composition), one user's history (user_search → user_activity / " +
  "user_profile), cohorts and their members (cohorts, cohort_members(cohort_id), an async export with a " +
  "monthly quota), the tracking plan (event_types, event_properties, user_properties, group_properties, " +
  "event_categories, event_totals) and chart annotations. Charts are computed inside Amplitude and return " +
  "long rows (series_label, period, value). Schema `unified` holds the cross-tool product-analytics " +
  "vocabulary (events, users(query), cohorts, event_definitions, property_definitions) shared with the " +
  "Mixpanel, Segment and PostHog workers, for UNION ALL across tools. Every object needs an `amplitude` " +
  "DuckDB secret with API_KEY and SECRET_KEY (Basic auth) and REGION 'eu' for EU data residency. Docs: " +
  "https://amplitude.com/docs/apis/analytics/export , https://amplitude.com/docs/apis/analytics/dashboard-rest .";

export const CATALOG_DOC_MD =
  "# Amplitude\n\n" +
  "Query an Amplitude project from DuckDB: raw events from the Export API (streamed hour by hour, with " +
  "the `event_time` range pushed down), event segmentation, funnel, retention, active-user, session and " +
  "revenue charts as long rows, user search / activity / profiles, behavioral cohorts and their members, " +
  "the tracking plan and chart annotations. Read-only.\n\n" +
  "Create an `amplitude` secret with the project's `API_KEY` and `SECRET_KEY`; set `REGION 'eu'` for EU " +
  "data residency. Schema `unified` holds the shared product-analytics vocabulary for queries across " +
  "analytics tools.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Amplitude objects. events() reads raw events (filter event_time). Chart functions take start_date / " +
  "end_date DATEs and Amplitude's own parameters as named arguments and return long rows. Tables: " +
  "event_types, event_totals, event_categories, event_properties, user_properties, group_properties, " +
  "cohorts, annotations. All need an `amplitude` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Amplitude raw events, charts, users, cohorts, the tracking plan and annotations.\n\n" +
  "Chart functions run inside Amplitude; raw events stream from the Export API by upload hour.\n\n" +
  "All objects need an `amplitude` secret.";

export const UNIFIED_DOC_LLM =
  "The shared product-analytics vocabulary: events, users(query), cohorts, event_definitions and " +
  "property_definitions with the same column names and types in every analytics worker (Amplitude, " +
  "Mixpanel, Segment, PostHog), each row tagged with `tool`. Use it to UNION ALL across tools; use schema " +
  "main for every Amplitude-specific field.";

export const UNIFIED_DOC_MD =
  "## unified\n\n" +
  "Amplitude data in the shared product-analytics vocabulary.\n\n" +
  "The same columns exist in the other analytics workers, so `UNION ALL` combines tools.";

export const AGENT_TEST_TASKS = [
  { name: "top_event_types", prompt: "Which three event types have the most events this week in Amplitude?" },
  {
    name: "purchases_on_day",
    prompt: "How many Purchase events happened in Amplitude on 2026-11-14 (UTC), from the raw event export?",
  },
  {
    name: "revenue_by_country",
    prompt: "What was the total revenue per country from raw Amplitude events on 2026-11-14 (UTC)?",
  },
  {
    name: "daily_uniques",
    prompt: "How many unique users did 'Purchase' in Amplitude each day from 2026-11-01 to 2026-11-03?",
  },
  {
    name: "signup_conversion",
    prompt: "What fraction of users who signed up (Sign Up) went on to Purchase between 2026-11-01 and 2026-11-07?",
  },
  { name: "largest_cohort", prompt: "Which Amplitude cohort has the most users?" },
  { name: "purchase_properties", prompt: "Which event properties does the Purchase event have in the tracking plan?" },
  { name: "pii_user_properties", prompt: "Which user properties are classified as PII?" },
  { name: "user_lookup", prompt: "What is the Amplitude id of user user_42, and in which country are they?" },
  {
    name: "day1_retention",
    prompt: "What was the combined day-1 retention of new users from 2026-11-01 to 2026-11-07?",
  },
  {
    name: "november_annotations",
    prompt: "Which chart annotations start in November 2026, in order?",
  },
];

/** Bind-only probes: each binds the object and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "events_columns",
    description: "The events() result columns (binds only; create an amplitude secret and drop LIMIT 0 for rows)",
    sql: "SELECT event_time, event_type, user_id, revenue FROM amplitude.main.events() LIMIT 0",
  },
  {
    name: "segmentation_columns",
    description: "The segmentation() result columns (binds only)",
    sql: "SELECT series_label, period, value FROM amplitude.main.segmentation('Purchase', DATE '2026-11-01', DATE '2026-11-07') LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Amplitude Product Analytics",
  "vgi.subtitle": "Amplitude raw events, charts, funnels, retention, users, cohorts and tracking plan as SQL.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "amplitude, product analytics, events, funnels, retention, segmentation, cohorts, export api, tracking plan",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Amplitude APIs",
  domain: "product-analytics",
  "vgi.keywords": keywordsArray("amplitude, events, charts, funnels, retention, cohorts, taxonomy, annotations"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(MAIN_CATEGORIES),
};

export const UNIFIED_SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Shared Product Analytics",
  domain: "product-analytics",
  "vgi.keywords": keywordsArray("product analytics, unified, events, users, cohorts, definitions, cross-tool"),
  "vgi.doc_llm": UNIFIED_DOC_LLM,
  "vgi.doc_md": UNIFIED_DOC_MD,
  "vgi.categories": JSON.stringify(UNIFIED_CATEGORIES),
};
