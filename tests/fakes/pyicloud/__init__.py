"""A stand-in for pyicloud, for exercising `abridge rem` without an Apple ID.

State lives in the JSON file named by FAKE_ICLOUD_STATE, so changes made by
one `abridge` process are seen by the next, just as they would be in iCloud.
Every write is also appended to state["calls"] for the tests to inspect, and
every fetch to state["reads"].

Sync tokens work like CloudKit's: state["seq"] counts changes, each list and
reminder carries the seq of its last change, and a deletion leaves a
tombstone. A token is the seq as a string; tokens below state["oldest_token"]
have expired.

The raw records behind `_raw.lookup`/`_raw.modify` keep what abridge writes
itself: a change tag ("tag"), the ResolutionTokenMap ("tokens") and the
title/notes documents ("title_doc", "notes_doc", base64 as written). A write
whose change tag is stale, or any write while state["conflict"] is set, is
refused with CONFLICT the way CloudKit refuses it.
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import uuid
import zlib
from datetime import datetime, timezone
from types import SimpleNamespace

from pyicloud.common.cloudkit import CKErrorItem, CKFields, CKRecord, CKTombstoneRecord

_DATES = ("due_date", "start_date", "completed_date", "created", "modified")
_RAW_ONLY = {"seq", "tag", "tokens", "title_doc", "notes_doc"}


class RemindersApiError(Exception):
    pass


def _load() -> dict:
    with open(os.environ["FAKE_ICLOUD_STATE"]) as f:
        return json.load(f)


def _save(state: dict) -> None:
    with open(os.environ["FAKE_ICLOUD_STATE"], "w") as f:
        json.dump(state, f, indent=2)


def _read(entry: dict) -> dict:
    state = _load()
    state.setdefault("reads", []).append(entry)
    _save(state)
    return state


def _stamp(state: dict, raw: dict) -> None:
    state["seq"] = state.get("seq", 0) + 1
    raw["seq"] = state["seq"]


def _since(state: dict, token: str | None) -> int:
    if token is None:
        return -1
    if not token.isdigit() or int(token) < state.get("oldest_token", 0):
        raise RemindersApiError("Changes response validation failed")
    return int(token)


def _list(raw: dict) -> SimpleNamespace:
    defaults = {"count": 0, "color": None, "deleted": False, "is_group": False}
    return SimpleNamespace(**{**defaults, **{k: v for k, v in raw.items() if k != "seq"}})


def _reminder(raw: dict) -> SimpleNamespace:
    fields = dict(
        desc="", completed=False, priority=0, flagged=False, all_day=False, deleted=False,
        time_zone=None, parent_reminder_id=None, recurrence_rule_ids=[],
    )
    fields.update((k, v) for k, v in raw.items() if k not in _RAW_ONLY)
    for key in _DATES:
        value = fields.get(key)
        fields[key] = datetime.fromisoformat(value) if value else None
    return SimpleNamespace(**fields)


class _Reads:
    def _iter_zone_change_pages(self, *, desired_record_types, sync_token=None, **_):
        assert desired_record_types == ["List"]
        state = _read({"list_changes": sync_token})
        since = _since(state, sync_token)
        records = [
            CKRecord(recordName=l["id"], recordType="List", fields=l)
            for l in state["lists"]
            if l.get("seq", 0) > since
        ]
        if sync_token is not None:
            records += [
                CKTombstoneRecord(recordName=t["id"], deleted=True)
                for t in state.get("tombstones", [])
                if t["seq"] > since
            ]
        yield SimpleNamespace(records=records, syncToken=str(state.get("seq", 0)), moreComing=False)


def _varint(data: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return value, i


def _field(message: bytes, number: int) -> bytes:
    """The first length-delimited field `number` of a protobuf message."""
    i = 0
    while i < len(message):
        key, i = _varint(message, i)
        kind = key & 7
        if kind == 0:
            _, i = _varint(message, i)
        elif kind == 1:
            i += 8
        elif kind == 5:
            i += 4
        else:
            length, i = _varint(message, i)
            if key >> 3 == number:
                return message[i:i + length]
            i += length
    return b""


def _document_text(value: str) -> str:
    """The text of a title/notes document: Document.version[0].data is a
    topotext.String whose field 2 is the string."""
    data = base64.b64decode(value)
    for decompress in (gzip.decompress, zlib.decompress):
        try:
            data = decompress(data)
            break
        except (OSError, zlib.error):
            pass
    return _field(_field(_field(data, 2), 3), 2).decode("utf-8")


def _ms(value):
    return None if value is None else datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


# CloudKit field -> (model key, how to store the value)
_WRITABLE = {
    "Completed": ("completed", bool),
    "CompletionDate": ("completed_date", _ms),
    "Deleted": ("deleted", bool),
    "DueDate": ("due_date", _ms),
    "AllDay": ("all_day", bool),
    "TimeZone": ("time_zone", lambda v: v),
    "Priority": ("priority", lambda v: v),
    "Flagged": ("flagged", bool),
    "LastModifiedDate": ("modified", _ms),
}


class _Raw:
    def lookup(self, *, record_names, zone_id):
        state = _load()
        records = []
        for raw in state["reminders"]:
            if raw["id"] in record_names:
                fields = CKFields({
                    "ResolutionTokenMap": SimpleNamespace(value=json.dumps({"map": raw.get("tokens", {})})),
                    **{name: SimpleNamespace(value=raw[key]) for name, key in
                       (("TitleDocument", "title_doc"), ("NotesDocument", "notes_doc")) if raw.get(key)},
                })
                records.append(CKRecord(recordName=raw["id"], recordType="Reminder",
                                        recordChangeTag=raw.get("tag", "1"), fields=fields))
        return SimpleNamespace(records=records)

    def modify(self, *, operations, zone_id):
        state = _load()
        out = []
        for op in operations:
            rec = op.record
            raw = next(r for r in state["reminders"] if r["id"] == rec.recordName)
            if state.get("conflict") or rec.recordChangeTag != raw.get("tag", "1"):
                out.append(CKErrorItem(recordName=rec.recordName, serverErrorCode="CONFLICT", reason="oplock"))
                continue
            fields = rec.fields
            state["calls"].append({"modify": bare(rec.recordName), "fields": sorted(fields)})
            for name, field in fields.items():
                value = field["value"]
                if name in _WRITABLE:
                    key, convert = _WRITABLE[name]
                    raw[key] = convert(value)
                elif name == "TitleDocument":
                    raw["title_doc"], raw["title"] = value, _document_text(value)
                elif name == "NotesDocument":
                    raw["notes_doc"], raw["desc"] = value, _document_text(value)
                elif name == "ResolutionTokenMap":
                    raw["tokens"] = json.loads(value)["map"]
            raw["tag"] = str(int(raw.get("tag", "1")) + 1)
            _stamp(state, raw)
            state["updated"] = raw
            out.append(CKRecord(recordName=rec.recordName, recordType="Reminder", recordChangeTag=raw["tag"]))
        _save(state)
        return SimpleNamespace(records=out)


class _Reminders:
    _reads = _Reads()
    _raw = _Raw()

    def _record_to_list(self, rec):
        return _list(rec.fields)

    def lists(self):
        return [_list(l) for l in _read({"lists": "all"})["lists"]]

    def sync_cursor(self):
        return str(_load().get("seq", 0))

    def iter_changes(self, *, since=None):
        state = _read({"reminder_changes": since})
        after = _since(state, since)
        for raw in state["reminders"]:
            if raw.get("seq", 0) > after:
                r = _reminder(raw)
                yield SimpleNamespace(type="deleted" if r.deleted else "updated", reminder_id=r.id, reminder=r)
        for t in state.get("tombstones", []):
            if t["seq"] > after:
                yield SimpleNamespace(type="deleted", reminder_id=t["id"], reminder=None)

    def list_reminders(self, list_id, include_completed=False, results_limit=200):
        state = _read({"list_reminders": bare(list_id), "completed": include_completed})
        rows = [_reminder(r) for r in state["reminders"] if r["list_id"] == list_id]
        if not include_completed:
            rows = [r for r in rows if not r.completed]
        return SimpleNamespace(reminders=rows)

    def get(self, reminder_id):
        for raw in _load()["reminders"]:
            if raw["id"] == reminder_id:
                return _reminder(raw)
        raise LookupError(reminder_id)

    def create(self, **kw):
        state = _load()
        kw = {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in kw.items()}
        state["calls"].append({"create": kw})
        raw = {"id": f"Reminder/{str(uuid.uuid4()).upper()}", **kw}
        _stamp(state, raw)
        state["reminders"].append(raw)
        _save(state)
        return _reminder(raw)

    # pyicloud's own update() and delete() rewrite every field and reset the
    # ResolutionTokenMap; abridge writes through _raw.modify instead.
    def update(self, reminder):
        raise AssertionError("abridge must not use pyicloud's update()")

    def delete(self, reminder):
        raise AssertionError("abridge must not use pyicloud's delete()")


def bare(record_id: str) -> str:
    return record_id.split("/", 1)[1]


class PyiCloudService:
    def __init__(self, apple_id, password=None, cookie_directory=None, authenticate=True, **_):
        assert authenticate is False, "abridge must never trigger a login prompt"
        assert cookie_directory, "abridge must pass the persistent session directory"
        self.apple_id = apple_id

    def get_auth_status(self):
        return {"authenticated": _load().get("authenticated", True)}

    @property
    def reminders(self):
        return _Reminders()
