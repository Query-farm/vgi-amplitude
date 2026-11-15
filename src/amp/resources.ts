/**
 * Definitions and lists: the Taxonomy API, the event list, behavioral cohorts and
 * chart annotations, as catalog tables in `amplitude.main`, plus the shared
 * product-analytics `unified.event_definitions` / `property_definitions` /
 * `cohorts` tables.
 */

import type { TableDescriptor } from "@query-farm/vgi";
import { log } from "../log.ts";
import { type AmpConfig, AmpError, ampGet } from "./client.ts";
import { eqValues, toEpochMs } from "./pushdown.ts";
import { type AmpRequest, C, defineAmpCatalogTable, type Row } from "./table.ts";

const Q = "amplitude.main";
const U = "amplitude.unified";
const MAIN = ["main"];
const UNIFIED = ["unified"];

const tool = C.lit("tool", "The analytics tool the row came from: 'amplitude'.", "amplitude");

/** Every event type in the tracking plan (GET /api/2/taxonomy/event). */
export async function taxonomyEventTypes(cfg: AmpConfig): Promise<string[]> {
  const body = (await ampGet(cfg, "/api/2/taxonomy/event", undefined, "taxonomy")) as Row | null;
  const data = Array.isArray(body?.data) ? (body?.data as Row[]) : [];
  return data.map((e) => e.event_type).filter((x): x is string => typeof x === "string");
}

/** Event-property requests: the pushed event types, else every taxonomy event + the shared set. */
async function eventPropertyRequests(cfg: AmpConfig, only: string[] | undefined): Promise<AmpRequest[]> {
  const types = only ?? (await taxonomyEventTypes(cfg));
  const reqs: AmpRequest[] = types.map((t) => ({
    path: "/api/2/taxonomy/event-property",
    query: { event_type: t },
    ctx: { event_type: t, shared: false },
  }));
  if (!only) reqs.unshift({ path: "/api/2/taxonomy/event-property", ctx: { event_type: null, shared: true } });
  return reqs;
}

const enumList = (r: Row): string[] | null => {
  const v = r.enum_values;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim() !== "")
    return v
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
  return null;
};

// ------------------------------------------------------------------ taxonomy

export const eventCategories = defineAmpCatalogTable(
  {
    name: "event_categories",
    description: "Event categories defined in the Amplitude tracking plan (Taxonomy API)",
    title: "Amplitude Event Categories",
    category: "taxonomy",
    keywords: "amplitude, taxonomy, event categories, tracking plan, governance",
    docLlm:
      "Event categories of the project's tracking plan (GET /api/2/taxonomy/category): id and name. " +
      "Join to event_types.category on name.",
    docMd: "## event_categories\n\nOne row per event category in the tracking plan.",
    bucket: "taxonomy",
    columns: [C.big("id", "Category id.", "id", false), C.str("name", "Category name.", "name")],
    requests: () => [{ path: "/api/2/taxonomy/category" }],
    examples: [
      { sql: `SELECT id, name FROM ${Q}.event_categories ORDER BY name`, description: "Every event category" },
    ],
  },
  MAIN,
  ["id"],
);

export const eventTypes = defineAmpCatalogTable(
  {
    name: "event_types",
    description:
      "Event types in the Amplitude tracking plan with category, description, visibility and owner (Taxonomy API)",
    title: "Amplitude Event Types",
    category: "taxonomy",
    keywords: "amplitude, taxonomy, event types, tracking plan, schema, governance",
    docLlm:
      "Every event type in the tracking plan (GET /api/2/taxonomy/event?showDeleted=true): event_type, " +
      "display_name, description, category, is_active, the four is_hidden_from_* visibility flags, tags and " +
      "owner. Deleted events are included (is_deleted). For weekly volumes use event_totals; for the " +
      "cross-tool shape use amplitude.unified.event_definitions.",
    docMd: "## event_types\n\nOne row per event type in the Amplitude tracking plan.",
    bucket: "taxonomy",
    columns: [
      C.str("event_type", "Event type (name) as sent by the SDKs.", "event_type", false),
      C.str("display_name", "Display name shown in Amplitude charts.", "display_name"),
      C.str("description", "Description from the tracking plan.", "description"),
      C.str("category", "Category name.", "category.name"),
      C.bool("is_active", "Whether the event is active (has recent data).", "is_active"),
      C.bool(
        "is_deleted",
        "Whether the event type was deleted from the plan.",
        (r) => r.deleted ?? r.is_deleted ?? false,
      ),
      C.bool("is_hidden_from_dropdowns", "Hidden from chart dropdowns.", "is_hidden_from_dropdowns"),
      C.bool("is_hidden_from_persona_results", "Hidden from Personas results.", "is_hidden_from_persona_results"),
      C.bool("is_hidden_from_pathfinder", "Hidden from Pathfinder.", "is_hidden_from_pathfinder"),
      C.bool("is_hidden_from_timeline", "Hidden from the user timeline.", "is_hidden_from_timeline"),
      C.strList("tags", "Tags.", "tags"),
      C.str("owner", "Owner.", "owner"),
    ],
    requests: () => [{ path: "/api/2/taxonomy/event", query: { showDeleted: "true" } }],
    examples: [
      {
        sql: `SELECT category, count(*) AS events FROM ${Q}.event_types WHERE NOT is_deleted GROUP BY category ORDER BY events DESC`,
        description: "Event types per category",
      },
      {
        sql: `SELECT event_type FROM ${Q}.event_types WHERE description IS NULL AND NOT is_deleted ORDER BY event_type`,
        description: "Undocumented event types",
      },
    ],
  },
  MAIN,
  ["event_type"],
);

const EVENT_PROPERTY_COLUMNS = [
  C.str(
    "event_type",
    "Event type the property belongs to (NULL for shared properties).",
    (r) => r.__ctx?.event_type ?? r.event_type,
  ),
  C.bool(
    "is_shared",
    "True for a shared property listed without an event type.",
    (r) => r.__ctx?.shared ?? false,
    false,
  ),
  C.str("event_property", "Property name.", "event_property", false),
  C.str("description", "Description.", "description"),
  C.str("type", "Data type: string, number, boolean, enum, any …", "type"),
  C.str("regex", "Validation regular expression.", "regex"),
  C.strList("enum_values", "Allowed values.", enumList),
  C.bool("is_array_type", "Whether the property is an array.", "is_array_type"),
  C.bool("is_required", "Whether the property is required.", "is_required"),
  C.bool("is_hidden", "Whether the property is hidden.", "is_hidden"),
  C.strList("classifications", "Data classifications, e.g. PII.", "classifications"),
];

export const eventProperties = defineAmpCatalogTable(
  {
    name: "event_properties",
    description:
      "Event properties in the Amplitude tracking plan, per event type plus shared properties (Taxonomy API)",
    title: "Amplitude Event Properties",
    category: "taxonomy",
    keywords: "amplitude, taxonomy, event properties, tracking plan, schema, PII",
    docLlm:
      "Event properties of the tracking plan (GET /api/2/taxonomy/event-property): event_type, is_shared, " +
      "event_property, description, type, regex, enum_values, is_array_type, is_required, is_hidden, " +
      "classifications. WHERE event_type = 'x' (or IN) reads only those event types (one request each); " +
      "otherwise the worker lists every event type and reads each, plus the shared properties (one request " +
      "per event type; the Taxonomy API allows 7,200 a hour).",
    docMd: "## event_properties\n\nOne row per (event type, property) in the tracking plan.",
    pushdown: "`event_type` (=, IN) → one `event_type=` request per value instead of one per event type.",
    bucket: "taxonomy",
    columns: EVENT_PROPERTY_COLUMNS,
    requests: ({ cfg, constraints }) => eventPropertyRequests(cfg, eqValues(constraints, "event_type")),
    examples: [
      {
        sql: `SELECT event_property, type FROM ${Q}.event_properties WHERE event_type = 'Purchase' ORDER BY event_property`,
        description: "Properties of one event (only that event type is requested)",
      },
      {
        sql: `SELECT event_type, event_property FROM ${Q}.event_properties WHERE list_contains(classifications, 'PII') ORDER BY ALL`,
        description: "Event properties classified as PII",
      },
    ],
  },
  MAIN,
  [],
);

export const userProperties = defineAmpCatalogTable(
  {
    name: "user_properties",
    description: "User properties in the Amplitude tracking plan (Taxonomy API)",
    title: "Amplitude User Properties",
    category: "taxonomy",
    keywords: "amplitude, taxonomy, user properties, tracking plan, schema, PII",
    docLlm:
      "User properties of the tracking plan (GET /api/2/taxonomy/user-property?showDeleted=true): user_property " +
      "(custom ones are prefixed gp: in chart parameters), description, type, enum_values, regex, " +
      "is_array_type, is_hidden, classifications, is_deleted.",
    docMd: "## user_properties\n\nOne row per user property in the tracking plan.",
    bucket: "taxonomy",
    columns: [
      C.str("user_property", "Property name.", "user_property", false),
      C.str("description", "Description.", "description"),
      C.str("type", "Data type.", "type"),
      C.str("regex", "Validation regular expression.", "regex"),
      C.strList("enum_values", "Allowed values.", enumList),
      C.bool("is_array_type", "Whether the property is an array.", "is_array_type"),
      C.bool("is_hidden", "Whether the property is hidden.", "is_hidden"),
      C.bool("is_deleted", "Whether the property was deleted.", (r) => r.deleted ?? false),
      C.strList("classifications", "Data classifications, e.g. PII.", "classifications"),
    ],
    requests: () => [{ path: "/api/2/taxonomy/user-property", query: { showDeleted: "true" } }],
    examples: [
      {
        sql: `SELECT user_property, type FROM ${Q}.user_properties WHERE NOT is_deleted ORDER BY user_property`,
        description: "Live user properties",
      },
    ],
  },
  MAIN,
  ["user_property"],
);

export const groupProperties = defineAmpCatalogTable(
  {
    name: "group_properties",
    description: "Shared group properties in the Amplitude tracking plan (Taxonomy API, Accounts add-on)",
    title: "Amplitude Group Properties",
    category: "taxonomy",
    keywords: "amplitude, taxonomy, group properties, accounts, b2b",
    docLlm:
      "Group (account) properties of the tracking plan (GET /api/2/taxonomy/group-property): group_type, " +
      "group_property (prefixed grp:), description, type, enum_values, regex, is_array_type, is_hidden, " +
      "classifications. WHERE group_type = 'x' pushes down as group_type=.",
    docMd: "## group_properties\n\nOne row per group property.",
    pushdown: "`group_type` (=, IN) → `group_type=`.",
    bucket: "taxonomy",
    columns: [
      C.str("group_type", "Group type, e.g. 'org id'.", (r) => r.group_type ?? r.__ctx?.group_type),
      C.str("group_property", "Property name (grp: prefix).", "group_property", false),
      C.str("description", "Description.", "description"),
      C.str("type", "Data type.", "type"),
      C.str("regex", "Validation regular expression.", "regex"),
      C.strList("enum_values", "Allowed values.", enumList),
      C.bool("is_array_type", "Whether the property is an array.", "is_array_type"),
      C.bool("is_hidden", "Whether the property is hidden.", "is_hidden"),
      C.strList("classifications", "Data classifications.", "classifications"),
    ],
    requests: ({ constraints }) => {
      const types = eqValues(constraints, "group_type");
      if (!types) return [{ path: "/api/2/taxonomy/group-property" }];
      return types.map((t) => ({
        path: "/api/2/taxonomy/group-property",
        query: { group_type: t },
        ctx: { group_type: t },
      }));
    },
    examples: [
      {
        sql: `SELECT group_type, group_property FROM ${Q}.group_properties ORDER BY ALL`,
        description: "Group properties by group type",
      },
    ],
  },
  MAIN,
  [],
);

// ------------------------------------------------------------------ event list

export const eventTotals = defineAmpCatalogTable(
  {
    name: "event_totals",
    description: "Visible event types with their total count this week (Dashboard REST API event list)",
    title: "Amplitude Event Totals",
    category: "taxonomy",
    keywords: "amplitude, event list, event volume, weekly totals, event types",
    docLlm:
      "The project's visible event types with this week's event count (GET /api/2/events/list): event_type, " +
      "display_name, totals_this_week, is_hidden, is_deleted, is_non_active, is_flow_hidden. Use it to rank " +
      "events by volume or to find event names for segmentation()/funnel().",
    docMd: "## event_totals\n\nOne row per visible event type with this week's total.",
    columns: [
      C.str("event_type", "Event type (name).", (r) => r.value ?? r.name, false),
      C.str("display_name", "Display name.", "display"),
      C.big("totals_this_week", "Events of this type so far this week.", "totals"),
      C.bool("is_hidden", "Hidden in charts.", "hidden"),
      C.bool("is_deleted", "Deleted.", "deleted"),
      C.bool("is_non_active", "Marked inactive.", "non_active"),
      C.bool("is_flow_hidden", "Hidden from Pathfinder / flows.", "flow_hidden"),
    ],
    requests: () => [{ path: "/api/2/events/list" }],
    examples: [
      {
        sql: `SELECT event_type, totals_this_week FROM ${Q}.event_totals ORDER BY totals_this_week DESC LIMIT 10`,
        description: "The ten most frequent events this week",
      },
    ],
  },
  MAIN,
  ["event_type"],
);

// --------------------------------------------------------------------- cohorts

const COHORT_ROWS = (body: unknown): Row[] => {
  const c = (body as { cohorts?: unknown } | null)?.cohorts;
  return Array.isArray(c) ? (c as Row[]) : [];
};

export const cohorts = defineAmpCatalogTable(
  {
    name: "cohorts",
    description: "Behavioral cohorts: name, size, definition, owners, sync targets (Behavioral Cohorts API)",
    title: "Amplitude Cohorts",
    category: "cohorts",
    keywords: "amplitude, cohorts, behavioral cohorts, segments, audiences, syncs",
    docLlm:
      "Every behavioral cohort in the project (GET /api/3/cohorts?includeSyncInfo=true): id, name, " +
      "description, size, type, archived, published, finished, hidden, is_predictive, is_official_content, " +
      "owners, viewers, created_at, last_modified, last_computed, last_viewed, view_count, popularity, " +
      "chart_id, definition (JSON) and sync_metadata (JSON: target, frequency, last_successful …). Members " +
      "are read with cohort_members(cohort_id).",
    docMd: "## cohorts\n\nOne row per behavioral cohort.",
    columns: [
      C.str("id", "Cohort id (use with cohort_members).", "id", false),
      C.str("name", "Cohort name.", "name"),
      C.str("description", "Description.", "description"),
      C.big("size", "Number of users at the last computation.", "size"),
      C.str("type", "Cohort type.", "type"),
      C.bool("archived", "Archived.", "archived"),
      C.bool("published", "Published.", "published"),
      C.bool("finished", "Computation finished.", "finished"),
      C.bool("hidden", "Hidden.", "hidden"),
      C.bool("is_predictive", "A predictive cohort.", "is_predictive"),
      C.bool("is_official_content", "Marked official.", "is_official_content"),
      C.strList("owners", "Owner logins.", "owners"),
      C.strList("viewers", "Viewer logins.", "viewers"),
      C.epochSec("created_at", "Created.", "createdAt"),
      C.epochSec("last_modified", "Last modified.", "lastMod"),
      C.epochSec("last_computed", "Last computed.", "lastComputed"),
      C.epochSec("last_viewed", "Last viewed.", "last_viewed"),
      C.big("view_count", "Times viewed.", "view_count"),
      C.big("popularity", "Popularity score.", "popularity"),
      C.str("chart_id", "Chart the cohort was created from.", "chart_id"),
      C.str("edit_id", "Edit id.", "edit_id"),
      C.str("location_id", "Space / location id.", "location_id"),
      C.big("app_id", "Project id.", "appId"),
      C.strList("metadata", "Metadata tags.", "metadata"),
      C.json("definition", "Cohort definition (JSON).", "definition"),
      C.json("sync_metadata", "Sync targets (JSON array).", "syncMetadata"),
    ],
    requests: () => [{ path: "/api/3/cohorts", query: { includeSyncInfo: "true" } }],
    rows: COHORT_ROWS,
    examples: [
      {
        sql: `SELECT name, size FROM ${Q}.cohorts WHERE NOT archived ORDER BY size DESC LIMIT 10`,
        description: "The largest active cohorts",
      },
    ],
  },
  MAIN,
  ["id"],
);

// ------------------------------------------------------------------ annotations

/** A lower bound on start_time → the annotations API's `start` (minute precision, widened). */
export function annotationStart(v: unknown): string | undefined {
  const ms = toEpochMs(v);
  if (ms === undefined) return undefined;
  const floored = Math.floor(ms / 60_000) * 60_000 - 60_000;
  return `${new Date(floored).toISOString().slice(0, 16)}Z`;
}

export const annotations = defineAmpCatalogTable(
  {
    name: "annotations",
    description: "Chart annotations (releases, incidents, campaigns) with their time range and category",
    title: "Amplitude Chart Annotations",
    category: "annotations",
    keywords: "amplitude, annotations, chart annotations, releases, launches, incidents",
    docLlm:
      "Chart annotations (GET /api/3/annotations): id, label, details, start_time, end_time (NULL for a point " +
      "annotation), category_id, category_name and chart_id (NULL for a global annotation). Use them to " +
      "explain jumps in charts. WHERE chart_id = … or category_name = … and a lower bound on start_time push " +
      "down. Amplitude's Releases are created through a write-only API and appear here only as annotations.",
    docMd: "## annotations\n\nOne row per chart annotation.",
    pushdown:
      "`chart_id =` → `chart_id=`; otherwise `category_name =` → `category=`; `start_time >=/>` → `start=` (widened a minute).",
    columns: [
      C.big("id", "Annotation id.", "id", false),
      C.str("label", "Label.", "label"),
      C.str("details", "Details.", "details"),
      C.time("start_time", "When the annotation starts.", (r) => r.start ?? r.date),
      C.time("end_time", "When a ranged annotation ends (NULL for a point).", "end"),
      C.big("category_id", "Category id.", "category.id"),
      C.str("category_name", "Category name.", "category.name"),
      C.str("chart_id", "Chart the annotation is limited to (NULL = all charts).", "chart_id"),
    ],
    requests: ({ constraints }) => {
      const chart = eqValues(constraints, "chart_id");
      const cat = eqValues(constraints, "category_name");
      let start: string | undefined;
      for (const c of constraints) {
        if (c.column === "start_time" && c.kind === "cmp" && (c.op === "ge" || c.op === "gt" || c.op === "eq")) {
          const s = annotationStart(c.value);
          if (s && (!start || s > start)) start = s;
        }
      }
      const query: Record<string, string | undefined> = { start };
      if (chart?.length === 1) query.chart_id = chart[0];
      else if (cat?.length === 1) query.category = cat[0];
      return [{ path: "/api/3/annotations", query }];
    },
    examples: [
      {
        sql: `SELECT start_time, label, category_name FROM ${Q}.annotations WHERE start_time >= TIMESTAMPTZ '2026-11-01' ORDER BY start_time`,
        description: "Annotations this month (the date bound is sent to Amplitude)",
      },
    ],
  },
  MAIN,
  ["id"],
);

// ------------------------------------------------------------------ unified

export const unifiedCohorts = defineAmpCatalogTable(
  {
    name: "cohorts",
    description: "Cohorts in the shared product-analytics shape (tool, cohort_id, name, size, timestamps, definition)",
    title: "Cohorts (Shared Shape)",
    category: "unified",
    keywords: "product analytics, cohorts, unified, amplitude, mixpanel, segment, posthog",
    docLlm:
      "Amplitude behavioral cohorts with the shared product-analytics columns (tool, cohort_id, name, " +
      "description, size, created_at, updated_at, is_archived, definition JSON), so they UNION ALL with the " +
      "same table of other analytics workers. Use amplitude.main.cohorts for every Amplitude field.",
    docMd: "## unified.cohorts\n\nAmplitude cohorts in the shared product-analytics shape.",
    columns: [
      tool,
      C.str("cohort_id", "Cohort id.", "id", false),
      C.str("name", "Cohort name.", "name"),
      C.str("description", "Description.", "description"),
      C.big("size", "Members at the last computation.", "size"),
      C.epochSec("created_at", "Created.", "createdAt"),
      C.epochSec("updated_at", "Last modified.", "lastMod"),
      C.bool("is_archived", "Archived.", "archived"),
      C.json("definition", "Tool-specific definition (JSON).", "definition"),
    ],
    requests: () => [{ path: "/api/3/cohorts" }],
    rows: COHORT_ROWS,
    examples: [{ sql: `SELECT tool, name, size FROM ${U}.cohorts ORDER BY size DESC`, description: "Cohorts by size" }],
  },
  UNIFIED,
  ["cohort_id"],
);

/** Join /api/2/events/list volumes with the taxonomy (category, description) by event name. */
async function withTaxonomy(rows: Row[], cfg: AmpConfig): Promise<Row[]> {
  let tax: Row[] = [];
  try {
    const body = (await ampGet(cfg, "/api/2/taxonomy/event", undefined, "taxonomy")) as Row | null;
    tax = Array.isArray(body?.data) ? (body?.data as Row[]) : [];
  } catch (err) {
    if (!(err instanceof AmpError) || (err.status !== 403 && err.status !== 404)) throw err;
    log.info("amplitude: taxonomy API not available; event definitions carry no category/description");
  }
  const byName = new Map(tax.map((t) => [t.event_type as string, t]));
  const out: Row[] = rows.map((r) => {
    const name = (r.value ?? r.name) as string;
    const t = byName.get(name);
    byName.delete(name);
    return {
      event_name: name,
      display_name: t?.display_name ?? r.display ?? null,
      description: t?.description ?? null,
      category: t?.category?.name ?? null,
      is_hidden: r.hidden ?? false,
      is_active: r.non_active === undefined ? (t?.is_active ?? null) : !r.non_active,
      volume: r.totals ?? null,
      tags: t?.tags ?? null,
    };
  });
  for (const [name, t] of byName) {
    out.push({
      event_name: name,
      display_name: t.display_name ?? null,
      description: t.description ?? null,
      category: t.category?.name ?? null,
      is_hidden: !!t.is_hidden_from_dropdowns,
      is_active: t.is_active ?? null,
      volume: null,
      tags: t.tags ?? null,
    });
  }
  return out;
}

export const unifiedEventDefinitions = defineAmpCatalogTable(
  {
    name: "event_definitions",
    description: "Event definitions in the shared product-analytics shape (name, description, category, volume)",
    title: "Event Definitions (Shared Shape)",
    category: "unified",
    keywords: "product analytics, event definitions, tracking plan, unified, amplitude",
    docLlm:
      "Every Amplitude event type in the shared product-analytics shape: tool, event_name, display_name, " +
      "description, category, is_hidden, is_active, volume (events this week, from /api/2/events/list) and " +
      "tags. Event list and tracking plan (Taxonomy API) are joined by name; events only in one appear too.",
    docMd: "## unified.event_definitions\n\nEvent types in the shared product-analytics shape.",
    columns: [
      tool,
      C.str("event_name", "Event name.", "event_name", false),
      C.str("display_name", "Display name.", "display_name"),
      C.str("description", "Description.", "description"),
      C.str("category", "Category.", "category"),
      C.bool("is_hidden", "Hidden in the tool's UI.", "is_hidden"),
      C.bool("is_active", "Receiving data.", "is_active"),
      C.big("volume", "Recent volume (Amplitude: events this week).", "volume"),
      C.strList("tags", "Tags.", "tags"),
    ],
    requests: () => [{ path: "/api/2/events/list" }],
    expand: (rows, _req, { cfg }) => withTaxonomy(rows, cfg),
    examples: [
      {
        sql: `SELECT event_name, volume FROM ${U}.event_definitions ORDER BY volume DESC NULLS LAST LIMIT 10`,
        description: "Highest-volume events",
      },
    ],
  },
  UNIFIED,
  ["event_name"],
);

export const unifiedPropertyDefinitions = defineAmpCatalogTable(
  {
    name: "property_definitions",
    description: "Event, user and group property definitions in the shared product-analytics shape",
    title: "Property Definitions (Shared Shape)",
    category: "unified",
    keywords: "product analytics, property definitions, tracking plan, unified, amplitude",
    docLlm:
      "Every property of the Amplitude tracking plan in the shared product-analytics shape: tool, " +
      "property_name, scope ('event', 'user' or 'group'), event_name (for event properties; NULL for shared " +
      "ones), data_type, description, is_array, is_required, is_hidden, enum_values. WHERE scope = 'user' " +
      "skips the per-event requests; WHERE event_name = 'x' reads one event's properties.",
    docMd: "## unified.property_definitions\n\nProperties in the shared product-analytics shape.",
    pushdown: "`scope` (=, IN) skips the other property families; `event_name` (=, IN) reads only those event types.",
    bucket: "taxonomy",
    columns: [
      tool,
      C.str("property_name", "Property name.", (r) => r.event_property ?? r.user_property ?? r.group_property, false),
      C.str("scope", "'event', 'user' or 'group'.", (r) => r.__ctx?.scope, false),
      C.str("event_name", "Event the property belongs to (event scope; NULL when shared).", (r) =>
        r.__ctx?.scope === "event" ? (r.__ctx?.event_type ?? r.event_type ?? null) : null,
      ),
      C.str("data_type", "Data type.", "type"),
      C.str("description", "Description.", "description"),
      C.bool("is_array", "Array-valued.", "is_array_type"),
      C.bool("is_required", "Required.", "is_required"),
      C.bool("is_hidden", "Hidden.", "is_hidden"),
      C.strList("enum_values", "Allowed values.", enumList),
    ],
    requests: async ({ cfg, constraints }) => {
      const scopes = eqValues(constraints, "scope") ?? ["event", "user", "group"];
      const reqs: AmpRequest[] = [];
      if (scopes.includes("user")) {
        reqs.push({ path: "/api/2/taxonomy/user-property", ctx: { scope: "user" } });
      }
      if (scopes.includes("event")) {
        for (const r of await eventPropertyRequests(cfg, eqValues(constraints, "event_name"))) {
          reqs.push({ ...r, ctx: { ...r.ctx, scope: "event" } });
        }
      }
      if (scopes.includes("group")) reqs.push({ path: "/api/2/taxonomy/group-property", ctx: { scope: "group" } });
      return reqs;
    },
    examples: [
      {
        sql: `SELECT scope, count(*) AS properties FROM ${U}.property_definitions GROUP BY scope ORDER BY scope`,
        description: "Properties per scope",
      },
    ],
  },
  UNIFIED,
  [],
);

export const MAIN_TABLES: TableDescriptor[] = [
  eventTypes,
  eventTotals,
  eventCategories,
  eventProperties,
  userProperties,
  groupProperties,
  cohorts,
  annotations,
];
export const UNIFIED_DEF_TABLES: TableDescriptor[] = [
  unifiedCohorts,
  unifiedEventDefinitions,
  unifiedPropertyDefinitions,
];
