#!/usr/bin/env python3
"""A strict, offline Amplitude API replay server for the tests (stdlib only).

It serves the fictional project in ``test/fixtures/build_fixture.py`` with Amplitude's
documented response shapes and behaves like Amplitude where the worker depends on it:

* **Auth.** HTTP Basic ``test-api-key:test-secret-key``. No header → 401, wrong keys → 403.
* **Strict parameters.** Each route accepts only its documented query parameters; an
  unknown parameter, a malformed date (``YYYYMMDD`` / ``YYYYMMDDTHH``), an unknown metric,
  interval, mode, or invalid event JSON is a 400.
* **Export API** ``/api/2/export?start=YYYYMMDDTHH&end=YYYYMMDDTHH`` (inclusive hours):
  a real ZIP of gzip JSON Lines files for the upload hours in range; 404 when the range has
  no files; ranges over **12 hours** answer 400 "Raw data files were too large" (the mock's
  stand-in for the 6 GB limit, so the worker's chunk halving runs); over 365 days → 400. The
  first export request answers 429 with ``Retry-After: 1``.
* **Dashboard REST API**: segmentation (grouped by ``g``), funnels, retention, users,
  sessions (length / average / per user), composition, realtime, revenue LTV, events list,
  user search, user activity (``offset``/``limit`` ≤ 1000 paging). The first segmentation
  request answers 429.
* **Taxonomy API**, **Behavioral Cohorts API** (list; request → status ``JOB INPROGRESS``
  once, then ``JOB COMPLETED`` → file: a 302 to a pre-signed link on ANOTHER origin
  (``localhost`` instead of ``127.0.0.1``) that rejects requests carrying credentials) and
  **chart annotations** (``category`` and ``chart_id`` are mutually exclusive).
* **Introspection.** ``GET /__requests?path=/api/2/export`` returns every recorded request to
  that path (``seq``, ``path``, ``query`` as a JSON object string, ``auth`` ok/missing/bad),
  so SQL tests can assert exactly what was pushed down.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "fixtures"))
import build_fixture as fx  # noqa: E402

API_KEY, SECRET_KEY = "test-api-key", "test-secret-key"
EXPORT_FILES = fx.export_files()
MEMBERS = fx.cohort_members()
ACTIVITY = fx.user_activity_events()
MAX_EXPORT_HOURS = 12

LOG: list[dict] = []
LOCK = threading.Lock()
ONCE: set[str] = set()
JOBS: dict[str, dict] = {}
PORT = [0]


class ApiError(Exception):
    def __init__(self, status: int, body: object, headers: dict | None = None):
        super().__init__(str(body))
        self.status, self.body, self.headers = status, body, headers or {}


def bad(msg: str) -> ApiError:
    return ApiError(400, {"error": msg})


def first_time(key: str) -> bool:
    with LOCK:
        if key in ONCE:
            return False
        ONCE.add(key)
        return True


def allow(q: dict, allowed: set[str], required: set[str] = frozenset()) -> None:
    unknown = set(q) - allowed
    if unknown:
        raise bad(f"unknown parameter(s): {sorted(unknown)}")
    missing = required - set(q)
    if missing:
        raise bad(f"missing parameter(s): {sorted(missing)}")


def one(q: dict, k: str) -> str | None:
    v = q.get(k)
    if v is None:
        return None
    if len(v) != 1:
        raise bad(f"parameter {k} given more than once")
    return v[0]


def ymd(q: dict, k: str) -> dt.date:
    v = one(q, k) or ""
    if not re.fullmatch(r"\d{8}", v):
        raise bad(f"{k} must be YYYYMMDD")
    return dt.datetime.strptime(v, "%Y%m%d").date()


def date_range(q: dict) -> list[str]:
    s, e = ymd(q, "start"), ymd(q, "end")
    if e < s:
        raise bad("end before start")
    return [(s + dt.timedelta(days=i)).isoformat() for i in range((e - s).days + 1)]


def event_json(raw: str, k: str) -> dict:
    try:
        e = json.loads(raw)
    except ValueError:
        raise bad(f"{k} is not JSON") from None
    if not isinstance(e, dict) or not isinstance(e.get("event_type"), str):
        raise bad(f"{k} needs event_type")
    return e


def choice(q: dict, k: str, allowed: set[str]) -> str | None:
    v = one(q, k)
    if v is not None and v not in allowed:
        raise bad(f"{k} must be one of {sorted(allowed)}")
    return v


def json_param(q: dict, k: str) -> object:
    v = one(q, k)
    if v is None:
        return None
    try:
        return json.loads(v)
    except ValueError:
        raise bad(f"{k} is not JSON") from None


# ------------------------------------------------------------------- export


def r_export(q: dict) -> tuple[int, bytes, dict]:
    allow(q, {"start", "end"}, {"start", "end"})
    hours = []
    for k in ("start", "end"):
        v = one(q, k) or ""
        if not re.fullmatch(r"\d{8}T\d{1,2}", v):
            raise bad(f"{k} must be YYYYMMDDTHH")
        hours.append(dt.datetime.strptime(v[:8], "%Y%m%d") + dt.timedelta(hours=int(v[9:])))
    start, end = hours
    if end < start:
        raise bad("end before start")
    n = int((end - start).total_seconds() // 3600) + 1
    if n > 365 * 24:
        raise bad("Date range exceeds 365 days")
    if first_time("export-429"):
        raise ApiError(429, {"error": "Too many concurrent requests (concurrent limit)"}, {"Retry-After": "1"})
    if n > MAX_EXPORT_HOURS:
        raise ApiError(400, "Raw data files were too large. Please shorten the time range of the export.")
    files = []
    for i in range(n):
        files += EXPORT_FILES.get((start + dt.timedelta(hours=i)).strftime("%Y%m%dT%H"), [])
    if not files:
        raise ApiError(404, "Raw data files were not found.")
    return 200, fx.build_export_zip(files), {"Content-Type": "application/zip"}


# --------------------------------------------------------------- dashboard

INTERVALS = {"-300000", "-3600000", "1", "7", "30"}
SEG_METRICS = {"uniques", "totals", "pct_dau", "average", "histogram", "sums", "value_avg", "formula"}
COUNTRY_SPLIT = {"United States": 3, "Germany": 2}


def r_segmentation(q: dict) -> dict:
    allow(q, {"e", "e2", "start", "end", "m", "n", "i", "s", "g", "limit", "formula", "rollingWindow", "rollingAverage"}, {"e", "start", "end"})
    e = event_json(one(q, "e") or "", "e")
    if "e2" in q:
        event_json(one(q, "e2") or "", "e2")
    days = date_range(q)
    m = choice(q, "m", SEG_METRICS) or "uniques"
    if m == "formula" and "formula" not in q:
        raise bad("formula required")
    choice(q, "i", INTERVALS)
    choice(q, "n", {"any", "active"})
    json_param(q, "s")
    if first_time("seg-429"):
        raise ApiError(429, {"error": "Exceeded rate limit (cost)"}, {"Retry-After": "1"})
    base = 10 if m == "uniques" else 25
    if e["event_type"] != "Purchase":
        base = 100
    g = q.get("g", [])
    if len(g) > 2:
        raise bad("at most two group-bys")
    if g:
        labels = list(COUNTRY_SPLIT)
        series = [[COUNTRY_SPLIT[c] * (i + 1) for i in range(len(days))] for c in labels]
        return {"data": {"series": series, "seriesLabels": [[0, c] for c in labels], "seriesCollapsed": [[{"setId": "", "value": sum(s)}] for s in series], "xValues": days}}
    series = [[base + i for i in range(len(days))]]
    return {"data": {"series": series, "seriesLabels": [0], "seriesCollapsed": [[{"setId": "", "value": sum(series[0])}]], "xValues": days}}


def r_funnels(q: dict) -> dict:
    allow(q, {"e", "start", "end", "mode", "n", "i", "s", "g", "cs", "limit"}, {"e", "start", "end"})
    steps = [event_json(x, "e")["event_type"] for x in q["e"]]
    date_range(q)
    choice(q, "mode", {"ordered", "unordered", "sequential"})
    choice(q, "n", {"active", "new"})
    choice(q, "i", INTERVALS)
    raw = [1000 // (2**i) for i in range(len(steps))]
    item = {
        "meta": {"segmentIndex": 0},
        "stepByStep": [1.0] + [raw[i] / raw[i - 1] for i in range(1, len(raw))],
        "medianTransTimes": [0] + [60000 * i for i in range(1, len(raw))],
        "avgTransTimes": [0] + [90000 * i for i in range(1, len(raw))],
        "cumulative": [r / raw[0] for r in raw],
        "cumulativeRaw": raw,
        "events": steps,
    }
    return {"data": [item]}


def r_retention(q: dict) -> dict:
    allow(q, {"se", "re", "start", "end", "rm", "rb", "i", "s", "g"}, {"se", "re", "start", "end"})
    event_json(one(q, "se") or "", "se")
    event_json(one(q, "re") or "", "re")
    days = date_range(q)
    rm = choice(q, "rm", {"nday", "rolling", "bracket", "nday_or_before"})
    if rm == "bracket" and "rb" not in q:
        raise bad("rb required for bracket")
    choice(q, "i", {"1", "7", "30"})
    values = {}
    for k, d in enumerate(days[:2]):
        size = 100 + 10 * k
        values[d] = [{"count": size, "outof": size, "incomplete": False}, {"count": size, "outof": size, "incomplete": False}, {"count": size // 2, "outof": size, "incomplete": False}, {"count": size // 4, "outof": size, "incomplete": True}]
    combined = [{"count": 210, "outof": 210, "retainedSetId": None, "incomplete": False}, {"count": 210, "outof": 210, "retainedSetId": None, "incomplete": False}, {"count": 105, "outof": 210, "retainedSetId": None, "incomplete": False}, {"count": 25, "outof": 100, "retainedSetId": None, "incomplete": True}]
    return {"data": {"series": [{"dates": list(reversed(days[:2])), "values": values, "combined": combined}], "seriesMeta": [{"segmentIndex": 0, "eventIndex": 0}]}}


def r_users(q: dict) -> dict:
    allow(q, {"start", "end", "m", "i", "s", "g"}, {"start", "end"})
    days = date_range(q)
    m = choice(q, "m", {"active", "new"}) or "active"
    choice(q, "i", {"1", "7", "30"})
    base = 500 if m == "active" else 50
    if "g" in q:
        return {"data": {"series": [[base + i for i in range(len(days))], [base // 2 + i for i in range(len(days))]], "seriesMeta": ["United States", "Germany"], "xValues": days}}
    return {"data": {"series": [[base + i for i in range(len(days))]], "seriesMeta": ["Any Active"], "xValues": days}}


def r_sessions_length(q: dict) -> dict:
    allow(q, {"start", "end", "timeHistogramConfigBinTimeUnit", "timeHistogramConfigBinMin", "timeHistogramConfigBinMax", "timeHistogramConfigBinSize"}, {"start", "end"})
    date_range(q)
    choice(q, "timeHistogramConfigBinTimeUnit", {"seconds", "minutes", "hours", "days"})
    return {"data": {"series": [[0, 120, 45, 7]], "xValues": ["0s-60s", "60s-120s", "120s-180s", "180s-240s"]}}


def r_sessions_avg(q: dict) -> dict:
    allow(q, {"start", "end"}, {"start", "end"})
    days = date_range(q)
    return {"data": {"series": [[600.0 + 60 * i for i in range(len(days))]], "seriesMeta": [{"segmentIndex": 0}], "xValues": days}}


def r_sessions_peruser(q: dict) -> dict:
    allow(q, {"start", "end"}, {"start", "end"})
    days = date_range(q)
    return {"data": {"series": [[2.5 + i for i in range(len(days))]], "seriesMeta": [{"segmentIndex": 0}], "xValues": days}}


def r_composition(q: dict) -> dict:
    allow(q, {"start", "end", "p"}, {"start", "end", "p"})
    date_range(q)
    p = one(q, "p")
    if p == "platform":
        return {"data": {"series": [[700, 250, 50]], "seriesLabels": ["platform"], "xValues": ["Web", "iOS", "(none)"]}}
    return {"data": {"series": [[10]], "seriesLabels": [p], "xValues": ["(none)"]}}


def r_realtime(q: dict) -> dict:
    allow(q, {"i"})
    choice(q, "i", {"5"})
    return {"data": {"xValues": ["15:00", "15:05", "15:10"], "seriesLabels": ["Today", "Yesterday"], "series": [[123, 144, 101], [139, 111, 180]]}}


def r_ltv(q: dict) -> dict:
    allow(q, {"start", "end", "m", "i", "s", "g"}, {"start", "end"})
    days = date_range(q)
    choice(q, "m", {"0", "1", "2", "3"})
    choice(q, "i", {"1", "7", "30"})
    values = {d: {"r1d": 1.5, "r7d": 4.0, "r30d": 9.5 + k, "count": 100, "paid": 12, "total_amount": 950.0} for k, d in enumerate(days)}
    return {"data": {"seriesLabels": [""], "series": [{"dates": list(reversed(days)), "values": values}]}}


def r_events_list(q: dict) -> dict:
    allow(q, set())
    rows = [("Page View", 250_000), ("Purchase", 4_000), ("Sign Up", 1_200), ("Legacy Event", 0)]
    return {"data": [{"non_active": name == "Legacy Event", "value": name, "totals": n, "deleted": False, "flow_hidden": False, "hidden": name == "Legacy Event", "display": name} for name, n in rows]}


USERS = {
    "user_42": {"user_id": "user_42", "amplitude_id": 12345},
    "user_7": {"user_id": "user_7", "amplitude_id": 777},
}


def r_usersearch(q: dict) -> dict:
    allow(q, {"user"}, {"user"})
    u = one(q, "user") or ""
    matches = [m for k, m in USERS.items() if k.startswith(u) or str(m["amplitude_id"]) == u]
    return {"matches": matches, "type": "match_user_or_device_id"} if matches else {"type": "nomatch", "matches": []}


def r_useractivity(q: dict) -> dict:
    allow(q, {"user", "offset", "limit", "direction"}, {"user"})
    uid = one(q, "user") or ""
    if not uid.isdigit():
        raise bad("user must be an Amplitude ID")
    offset = int(one(q, "offset") or 0)
    limit = int(one(q, "limit") or 1000)
    if not 1 <= limit <= 1000:
        raise bad("limit must be 1..1000")
    direction = choice(q, "direction", {"latest", "earliest"}) or "latest"
    evs = ACTIVITY if uid == "12345" else []
    if direction == "earliest":
        evs = list(reversed(evs))
    profile = {
        "12345": {"user_id": "user_42", "canonical_amplitude_id": 12345, "merged_amplitude_ids": [11111], "num_events": 2504, "num_sessions": 40, "usage_time": 2570259, "first_used": "2026-01-02", "last_used": "2026-11-14", "purchases": 3, "revenue": 49.99, "platform": "Web", "os": "Chrome 119", "version": "3.2.1", "device": "Mac", "device_type": "Mac", "carrier": None, "country": "United States", "region": "California", "city": "San Francisco", "dma": None, "language": "English", "start_version": "3.0.0", "device_ids": ["d42"], "last_location": {"lat": 37.77, "lng": -122.41}, "properties": {"plan": "pro"}},
        "777": {"user_id": "user_7", "canonical_amplitude_id": 777, "merged_amplitude_ids": [], "num_events": 2, "num_sessions": 2, "usage_time": 1000, "first_used": "2026-11-14", "last_used": "2026-11-14", "purchases": 2, "revenue": 25.0, "platform": "iOS", "os": "ios 17.1", "version": "3.2.1", "device": "Apple iPhone", "device_type": "Apple iPhone 15", "carrier": "Telekom", "country": "Germany", "region": None, "city": "Berlin", "dma": None, "language": "German", "start_version": "3.2.0", "device_ids": ["d7"], "last_location": None, "properties": {"plan": "free"}},
    }.get(uid)
    if profile is None:
        raise bad("Unknown user")
    return {"userData": profile, "events": evs[offset : offset + limit]}


# ---------------------------------------------------------------- taxonomy


def r_tax_category(q: dict) -> dict:
    allow(q, set())
    return {"success": True, "data": [{"id": 412931, "name": "Attribution"}, {"id": 412941, "name": "Conversion"}]}


TAX_EVENTS = [
    {"event_type": "Purchase", "category": {"name": "Conversion"}, "description": "A completed checkout.", "display_name": "Purchase", "is_active": True, "is_hidden_from_dropdowns": False, "is_hidden_from_persona_results": False, "is_hidden_from_pathfinder": False, "is_hidden_from_timeline": False, "tags": ["revenue"], "owner": "ana@example.com"},
    {"event_type": "Sign Up", "category": {"name": "Conversion"}, "description": None, "display_name": None, "is_active": True, "is_hidden_from_dropdowns": False, "is_hidden_from_persona_results": False, "is_hidden_from_pathfinder": False, "is_hidden_from_timeline": False, "tags": [], "owner": None},
    {"event_type": "Page View", "category": {"name": "Attribution"}, "description": "Any page view.", "display_name": None, "is_active": True, "is_hidden_from_dropdowns": False, "is_hidden_from_persona_results": False, "is_hidden_from_pathfinder": False, "is_hidden_from_timeline": False, "tags": [], "owner": None},
    {"event_type": "Planned Event", "category": {"name": "Conversion"}, "description": "Planned, not yet sent.", "display_name": None, "is_active": False, "is_hidden_from_dropdowns": False, "is_hidden_from_persona_results": False, "is_hidden_from_pathfinder": False, "is_hidden_from_timeline": False, "tags": [], "owner": None},
]
DELETED_EVENT = {**TAX_EVENTS[1], "event_type": "Old Checkout", "deleted": True, "is_active": False, "description": None}


def r_tax_event(q: dict) -> dict:
    allow(q, {"showDeleted"})
    data = list(TAX_EVENTS)
    if one(q, "showDeleted") == "true":
        data.append(DELETED_EVENT)
    return {"success": True, "data": data}


def prop(name: str, et: str | None, typ: str, desc: str = "", cls: list | None = None, required: bool = False, enum: str | None = None) -> dict:
    return {"event_property": name, "event_type": et, "description": desc, "type": typ, "regex": None, "enum_values": enum, "is_array_type": False, "is_required": required, "is_hidden": False, "classifications": cls or []}


EVENT_PROPS = {
    "Purchase": [prop("$revenue", "Purchase", "number", "Order total", required=True), prop("sku", "Purchase", "string", "SKU"), prop("coupon", "Purchase", "enum", enum="SAVE10, FREESHIP")],
    "Sign Up": [prop("method", "Sign Up", "enum", "How the user signed up", enum="email, google")],
    "Page View": [prop("path", "Page View", "string")],
    "Planned Event": [],
}
SHARED_PROPS = [prop("email", None, "string", "Email address", ["PII"])]


def r_tax_event_property(q: dict) -> dict:
    allow(q, {"event_type"})
    et = one(q, "event_type")
    if et is None:
        return {"success": True, "data": SHARED_PROPS}
    if et not in EVENT_PROPS:
        raise ApiError(400, {"success": False, "errors": [{"message": f"Event type {et} not found"}]})
    return {"success": True, "data": EVENT_PROPS[et]}


def r_tax_user_property(q: dict) -> dict:
    allow(q, {"showDeleted"})
    rows = [
        {"user_property": "plan", "description": "Subscription plan", "type": "enum", "enum_values": "free, pro", "regex": None, "is_array_type": False, "is_hidden": False, "classifications": [], "deleted": False},
        {"user_property": "email", "description": "Email", "type": "string", "enum_values": None, "regex": None, "is_array_type": False, "is_hidden": False, "classifications": ["PII"], "deleted": False},
        {"user_property": "device_id", "description": None, "type": None, "enum_values": None, "regex": None, "is_array_type": False, "is_hidden": False, "classifications": ["PII"], "deleted": False},
    ]
    if one(q, "showDeleted") == "true":
        rows.append({"user_property": "old_flag", "description": None, "type": "boolean", "enum_values": None, "regex": None, "is_array_type": False, "is_hidden": False, "classifications": [], "deleted": True})
    return {"success": True, "data": rows}


GROUP_PROPS = [
    {"group_type": "org", "group_property": "grp:tier", "description": "Account tier", "type": "string", "enum_values": None, "regex": None, "is_array_type": False, "is_hidden": False, "classifications": []},
    {"group_type": "workspace", "group_property": "grp:seats", "description": "Seats", "type": "number", "enum_values": None, "regex": None, "is_array_type": False, "is_hidden": False, "classifications": []},
]


def r_tax_group_property(q: dict) -> dict:
    allow(q, {"group_type"})
    gt = one(q, "group_type")
    return {"success": True, "data": [g for g in GROUP_PROPS if gt is None or g["group_type"] == gt]}


# ----------------------------------------------------------------- cohorts

COHORTS = [
    {"appId": fx.APP, "archived": False, "definition": {"version": 3, "andClauses": []}, "description": "Bought 3+ times", "finished": True, "id": "coh_power", "name": "Power Buyers", "owners": ["ana@example.com"], "viewers": [], "published": True, "size": 12000, "type": "redshift", "lastMod": 1763078400, "createdAt": 1735689600, "lastComputed": 1763082000, "hidden": False, "metadata": [], "view_count": 14, "popularity": 3, "last_viewed": 1763082000, "chart_id": None, "edit_id": "e1", "is_predictive": False, "is_official_content": True, "location_id": None, "shortcut_ids": []},
    {"appId": fx.APP, "archived": True, "definition": {"version": 3}, "description": None, "finished": True, "id": "coh_old", "name": "Old Trial", "owners": [], "viewers": [], "published": False, "size": 40, "type": "redshift", "lastMod": 1700000000, "createdAt": 1690000000, "lastComputed": 1700000000, "hidden": False, "metadata": [], "view_count": 0, "popularity": 0, "last_viewed": None, "chart_id": None, "edit_id": "e2", "is_predictive": False, "is_official_content": False, "location_id": None, "shortcut_ids": []},
]


def r_cohorts(q: dict) -> dict:
    allow(q, {"includeSyncInfo"})
    rows = [dict(c) for c in COHORTS]
    if one(q, "includeSyncInfo") == "true":
        rows[0]["syncMetadata"] = [{"target": "braze", "frequency": "daily", "last_successful": 1763082000, "last_failure": None, "params": {}}]
    return {"cohorts": rows}


def r_cohort_request(q: dict, cohort_id: str) -> tuple[int, dict]:
    allow(q, {"props", "propKeys"})
    choice(q, "props", {"0", "1"})
    if cohort_id not in {c["id"] for c in COHORTS}:
        raise ApiError(404, {"error": "Cohort not found"})
    rid = f"req-{cohort_id}-{len(JOBS) + 1}"
    JOBS[rid] = {"cohort": cohort_id, "polls": 0, "props": one(q, "props") == "1", "keys": q.get("propKeys", [])}
    return 202, {"request_id": rid, "cohort_id": cohort_id}


def r_cohort_status(q: dict, rid: str) -> tuple[int, dict]:
    allow(q, set())
    job = JOBS.get(rid)
    if not job:
        raise ApiError(404, {"error": "unknown request"})
    job["polls"] += 1
    if job["polls"] == 1:
        return 202, {"request_id": rid, "cohort_id": job["cohort"], "async_status": "JOB INPROGRESS"}
    return 200, {"request_id": rid, "cohort_id": job["cohort"], "async_status": "JOB COMPLETED"}


def members_csv(job: dict) -> bytes:
    rows = MEMBERS if job["cohort"] == "coh_power" else MEMBERS[:1]
    keys = [k for k in ("gp:plan", "country") if job["props"] and (not job["keys"] or k.removeprefix("gp:") in job["keys"] or k in job["keys"])]
    head = ["amplitude_id", "user_id", *keys]
    out = [",".join(f'"{h}"' for h in head)]
    for r in rows:
        out.append(",".join(['"' + str(r.get(h, "")).replace('"', '""') + '"' for h in head]))
    return ("\n".join(out) + "\n").encode()


# -------------------------------------------------------------- annotations

ANNOTATIONS = [
    {"id": 1, "start": "2026-10-20T07:00:00+00:00", "details": "v3.1 shipped", "category": {"id": 45678, "name": "Releases"}, "end": None, "label": "v3.1", "chart_id": None},
    {"id": 2, "start": "2026-11-03T09:00:00+00:00", "details": "Checkout outage", "category": {"id": 45679, "name": "Incidents"}, "end": "2026-11-03T11:30:00+00:00", "label": "Outage", "chart_id": None},
    {"id": 3, "start": "2026-11-10T07:00:00+00:00", "details": "v3.2 shipped", "category": {"id": 45678, "name": "Releases"}, "end": None, "label": "v3.2", "chart_id": "chart9"},
]


def r_annotations(q: dict) -> dict:
    allow(q, {"category", "chart_id", "start", "end"})
    if "category" in q and "chart_id" in q:
        raise ApiError(400, {"error": "category and chart_id cannot be combined"})
    rows = ANNOTATIONS
    if "start" in q:
        s = one(q, "start") or ""
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})", s):
            raise bad("start must be YYYY-MM-DDThh:mmTZD")
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        rows = [a for a in rows if dt.datetime.fromisoformat(a["start"]) > t]
    if "category" in q:
        rows = [a for a in rows if a["category"]["name"] == one(q, "category")]
    if "chart_id" in q:
        rows = [a for a in rows if a["chart_id"] == one(q, "chart_id")]
    return {"data": rows}


ROUTES = {
    "/api/2/events/segmentation": r_segmentation,
    "/api/2/funnels": r_funnels,
    "/api/2/retention": r_retention,
    "/api/2/users": r_users,
    "/api/2/sessions/length": r_sessions_length,
    "/api/2/sessions/average": r_sessions_avg,
    "/api/2/sessions/peruser": r_sessions_peruser,
    "/api/2/composition": r_composition,
    "/api/2/realtime": r_realtime,
    "/api/2/revenue/ltv": r_ltv,
    "/api/2/events/list": r_events_list,
    "/api/2/usersearch": r_usersearch,
    "/api/2/useractivity": r_useractivity,
    "/api/2/taxonomy/category": r_tax_category,
    "/api/2/taxonomy/event": r_tax_event,
    "/api/2/taxonomy/event-property": r_tax_event_property,
    "/api/2/taxonomy/user-property": r_tax_user_property,
    "/api/2/taxonomy/group-property": r_tax_group_property,
    "/api/3/cohorts": r_cohorts,
    "/api/3/annotations": r_annotations,
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        pass

    def _send(self, status: int, body: object, headers: dict | None = None) -> None:
        data = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body)).encode()
        self.send_response(status)
        hdrs = {"Content-Type": "application/json", **(headers or {})}
        for k, v in hdrs.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _auth(self) -> str:
        h = self.headers.get("Authorization")
        if not h:
            return "missing"
        if not h.startswith("Basic "):
            return "bad"
        try:
            k, _, s = base64.b64decode(h[6:]).decode().partition(":")
        except ValueError:
            return "bad"
        return "ok" if (k, s) == (API_KEY, SECRET_KEY) else "bad"

    def do_GET(self) -> None:  # noqa: N802 - stdlib name
        url = urlparse(self.path)
        q = parse_qs(url.query, keep_blank_values=True)
        if url.path == "/__requests":
            want = (q.get("path") or [""])[0]
            with LOCK:
                rows = [r for r in LOG if not want or r["path"] == want or r["path"].startswith(want + "/")]
            return self._send(200, rows)
        if url.path.startswith("/__s3/"):
            # A pre-signed link: must arrive WITHOUT the Amplitude credentials.
            if self.headers.get("Authorization"):
                return self._send(400, "<Error>Only one auth mechanism allowed</Error>", {"Content-Type": "application/xml"})
            job = JOBS.get(url.path.removeprefix("/__s3/"))
            if not job:
                return self._send(404, "<Error>NoSuchKey</Error>", {"Content-Type": "application/xml"})
            return self._send(200, members_csv(job), {"Content-Type": "text/csv"})
        auth = self._auth()
        with LOCK:
            LOG.append({"seq": len(LOG) + 1, "path": url.path, "query": json.dumps({k: (v[0] if len(v) == 1 else v) for k, v in q.items()}, sort_keys=True), "auth": auth})
        if auth == "missing":
            return self._send(401, {"error": "Missing Basic authorization header"})
        if auth == "bad":
            return self._send(403, {"error": "Invalid API key or secret key"})
        try:
            if url.path == "/api/2/export":
                status, body, headers = r_export(q)
                return self._send(status, body, headers)
            m = re.fullmatch(r"/api/5/cohorts/request/([^/]+)", url.path)
            if m:
                return self._send(*r_cohort_request(q, m.group(1)))
            m = re.fullmatch(r"/api/5/cohorts/request-status/([^/]+)", url.path)
            if m:
                return self._send(*r_cohort_status(q, m.group(1)))
            m = re.fullmatch(r"/api/5/cohorts/request/([^/]+)/file", url.path)
            if m:
                allow(q, set())
                rid = m.group(1)
                if rid not in JOBS or JOBS[rid]["polls"] < 2:
                    raise ApiError(404, {"error": "file not ready"})
                return self._send(302, b"", {"Location": f"http://localhost:{PORT[0]}/__s3/{rid}"})
            route = ROUTES.get(url.path)
            if not route:
                raise ApiError(404, {"error": f"no route {url.path}"})
            return self._send(200, route(q))
        except ApiError as e:
            return self._send(e.status, e.body, e.headers)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    PORT[0] = srv.server_address[1]
    print(f"PORT:{PORT[0]}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        srv.serve_forever()


if __name__ == "__main__":
    main()
