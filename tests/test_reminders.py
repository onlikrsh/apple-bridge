"""Unit tests for libexec/abridge-reminders (no network, no pyicloud needed)."""

from __future__ import annotations

import importlib.machinery
import importlib.util
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
_loader = importlib.machinery.SourceFileLoader("abridge_reminders", str(ROOT / "libexec" / "abridge-reminders"))
_spec = importlib.util.spec_from_loader("abridge_reminders", _loader)
rem = importlib.util.module_from_spec(_spec)
_loader.exec_module(rem)

UTC = timezone.utc


def make_list(title="Shopping", lid="List/AAAA-1111", color=None):
    return SimpleNamespace(id=lid, title=title, color=color, count=0, deleted=False, is_group=False)


def make_reminder(**kw):
    base = dict(
        id="Reminder/0E9A1F2B-1234-5678-9ABC-DEF012345678",
        list_id="List/AAAA-1111",
        title="Buy milk",
        desc="",
        completed=False,
        completed_date=None,
        due_date=None,
        start_date=None,
        priority=0,
        flagged=False,
        all_day=False,
        deleted=False,
        time_zone=None,
        parent_reminder_id=None,
        created=datetime(2026, 10, 1, 8, 0, tzinfo=UTC),
        modified=datetime(2026, 10, 2, 9, 30, tzinfo=UTC),
    )
    base.update(kw)
    return SimpleNamespace(**base)


def unfold(ics: str) -> list[str]:
    return ics.replace("\r\n ", "").split("\r\n")


# ------------------------------------------------------------------- dates


def test_parse_due_date_only_is_all_day_midnight_utc():
    assert rem.parse_due("2026-10-20") == (datetime(2026, 10, 20, tzinfo=UTC), True, None)


def test_parse_due_relative_words():
    today = date(2026, 10, 12)
    assert rem.parse_due("today", today)[0] == datetime(2026, 10, 12, tzinfo=UTC)
    assert rem.parse_due("Tomorrow", today)[:2] == (datetime(2026, 10, 13, tzinfo=UTC), True)


def test_parse_due_timed_uses_local_zone(monkeypatch):
    monkeypatch.setenv("TZ", "Asia/Kolkata")
    import time

    time.tzset()
    try:
        moment, all_day, tz = rem.parse_due("2026-10-20 09:30")
        assert (moment, all_day, tz) == (datetime(2026, 10, 20, 4, 0, tzinfo=UTC), False, "Asia/Kolkata")
        # 'T' separator and explicit offsets work too.
        assert rem.parse_due("2026-10-20T09:30")[0] == moment
        assert rem.parse_due("2026-10-20T09:30+00:00")[0] == datetime(2026, 10, 20, 9, 30, tzinfo=UTC)
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


def test_parse_due_rejects_garbage():
    with pytest.raises(rem.UserError):
        rem.parse_due("next friday")


def test_due_label_all_day_keeps_the_literal_date(monkeypatch):
    # 00:00 UTC must not turn into the previous day west of Greenwich.
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    import time

    time.tzset()
    try:
        r = make_reminder(due_date=datetime(2026, 10, 20, tzinfo=UTC), all_day=True)
        assert rem.due_label(r) == "2026-10-20"
    finally:
        monkeypatch.delenv("TZ")
        time.tzset()


# -------------------------------------------------------------- resolution


def test_resolve_list_exact_then_prefix_case_insensitive():
    lists = [make_list("Shopping"), make_list("Shop stuff", "List/BBBB"), make_list("Work", "List/CCCC")]
    assert rem.resolve_list(lists, "shopping").title == "Shopping"
    assert rem.resolve_list(lists, "wo").title == "Work"
    with pytest.raises(rem.UserError, match="several lists"):
        rem.resolve_list(lists, "shop")
    with pytest.raises(rem.UserError, match="no list matches"):
        rem.resolve_list(lists, "nope")


def test_resolve_reminder_by_prefix_or_full_id():
    a = make_reminder(id="Reminder/ABCD1234-0000")
    b = make_reminder(id="Reminder/ABCE9999-0000")
    assert rem.resolve_reminder([a, b], "abcd") is a
    assert rem.resolve_reminder([a, b], "Reminder/ABCE9999-0000") is b
    with pytest.raises(rem.UserError, match="ambiguous"):
        rem.resolve_reminder([a, b], "ABC")
    with pytest.raises(rem.UserError, match="no reminder"):
        rem.resolve_reminder([a, b], "ffff")


def test_short_id():
    assert rem.short_id("Reminder/0E9A1F2B-1234") == "0E9A1F2B"


# ------------------------------------------------------------------- VTODO


def test_vtodo_basic_fields():
    lines = unfold(rem.to_vtodo(make_reminder(), "Shopping"))
    assert lines[0] == "BEGIN:VCALENDAR" and lines[-2] == "END:VCALENDAR" and lines[-1] == ""
    assert "UID:0E9A1F2B-1234-5678-9ABC-DEF012345678" in lines
    assert "SUMMARY:Buy milk" in lines
    assert "STATUS:NEEDS-ACTION" in lines
    assert "DTSTAMP:20261002T093000Z" in lines
    assert "CATEGORIES:Shopping" in lines
    assert not any(l.startswith("DUE") for l in lines)


def test_vtodo_all_day_due_is_a_date_and_timed_due_is_utc():
    all_day = unfold(rem.to_vtodo(make_reminder(due_date=datetime(2026, 10, 20, tzinfo=UTC), all_day=True), "L"))
    assert "DUE;VALUE=DATE:20261020" in all_day
    timed = unfold(rem.to_vtodo(make_reminder(due_date=datetime(2026, 10, 20, 4, 0, tzinfo=UTC)), "L"))
    assert "DUE:20261020T040000Z" in timed


def test_vtodo_completed_priority_flag_parent():
    r = make_reminder(
        completed=True,
        completed_date=datetime(2026, 10, 3, tzinfo=UTC),
        priority=1,
        flagged=True,
        parent_reminder_id="Reminder/PARENT-1",
    )
    lines = unfold(rem.to_vtodo(r, "Work"))
    assert "STATUS:COMPLETED" in lines
    assert "COMPLETED:20261003T000000Z" in lines
    assert "PRIORITY:1" in lines
    assert "CATEGORIES:Work,Flagged" in lines
    assert "RELATED-TO;RELTYPE=PARENT:PARENT-1" in lines


def test_vtodo_escapes_text():
    r = make_reminder(title="Milk, eggs; bread\\jam", desc="line one\nline two")
    lines = unfold(rem.to_vtodo(r, "A,B"))
    assert "SUMMARY:Milk\\, eggs\\; bread\\\\jam" in lines
    assert "DESCRIPTION:line one\\nline two" in lines
    assert "CATEGORIES:A\\,B" in lines


def test_vtodo_folds_long_lines_without_splitting_utf8():
    r = make_reminder(title="🛒" * 60)
    ics = rem.to_vtodo(r, "L")
    for line in ics.split("\r\n"):
        assert len(line.encode("utf-8")) <= 75
    assert "SUMMARY:" + "🛒" * 60 in unfold(ics)


def test_list_color():
    assert rem.list_color('{"daHexString": "#1BADF8", "ckSymbolicColorName": "blue"}') == "#1BADF8"
    assert rem.list_color("#FF0000") == "#FF0000"
    assert rem.list_color("blue") is None
    assert rem.list_color(None) is None
    assert rem.list_color("{not json") is None


# ------------------------------------------------------------------ mirror


def test_mirror_writes_updates_and_removes(tmp_path):
    dest = tmp_path / "reminders"
    shopping = make_list("Shopping", "List/AAAA", '{"daHexString": "#1BADF8"}')
    a = make_reminder(id="Reminder/A1")
    b = make_reminder(id="Reminder/B2", title="Bread")

    stats = rem.mirror([(shopping, [a, b])], dest)
    assert stats == {"lists": 1, "written": 2, "removed": 0, "unchanged": 0}
    coll = dest / "AAAA"
    assert (coll / "displayname").read_text() == "Shopping"
    assert (coll / "color").read_text() == "#1BADF8"
    assert sorted(p.name for p in coll.glob("*.ics")) == ["A1.ics", "B2.ics"]

    # Nothing changed: nothing rewritten.
    assert rem.mirror([(shopping, [a, b])], dest)["unchanged"] == 2

    # b deleted on the phone, a renamed.
    a.title = "Oat milk"
    stats = rem.mirror([(shopping, [a])], dest)
    assert stats["written"] == 1 and stats["removed"] == 1
    assert "SUMMARY:Oat milk" in unfold((coll / "A1.ics").read_bytes().decode())

    # The whole list deleted on the phone.
    rem.mirror([], dest)
    assert not coll.exists()
    assert (dest / rem.MIRROR_MARKER).exists()


def test_mirror_refuses_a_folder_it_did_not_create(tmp_path):
    (tmp_path / "precious.txt").write_text("mine")
    with pytest.raises(rem.UserError, match="refusing"):
        rem.mirror([(make_list(), [])], tmp_path)
    assert (tmp_path / "precious.txt").read_text() == "mine"


def test_mirror_leaves_foreign_subfolders_alone(tmp_path):
    rem.mirror([(make_list(lid="List/AAAA"), [])], tmp_path)
    (tmp_path / "mine").mkdir()
    (tmp_path / "mine" / "keep.txt").write_text("x")
    rem.mirror([], tmp_path)
    assert (tmp_path / "mine" / "keep.txt").exists()
