// Unit tests. The SQL-level tests live in test/sql and run through DuckDB against the
// replay server in test/mock_api.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { funnelRows, longSeries, ltvRows, retentionRows, seriesLabel } from "../src/amp/analytics.ts";
import { buildUrl, configFromSecrets, normalizeBaseUrl, REGION_URLS, retryDelayMs } from "../src/amp/client.ts";
import { csvFields, memberRecords, memberRow } from "../src/amp/cohort_members.ts";
import { DEFAULT_EXPORT_ARGS, exportWindow, HOUR_MS, hourParam, revenueOf, sessionId } from "../src/amp/export.ts";
import type { Constraint } from "../src/amp/pushdown.ts";
import { annotationStart } from "../src/amp/resources.ts";
import { eventJson, parseTime, ymd } from "../src/amp/table.ts";
import { type ArchivePos, archiveLines, lines, readZipEntries } from "../src/amp/zip.ts";

const ROOT = join(import.meta.dir, "..");
const SAMPLE = join(ROOT, "test", "fixtures", "export-sample.zip");
const us = (iso: string) => BigInt(Date.parse(iso)) * 1000n;
const cmp = (column: string, op: "eq" | "gt" | "ge" | "lt" | "le", iso: string): Constraint => ({
  kind: "cmp",
  column,
  op,
  value: us(iso),
});
const hour = (iso: string) => Date.parse(iso) / HOUR_MS;
const NOW = Date.parse("2026-11-15T12:34:00Z");

// --------------------------------------------------------------------- client

test("base_url: https required except for loopback fixtures; path dropped", () => {
  expect(normalizeBaseUrl("https://analytics.eu.amplitude.com/api")).toBe("https://analytics.eu.amplitude.com");
  expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(() => normalizeBaseUrl("http://amplitude.com")).toThrow(/https/);
  expect(() => normalizeBaseUrl("not a url")).toThrow(/not a URL/);
});

test("configFromSecrets: both keys required; REGION picks the origin; BASE_URL wins", () => {
  expect(() => configFromSecrets({})).toThrow(/no amplitude secret/);
  expect(() => configFromSecrets({ s: { type: "amplitude", api_key: "k" } })).toThrow(/SECRET_KEY/);
  const base = { type: "amplitude", api_key: " k ", secret_key: "s" };
  expect(configFromSecrets({ s: base })).toEqual({ baseUrl: REGION_URLS.us as string, apiKey: "k", secretKey: "s" });
  expect(configFromSecrets({ s: { ...base, region: "EU" } }).baseUrl).toBe("https://analytics.eu.amplitude.com");
  expect(() => configFromSecrets({ s: { ...base, region: "apac" } })).toThrow(/REGION/);
  expect(configFromSecrets({ s: { ...base, region: "eu", base_url: "http://localhost:9" } }).baseUrl).toBe(
    "http://localhost:9",
  );
});

test("buildUrl: arrays repeat a parameter (funnel steps); null/empty are dropped", () => {
  const cfg = { baseUrl: "https://h", apiKey: "k", secretKey: "s" };
  expect(buildUrl(cfg, "/api/2/funnels", { e: ['{"event_type":"A"}', '{"event_type":"B"}'], g: null, s: "" })).toBe(
    "https://h/api/2/funnels?e=%7B%22event_type%22%3A%22A%22%7D&e=%7B%22event_type%22%3A%22B%22%7D",
  );
});

test("retryDelayMs: Retry-After seconds, else jittered exponential back-off, capped", () => {
  expect(retryDelayMs(new Headers({ "Retry-After": "2" }), 1)).toBe(2000);
  expect(retryDelayMs(new Headers({ "Retry-After": "9999" }), 1)).toBe(60_000);
  expect(retryDelayMs(undefined, 2, () => 0)).toBe(1000);
  expect(retryDelayMs(undefined, 2, () => 1)).toBe(2000);
  expect(retryDelayMs(undefined, 20, () => 1)).toBe(60_000);
});

// ---------------------------------------------------------------- export window

test("hourParam: the Export API's YYYYMMDDTHH in UTC", () => {
  expect(hourParam(hour("2026-11-14T05:00:00Z"))).toBe("20261114T05");
  expect(hourParam(hour("2026-01-02T00:00:00Z"))).toBe("20260102T00");
});

describe("exportWindow", () => {
  test("server_upload_time bounds map to hours exactly (strict < on an hour boundary excludes it)", () => {
    const w = exportWindow(
      [
        cmp("server_upload_time", "ge", "2026-11-14T03:00:00Z"),
        cmp("server_upload_time", "lt", "2026-11-14T04:00:00Z"),
      ],
      DEFAULT_EXPORT_ARGS,
      NOW,
    );
    expect([hourParam(w.startHour), hourParam(w.endHour)]).toEqual(["20261114T03", "20261114T03"]);
    const le = exportWindow([cmp("server_upload_time", "le", "2026-11-14T04:00:00Z")], DEFAULT_EXPORT_ARGS, NOW);
    expect(hourParam(le.endHour)).toBe("20261114T04");
  });

  test("event_time widens: one hour of skew below, late_hours above", () => {
    const cs = [cmp("event_time", "ge", "2026-11-14T00:00:00Z"), cmp("event_time", "lt", "2026-11-14T06:00:00Z")];
    const w = exportWindow(cs, { ...DEFAULT_EXPORT_ARGS, late_hours: 2 }, NOW);
    expect([hourParam(w.startHour), hourParam(w.endHour)]).toEqual(["20261113T23", "20261114T07"]);
  });

  test("both columns intersect; equality bounds both sides", () => {
    const w = exportWindow(
      [cmp("event_time", "eq", "2026-11-14T10:30:00Z"), cmp("server_upload_time", "lt", "2026-11-14T12:00:00Z")],
      DEFAULT_EXPORT_ARGS,
      NOW,
    );
    expect([hourParam(w.startHour), hourParam(w.endHour)]).toEqual(["20261114T09", "20261114T11"]);
  });

  test("no lower bound reads lookback_hours back from now; the end is clamped to now", () => {
    const w = exportWindow([], { ...DEFAULT_EXPORT_ARGS, lookback_hours: 3 }, NOW);
    expect([hourParam(w.startHour), hourParam(w.endHour)]).toEqual(["20261115T10", "20261115T12"]);
    const future = exportWindow([cmp("event_time", "ge", "2026-11-15T00:00:00Z")], DEFAULT_EXPORT_ARGS, NOW);
    expect(hourParam(future.endHour)).toBe("20261115T12");
  });

  test("the upload column name is configurable (received_time in the shared shape)", () => {
    const w = exportWindow(
      [cmp("received_time", "ge", "2026-11-14T03:00:00Z")],
      DEFAULT_EXPORT_ARGS,
      NOW,
      "received_time",
    );
    expect(hourParam(w.startHour)).toBe("20261114T03");
  });
});

// -------------------------------------------------------------------- values

test("parseTime: Amplitude's offset-less UTC formats keep microseconds; offsets are honoured", () => {
  expect(parseTime("2026-11-14 05:59:59.999999")).toBe(us("2026-11-14T05:59:59.999Z") + 999n);
  expect(parseTime("2022-02-01T04:59:58.000000")).toBe(us("2022-02-01T04:59:58Z"));
  expect(parseTime("2021-11-03 18:22:10")).toBe(us("2021-11-03T18:22:10Z"));
  expect(parseTime("2026-11-14")).toBe(us("2026-11-14T00:00:00Z"));
  expect(parseTime("2025-11-10T07:00:00+01:00")).toBe(us("2025-11-10T06:00:00Z"));
  expect(parseTime("")).toBeNull();
  expect(parseTime(null)).toBeNull();
});

test("revenueOf: revenue, then $revenue, then $price x $quantity", () => {
  expect(revenueOf({ revenue: 3 })).toBe(3);
  expect(revenueOf({ event_properties: { $revenue: "19.99" } })).toBe(19.99);
  expect(revenueOf({ event_properties: { $price: 5, $quantity: 3 } })).toBe(15);
  expect(revenueOf({ event_properties: { $price: 5 } })).toBe(5);
  expect(revenueOf({ event_properties: {} })).toBeNull();
});

test("sessionId: -1 means no session", () => {
  expect(sessionId({ session_id: -1 })).toBeNull();
  expect(sessionId({ session_id: 1794600000000 })).toBe(1794600000000);
});

test("ymd / eventJson / annotationStart argument handling", () => {
  expect(ymd(new Date("2026-11-01T00:00:00Z"), "d")).toBe("20261101");
  expect(ymd(20393, "d")).toBe("20251101");
  expect(ymd("2026-11-01", "d")).toBe("20261101");
  expect(() => ymd(undefined, "start_date")).toThrow(/start_date/);
  expect(eventJson("Purchase", "e")).toBe('{"event_type":"Purchase"}');
  expect(eventJson('{"event_type":"_active","filters":[]}', "e")).toBe('{"event_type":"_active","filters":[]}');
  expect(() => eventJson('{"x":1}', "e")).toThrow(/event_type/);
  expect(() => eventJson("{bad", "e")).toThrow(/not valid JSON/);
  expect(annotationStart(us("2026-11-01T00:00:30Z"))).toBe("2026-10-31T23:59Z");
});

// ------------------------------------------------------------------ chart shapes

test("seriesLabel: string, [index, label], numbers and objects", () => {
  expect(seriesLabel(["US"], 0)).toBe("US");
  expect(seriesLabel([[0, "US"]], 0)).toBe("US");
  expect(seriesLabel([[0, "US", "iOS"]], 0)).toBe("US; iOS");
  expect(seriesLabel([0], 0)).toBeNull();
  expect(seriesLabel([{ segmentIndex: 0 }], 0)).toBeNull();
  expect(seriesLabel(undefined, 0)).toBeNull();
});

test("longSeries: series x xValues → long rows with the collapsed total", () => {
  const rows = longSeries({
    series: [[1, 2], [3]],
    seriesLabels: [
      [0, "A"],
      [0, "B"],
    ],
    seriesCollapsed: [[{ value: 3 }], [{ value: 3 }]],
    xValues: ["d1", "d2"],
  });
  expect(rows).toEqual([
    { series_index: 0, series_label: "A", period: "d1", value: 1, series_total: 3 },
    { series_index: 0, series_label: "A", period: "d2", value: 2, series_total: 3 },
    { series_index: 1, series_label: "B", period: "d1", value: 3, series_total: 3 },
  ]);
});

test("funnelRows: one row per group and step; transition times in seconds", () => {
  const rows = funnelRows({
    data: [
      {
        events: ["A", "B"],
        cumulativeRaw: [10, 4],
        cumulative: [1, 0.4],
        stepByStep: [1, 0.4],
        medianTransTimes: [0, 1500],
        avgTransTimes: [0, 3000],
        groupValue: "US",
      },
    ],
  });
  expect(rows[1]).toEqual({
    group_index: 0,
    group_label: "US",
    step: 2,
    event_type: "B",
    users: 4,
    conversion_rate: 0.4,
    step_conversion_rate: 0.4,
    median_seconds: 1.5,
    avg_seconds: 3,
  });
});

test("retentionRows: index 0 (cohort total) is skipped; day 0 is index 1; combined has cohort NULL", () => {
  const rows = retentionRows({
    data: {
      series: [
        {
          dates: ["Aug 14"],
          values: {
            "Aug 14": [
              { count: 10, outof: 10 },
              { count: 10, outof: 10 },
              { count: 4, outof: 10, incomplete: true },
            ],
          },
          combined: [
            { count: 10, outof: 10 },
            { count: 10, outof: 10 },
          ],
        },
      ],
    },
  });
  expect(rows.map((r) => [r.cohort, r.day, r.retained, r.retention_rate, r.incomplete])).toEqual([
    ["Aug 14", 0, 10, 1, null],
    ["Aug 14", 1, 4, 0.4, true],
    [null, 0, 10, 1, null],
  ]);
});

test("ltvRows: rNd keys become day N", () => {
  const rows = ltvRows({
    data: {
      seriesLabels: [""],
      series: [{ values: { "2026-11-01": { r1d: 1, r30d: 9, count: 5, paid: 2, total_amount: 20 } } }],
    },
  });
  expect(rows.map((r) => [r.cohort_date, r.day, r.value, r.cohort_users])).toEqual([
    ["2026-11-01", 1, 1, 5n],
    ["2026-11-01", 30, 9, 5n],
  ]);
});

// ------------------------------------------------------------------------ zip

describe("zip archives", () => {
  test("the committed Export API sample: entries in name order, data descriptors, deflate + gzip", async () => {
    const entries = await readZipEntries(SAMPLE);
    expect(entries.map((e) => e.name)).toEqual([
      "187520/187520_2026-11-14_0#0.json.gz",
      "187520/187520_2026-11-14_0#1.json.gz",
      "187520/187520_2026-11-14_1#0.json.gz",
    ]);
    const pos: ArchivePos = { entry: 0, line: 0 };
    const types: string[] = [];
    for await (const l of archiveLines(SAMPLE, { entry: 0, line: 0 }, pos)) types.push(JSON.parse(l).event_type);
    expect(types).toEqual(["Sign Up", "Purchase", "Purchase", "Purchase", "Page View", "Purchase"]);
    expect(pos).toEqual({ entry: 3, line: 0 });
  });

  test("archiveLines resumes at an (entry, line) cursor without repeating rows", async () => {
    const all: string[] = [];
    for await (const l of archiveLines(SAMPLE, { entry: 0, line: 0 }, { entry: 0, line: 0 })) all.push(l);
    // Read two lines, note the cursor, then resume from it in a fresh iterator.
    const pos: ArchivePos = { entry: 0, line: 0 };
    const head: string[] = [];
    for await (const l of archiveLines(SAMPLE, { entry: 0, line: 0 }, pos)) {
      head.push(l);
      if (head.length === 2) break;
    }
    expect(pos).toEqual({ entry: 1, line: 1 });
    const tail: string[] = [];
    for await (const l of archiveLines(SAMPLE, { ...pos }, { entry: 0, line: 0 })) tail.push(l);
    expect([...head, ...tail]).toEqual(all);
  });

  test("ZIP64 end records and extra fields are read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vgi-amplitude-test-"));
    const path = join(dir, "z64.zip");
    writeFileSync(path, zip64Archive("a.json.gz", gzipSync('{"n":1}\n{"n":2}\n')));
    const entries = await readZipEntries(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("a.json.gz");
    const got: string[] = [];
    for await (const l of archiveLines(path, { entry: 0, line: 0 }, { entry: 0, line: 0 })) got.push(l);
    expect(got).toEqual(['{"n":1}', '{"n":2}']);
  });

  test("not a zip → a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vgi-amplitude-test-"));
    const path = join(dir, "x.zip");
    writeFileSync(path, "Raw data files were not found.".repeat(2));
    expect(readZipEntries(path)).rejects.toThrow(/not a ZIP/);
  });

  test("lines: CRLF, blank lines, chunk boundaries inside a multi-byte character", async () => {
    const bytes = new TextEncoder().encode('{"a":"é"}\r\n\n{"b":2}');
    const chunks = [bytes.slice(0, 7), bytes.slice(7)];
    const out: string[] = [];
    for await (const l of lines(
      (async function* () {
        yield* chunks;
      })(),
    ))
      out.push(l);
    expect(out).toEqual(['{"a":"é"}', '{"b":2}']);
  });
});

/** A one-entry ZIP64 archive: saturated sizes/offsets, ZIP64 extra, ZIP64 EOCD + locator. */
function zip64Archive(name: string, content: Buffer): Buffer {
  const data = deflateRawSync(content);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(20, 28);
  const localExtra = Buffer.alloc(20);
  localExtra.writeUInt16LE(1, 0);
  localExtra.writeUInt16LE(16, 2);
  localExtra.writeBigUInt64LE(BigInt(content.length), 4);
  localExtra.writeBigUInt64LE(BigInt(data.length), 12);
  const localPart = Buffer.concat([local, nameBuf, localExtra, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(28, 30);
  central.writeUInt32LE(0xffffffff, 42);
  const cExtra = Buffer.alloc(28);
  cExtra.writeUInt16LE(1, 0);
  cExtra.writeUInt16LE(24, 2);
  cExtra.writeBigUInt64LE(BigInt(content.length), 4);
  cExtra.writeBigUInt64LE(BigInt(data.length), 12);
  cExtra.writeBigUInt64LE(0n, 20);
  const cd = Buffer.concat([central, nameBuf, cExtra]);
  const cdOffset = localPart.length;

  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(44n, 4);
  z64.writeUInt16LE(45, 12);
  z64.writeUInt16LE(45, 14);
  z64.writeBigUInt64LE(1n, 24);
  z64.writeBigUInt64LE(1n, 32);
  z64.writeBigUInt64LE(BigInt(cd.length), 40);
  z64.writeBigUInt64LE(BigInt(cdOffset), 48);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
  loc.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([localPart, cd, z64, loc, eocd]);
}

// -------------------------------------------------------------- cohort files

test("csvFields: quoted fields, escaped quotes, empty values", () => {
  expect(csvFields('"12345","user, 42","say ""hi""",')).toEqual(["12345", "user, 42", 'say "hi"', ""]);
});

test("memberRow: amplitude_id / user_id columns; other non-empty fields become properties", () => {
  expect(memberRow({ amplitude_id: "1", user_id: "", "gp:plan": "pro", country: "" })).toEqual({
    amplitude_id: "1",
    user_id: null,
    properties: { "gp:plan": "pro" },
  });
});

test("memberRecords: CSV with a header, and JSON Lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vgi-amplitude-test-"));
  const csv = join(dir, "m.csv");
  writeFileSync(csv, '﻿"amplitude_id","user_id","gp:plan"\n"1","u1","pro"\n"2","",""\n');
  const rows = [];
  for await (const r of memberRecords(csv)) rows.push(r);
  expect(rows).toEqual([
    { amplitude_id: "1", user_id: "u1", properties: { "gp:plan": "pro" } },
    { amplitude_id: "2", user_id: null, properties: {} },
  ]);
  const jl = join(dir, "m.jsonl");
  writeFileSync(jl, '{"amplitude_id":3,"user_id":"u3"}\n');
  const j = [];
  for await (const r of memberRecords(jl)) j.push(r);
  expect(j).toEqual([{ amplitude_id: 3, user_id: "u3", properties: {} }]);
});

// ----------------------------------------------------------------- the worker

describe("worker over stdio", () => {
  let client: VgiClient;
  beforeAll(() => {
    client = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
  });
  afterAll(() => client?.close());

  // Fixture-backed results are covered end to end through DuckDB in test/sql (all
  // transports); here the worker must fail clearly when no amplitude secret is attached.
  test("a scan without an amplitude secret explains how to create one", async () => {
    const run = async () => {
      for await (const _ of client.tableFunctionRows({
        functionName: "cohort_members",
        arguments: new Arguments(["coh"], new Map()),
        int64: "bigint",
      })) {
        // no rows expected
      }
    };
    expect(run()).rejects.toThrow(/no amplitude secret/);
  });
});
