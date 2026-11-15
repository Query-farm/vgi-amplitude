/**
 * Raw events from the Amplitude Export API (`GET /api/2/export?start=…&end=…`).
 *
 * The Export API returns every event *uploaded* in a UTC hour range as a ZIP of
 * gzip JSON Lines files. This module turns that into a resumable scan:
 *
 * - **Window.** The upload-hour range comes from the pushed WHERE predicates:
 *   `server_upload_time` bounds map to hours exactly; `event_time` bounds map to
 *   `[lower − 1 h skew, upper + late_hours]` (an event is uploaded at or after it
 *   happens, up to `late_hours` later for offline clients). With no lower bound the
 *   scan reads the last `lookback_hours`. The upper end is clamped to the current
 *   hour. Every predicate is then re-applied to the rows exactly.
 * - **Chunks.** The window is fetched `chunk_hours` at a time (Amplitude allows 365
 *   days and 6 GB per request). A 400 "too large" or a 504 halves the chunk and
 *   retries, down to one hour. A 404 means no export files for the range: zero rows.
 * - **Streaming.** Each chunk is spooled to a temporary file and read entry by entry
 *   through inflate → gunzip → line splitting, so memory stays bounded however large
 *   the export. The temp file is deleted when the chunk is done (or abandoned).
 * - **Cursor.** State holds the window, the current chunk, the archive entry and the
 *   lines consumed within it. One Arrow batch goes out per call; the open archive is
 *   kept for the next call in the same process, and a different process (HTTP) re-
 *   downloads the chunk and skips to the cursor, so long scans survive transport
 *   hops and rate-limit pauses.
 */

import {
  defineTableFunction,
  formatPushedFilters,
  int32,
  type TableDescriptor,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import type { Category } from "../meta.ts";
import { type AmpConfig, AmpError, ampFetch, configFromSecrets, SECRET_TYPE } from "./client.ts";
import { type Constraint, constraintsOf, toEpochMs } from "./pushdown.ts";
import { asNum, batchOf, C, type Col, catalogTable, type FnExample, type Row, schemaOf, tagsOf } from "./table.ts";
import { type ArchivePos, archiveLines, removeSpool, spool } from "./zip.ts";

export const HOUR_MS = 3_600_000;
/** Clock-skew allowance between an event's time and its upload time. */
export const SKEW_HOURS = 1;
export const MAX_CHUNK_HOURS = 365 * 24;
export const BATCH_ROWS = 10_000;
/** An open archive left untouched this long is closed and its spool file deleted. */
const IDLE_MS = 10 * 60_000;

export interface ExportArgs {
  lookback_hours: number;
  late_hours: number;
  chunk_hours: number;
}
export const DEFAULT_EXPORT_ARGS: ExportArgs = { lookback_hours: 24, late_hours: 24, chunk_hours: 24 };

/** Hour index (hours since the epoch, UTC) → the Export API's `YYYYMMDDTHH`. */
export function hourParam(hour: number): string {
  const iso = new Date(hour * HOUR_MS).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}`;
}

/** The tightest [lo, hi] epoch-ms bounds the constraints put on one column (inclusive-ish). */
export function msBounds(
  constraints: Constraint[],
  columnName: string,
): { lo?: number; hi?: number; hiStrict?: boolean } {
  let lo: number | undefined;
  let hi: number | undefined;
  let hiStrict = false;
  for (const c of constraints) {
    if (c.column !== columnName || c.kind !== "cmp") continue;
    const ms = toEpochMs(c.value);
    if (ms === undefined) continue;
    if (c.op === "gt" || c.op === "ge" || c.op === "eq") lo = lo === undefined ? ms : Math.max(lo, ms);
    if (c.op === "lt" || c.op === "le" || c.op === "eq") {
      const strict = c.op === "lt";
      if (hi === undefined || ms < hi) {
        hi = ms;
        hiStrict = strict;
      } else if (ms === hi) hiStrict = hiStrict || strict;
    }
  }
  return { lo, hi, hiStrict };
}

/**
 * The upload-hour window [startHour, endHour] (inclusive) a scan must export, from
 * its pushed predicates and arguments. Exported for unit tests.
 */
export function exportWindow(
  constraints: Constraint[],
  args: ExportArgs,
  nowMs: number,
): { startHour: number; endHour: number } {
  const nowHour = Math.floor(nowMs / HOUR_MS);
  let start: number | undefined;
  let end: number | undefined;
  const lastHour = (hi: number, strict: boolean) => {
    const h = Math.floor(hi / HOUR_MS);
    return strict && hi % HOUR_MS === 0 ? h - 1 : h;
  };
  const up = msBounds(constraints, "server_upload_time");
  if (up.lo !== undefined) start = Math.floor(up.lo / HOUR_MS);
  if (up.hi !== undefined) end = lastHour(up.hi, up.hiStrict ?? false);
  const ev = msBounds(constraints, "event_time");
  if (ev.lo !== undefined) {
    const s = Math.floor(ev.lo / HOUR_MS) - SKEW_HOURS;
    start = start === undefined ? s : Math.max(start, s);
  }
  if (ev.hi !== undefined) {
    const e = lastHour(ev.hi, ev.hiStrict ?? false) + args.late_hours;
    end = end === undefined ? e : Math.min(end, e);
  }
  end = Math.min(end ?? nowHour, nowHour);
  if (start === undefined) start = end - Math.max(1, args.lookback_hours) + 1;
  return { startHour: start, endHour: end };
}

// ------------------------------------------------------------------ open archives

interface LiveArchive {
  path: string;
  gen: AsyncGenerator<string>;
  pos: ArchivePos;
  start: number;
  end: number;
  lastUsed: number;
}
const live = new Map<string, LiveArchive>();

async function closeLive(id: string): Promise<void> {
  const a = live.get(id);
  if (!a) return;
  live.delete(id);
  try {
    await a.gen.return(undefined);
  } catch {
    // already closed
  }
  await removeSpool(a.path);
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, a] of live) if (now - a.lastUsed > IDLE_MS) void closeLive(id);
}, 60_000);
sweeper.unref?.();

const tooLarge = (err: AmpError) =>
  err.status === 504 || (err.status === 400 && /too large|size|exceed|shorten/i.test(err.body ?? err.message));

/**
 * Download one chunk [start, end] to a spool file. Returns null when Amplitude has
 * no export files for it (404). Throws AmpError (with status) otherwise.
 */
async function downloadChunk(cfg: AmpConfig, start: number, end: number): Promise<string | null> {
  const { res, release } = await ampFetch(
    cfg,
    "/api/2/export",
    { start: hourParam(start), end: hourParam(end) },
    {
      bucket: "export",
      pass: [400, 404, 504],
      accept: "application/zip, application/octet-stream",
      timeoutMs: 30 * 60_000,
    },
  );
  try {
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new AmpError(
        `GET /api/2/export?start=${hourParam(start)}&end=${hourParam(end)} failed with HTTP ${res.status}: ${body.trim()}`,
        res.status,
        body,
      );
    }
    return await spool(res.body, ".zip");
  } finally {
    release();
  }
}

interface ExportState {
  /** Random id naming this scan's open archive in this process. */
  scanId: string;
  /** -1 until the window is resolved on the first call. */
  windowEnd: number;
  /** First hour not yet exported. */
  next: number;
  chunk: number;
  /** The chunk being read, or -1. */
  curStart: number;
  curEnd: number;
  entry: number;
  line: number;
}

/** Map one exported event (a JSON line) to a row. */
export function parseEventLine(line: string): Row | null {
  try {
    const r = JSON.parse(line) as Row;
    return r && typeof r === "object" ? r : null;
  } catch {
    log.warn("amplitude export: skipping a line that is not JSON");
    return null;
  }
}

/** Revenue of an exported event: `revenue`, else `$revenue`, else `$price × $quantity`. */
export function revenueOf(r: Row): number | null {
  const ep = (r.event_properties ?? {}) as Row;
  const direct = asNum(r.revenue) ?? asNum(ep.$revenue) ?? asNum(r.$revenue);
  if (direct !== null) return direct;
  const price = asNum(ep.$price ?? r.price);
  if (price === null) return null;
  return price * (asNum(ep.$quantity ?? r.quantity) ?? 1);
}

/** Amplitude's session id is the session start in epoch ms; -1 means "no session". */
export const sessionId = (r: Row): number | null => {
  const n = asNum(r.session_id);
  return n === null || n < 0 ? null : n;
};

export interface ExportSpec {
  name: string;
  description: string;
  title: string;
  keywords: string;
  docLlm: string;
  docMd: string;
  pushdown: string;
  columns: Col[];
  examples: FnExample[];
  category?: Category;
  /** Named tuning arguments (the main.events function) or fixed defaults (catalog tables). */
  withArgs: boolean;
}

const ARG_DOCS: Record<keyof ExportArgs, string> = {
  lookback_hours:
    "Hours to read back from now when the query has no lower bound on event_time or server_upload_time (named, default 24).",
  late_hours:
    "How long after an event's time its upload may arrive: an event_time upper bound reads uploads up to this many hours later (named, default 24; 0 = only events uploaded within the same hour).",
  chunk_hours:
    "Upload hours per Export API request (named, default 24, max 8760). A chunk that exceeds Amplitude's size limit is halved automatically.",
};

export function defineExportScan(spec: ExportSpec, fnName: string): VgiFunction {
  const outSchema = schemaOf(spec.columns);
  const args: Record<string, VgiDataType> = spec.withArgs
    ? { lookback_hours: int32, late_hours: int32, chunk_hours: int32 }
    : {};
  return defineTableFunction<Partial<ExportArgs>, ExportState>({
    name: fnName,
    description: spec.description,
    args,
    argDocs: spec.withArgs ? ARG_DOCS : {},
    argDefaults: spec.withArgs ? { ...DEFAULT_EXPORT_ARGS } : {},
    argConstraints: spec.withArgs
      ? {
          lookback_hours: { ge: 1, le: 24 * 366 * 5 },
          late_hours: { ge: 0, le: 24 * 365 },
          chunk_hours: { ge: 1, le: MAX_CHUNK_HOURS },
        }
      : undefined,
    filterPushdown: true,
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({
      scanId: crypto.randomUUID(),
      windowEnd: -1,
      next: 0,
      chunk: 0,
      curStart: -1,
      curEnd: -1,
      entry: 0,
      line: 0,
    }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      if (state.windowEnd < 0) {
        const a: ExportArgs = {
          lookback_hours: Number(params.args.lookback_hours ?? DEFAULT_EXPORT_ARGS.lookback_hours),
          late_hours: Number(params.args.late_hours ?? DEFAULT_EXPORT_ARGS.late_hours),
          chunk_hours: Number(params.args.chunk_hours ?? DEFAULT_EXPORT_ARGS.chunk_hours),
        };
        const w = exportWindow(constraintsOf(params.pushdownFilters), a, Date.now());
        log.debug(
          `${fnName}: pushed ${formatPushedFilters(params.pushdownFilters)} → upload hours ${hourParam(w.startHour)}..${hourParam(w.endHour)}`,
        );
        state.next = w.startHour;
        state.windowEnd = w.endHour;
        state.chunk = Math.min(MAX_CHUNK_HOURS, Math.max(1, a.chunk_hours));
      }
      for (;;) {
        if (state.curStart < 0) {
          if (state.next > state.windowEnd) {
            await closeLive(state.scanId);
            out.finish();
            return;
          }
          state.curStart = state.next;
          state.curEnd = Math.min(state.next + state.chunk - 1, state.windowEnd);
          state.entry = 0;
          state.line = 0;
        }
        let a = live.get(state.scanId);
        if (
          a &&
          (a.start !== state.curStart ||
            a.end !== state.curEnd ||
            a.pos.entry !== state.entry ||
            a.pos.line !== state.line)
        ) {
          await closeLive(state.scanId);
          a = undefined;
        }
        if (!a) {
          let path: string | null;
          try {
            path = await downloadChunk(cfg, state.curStart, state.curEnd);
          } catch (err) {
            if (err instanceof AmpError && tooLarge(err) && state.curEnd > state.curStart) {
              state.chunk = Math.max(1, Math.floor((state.curEnd - state.curStart + 1) / 2));
              state.curEnd = state.curStart + state.chunk - 1;
              log.info(`${fnName}: export too large; retrying with ${state.chunk}-hour chunks`);
              continue;
            }
            if (err instanceof AmpError && tooLarge(err)) {
              throw new AmpError(
                `${err.message} — a single upload hour exceeds the Export API's size limit; use Amplitude's S3 export for this volume`,
                err.status,
              );
            }
            throw err;
          }
          if (path === null) {
            state.next = state.curEnd + 1;
            state.curStart = -1;
            continue;
          }
          const pos: ArchivePos = { entry: state.entry, line: state.line };
          a = {
            path,
            pos,
            gen: archiveLines(path, { entry: state.entry, line: state.line }, pos),
            start: state.curStart,
            end: state.curEnd,
            lastUsed: Date.now(),
          };
          live.set(state.scanId, a);
        }
        a.lastUsed = Date.now();
        const rows: Row[] = [];
        let done = false;
        while (rows.length < BATCH_ROWS) {
          const n = await a.gen.next();
          if (n.done) {
            done = true;
            break;
          }
          const r = parseEventLine(n.value);
          if (r) rows.push(r);
        }
        state.entry = a.pos.entry;
        state.line = a.pos.line;
        if (done) {
          await closeLive(state.scanId);
          state.next = state.curEnd + 1;
          state.curStart = -1;
        }
        if (rows.length === 0) continue;
        out.emit(batchOf(spec.columns, rows, params.outputSchema));
        return;
      }
    },
    tags: tagsOf({ ...spec, category: spec.category ?? "events" }),
    examples: spec.examples,
  });
}

export function defineExportTable(spec: ExportSpec, schemaPath: string[]): TableDescriptor {
  const fn = defineExportScan({ ...spec, withArgs: false }, `${schemaPath.join("_")}_${spec.name}_scan`);
  return catalogTable({ ...spec, category: spec.category ?? "events" }, fn, schemaPath, []);
}

// ------------------------------------------------------------------ the columns

const ep = (r: Row) => r.event_properties;

/** Every documented Export API field, typed. */
export const NATIVE_EVENT_COLUMNS: Col[] = [
  C.str("uuid", "Amplitude's unique id for the event.", "uuid"),
  C.str("event_type", "Event type (name), e.g. 'Purchase'.", "event_type"),
  C.time("event_time", "When the event happened (UTC, client time corrected by Amplitude).", "event_time"),
  C.time(
    "server_upload_time",
    "When Amplitude received the upload; the Export API's hour range filters on this.",
    "server_upload_time",
  ),
  C.time("server_received_time", "When the Amplitude server received the event.", "server_received_time"),
  C.time("client_event_time", "Event time as reported by the client clock.", "client_event_time"),
  C.time("client_upload_time", "Upload time as reported by the client clock.", "client_upload_time"),
  C.time("processed_time", "When Amplitude finished processing the event.", "processed_time"),
  C.time(
    "user_creation_time",
    "When Amplitude first saw this user (NULL for legacy or unmerged users).",
    "user_creation_time",
  ),
  C.str("user_id", "Your user id (NULL for anonymous users).", "user_id"),
  C.str("device_id", "Device id.", "device_id"),
  C.big("amplitude_id", "Amplitude's internal user id (canonical across merged devices).", "amplitude_id"),
  C.big("event_id", "Per-device event counter.", "event_id"),
  C.big(
    "session_id",
    "Session id: the session start time in epoch ms (NULL when the event has no session).",
    sessionId,
  ),
  C.str("insert_id", "Client-supplied deduplication id ($insert_id).", "$insert_id"),
  C.big("app", "Amplitude project (app) id.", "app"),
  C.str("platform", "Platform, e.g. 'iOS', 'Android', 'Web'.", "platform"),
  C.str("os_name", "Operating system name.", "os_name"),
  C.str("os_version", "Operating system version.", "os_version"),
  C.str("device_brand", "Device brand.", "device_brand"),
  C.str("device_manufacturer", "Device manufacturer.", "device_manufacturer"),
  C.str("device_model", "Device model.", "device_model"),
  C.str("device_family", "Device family, e.g. 'iPhone'.", "device_family"),
  C.str("device_type", "Device type, e.g. 'Apple iPhone'.", "device_type"),
  C.str("device_carrier", "Mobile carrier.", "device_carrier"),
  C.str("country", "Country (from IP geolocation).", "country"),
  C.str("region", "Region or state.", "region"),
  C.str("city", "City.", "city"),
  C.str("dma", "Designated market area.", "dma"),
  C.str("language", "Device language.", "language"),
  C.str("ip_address", "Client IP address.", "ip_address"),
  C.num("location_lat", "Latitude.", "location_lat"),
  C.num("location_lng", "Longitude.", "location_lng"),
  C.str("version_name", "App version.", "version_name"),
  C.str("start_version", "App version the user first used.", "start_version"),
  C.str("library", "SDK that sent the event, e.g. 'amplitude-ts/2.0.0'.", "library"),
  C.bool("paying", "Whether the user has ever made a revenue event.", "paying"),
  C.num("revenue", "Revenue of the event: revenue / $revenue, else $price × $quantity.", revenueOf),
  C.json("event_properties", "Event properties (JSON object).", "event_properties"),
  C.json("user_properties", "User properties at the time of the event (JSON object).", "user_properties"),
  C.json("group_properties", "Group properties (JSON object).", "group_properties"),
  C.json("groups", "Groups the user belongs to (JSON object of group type → names).", "groups"),
  C.json("data", "Amplitude-internal event data (JSON object).", "data"),
  C.str(
    "amplitude_event_type",
    "Amplitude's internal event type for system events (e.g. merges).",
    "amplitude_event_type",
  ),
  C.str("amplitude_attribution_ids", "Attribution ids.", "amplitude_attribution_ids"),
  C.str("adid", "Google advertising id.", "adid"),
  C.str("idfa", "Apple identifier for advertisers.", "idfa"),
  C.num("sample_rate", "Sampling rate (NULL when unsampled).", "sample_rate"),
];

/** The shared product-analytics vocabulary (see README, "Shared product-analytics vocabulary"). */
export const UNIFIED_EVENT_COLUMNS: Col[] = [
  C.lit("tool", "The analytics tool the row came from: 'amplitude'.", "amplitude"),
  C.str("event_id", "The tool's unique event id (Amplitude uuid).", "uuid"),
  C.str("event_name", "Event name (Amplitude event_type).", (r) => r.event_type ?? r.amplitude_event_type ?? "", false),
  C.time("event_time", "When the event happened (UTC).", (r) => r.event_time ?? r.server_upload_time, false),
  C.time("received_time", "When the tool received the event (Amplitude server_upload_time).", "server_upload_time"),
  C.str("user_id", "Your user id (NULL for anonymous users).", "user_id"),
  C.str("device_id", "Device / anonymous id.", "device_id"),
  C.str("distinct_id", "The id the tool resolves people by (Amplitude amplitude_id, as text).", (r) =>
    r.amplitude_id == null ? null : String(r.amplitude_id),
  ),
  C.str("session_id", "Session id as text (Amplitude: session start epoch ms).", (r) => {
    const s = sessionId(r);
    return s === null ? null : String(s);
  }),
  C.str("insert_id", "Client deduplication id.", "$insert_id"),
  C.json("properties", "Event properties (JSON object).", ep),
  C.json("user_properties", "User properties at event time (JSON object).", "user_properties"),
  C.str("platform", "Platform, e.g. 'iOS', 'Web'.", "platform"),
  C.str("os", "Operating system name.", "os_name"),
  C.str("country", "Country.", "country"),
  C.str("city", "City.", "city"),
  C.str("app_version", "App version.", "version_name"),
  C.str("library", "SDK that sent the event.", "library"),
  C.num("revenue", "Revenue attached to the event, in the project's currency.", revenueOf),
];
