/**
 * `cohort_members(cohort_id)`: download a behavioral cohort's members through
 * Amplitude's asynchronous cohort export.
 *
 * Calling the function is the opt-in: each call starts one export job, which counts
 * against Amplitude's quota (500 cohort downloads a month on Growth/Enterprise, 60
 * per 10 minutes per project) and is limited to cohorts of at most 2 million users.
 *
 * 1. `GET /api/5/cohorts/request/{id}?props=0|1&propKeys=…` → `request_id` (202).
 * 2. `GET /api/5/cohorts/request-status/{request_id}` until `JOB COMPLETED`, polling
 *    every `poll_seconds` up to `max_wait_seconds`.
 * 3. `GET /api/5/cohorts/request/{request_id}/file` → the file, or a 302 to a
 *    pre-signed S3 link valid one minute (followed at once, without the API keys).
 *
 * The file is spooled to disk and parsed incrementally (CSV with a header row, or
 * JSON Lines), one batch per call. The state keeps the request id and the rows
 * consumed, so a resumed scan on another process downloads the same file again
 * (links stay valid for seven days) without starting a second export job.
 */

import { createReadStream } from "node:fs";
import { bool, defineTableFunction, formatPushedFilters, int32, list, utf8, type VgiFunction } from "@query-farm/vgi";
import { log } from "../log.ts";
import { type AmpConfig, AmpError, ampFetch, ampGet, configFromSecrets, SECRET_TYPE } from "./client.ts";
import { asBig, batchOf, C, type Row, schemaOf, tagsOf } from "./table.ts";
import { lines, removeSpool, spool } from "./zip.ts";

const BATCH = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split one CSV record (RFC 4180 quoting within a line). */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Normalise a header cell: trim, drop BOM/tabs and surrounding quotes. */
const headerName = (h: string) => h.replace(/^﻿/, "").trim().replace(/^\t+/, "");

/** Turn one member record into a row: amplitude_id, user_id, and every other field as properties. */
export function memberRow(rec: Record<string, unknown>): Row {
  const props: Record<string, unknown> = {};
  let amplitudeId: unknown = null;
  let userId: unknown = null;
  for (const [k, v] of Object.entries(rec)) {
    const key = k.toLowerCase();
    if (key === "amplitude_id" || key === "amplitudeid") amplitudeId = v;
    else if (key === "user_id" || key === "userid") userId = v;
    else if (v !== "" && v != null) props[k] = v;
  }
  return { amplitude_id: amplitudeId, user_id: userId === "" ? null : userId, properties: props };
}

interface LiveFile {
  path: string;
  gen: AsyncGenerator<Row>;
  consumed: number;
  lastUsed: number;
}
const live = new Map<string, LiveFile>();

async function closeLive(id: string) {
  const f = live.get(id);
  if (!f) return;
  live.delete(id);
  try {
    await f.gen.return(undefined);
  } catch {
    // closed
  }
  await removeSpool(f.path);
}
setInterval(() => {
  for (const [id, f] of live) if (Date.now() - f.lastUsed > 10 * 60_000) void closeLive(id);
}, 60_000).unref?.();

/** Parse a spooled member file (CSV with header, or JSON Lines / a JSON array). */
export async function* memberRecords(path: string): AsyncGenerator<Row> {
  let header: string[] | null = null;
  let json: boolean | null = null;
  for await (const line of lines(createReadStream(path))) {
    if (json === null) {
      const t = line.trimStart();
      if (t.startsWith("[")) {
        // A JSON array: read it whole (documented fallback; Amplitude serves CSV).
        const text = await Bun.file(path).text();
        const arr = JSON.parse(text) as unknown;
        const items = Array.isArray(arr) ? arr : [];
        for (const it of items) yield memberRow(it as Record<string, unknown>);
        return;
      }
      json = t.startsWith("{");
    }
    if (json) {
      yield memberRow(JSON.parse(line) as Record<string, unknown>);
      continue;
    }
    const fields = csvFields(line);
    if (!header) {
      header = fields.map(headerName);
      continue;
    }
    const rec: Record<string, unknown> = {};
    header.forEach((h, i) => {
      rec[h] = fields[i] ?? "";
    });
    yield memberRow(rec);
  }
}

interface Args {
  cohort_id: string;
  include_properties: boolean;
  property_keys: string[] | null;
  max_wait_seconds: number;
  poll_seconds: number;
}

interface State {
  scanId: string;
  requestId: string;
  consumed: number;
  done: boolean;
}

async function requestExport(cfg: AmpConfig, args: Args): Promise<string> {
  const keys = Array.isArray(args.property_keys) ? args.property_keys.filter(Boolean) : [];
  const body = (await ampGet(
    cfg,
    `/api/5/cohorts/request/${encodeURIComponent(args.cohort_id)}`,
    { props: args.include_properties || keys.length ? "1" : "0", propKeys: keys.length ? keys : undefined },
    "dashboard",
  )) as Row | null;
  const id = body?.request_id;
  if (typeof id !== "string" || !id) throw new AmpError("cohort export: Amplitude returned no request_id");
  return id;
}

async function waitForExport(cfg: AmpConfig, requestId: string, args: Args): Promise<void> {
  const deadline = Date.now() + Number(args.max_wait_seconds) * 1000;
  for (;;) {
    const s = (await ampGet(
      cfg,
      `/api/5/cohorts/request-status/${encodeURIComponent(requestId)}`,
      undefined,
      "dashboard",
    )) as Row | null;
    const status = String(s?.async_status ?? "");
    if (/COMPLETED/i.test(status)) return;
    if (/FAIL|ERROR|CANCEL/i.test(status)) throw new AmpError(`cohort export ${requestId} failed: ${status}`);
    if (Date.now() >= deadline) {
      throw new AmpError(
        `cohort export ${requestId} still '${status}' after ${args.max_wait_seconds} s; raise max_wait_seconds`,
      );
    }
    await sleep(Number(args.poll_seconds) * 1000);
  }
}

async function downloadFile(cfg: AmpConfig, requestId: string): Promise<string> {
  const { res, release } = await ampFetch(
    cfg,
    `/api/5/cohorts/request/${encodeURIComponent(requestId)}/file`,
    undefined,
    { bucket: "dashboard", followForeignRedirect: true, accept: "*/*", timeoutMs: 30 * 60_000 },
  );
  try {
    return await spool(res.body, ".members");
  } finally {
    release();
  }
}

const COLUMNS = [
  C.str("cohort_id", "The cohort read.", (r) => r.__ctx?.cohort_id, false),
  C.big("amplitude_id", "Member's Amplitude id.", (r) => asBig(r.amplitude_id)),
  C.str("user_id", "Member's user id (NULL for anonymous users).", "user_id"),
  C.json("properties", "Requested user properties (JSON object; empty unless include_properties).", "properties"),
];

export const cohortMembers: VgiFunction = defineTableFunction<Args, State>({
  name: "cohort_members",
  description: "Download a behavioral cohort's members (async export job; optional user properties)",
  args: {
    cohort_id: utf8(),
    include_properties: bool,
    property_keys: list(utf8()),
    max_wait_seconds: int32,
    poll_seconds: int32,
  },
  argDocs: {
    cohort_id: "Cohort id from amplitude.main.cohorts (positional).",
    include_properties: "Include user properties in `properties` (named; default false; slower).",
    property_keys: "User property names to include (named); setting it implies include_properties.",
    max_wait_seconds: "How long to wait for Amplitude to prepare the export (named; default 600).",
    poll_seconds: "Seconds between status polls (named; default 5).",
  },
  argDefaults: { include_properties: false, property_keys: null, max_wait_seconds: 600, poll_seconds: 5 },
  argConstraints: { max_wait_seconds: { ge: 1, le: 7200 }, poll_seconds: { ge: 1, le: 300 } },
  filterPushdown: true,
  autoApplyFilters: true,
  onBind: (params) =>
    params.resolvedSecretsProvided
      ? { outputSchema: schemaOf(COLUMNS) }
      : { outputSchema: schemaOf(COLUMNS), lookupSecretTypes: [SECRET_TYPE] },
  initialState: () => ({ scanId: crypto.randomUUID(), requestId: "", consumed: 0, done: false }),
  process: async (params, state, out) => {
    const cfg = configFromSecrets(params.secrets);
    const args = params.args;
    if (!args.cohort_id) throw new AmpError("cohort_id is required (see amplitude.main.cohorts)");
    if (!state.requestId) {
      log.debug(`cohort_members: pushed ${formatPushedFilters(params.pushdownFilters)}`);
      state.requestId = await requestExport(cfg, args);
      await waitForExport(cfg, state.requestId, args);
    }
    let f = live.get(state.scanId);
    if (f && f.consumed !== state.consumed) {
      await closeLive(state.scanId);
      f = undefined;
    }
    if (!f) {
      const path = await downloadFile(cfg, state.requestId);
      const gen = memberRecords(path);
      for (let i = 0; i < state.consumed; i++) if ((await gen.next()).done) break;
      f = { path, gen, consumed: state.consumed, lastUsed: Date.now() };
      live.set(state.scanId, f);
    }
    f.lastUsed = Date.now();
    const rows: Row[] = [];
    let done = false;
    while (rows.length < BATCH) {
      const n = await f.gen.next();
      if (n.done) {
        done = true;
        break;
      }
      rows.push({ ...n.value, __ctx: { cohort_id: args.cohort_id } });
    }
    f.consumed += rows.length;
    state.consumed = f.consumed;
    if (done) await closeLive(state.scanId);
    if (rows.length) out.emit(batchOf(COLUMNS, rows, params.outputSchema));
    if (done) out.finish();
  },
  tags: tagsOf({
    title: "Amplitude Cohort Members",
    category: "cohorts",
    keywords: "amplitude, cohort members, cohort export, audience, user list, behavioral cohort",
    docLlm:
      "Downloads the members of one behavioral cohort through Amplitude's asynchronous cohort export: " +
      "cohort_id, amplitude_id, user_id and properties (JSON of the requested user properties). Arguments: " +
      "cohort_id (from amplitude.main.cohorts) and named include_properties (default false), property_keys " +
      "(a list of user property names), max_wait_seconds (default 600) and poll_seconds (default 5). Each " +
      "call starts one export job: it counts against Amplitude's cohort download quota (500 a month on " +
      "Growth/Enterprise, 60 per 10 minutes) and works for cohorts up to 2 million users.",
    docMd: "## cohort_members\n\nMembers of one cohort via the asynchronous cohort export (request → poll → download).",
    pushdown: "none: the whole cohort is exported; WHERE clauses filter the downloaded rows.",
    columns: COLUMNS,
  }),
  examples: [
    {
      sql: "SELECT count(*) AS members FROM amplitude.main.cohort_members('abc123')",
      description: "How many users a cohort has right now",
    },
    {
      sql: "SELECT properties->>'plan' AS plan, count(*) AS users FROM amplitude.main.cohort_members('abc123', property_keys := ['plan']) GROUP BY plan ORDER BY users DESC",
      description: "Cohort members by plan",
    },
  ],
});
