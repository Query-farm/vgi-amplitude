/**
 * Dashboard REST API charts as long-format table functions, plus user search,
 * user activity and user profiles.
 *
 * Every chart endpoint returns `series` (one array per segment / group) against
 * `xValues` (dates, hours or bins); these functions return one row per
 * (series, x value) so results join and aggregate like any table. Charts run inside
 * Amplitude, so their arguments are the pushdown: start/end dates, metric,
 * granularity, segments and group-bys are sent as Amplitude's own parameters.
 *
 * Amplitude prices chart queries in "cost" (days × conditions × endpoint cost) with an
 * hourly budget per project; group-bys count as 4 segments each. The client retries
 * 429s with back-off, but an exhausted hourly budget only clears with time: shorten
 * the date range or drop group-bys.
 */

import { dateDay, int32, int64, list, utf8, type VgiFunction } from "@query-farm/vgi";
import { type AmpConfig, AmpError, ampGet } from "./client.ts";
import { NATIVE_EVENT_COLUMNS } from "./export.ts";
import { asBig, asNum, C, type Col, defineAmpTable, eventJson, jsonArg, type Row, ymd } from "./table.ts";

const Q = "amplitude.main";
const U = "amplitude.unified";

const GRANULARITY: Record<string, string> = {
  realtime: "-300000",
  hour: "-3600000",
  day: "1",
  week: "7",
  month: "30",
};
const GRAN_DOC =
  "Interval (named): 'day' (default), 'week', 'month'; segmentation and funnel also take 'hour' (≤ 7 days) and 'realtime' (5-minute, ≤ 2 days).";
const DAY_WEEK_MONTH = { choices: ["day", "week", "month"] };
const ALL_GRAN = { choices: ["realtime", "hour", "day", "week", "month"] };
const SEGMENTS_DOC =
  'Segment definitions (named): Amplitude `s` JSON, e.g. \'[{"prop":"country","op":"is","values":["United States"]}]\'. NULL = all users.';
const START_DOC = "First day of the range (DATE, project time zone).";
const END_DOC = "Last day of the range, inclusive (DATE).";

/** The label of series i: seriesLabels / seriesMeta entries are a string, a number or [index, label]. */
export function seriesLabel(labels: unknown, i: number): string | null {
  if (!Array.isArray(labels)) return null;
  const l = labels[i];
  if (typeof l === "string") return l === "" ? null : l;
  if (Array.isArray(l)) {
    const s = l.filter((x) => typeof x === "string");
    return s.length ? s.join("; ") : null;
  }
  if (l && typeof l === "object") {
    const o = l as Row;
    const v = o.label ?? o.groupValue ?? o.value;
    return typeof v === "string" ? v : null;
  }
  return null;
}

/** series × xValues → long rows {series_index, series_label, period, value}. */
export function longSeries(data: Row | null | undefined, labelsKey = "seriesLabels"): Row[] {
  if (!data) return [];
  const series = Array.isArray(data.series) ? (data.series as unknown[]) : [];
  const xs = Array.isArray(data.xValues) ? (data.xValues as unknown[]) : [];
  const collapsed = Array.isArray(data.seriesCollapsed) ? (data.seriesCollapsed as unknown[]) : [];
  const labels = data[labelsKey] ?? data.seriesLabels ?? data.seriesMeta;
  const out: Row[] = [];
  series.forEach((s, i) => {
    if (!Array.isArray(s)) return;
    const c = collapsed[i];
    const total = Array.isArray(c) ? asNum((c[0] as Row | undefined)?.value) : null;
    s.forEach((v, j) => {
      out.push({
        series_index: i,
        series_label: seriesLabel(labels, i),
        period: xs[j] == null ? null : String(xs[j]),
        value: asNum(v),
        series_total: total,
      });
    });
  });
  return out;
}

const SERIES_COLS = (valueName: string, valueDoc: string, big = false): Col[] => [
  C.int("series_index", "Series (segment / group) index, 0-based.", "series_index", false),
  C.str("series_label", "Group-by value or segment label (NULL when ungrouped).", "series_label"),
  C.str("period", "The x value: a date (YYYY-MM-DD, project time zone), an hour, or a time of day.", "period"),
  big ? C.big(valueName, valueDoc, "value") : C.num(valueName, valueDoc, "value"),
];

const dataOf = (body: unknown): Row | null => ((body as Row | null)?.data as Row) ?? null;

const groupList = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x !== "")
    : typeof v === "string" && v
      ? [v]
      : undefined;

function gran(v: unknown, allowed: string[]): string {
  const g = String(v ?? "day");
  if (!allowed.includes(g)) throw new AmpError(`granularity must be one of ${allowed.join(", ")}`);
  return GRANULARITY[g] as string;
}

// ------------------------------------------------------------------ segmentation

interface SegArgs {
  event_json: string;
  start_date: unknown;
  end_date: unknown;
  metric: string;
  granularity: string;
  group_by: string[] | null;
  segments: string | null;
  second_event: string | null;
  formula: string | null;
  group_limit: number | null;
  user_type: string | null;
}

export const segmentation = defineAmpTable<SegArgs & Record<string, unknown>>({
  name: "segmentation",
  description: "Event segmentation chart (uniques, totals, DAU %, averages, property sums, formulas) as long rows",
  title: "Amplitude Event Segmentation",
  category: "charts",
  keywords: "amplitude, event segmentation, uniques, totals, dau, time series, group by, formula",
  docLlm:
    "Runs an Amplitude event segmentation chart (GET /api/2/events/segmentation) and returns one row per " +
    "(series, period): series_index, series_label (the group-by value), period (date or hour), value and " +
    "series_total (the series collapsed over the range). Arguments: event_json (an event type name such as " +
    '\'Purchase\', or Amplitude event JSON \'{"event_type":"Purchase","filters":[…],"group_by":[…]}\'; ' +
    "'_active' and '_all' are any active / any event), start_date, end_date (DATEs), and named metric " +
    "('uniques' default, 'totals', 'pct_dau', 'average', 'histogram', 'sums', 'value_avg', 'formula'), " +
    "granularity ('day', 'week', 'month', 'hour', 'realtime'), group_by (up to two property names, e.g. " +
    "['country'] or ['gp:plan']), segments (s JSON), second_event + formula (e.g. 'UNIQUES(A)/UNIQUES(B)'), " +
    "group_limit (≤ 20,000) and user_type ('any' or 'active'). Everything runs in Amplitude; cost = days × " +
    "events (+4 per group-by) against the project's hourly budget.",
  docMd: "## segmentation\n\nAn Amplitude event segmentation chart as long rows: one row per series and period.",
  args: {
    event_json: utf8(),
    start_date: dateDay(),
    end_date: dateDay(),
    metric: utf8(),
    granularity: utf8(),
    group_by: list(utf8()),
    segments: utf8(),
    second_event: utf8(),
    formula: utf8(),
    group_limit: int32,
    user_type: utf8(),
  },
  argDocs: {
    event_json: "Event type name or Amplitude event JSON (positional).",
    start_date: START_DOC,
    end_date: END_DOC,
    metric: "Metric (named): uniques (default), totals, pct_dau, average, histogram, sums, value_avg, formula.",
    granularity: GRAN_DOC,
    group_by: "Up to two user/event property names to group by (named), e.g. ['country'].",
    segments: SEGMENTS_DOC,
    second_event: "Second event (named) for formulas: name or event JSON; it is event B.",
    formula: "Formula (named) when metric = 'formula', e.g. 'UNIQUES(A)/UNIQUES(B)'.",
    group_limit: "Group-by values returned (named; Amplitude default 1000, max 20,000).",
    user_type: "Count 'any' users (default) or only 'active' users (named).",
  },
  argDefaults: {
    metric: "uniques",
    granularity: "day",
    group_by: null,
    segments: null,
    second_event: null,
    formula: null,
    group_limit: null,
    user_type: null,
  },
  argConstraints: {
    metric: { choices: ["uniques", "totals", "pct_dau", "average", "histogram", "sums", "value_avg", "formula"] },
    granularity: ALL_GRAN,
    group_limit: { ge: 1, le: 20_000 },
    user_type: { choices: ["any", "active"] },
  },
  columns: [
    ...SERIES_COLS("value", "Metric value for the series in the period."),
    C.num("series_total", "The series collapsed over the whole range (Amplitude seriesCollapsed).", "series_total"),
  ],
  requests: ({ args }) => {
    const g = groupList(args.group_by);
    if (g && g.length > 2) throw new AmpError("group_by: Amplitude allows at most two group-by properties");
    if (args.metric === "formula" && !args.formula) throw new AmpError("formula is required when metric = 'formula'");
    return [
      {
        path: "/api/2/events/segmentation",
        query: {
          e: eventJson(args.event_json, "event_json"),
          e2: args.second_event ? eventJson(args.second_event, "second_event") : undefined,
          start: ymd(args.start_date, "start_date"),
          end: ymd(args.end_date, "end_date"),
          m: args.metric ?? "uniques",
          i: gran(args.granularity, Object.keys(GRANULARITY)),
          s: jsonArg(args.segments, "segments"),
          g,
          formula: args.formula ?? undefined,
          limit: args.group_limit == null ? undefined : String(args.group_limit),
          n: args.user_type ?? undefined,
        },
      },
    ];
  },
  rows: (body) => longSeries(dataOf(body)),
  examples: [
    {
      sql: `SELECT period, value AS daily_purchasers FROM ${Q}.segmentation('Purchase', DATE '2026-11-01', DATE '2026-11-07') ORDER BY period`,
      description: "Daily unique purchasers for a week",
    },
    {
      sql: `SELECT series_label AS country, sum(value) AS purchases FROM ${Q}.segmentation('Purchase', DATE '2026-11-01', DATE '2026-11-07', metric := 'totals', group_by := ['country']) GROUP BY ALL ORDER BY purchases DESC`,
      description: "Purchases per country (grouped in Amplitude)",
    },
  ],
});

// --------------------------------------------------------------------- funnel

export function funnelRows(body: unknown): Row[] {
  const data = (body as Row | null)?.data;
  const groups = Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : [];
  const out: Row[] = [];
  groups.forEach((g, gi) => {
    const events = Array.isArray(g.events) ? g.events : [];
    const raw = Array.isArray(g.cumulativeRaw) ? g.cumulativeRaw : [];
    const n = Math.max(events.length, raw.length);
    const label = g.groupValue ?? g.meta?.groupValue ?? g.meta?.label ?? null;
    for (let i = 0; i < n; i++) {
      const med = asNum(g.medianTransTimes?.[i]);
      const avg = asNum(g.avgTransTimes?.[i]);
      out.push({
        group_index: gi,
        group_label: typeof label === "string" ? label : label == null ? null : JSON.stringify(label),
        step: i + 1,
        event_type: events[i] ?? null,
        users: raw[i] ?? null,
        conversion_rate: g.cumulative?.[i] ?? null,
        step_conversion_rate: g.stepByStep?.[i] ?? null,
        median_seconds: med === null ? null : med / 1000,
        avg_seconds: avg === null ? null : avg / 1000,
      });
    }
  });
  return out;
}

interface FunnelArgs {
  events: string[];
  start_date: unknown;
  end_date: unknown;
  mode: string;
  user_type: string;
  conversion_seconds: bigint | null;
  granularity: string;
  group_by: string | null;
  segments: string | null;
  group_limit: number | null;
}

export const funnel = defineAmpTable<FunnelArgs & Record<string, unknown>>({
  name: "funnel",
  description: "Funnel analysis: users reaching each step, conversion and time-to-convert, per group",
  title: "Amplitude Funnel",
  category: "charts",
  keywords: "amplitude, funnel, conversion, drop-off, time to convert, steps",
  docLlm:
    "Runs an Amplitude funnel (GET /api/2/funnels) over the ordered steps in `events` (a list of event names " +
    "or event JSON objects) between start_date and end_date, and returns one row per (group, step): " +
    "group_index, group_label, step (1-based), event_type, users reaching the step, conversion_rate " +
    "(from step 1), step_conversion_rate (from the previous step), median_seconds and avg_seconds to " +
    "convert. Named: mode ('ordered' default, 'unordered', 'sequential'), user_type ('active' default or " +
    "'new'), conversion_seconds (window, default 30 days), granularity, group_by (one property), segments, " +
    "group_limit (≤ 1000).",
  docMd: "## funnel\n\nAn Amplitude funnel: one row per group and step.",
  args: {
    events: list(utf8()),
    start_date: dateDay(),
    end_date: dateDay(),
    mode: utf8(),
    user_type: utf8(),
    conversion_seconds: int64(),
    granularity: utf8(),
    group_by: utf8(),
    segments: utf8(),
    group_limit: int32,
  },
  argDocs: {
    events: "Funnel steps in order: event names or event JSON (positional), e.g. ['Sign Up', 'Purchase'].",
    start_date: START_DOC,
    end_date: END_DOC,
    mode: "Step order (named): ordered (default), unordered, sequential.",
    user_type: "Users counted (named): active (default) or new.",
    conversion_seconds: "Conversion window in seconds (named; default 2,592,000 = 30 days).",
    granularity: GRAN_DOC,
    group_by: "One property to group by (named), e.g. 'country' or 'gp:plan'.",
    segments: SEGMENTS_DOC,
    group_limit: "Group-by values returned (named; max 1000).",
  },
  argDefaults: {
    mode: "ordered",
    user_type: "active",
    conversion_seconds: null,
    granularity: "day",
    group_by: null,
    segments: null,
    group_limit: null,
  },
  argConstraints: {
    mode: { choices: ["ordered", "unordered", "sequential"] },
    user_type: { choices: ["active", "new"] },
    granularity: ALL_GRAN,
    conversion_seconds: { ge: 1 },
    group_limit: { ge: 1, le: 1000 },
  },
  columns: [
    C.int("group_index", "Group index, 0-based (one group when ungrouped).", "group_index", false),
    C.str("group_label", "Group-by value (NULL when ungrouped).", "group_label"),
    C.int("step", "Step number, 1-based.", "step", false),
    C.str("event_type", "The step's event.", "event_type"),
    C.big("users", "Users who reached this step.", "users"),
    C.num("conversion_rate", "Fraction of step-1 users who reached this step.", "conversion_rate"),
    C.num(
      "step_conversion_rate",
      "Fraction of the previous step's users who reached this step.",
      "step_conversion_rate",
    ),
    C.num("median_seconds", "Median time from the previous step, in seconds.", "median_seconds"),
    C.num("avg_seconds", "Average time from the previous step, in seconds.", "avg_seconds"),
  ],
  requests: ({ args }) => {
    const steps = Array.isArray(args.events) ? args.events : [];
    if (steps.length < 1) throw new AmpError("events: give at least one funnel step");
    return [
      {
        path: "/api/2/funnels",
        query: {
          e: steps.map((s, i) => eventJson(s, `events[${i + 1}]`)),
          start: ymd(args.start_date, "start_date"),
          end: ymd(args.end_date, "end_date"),
          mode: args.mode ?? "ordered",
          n: args.user_type ?? "active",
          cs: args.conversion_seconds == null ? undefined : String(args.conversion_seconds),
          i: gran(args.granularity, Object.keys(GRANULARITY)),
          g: args.group_by ?? undefined,
          s: jsonArg(args.segments, "segments"),
          limit: args.group_limit == null ? undefined : String(args.group_limit),
        },
      },
    ];
  },
  rows: funnelRows,
  examples: [
    {
      sql: `SELECT step, event_type, users, round(conversion_rate, 3) AS conversion FROM ${Q}.funnel(['Sign Up', 'Purchase'], DATE '2026-11-01', DATE '2026-11-07') ORDER BY step`,
      description: "Sign-up to purchase conversion",
    },
  ],
});

// ------------------------------------------------------------------ retention

export function retentionRows(body: unknown): Row[] {
  const data = dataOf(body);
  const series = Array.isArray(data?.series) ? (data?.series as Row[]) : [];
  const out: Row[] = [];
  series.forEach((s, si) => {
    const push = (cohort: string | null, cells: unknown) => {
      if (!Array.isArray(cells)) return;
      cells.forEach((c, idx) => {
        if (idx === 0) return; // index 0 is the cohort total; index 1 is day 0
        const cell = c as Row;
        const outof = asNum(cell?.outof);
        const count = asNum(cell?.count);
        out.push({
          series_index: si,
          cohort,
          day: idx - 1,
          cohort_size: outof,
          retained: count,
          retention_rate: outof ? (count ?? 0) / outof : null,
          incomplete: cell?.incomplete ?? null,
        });
      });
    };
    const values = (s.values ?? {}) as Record<string, unknown>;
    const dates = Array.isArray(s.dates) ? (s.dates as string[]) : Object.keys(values);
    for (const d of [...dates].reverse()) push(d, values[d]);
    push(null, s.combined);
  });
  return out;
}

interface RetArgs {
  start_event: string;
  return_event: string;
  start_date: unknown;
  end_date: unknown;
  mode: string;
  brackets: string | null;
  granularity: string;
  group_by: string | null;
  segments: string | null;
}

export const retention = defineAmpTable<RetArgs & Record<string, unknown>>({
  name: "retention",
  description: "Retention analysis: users retained N days (or periods) after a start event, per cohort",
  title: "Amplitude Retention",
  category: "charts",
  keywords: "amplitude, retention, n-day retention, cohort analysis, churn, return rate",
  docLlm:
    "Runs an Amplitude retention chart (GET /api/2/retention): users who did start_event in each period " +
    "between start_date and end_date and then return_event. One row per (series, cohort, day): " +
    "series_index, cohort (the start period's label; NULL for the combined row over all cohorts), day " +
    "(0 = the start period, then 1, 2 …, in granularity units or bracket index), cohort_size, retained, " +
    "retention_rate and incomplete (the period has not fully elapsed). start_event: '_new' (new users), " +
    "'_active', or an event name / event JSON; return_event: '_all', '_active', or an event. Named: mode " +
    "('nday' default, 'rolling', 'bracket', 'nday_or_before'), brackets (JSON like '[[0,5],[5,10]]' for " +
    "bracket mode), granularity ('day', 'week', 'month'), group_by, segments.",
  docMd: "## retention\n\nAn Amplitude retention chart: one row per cohort and day.",
  args: {
    start_event: utf8(),
    return_event: utf8(),
    start_date: dateDay(),
    end_date: dateDay(),
    mode: utf8(),
    brackets: utf8(),
    granularity: utf8(),
    group_by: utf8(),
    segments: utf8(),
  },
  argDocs: {
    start_event: "Start event: '_new', '_active', an event name or event JSON (positional).",
    return_event: "Return event: '_all', '_active', an event name or event JSON (positional).",
    start_date: START_DOC,
    end_date: END_DOC,
    mode: "Retention mode (named): nday (default), rolling, bracket, nday_or_before.",
    brackets: "Brackets for mode = 'bracket' (named): JSON '[[0,5],[5,10]]', end exclusive.",
    granularity: "Period (named): day (default), week, month.",
    group_by: "One property to group by (named).",
    segments: SEGMENTS_DOC,
  },
  argDefaults: { mode: "nday", brackets: null, granularity: "day", group_by: null, segments: null },
  argConstraints: {
    mode: { choices: ["nday", "rolling", "bracket", "nday_or_before"] },
    granularity: DAY_WEEK_MONTH,
  },
  columns: [
    C.int("series_index", "Series (segment / group) index, 0-based.", "series_index", false),
    C.str("cohort", "Start-period label as Amplitude returns it (NULL for the combined row).", "cohort"),
    C.int("day", "Periods after the start period (0 = the start period) or bracket index.", "day", false),
    C.big("cohort_size", "Users in the cohort (out of).", "cohort_size"),
    C.big("retained", "Users who returned in this period.", "retained"),
    C.num("retention_rate", "retained / cohort_size.", "retention_rate"),
    C.bool("incomplete", "True when the period has not fully elapsed yet.", "incomplete"),
  ],
  requests: ({ args }) => {
    if (args.mode === "bracket" && !args.brackets) throw new AmpError("brackets is required when mode = 'bracket'");
    return [
      {
        path: "/api/2/retention",
        query: {
          se: eventJson(args.start_event, "start_event"),
          re: eventJson(args.return_event, "return_event"),
          start: ymd(args.start_date, "start_date"),
          end: ymd(args.end_date, "end_date"),
          rm: args.mode ?? "nday",
          rb: jsonArg(args.brackets, "brackets"),
          i: gran(args.granularity, ["day", "week", "month"]),
          g: args.group_by ?? undefined,
          s: jsonArg(args.segments, "segments"),
        },
      },
    ];
  },
  rows: retentionRows,
  examples: [
    {
      sql: `SELECT day, round(retention_rate, 3) AS retention FROM ${Q}.retention('_new', '_all', DATE '2026-11-01', DATE '2026-11-07') WHERE cohort IS NULL ORDER BY day`,
      description: "Combined N-day retention of new users",
    },
  ],
});

// ----------------------------------------------------------- simple chart readers

type RangeArgs = {
  start_date: unknown;
  end_date: unknown;
} & Record<string, unknown>;
const RANGE_ARGS = { start_date: dateDay(), end_date: dateDay() };
const RANGE_DOCS = { start_date: START_DOC, end_date: END_DOC };
const range = (a: RangeArgs) => ({ start: ymd(a.start_date, "start_date"), end: ymd(a.end_date, "end_date") });

export const activeUsers = defineAmpTable<
  RangeArgs & { metric: string; granularity: string; group_by: string | null; segments: string | null }
>({
  name: "active_users",
  description: "Active or new user counts per day, week or month, optionally grouped or segmented",
  title: "Amplitude Active and New Users",
  category: "charts",
  keywords: "amplitude, active users, dau, wau, mau, new users, growth",
  docLlm:
    "Active or new users (GET /api/2/users) between start_date and end_date: one row per (series, period) " +
    "with series_index, series_label (group value or segment), period and users. Named: metric ('active' " +
    "default or 'new'), granularity ('day', 'week', 'month'), group_by (a property), segments.",
  docMd: "## active_users\n\nActive or new users per period.",
  args: { ...RANGE_ARGS, metric: utf8(), granularity: utf8(), group_by: utf8(), segments: utf8() },
  argDocs: {
    ...RANGE_DOCS,
    metric: "active (default) or new (named).",
    granularity: "Period (named): day (default), week, month.",
    group_by: "One property to group by (named).",
    segments: SEGMENTS_DOC,
  },
  argDefaults: { metric: "active", granularity: "day", group_by: null, segments: null },
  argConstraints: { metric: { choices: ["active", "new"] }, granularity: DAY_WEEK_MONTH },
  columns: SERIES_COLS("users", "Users in the period.", true),
  requests: ({ args }) => [
    {
      path: "/api/2/users",
      query: {
        ...range(args),
        m: args.metric ?? "active",
        i: gran(args.granularity, ["day", "week", "month"]),
        g: args.group_by ?? undefined,
        s: jsonArg(args.segments, "segments"),
      },
    },
  ],
  rows: (body) => longSeries(dataOf(body), "seriesMeta"),
  examples: [
    {
      sql: `SELECT period, users AS dau FROM ${Q}.active_users(DATE '2026-11-01', DATE '2026-11-07') ORDER BY period`,
      description: "Daily active users for a week",
    },
  ],
});

export const averageSessionLength = defineAmpTable<RangeArgs>({
  name: "average_session_length",
  description: "Average session length in seconds per day",
  title: "Amplitude Average Session Length",
  category: "charts",
  keywords: "amplitude, sessions, session length, engagement, time in app",
  docLlm:
    "Average session length (GET /api/2/sessions/average) per day between start_date and end_date: period " +
    "and avg_seconds.",
  docMd: "## average_session_length\n\nAverage session length per day.",
  args: RANGE_ARGS,
  argDocs: RANGE_DOCS,
  columns: [
    C.str("period", "Day (YYYY-MM-DD, project time zone).", "period"),
    C.num("avg_seconds", "Average session length in seconds.", "value"),
  ],
  requests: ({ args }) => [{ path: "/api/2/sessions/average", query: range(args) }],
  rows: (body) => longSeries(dataOf(body)),
  examples: [
    {
      sql: `SELECT period, round(avg_seconds / 60, 1) AS minutes FROM ${Q}.average_session_length(DATE '2026-11-01', DATE '2026-11-07') ORDER BY period`,
      description: "Average session minutes per day",
    },
  ],
});

export const sessionsPerUser = defineAmpTable<RangeArgs>({
  name: "sessions_per_user",
  description: "Average sessions per user per day",
  title: "Amplitude Sessions per User",
  category: "charts",
  keywords: "amplitude, sessions, sessions per user, engagement, frequency",
  docLlm:
    "Average number of sessions per active user (GET /api/2/sessions/peruser) per day between start_date " +
    "and end_date: period and sessions_per_user.",
  docMd: "## sessions_per_user\n\nAverage sessions per user per day.",
  args: RANGE_ARGS,
  argDocs: RANGE_DOCS,
  columns: [
    C.str("period", "Day (YYYY-MM-DD).", "period"),
    C.num("sessions_per_user", "Average sessions per active user.", "value"),
  ],
  requests: ({ args }) => [{ path: "/api/2/sessions/peruser", query: range(args) }],
  rows: (body) => longSeries(dataOf(body)),
  examples: [
    {
      sql: `SELECT avg(sessions_per_user) AS mean FROM ${Q}.sessions_per_user(DATE '2026-11-01', DATE '2026-11-07')`,
      description: "Mean sessions per user over a week",
    },
  ],
});

export const sessionLengthDistribution = defineAmpTable<
  RangeArgs & { bin_unit: string | null; bin_min: number | null; bin_max: number | null; bin_size: number | null }
>({
  name: "session_length_distribution",
  description: "Histogram of session lengths over a date range",
  title: "Amplitude Session Length Distribution",
  category: "charts",
  keywords: "amplitude, sessions, session length, histogram, distribution",
  docLlm:
    "Session length histogram (GET /api/2/sessions/length) between start_date and end_date: bin_index, bin " +
    "label (e.g. '60s-120s') and sessions. Optional named bin_unit ('seconds', 'minutes', 'hours', 'days'), " +
    "bin_min, bin_max and bin_size customise the bins (Amplitude falls back to its defaults when invalid).",
  docMd: "## session_length_distribution\n\nSession counts per length bin.",
  args: { ...RANGE_ARGS, bin_unit: utf8(), bin_min: int32, bin_max: int32, bin_size: int32 },
  argDocs: {
    ...RANGE_DOCS,
    bin_unit: "Bin time unit (named): seconds, minutes, hours, days.",
    bin_min: "Lowest bin edge (named).",
    bin_max: "Highest bin edge (named).",
    bin_size: "Bin width (named).",
  },
  argDefaults: { bin_unit: null, bin_min: null, bin_max: null, bin_size: null },
  argConstraints: { bin_unit: { choices: ["seconds", "minutes", "hours", "days"] } },
  columns: [
    C.int("bin_index", "Bin position, 0-based.", "bin_index", false),
    C.str("bin", "Bin label, e.g. '60s-120s'.", "bin"),
    C.big("sessions", "Sessions whose length falls in the bin.", "sessions"),
  ],
  requests: ({ args }) => [
    {
      path: "/api/2/sessions/length",
      query: {
        ...range(args),
        timeHistogramConfigBinTimeUnit: args.bin_unit ?? undefined,
        timeHistogramConfigBinMin: args.bin_min == null ? undefined : String(args.bin_min),
        timeHistogramConfigBinMax: args.bin_max == null ? undefined : String(args.bin_max),
        timeHistogramConfigBinSize: args.bin_size == null ? undefined : String(args.bin_size),
      },
    },
  ],
  rows: (body) =>
    longSeries(dataOf(body))
      .filter((r) => r.series_index === 0)
      .map((r, i) => ({ bin_index: i, bin: r.period, sessions: r.value })),
  examples: [
    {
      sql: `SELECT bin, sessions FROM ${Q}.session_length_distribution(DATE '2026-11-01', DATE '2026-11-07') ORDER BY bin_index`,
      description: "Session length histogram",
    },
  ],
});

export const userComposition = defineAmpTable<RangeArgs & { property: string }>({
  name: "user_composition",
  description: "Active users broken down by one property (version, country, platform, a custom gp: property …)",
  title: "Amplitude User Composition",
  category: "charts",
  keywords: "amplitude, user composition, breakdown, distribution, country, platform, version",
  docLlm:
    "User composition (GET /api/2/composition): active users between start_date and end_date broken down " +
    "by one property: value and users. property: version, country, city, region, DMA, language, platform, " +
    "os, device, start_version, paying, or a custom user property as 'gp:<name>'.",
  docMd: "## user_composition\n\nUsers per value of one property.",
  args: { ...RANGE_ARGS, property: utf8() },
  argDocs: { ...RANGE_DOCS, property: "Property to break down by (positional), e.g. 'platform' or 'gp:plan'." },
  columns: [
    C.str("value", "Property value ('(none)' when unset).", "period"),
    C.big("users", "Users with that value.", "value"),
  ],
  requests: ({ args }) => [{ path: "/api/2/composition", query: { ...range(args), p: String(args.property ?? "") } }],
  rows: (body) => longSeries(dataOf(body)).filter((r) => r.series_index === 0),
  examples: [
    {
      sql: `SELECT value AS platform, users FROM ${Q}.user_composition(DATE '2026-11-01', DATE '2026-11-07', 'platform') ORDER BY users DESC`,
      description: "Users per platform",
    },
  ],
});

export const realtimeActiveUsers = defineAmpTable<Record<string, never>>({
  name: "realtime_active_users",
  description: "Real-time active users in 5-minute buckets for today and yesterday",
  title: "Amplitude Real-time Active Users",
  category: "charts",
  keywords: "amplitude, real-time, realtime, live users, active users, now",
  docLlm:
    "Real-time active users (GET /api/2/realtime?i=5) in 5-minute buckets: series_label ('Today' or " +
    "'Yesterday'), time_of_day (HH:MM) and users. Use it for 'how many users are on right now' questions.",
  docMd: "## realtime_active_users\n\nActive users per 5-minute bucket, today and yesterday.",
  columns: [
    C.str("series_label", "'Today' or 'Yesterday'.", "series_label"),
    C.str("time_of_day", "Bucket start (HH:MM).", "period"),
    C.big("users", "Active users in the bucket.", "value"),
  ],
  requests: () => [{ path: "/api/2/realtime", query: { i: "5" } }],
  rows: (body) => longSeries(dataOf(body)),
  examples: [
    {
      sql: `SELECT time_of_day, users FROM ${Q}.realtime_active_users() WHERE series_label = 'Today' ORDER BY time_of_day DESC LIMIT 1`,
      description: "Active users in the latest bucket today",
    },
  ],
});

const LTV_METRIC: Record<string, string> = { arpu: "0", arppu: "1", total_revenue: "2", paying_users: "3" };

export function ltvRows(body: unknown): Row[] {
  const data = dataOf(body);
  const series = Array.isArray(data?.series) ? (data?.series as Row[]) : [];
  const out: Row[] = [];
  series.forEach((s, si) => {
    const label = seriesLabel(data?.seriesLabels, si);
    for (const [cohort, v] of Object.entries((s.values ?? {}) as Record<string, Row>)) {
      for (const [k, val] of Object.entries(v ?? {})) {
        const m = /^r(\d+)d$/.exec(k);
        if (!m) continue;
        out.push({
          series_index: si,
          series_label: label,
          cohort_date: cohort,
          day: Number(m[1]),
          value: asNum(val),
          cohort_users: asBig(v.count),
          paying_users: asBig(v.paid),
          total_amount: asNum(v.total_amount),
        });
      }
    }
  });
  return out;
}

export const revenueLtv = defineAmpTable<
  RangeArgs & { metric: string; granularity: string; group_by: string | null; segments: string | null }
>({
  name: "revenue_ltv",
  description: "Revenue lifetime value (ARPU, ARPPU, total revenue or paying users) per acquisition cohort and day",
  title: "Amplitude Revenue LTV",
  category: "charts",
  keywords: "amplitude, revenue, ltv, lifetime value, arpu, arppu, monetization",
  docLlm:
    "Revenue LTV (GET /api/2/revenue/ltv) for users acquired between start_date and end_date: one row per " +
    "(series, cohort_date, day) where day is N of Amplitude's rNd buckets (1, 2, 3 … 90) and value is the " +
    "chosen metric N days after acquisition, plus cohort_users, paying_users and total_amount for the " +
    "cohort. Named: metric ('arpu' default, 'arppu', 'total_revenue', 'paying_users'), granularity, " +
    "group_by, segments.",
  docMd: "## revenue_ltv\n\nLifetime value by acquisition cohort and day.",
  args: { ...RANGE_ARGS, metric: utf8(), granularity: utf8(), group_by: utf8(), segments: utf8() },
  argDocs: {
    ...RANGE_DOCS,
    metric: "arpu (default), arppu, total_revenue or paying_users (named).",
    granularity: "Cohort period (named): day (default), week, month.",
    group_by: "One property to group by (named).",
    segments: SEGMENTS_DOC,
  },
  argDefaults: { metric: "arpu", granularity: "day", group_by: null, segments: null },
  argConstraints: { metric: { choices: Object.keys(LTV_METRIC) }, granularity: DAY_WEEK_MONTH },
  columns: [
    C.int("series_index", "Series index, 0-based.", "series_index", false),
    C.str("series_label", "Group value (NULL when ungrouped).", "series_label"),
    C.str("cohort_date", "Acquisition period (YYYY-MM-DD).", "cohort_date"),
    C.int("day", "Days since acquisition (Amplitude's rNd bucket).", "day", false),
    C.num("value", "Metric value N days after acquisition.", "value"),
    C.big("cohort_users", "Users in the cohort.", "cohort_users"),
    C.big("paying_users", "Paying users in the cohort.", "paying_users"),
    C.num("total_amount", "Total revenue of the cohort.", "total_amount"),
  ],
  requests: ({ args }) => [
    {
      path: "/api/2/revenue/ltv",
      query: {
        ...range(args),
        m: LTV_METRIC[args.metric ?? "arpu"] ?? "0",
        i: gran(args.granularity, ["day", "week", "month"]),
        g: args.group_by ?? undefined,
        s: jsonArg(args.segments, "segments"),
      },
    },
  ],
  rows: ltvRows,
  examples: [
    {
      sql: `SELECT cohort_date, value AS arpu_30d FROM ${Q}.revenue_ltv(DATE '2026-10-01', DATE '2026-10-07') WHERE day = 30 ORDER BY cohort_date`,
      description: "30-day ARPU per acquisition day",
    },
  ],
});

// ----------------------------------------------------------------------- users

const MATCHES = (body: unknown): Row[] => {
  const m = (body as Row | null)?.matches;
  const type = (body as Row | null)?.type;
  return Array.isArray(m) ? (m as Row[]).map((x) => ({ ...x, __type: type })) : [];
};

export const userSearch = defineAmpTable<{ query: string }>({
  name: "user_search",
  description: "Find users by user id, device id, Amplitude id or user id prefix",
  title: "Amplitude User Search",
  category: "users",
  keywords: "amplitude, user search, lookup, user id, device id, amplitude id",
  docLlm:
    "User search (GET /api/2/usersearch?user=…): matches for a user id, device id, Amplitude id or user id " +
    "prefix: amplitude_id, user_id, match_type and the raw match (JSON). Feed amplitude_id to " +
    "user_activity() or user_profile(). User search and user activity share a budget of 360 queries an hour.",
  docMd: "## user_search\n\nUsers matching an id or id prefix.",
  args: { query: utf8() },
  argDocs: { query: "User id, device id, Amplitude id or user id prefix (positional)." },
  columns: [
    C.big("amplitude_id", "Amplitude id.", "amplitude_id"),
    C.str("user_id", "User id.", "user_id"),
    C.str("match_type", "Amplitude's match type, e.g. match_user_or_device_id.", "__type"),
    C.json("match", "The full match object.", (r) => {
      const { __type, __ctx, ...rest } = r;
      return rest;
    }),
  ],
  requests: ({ args }) => {
    if (!args.query) throw new AmpError("query: give a user id, device id or Amplitude id");
    return [{ path: "/api/2/usersearch", query: { user: String(args.query) } }];
  },
  rows: MATCHES,
  examples: [
    {
      sql: `SELECT amplitude_id, user_id FROM ${Q}.user_search('user_42') ORDER BY amplitude_id`,
      description: "Look a user up by user id",
    },
  ],
});

export const userActivity = defineAmpTable<{ amplitude_id: bigint; max_events: number; direction: string }>({
  name: "user_activity",
  description: "One user's event stream (most recent first by default), with every export event column",
  title: "Amplitude User Activity",
  category: "users",
  keywords: "amplitude, user activity, user timeline, event stream, user lookup, debugging",
  docLlm:
    "One user's events (GET /api/2/useractivity?user=<amplitude_id>), newest first by default, with the " +
    "same columns as events(). Arguments: amplitude_id (BIGINT, from user_search), named max_events " +
    "(default 1000; pages 1,000 at a time with offset) and direction ('latest' default or 'earliest').",
  docMd: "## user_activity\n\nOne user's events, paged 1,000 at a time.",
  args: { amplitude_id: int64(), max_events: int32, direction: utf8() },
  argDocs: {
    amplitude_id: "Amplitude id of the user (positional; see user_search).",
    max_events: "Most events to return (named; default 1000).",
    direction: "latest (default, newest first) or earliest (named).",
  },
  argDefaults: { max_events: 1000, direction: "latest" },
  argConstraints: { max_events: { ge: 1, le: 1_000_000 }, direction: { choices: ["latest", "earliest"] } },
  columns: NATIVE_EVENT_COLUMNS,
  requests: ({ args }) => [
    {
      path: "/api/2/useractivity",
      query: { user: String(args.amplitude_id), direction: args.direction ?? "latest" },
      page: { limit: 1000, max: Number(args.max_events ?? 1000) },
    },
  ],
  rows: (body) => {
    const e = (body as Row | null)?.events;
    return Array.isArray(e) ? (e as Row[]) : [];
  },
  examples: [
    {
      sql: `SELECT event_time, event_type FROM ${Q}.user_activity(12345, max_events := 20) ORDER BY event_time DESC`,
      description: "A user's 20 most recent events",
    },
  ],
});

/** Search, then fetch each match's profile (useractivity with limit=1 returns userData). */
async function profileRequests(cfg: AmpConfig, query: unknown) {
  if (!query) throw new AmpError("query: give a user id, device id or Amplitude id");
  const body = await ampGet(cfg, "/api/2/usersearch", { user: String(query) }, "dashboard");
  return MATCHES(body)
    .filter((m) => m.amplitude_id != null)
    .map((m) => ({
      path: "/api/2/useractivity",
      query: { user: String(m.amplitude_id), limit: "1" },
      ctx: { amplitude_id: String(m.amplitude_id) },
    }));
}

const USER_DATA = (body: unknown): Row[] => {
  const u = (body as Row | null)?.userData;
  return u && typeof u === "object" ? [u as Row] : [];
};

export const userProfile = defineAmpTable<{ query: string }>({
  name: "user_profile",
  description: "Profiles (usage totals, first/last seen, devices, location, user properties) of users matching an id",
  title: "Amplitude User Profile",
  category: "users",
  keywords: "amplitude, user profile, user properties, first seen, last seen, devices",
  docLlm:
    "Profiles of the users matching `query` (user search, then GET /api/2/useractivity per match): " +
    "amplitude_id, user_id, merged_amplitude_ids, num_events, num_sessions, usage_time_ms, first_used, " +
    "last_used, purchases, revenue, platform, os, version, device, device_type, carrier, country, region, " +
    "city, dma, language, start_version, device_ids, last_lat, last_lng and properties (JSON user " +
    "properties). Amplitude cannot list all users; use cohort_members() for whole audiences.",
  docMd: "## user_profile\n\nProfiles of the users matching an id.",
  args: { query: utf8() },
  argDocs: { query: "User id, device id, Amplitude id or user id prefix (positional)." },
  columns: [
    C.big("amplitude_id", "Amplitude id.", (r) => r.canonical_amplitude_id ?? r.__ctx?.amplitude_id),
    C.str("user_id", "User id.", "user_id"),
    C.bigList("merged_amplitude_ids", "Amplitude ids merged into this user.", "merged_amplitude_ids"),
    C.big("num_events", "Lifetime events.", "num_events"),
    C.big("num_sessions", "Lifetime sessions.", "num_sessions"),
    C.big("usage_time_ms", "Lifetime usage time (ms).", "usage_time"),
    C.time("first_used", "First day seen (midnight UTC of Amplitude's date).", "first_used"),
    C.time("last_used", "Last day seen (midnight UTC of Amplitude's date).", "last_used"),
    C.big("purchases", "Revenue events.", "purchases"),
    C.num("revenue", "Lifetime revenue.", "revenue"),
    C.str("platform", "Platform.", "platform"),
    C.str("os", "Operating system.", "os"),
    C.str("version", "App version.", "version"),
    C.str("device", "Device.", "device"),
    C.str("device_type", "Device type.", "device_type"),
    C.str("carrier", "Carrier.", "carrier"),
    C.str("country", "Country.", "country"),
    C.str("region", "Region.", "region"),
    C.str("city", "City.", "city"),
    C.str("dma", "DMA.", "dma"),
    C.str("language", "Language.", "language"),
    C.str("start_version", "First app version.", "start_version"),
    C.strList("device_ids", "Device ids.", "device_ids"),
    C.num("last_lat", "Last latitude.", "last_location.lat"),
    C.num("last_lng", "Last longitude.", "last_location.lng"),
    C.json("properties", "User properties (JSON).", "properties"),
  ],
  requests: ({ args, cfg }) => profileRequests(cfg, args.query),
  rows: USER_DATA,
  examples: [
    {
      sql: `SELECT user_id, num_events, last_used, country FROM ${Q}.user_profile('user_42')`,
      description: "A user's profile",
    },
  ],
});

export const unifiedUsers = defineAmpTable<{ query: string }>({
  name: "users",
  description: "Users matching an id, in the shared product-analytics shape",
  title: "Users (Shared Shape)",
  category: "unified",
  keywords: "product analytics, users, persons, profiles, unified, amplitude",
  docLlm:
    "Users matching `query` (a user id, device id, Amplitude id or user id prefix) in the shared " +
    "product-analytics shape: tool, user_id, distinct_id (Amplitude id as text), device_ids, first_seen, " +
    "last_seen, properties (JSON), platform, os, country, city, app_version. Amplitude cannot enumerate all " +
    "users, so this is a function of the search term rather than a table.",
  docMd: "## unified.users\n\nUsers in the shared product-analytics shape.",
  args: { query: utf8() },
  argDocs: { query: "User id, device id, Amplitude id or user id prefix (positional)." },
  columns: [
    C.lit("tool", "The analytics tool the row came from: 'amplitude'.", "amplitude"),
    C.str("user_id", "User id.", "user_id"),
    C.str(
      "distinct_id",
      "The tool's person id (Amplitude id as text).",
      (r) => r.canonical_amplitude_id ?? r.__ctx?.amplitude_id,
    ),
    C.strList("device_ids", "Device / anonymous ids.", "device_ids"),
    C.time("first_seen", "First seen (day precision for Amplitude).", "first_used"),
    C.time("last_seen", "Last seen (day precision for Amplitude).", "last_used"),
    C.json("properties", "User properties (JSON).", "properties"),
    C.str("platform", "Platform.", "platform"),
    C.str("os", "Operating system.", "os"),
    C.str("country", "Country.", "country"),
    C.str("city", "City.", "city"),
    C.str("app_version", "App version.", "version"),
  ],
  requests: ({ args, cfg }) => profileRequests(cfg, args.query),
  rows: USER_DATA,
  examples: [
    {
      sql: `SELECT tool, user_id, last_seen FROM ${U}.users('user_42')`,
      description: "A user in the shared shape",
    },
  ],
});

export const CHART_FUNCTIONS: VgiFunction[] = [
  segmentation,
  funnel,
  retention,
  activeUsers,
  averageSessionLength,
  sessionsPerUser,
  sessionLengthDistribution,
  userComposition,
  realtimeActiveUsers,
  revenueLtv,
  userSearch,
  userActivity,
  userProfile,
];
export const UNIFIED_FUNCTIONS: VgiFunction[] = [unifiedUsers];
