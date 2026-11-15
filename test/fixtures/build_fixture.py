#!/usr/bin/env python3
"""Fixture data for the Amplitude replay server (test/mock_api/server.py), stdlib only.

Everything here is fictional and deterministic. Shapes follow Amplitude's documented
responses (Export API, Dashboard REST API, Taxonomy API, Behavioral Cohorts API, chart
annotations).

* ``export_files()`` — the raw events, grouped by UTC **upload** hour into gzip JSON Lines
  files named like Amplitude's (``<app>/<app>_YYYY-MM-DD_H#N.json.gz``). The server zips
  the files of the requested hours into a real ZIP archive per request.
* ``build_export_zip(hours)`` — that archive (also used to write the committed sample
  ``test/fixtures/export-sample.zip`` that the unit tests parse):

      python3 test/fixtures/build_fixture.py test/fixtures/export-sample.zip

Upload hours (2026-11-14 UTC unless noted):

* 2026-11-13T23: one Purchase (user_1, revenue 100) — before the test day.
* T00: Sign Up + Purchase (user_42, $revenue 19.99, US) in file #0 and #1, Purchase user_7
  ($price 5 x $quantity 3, Germany).
* T01: Purchase user_7 ($revenue 10, Germany), an anonymous Page View with session_id -1,
  and a LATE Purchase by user_9 (event_time 2026-11-13T20:00, revenue 7.5, France).
* T02: no events (the Export API answers 404 for a range with no files).
* T03: 25,000 Page View events (Canada) across three files — forces several batches.
* T04: Sign Up user_9; Purchase user_42 ($revenue 30, US).
* T05: Purchase user_99 at 05:59:59.999999 ($revenue 1, US).
"""

from __future__ import annotations

import datetime as dt
import gzip
import io
import json
import sys
import zipfile

APP = 187520
DAY = dt.datetime(2026, 11, 14, tzinfo=dt.timezone.utc)


def _fmt(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%d %H:%M:%S.%f")


_counter = [0]


def event(
    event_type: str,
    event_time: dt.datetime,
    upload: dt.datetime,
    user_id: str | None,
    device_id: str,
    amplitude_id: int,
    country: str = "United States",
    platform: str = "Web",
    props: dict | None = None,
    session_id: int | None = None,
) -> dict:
    _counter[0] += 1
    n = _counter[0]
    return {
        "server_received_time": _fmt(upload),
        "app": APP,
        "device_carrier": None,
        "$schema": 12,
        "city": {"United States": "San Francisco", "Germany": "Berlin", "France": "Paris", "Canada": "Toronto"}.get(country),
        "user_id": user_id,
        "uuid": f"00000000-0000-4000-8000-{n:012d}",
        "event_time": _fmt(event_time),
        "platform": platform,
        "os_version": "17.1" if platform == "iOS" else "119",
        "amplitude_id": amplitude_id,
        "processed_time": _fmt(upload + dt.timedelta(seconds=5)),
        "user_creation_time": "2026-01-02 03:04:05",
        "version_name": "3.2.1",
        "ip_address": "203.0.113.5",
        "paying": event_type == "Purchase",
        "dma": None,
        "group_properties": {},
        "user_properties": {"plan": "pro" if user_id in ("user_42", "user_9") else "free"},
        "client_upload_time": _fmt(upload),
        "$insert_id": f"ins-{n}",
        "event_type": event_type,
        "library": "amplitude-ts/2.11.0" if platform == "Web" else "amplitude-swift/1.9.0",
        "amplitude_attribution_ids": None,
        "device_type": "Apple iPhone" if platform == "iOS" else "Mac",
        "device_manufacturer": "Apple",
        "start_version": "3.0.0",
        "location_lng": -122.4194,
        "server_upload_time": _fmt(upload),
        "event_id": n,
        "location_lat": 37.7749,
        "os_name": "ios" if platform == "iOS" else "Chrome",
        "amplitude_event_type": None,
        "device_brand": "Apple",
        "groups": {},
        "event_properties": props or {},
        "data": {"group_first_event": {}},
        "device_id": device_id,
        "language": "English",
        "device_model": "iPhone15,2" if platform == "iOS" else "Mac",
        "country": country,
        "region": None,
        "is_attribution_event": False,
        "adid": None,
        "session_id": (int(event_time.timestamp() * 1000) if session_id is None else session_id),
        "device_family": "iPhone" if platform == "iOS" else "Mac",
        "sample_rate": None,
        "idfa": None,
        "client_event_time": _fmt(event_time),
    }


def h(hour: int, minute: int = 0, second: int = 0, micro: int = 0, day: dt.datetime = DAY) -> dt.datetime:
    return day.replace(hour=hour, minute=minute, second=second, microsecond=micro)


def export_files() -> dict[str, list[tuple[str, list[dict]]]]:
    """Upload hour key ``YYYYMMDDTHH`` → [(file name, events)]."""
    _counter[0] = 0
    prev = DAY - dt.timedelta(days=1)
    files: dict[str, list[tuple[str, list[dict]]]] = {}

    def put(hour: dt.datetime, n: int, events: list[dict]) -> None:
        key = hour.strftime("%Y%m%dT%H")
        name = f"{APP}/{APP}_{hour.strftime('%Y-%m-%d')}_{hour.hour}#{n}.json.gz"
        files.setdefault(key, []).append((name, events))

    put(h(23, day=prev), 0, [event("Purchase", h(23, 50, day=prev), h(23, 55, day=prev), "user_1", "d1", 1001, props={"$revenue": 100})])
    put(h(0), 0, [event("Sign Up", h(0, 5), h(0, 6), "user_42", "d42", 12345, props={"method": "email"})])
    put(
        h(0),
        1,
        [
            event("Purchase", h(0, 10), h(0, 11), "user_42", "d42", 12345, props={"$revenue": 19.99, "sku": "A1"}),
            event("Purchase", h(0, 20), h(0, 21), "user_7", "d7", 777, "Germany", "iOS", {"$price": 5, "$quantity": 3}),
        ],
    )
    put(
        h(1),
        0,
        [
            event("Purchase", h(1, 20), h(1, 21), "user_7", "d7", 777, "Germany", "iOS", {"$revenue": 10}),
            event("Page View", h(1, 30), h(1, 31), None, "anon-1", 5555, session_id=-1, props={"path": "/pricing"}),
            event("Purchase", h(20, day=prev), h(1, 10), "user_9", "d9", 999, "France", "iOS", {"$revenue": 7.5}),
        ],
    )
    bulk = [
        event("Page View", h(3, i // 1000, (i // 17) % 60, i % 1000), h(3, 59), f"bulk_{i % 100}", f"bd{i % 100}", 20000 + i % 100, "Canada", props={"path": f"/p/{i % 7}"})
        for i in range(25_000)
    ]
    for n, chunk in enumerate((bulk[:9000], bulk[9000:18000], bulk[18000:])):
        put(h(3), n, chunk)
    put(
        h(4),
        0,
        [
            event("Sign Up", h(4, 15), h(4, 16), "user_9", "d9", 999, "France", "iOS"),
            event("Purchase", h(4, 30), h(4, 31), "user_42", "d42", 12345, props={"$revenue": 30}),
        ],
    )
    put(h(5), 0, [event("Purchase", h(5, 59, 59, 999999), h(5, 59, 59, 999999), "user_99", "d99", 9999, props={"$revenue": 1})])
    return files


def build_export_zip(files: list[tuple[str, list[dict]]], zip64: bool = False) -> bytes:
    """A real Export API archive: a ZIP of gzip JSON Lines files."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, events in files:
            raw = "".join(json.dumps(e, separators=(",", ":")) + "\n" for e in events).encode()
            gz = gzip.compress(raw, mtime=0)
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            with zf.open(info, "w", force_zip64=zip64) as w:
                w.write(gz)
    return buf.getvalue()


def cohort_members() -> list[dict]:
    """Members of cohort ``coh_power`` (12,000 users → several batches)."""
    out = [{"amplitude_id": 12345, "user_id": "user_42", "gp:plan": "pro", "country": "United States"}]
    out.append({"amplitude_id": 5555, "user_id": "", "gp:plan": "free", "country": "Canada"})
    for i in range(11_998):
        out.append({"amplitude_id": 100000 + i, "user_id": f"u{i}", "gp:plan": "pro" if i % 4 == 0 else "free", "country": "Canada"})
    return out


def user_activity_events() -> list[dict]:
    """2,500 events of amplitude id 12345, newest first (useractivity pages 1,000 at a time)."""
    _counter[0] = 50_000
    base = DAY - dt.timedelta(days=3)
    evs = [
        event("Page View" if i % 10 else "Purchase", base + dt.timedelta(minutes=i), base + dt.timedelta(minutes=i, seconds=1), "user_42", "d42", 12345, props={"i": i})
        for i in range(2_500)
    ]
    return list(reversed(evs))


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "test/fixtures/export-sample.zip"
    f = export_files()
    sample = f["20261114T00"] + f["20261114T01"]
    with open(out, "wb") as fh:
        fh.write(build_export_zip(sample))
    print(f"wrote {out}", file=sys.stderr)
