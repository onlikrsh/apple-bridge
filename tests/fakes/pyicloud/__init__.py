"""A stand-in for pyicloud, for exercising `abridge rem` without an Apple ID.

State lives in the JSON file named by FAKE_ICLOUD_STATE, so changes made by
one `abridge` process are seen by the next, just as they would be in iCloud.
Every write is also appended to state["calls"] for the tests to inspect.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from types import SimpleNamespace

_DATES = ("due_date", "start_date", "completed_date", "created", "modified")


def _load() -> dict:
    with open(os.environ["FAKE_ICLOUD_STATE"]) as f:
        return json.load(f)


def _save(state: dict) -> None:
    with open(os.environ["FAKE_ICLOUD_STATE"], "w") as f:
        json.dump(state, f, indent=2)


def _reminder(raw: dict) -> SimpleNamespace:
    fields = dict(
        desc="", completed=False, priority=0, flagged=False, all_day=False, deleted=False,
        time_zone=None, parent_reminder_id=None,
    )
    fields.update(raw)
    for key in _DATES:
        value = fields.get(key)
        fields[key] = datetime.fromisoformat(value) if value else None
    return SimpleNamespace(**fields)


def _dump(r: SimpleNamespace) -> dict:
    out = dict(vars(r))
    for key in _DATES:
        out[key] = out[key].isoformat() if out.get(key) else None
    return out


class _Reminders:
    def lists(self):
        defaults = {"count": 0, "color": None, "deleted": False, "is_group": False}
        return [SimpleNamespace(**{**defaults, **l}) for l in _load()["lists"]]

    def list_reminders(self, list_id, include_completed=False, results_limit=200):
        rows = [_reminder(r) for r in _load()["reminders"] if r["list_id"] == list_id]
        if not include_completed:
            rows = [r for r in rows if not r.completed]
        return SimpleNamespace(reminders=rows)

    def create(self, **kw):
        state = _load()
        kw = {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in kw.items()}
        state["calls"].append({"create": kw})
        raw = {"id": f"Reminder/{str(uuid.uuid4()).upper()}", **kw}
        state["reminders"].append(raw)
        _save(state)
        return _reminder(raw)

    def update(self, reminder):
        state = _load()
        state["calls"].append({"update": bare(reminder.id), "completed": reminder.completed})
        state["reminders"] = [_dump(reminder) if r["id"] == reminder.id else r for r in state["reminders"]]
        _save(state)

    def delete(self, reminder):
        state = _load()
        state["calls"].append({"delete": bare(reminder.id)})
        state["reminders"] = [r for r in state["reminders"] if r["id"] != reminder.id]
        _save(state)


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
