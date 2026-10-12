"""Run bin/abridge end to end in a throwaway HOME, with fakes standing in for
Apple: tests/fakes/pyicloud for CloudKit, shell stubs for icloud-md and the
pyicloud CLI, and a vdirsyncer stub that validates the generated config with
the real vdirsyncer.

The real khal, khard, todoman and vdirsyncer are used when found: on PATH, or
in the directory named by ABRIDGE_TEST_TOOLS (e.g. a venv's bin). Tests that
need one skip without it.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
ABRIDGE = ROOT / "bin" / "abridge"
FAKES = ROOT / "tests" / "fakes"
TOOLS = os.environ.get("ABRIDGE_TEST_TOOLS", "")
TOOL_PATH = os.pathsep.join(p for p in (TOOLS, os.environ.get("PATH", "")) if p)

REAL_ICLOUD_MD = Path(
    os.environ.get("ABRIDGE_TEST_ICLOUD_MD", Path.home() / ".local/share/apple-bridge/node/lib/node_modules/icloud-md")
)
WRITE_FIELDS = ["LastModifiedDate", "ResolutionTokenMap"]  # in every write

LIST_SHOP = "List/AAAA0000-1111-2222-3333-444455556666"
LIST_WORK = "List/BBBB0000-1111-2222-3333-444455556666"


def tool(name: str) -> str | None:
    return shutil.which(name, path=TOOL_PATH)


def write_exe(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


@pytest.fixture
def ab(tmp_path):
    home = tmp_path / "home"
    data = home / ".local/share/apple-bridge"
    env = {
        "HOME": str(home),
        "PATH": f"{tmp_path / 'stubs'}{os.pathsep}{TOOL_PATH}",
        "TZ": "UTC",
        "LANG": "C.UTF-8",
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "FAKE_ICLOUD_STATE": str(tmp_path / "icloud.json"),
    }
    (tmp_path / "stubs").mkdir()
    config = home / ".config/apple-bridge/config"
    config.parent.mkdir(parents=True)
    config.write_text('APPLE_ID="me@icloud.com"\nNOTES_DIR="$HOME/Notes"\n')

    # The venv: its python sees the fake pyicloud; its icloud CLI logs calls.
    write_exe(data / "venv/bin/python", f'#!/bin/sh\nPYTHONPATH="{FAKES}" exec "{sys.executable}" "$@"\n')
    write_exe(data / "venv/bin/icloud", '#!/bin/sh\necho "$*" >> "$HOME/icloud.log"\n')
    write_exe(
        data / "node/bin/icloud-md",
        """#!/bin/sh
echo "$*" >> "$HOME/icloud-md.log"
case "$1" in
  clone) mkdir -p "$2/.icloud-md" && echo '{}' > "$2/.icloud-md/state.json"
         printf 'Groceries\\n\\nmilk\\n' > "$2/Groceries.md" ;;
  verify-auth) [ -f "$HOME/notes-expired" ] && exit 1; exit 0 ;;
  pull) printf 'Groceries\\n\\nmilk\\neggs\\n' > "$2/Groceries.md" ;;
esac
""",
    )
    # What install.sh's icloud-md patch leaves behind (see test_notes_push_needs_the_paragraph_fix).
    reconciler = data / "node/lib/node_modules/icloud-md/dist/notes/formatReconcile.js"
    reconciler.parent.mkdir(parents=True)
    reconciler.write_text("// apple-bridge patch: uniform paragraph styles\n")
    (tmp_path / "icloud.json").write_text(
        json.dumps(
            {
                "authenticated": True,
                "calls": [],
                "lists": [
                    {"id": LIST_SHOP, "title": "Shopping", "color": '{"daHexString": "#1BADF8"}'},
                    {"id": LIST_WORK, "title": "Work"},
                ],
                "reminders": [
                    {"id": "Reminder/AB12CD34-0000", "list_id": LIST_SHOP, "title": "Milk"},
                    {"id": "Reminder/EF56AB78-0000", "list_id": LIST_SHOP, "title": "Bread", "completed": True},
                    {
                        "id": "Reminder/99887766-0000",
                        "list_id": LIST_WORK,
                        "title": "Send report",
                        "due_date": "2026-10-20T00:00:00+00:00",
                        "all_day": True,
                        "priority": 1,
                    },
                ],
            }
        )
    )

    def run(*args, input=None, ok=True):
        proc = subprocess.run([str(ABRIDGE), *args], env=env, capture_output=True, text=True, input=input)
        if ok and proc.returncode != 0:
            pytest.fail(f"abridge {' '.join(args)} exited {proc.returncode}\n{proc.stdout}\n{proc.stderr}")
        return proc

    def icloud_state():
        return json.loads((tmp_path / "icloud.json").read_text())

    return SimpleNamespace(run=run, env=env, home=home, data=data, tmp=tmp_path, state=icloud_state)


# -------------------------------------------------------------------- basics


def test_help(ab):
    out = ab.run("help").stdout
    for word in ("setup calendar", "rem add", "airdrop send", "usb photos", "timer on"):
        assert word in out


def test_unknown_command_fails(ab):
    assert ab.run("frobnicate", ok=False).returncode == 2


def test_secret_falls_back_to_a_private_file_without_a_keyring(ab):
    if tool("secret-tool"):
        pytest.skip("secret-tool present; this test covers the fallback")
    ab.run("secret", "set", input="abcd-efgh-ijkl-mnop\n")
    path = ab.home / ".config/apple-bridge/app-password"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert ab.run("secret", "get").stdout.strip() == "abcd-efgh-ijkl-mnop"


def test_icloud_passthrough_adds_the_persistent_session(ab):
    ab.run("icloud", "reminders", "lists")
    ab.run("icloud", "reminders", "--help")
    lines = (ab.home / "icloud.log").read_text().splitlines()
    session = ab.home / ".local/state/apple-bridge/pyicloud"
    assert lines[0] == f"reminders lists --username me@icloud.com --session-dir {session}"
    assert lines[1] == "reminders --help"


# ----------------------------------------------------------------- reminders


def test_rem_lists_and_ls(ab):
    assert "Shopping" in ab.run("rem", "lists").stdout
    out = ab.run("rem", "ls", "shop").stdout
    assert "[ ] Milk  (AB12CD34)" in out
    assert "Bread" not in out  # completed
    assert "Bread" in ab.run("rem", "ls", "shop", "-a").stdout
    everything = ab.run("rem", "ls").stdout
    assert "[ ] Send report !!!  due 2026-10-20  (99887766)" in everything


def test_rem_add_sends_apple_style_dates_and_priorities(ab):
    out = ab.run("rem", "add", "Shop", "Eggs", "-d", "2026-10-21", "-p", "high", "-f", "-n", "free range").stdout
    assert out.startswith("added to Shopping: Eggs")
    call = ab.state()["calls"][-1]["create"]
    assert call == {
        "list_id": LIST_SHOP,
        "title": "Eggs",
        "desc": "free range",
        "due_date": "2026-10-21T00:00:00+00:00",
        "priority": 1,
        "flagged": True,
        "all_day": True,
        "time_zone": None,
        "parent_reminder_id": None,
    }

    ab.run("rem", "add", "work", "Standup", "-d", "2026-10-21 09:30")
    call = ab.state()["calls"][-1]["create"]
    assert (call["due_date"], call["all_day"]) == ("2026-10-21T09:30:00+00:00", False)


def test_rem_done_undo_rm_by_short_id(ab):
    done = {"modify": "AB12CD34-0000", "fields": sorted(["Completed", "CompletionDate", *WRITE_FIELDS])}
    ab.run("rem", "done", "ab12")
    assert ab.state()["calls"][-1] == done
    assert ab.state()["updated"]["completed"] is True
    ab.run("rem", "undo", "AB12CD34")
    assert ab.state()["calls"][-1] == done
    assert (ab.state()["updated"]["completed"], ab.state()["updated"]["completed_date"]) == (False, None)
    ab.run("rem", "rm", "99887766")
    assert ab.state()["calls"][-1] == {"modify": "99887766-0000", "fields": sorted(["Deleted", *WRITE_FIELDS])}
    assert "Send report" not in ab.run("rem", "ls").stdout


def test_rem_dump_is_what_the_app_reads(ab):
    data = json.loads(ab.run("rem", "dump").stdout)
    assert [l["title"] for l in data["lists"]] == ["Shopping", "Work"]
    assert data["lists"][0] == {
        "id": "AAAA0000-1111-2222-3333-444455556666", "title": "Shopping", "color": "#1BADF8", "open": 1,
    }
    titles = {r["title"]: r for r in data["reminders"]}
    assert set(titles) == {"Milk", "Send report"}  # completed left out
    report = titles["Send report"]
    assert (report["due_label"], report["all_day"], report["priority"]) == ("2026-10-20", True, 1)
    assert report["list_id"] == "BBBB0000-1111-2222-3333-444455556666"
    full = json.loads(ab.run("rem", "dump", "--completed").stdout)
    assert {r["title"] for r in full["reminders"]} == {"Milk", "Bread", "Send report"}


def test_rem_edit_writes_only_what_changed(ab):
    ab.run("rem", "edit", "ab12", "--due", "2026-11-01 08:15", "--flag")
    assert ab.state()["calls"][-1]["fields"] == sorted(["DueDate", "Flagged", "TimeZone", *WRITE_FIELDS])
    updated = ab.state()["updated"]
    assert (updated["flagged"], updated.get("all_day", False), updated["time_zone"]) == (True, False, "UTC")
    assert updated["due_date"] == "2026-11-01T08:15:00+00:00"
    # The report: all-day, high priority, not flagged.
    ab.run("rem", "edit", "99887766", "--no-due", "--no-flag", "-p", "low")
    assert ab.state()["calls"][-1]["fields"] == sorted(["AllDay", "DueDate", "Priority", *WRITE_FIELDS])
    updated = ab.state()["updated"]
    assert (updated["due_date"], updated["all_day"], updated["priority"]) == (None, False, 9)
    calls = len(ab.state()["calls"])
    assert ab.run("rem", "edit", "99887766", "-p", "low", "--notes", "").stdout.startswith("unchanged: Send report")
    assert len(ab.state()["calls"]) == calls
    proc = ab.run("rem", "edit", "ab12", "--title", "  ", ok=False)
    assert proc.returncode == 1 and "cannot be empty" in proc.stderr


def test_rem_writes_advance_only_their_own_fields_tokens(ab):
    # How Apple's clients tell which change to a field is newest.
    state = ab.state()
    milk = record(state, "reminders", "Reminder/AB12CD34-0000")
    milk["tokens"] = {
        "completed": {"counter": 5, "modificationTime": 1.0, "replicaID": "A"},
        "titleDocument": {"counter": 3, "modificationTime": 1.0, "replicaID": "B"},
        "list": {"counter": 2, "modificationTime": 1.0, "replicaID": "C"},
    }
    Path(ab.env["FAKE_ICLOUD_STATE"]).write_text(json.dumps(state))
    ab.run("rem", "done", "ab12")
    tokens = record(ab.state(), "reminders", "Reminder/AB12CD34-0000")["tokens"]
    assert tokens["completed"]["counter"] == 6 and tokens["completed"]["replicaID"] not in ("A", "B", "C")
    assert tokens["completed"]["modificationTime"] > 800_000_000  # seconds since 2001
    assert tokens["completionDate"]["counter"] == 1 and tokens["lastModifiedDate"]["counter"] == 1
    assert tokens["titleDocument"] == {"counter": 3, "modificationTime": 1.0, "replicaID": "B"}
    assert tokens["list"] == {"counter": 2, "modificationTime": 1.0, "replicaID": "C"}


def test_rem_done_leaves_repeating_and_finished_reminders_alone(ab):
    state = ab.state()
    record(state, "reminders", "Reminder/AB12CD34-0000")["recurrence_rule_ids"] = ["RecurrenceRule/1"]
    Path(ab.env["FAKE_ICLOUD_STATE"]).write_text(json.dumps(state))
    proc = ab.run("rem", "done", "99887766", "ab12", ok=False)
    assert proc.returncode == 1 and '"Milk" repeats' in proc.stderr
    assert ab.state()["calls"] == []  # checked before anything was written
    assert ab.run("rem", "done", "ef56").stdout.startswith("already done: Bread")
    assert ab.state()["calls"] == []


def test_rem_write_conflict_is_a_clear_error(ab):
    state = ab.state()
    state["conflict"] = True
    Path(ab.env["FAKE_ICLOUD_STATE"]).write_text(json.dumps(state))
    proc = ab.run("rem", "done", "ab12", ok=False)
    assert proc.returncode == 1 and "changed on another device" in proc.stderr


INSPECT_DOCUMENT = """
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
const nd = await import(pathToFileURL(process.argv[1] + '/dist/notes/noteDocument.js').href);
const doc = nd.parseNoteDocument(gunzipSync(Buffer.from(process.argv[2], 'base64')));
console.log(JSON.stringify({
  text: doc.text,
  replicas: doc.replicas.map((r) => r.counters),
  runs: doc.runs.map((r) => ({ replica: r.coord.replica, clock: r.coord.clock, length: r.length, tombstone: r.tombstone })),
}));
"""


def with_icloud_md(ab):
    """Title and notes edits run icloud-md's CRDT editor (libexec/abridge-topotext.mjs)."""
    if not ((REAL_ICLOUD_MD / "dist/notes/noteDocument.js").exists() and tool("node")):
        pytest.skip("needs node and icloud-md (or ABRIDGE_TEST_ICLOUD_MD)")
    ab.env["ABRIDGE_ICLOUD_MD_PKG"] = str(REAL_ICLOUD_MD)


def inspect_document(value: str) -> dict:
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", INSPECT_DOCUMENT, str(REAL_ICLOUD_MD), value],
        capture_output=True, text=True, check=True,
    )
    return json.loads(proc.stdout)


def test_rem_title_edits_continue_one_document(ab):
    with_icloud_md(ab)
    ab.run("rem", "edit", "--title=Oat milk", "--", "ab12")
    assert ab.state()["calls"][-1]["fields"] == sorted(["TitleDocument", *WRITE_FIELDS])
    assert ab.state()["updated"]["title"] == "Oat milk"
    replica = (ab.home / ".local/state/apple-bridge/reminders-replica").read_text()
    # What the app sends: options as --opt=value, positionals after --.
    ab.run("rem", "edit", "--title=-1 day left", "--", "ab12")
    milk = ab.state()["updated"]
    assert milk["title"] == "-1 day left"
    assert (ab.home / ".local/state/apple-bridge/reminders-replica").read_text() == replica
    doc = inspect_document(milk["title_doc"])
    assert doc["text"] == "-1 day left"
    # One replica (ours) wrote both versions: the first title's characters are
    # kept as tombstones, and no character id was used twice.
    assert len(doc["replicas"]) == 1
    ours = sorted((r["clock"], r["clock"] + r["length"]) for r in doc["runs"] if r["replica"] == 1)
    assert all(a_end <= b_start for (_, a_end), (b_start, _) in zip(ours, ours[1:]))
    inserted = sum(end - start for start, end in ours)
    assert inserted == doc["replicas"][0][0]  # our clock counts each character once
    assert inserted > len("-1 day left")  # the old characters are still there
    assert any(r["tombstone"] for r in doc["runs"])


def test_rem_notes_are_only_written_when_there_are_some(ab):
    with_icloud_md(ab)
    calls = len(ab.state()["calls"])
    assert ab.run("rem", "edit", "ab12", "--notes", "").stdout.startswith("unchanged")
    assert len(ab.state()["calls"]) == calls  # no empty NotesDocument added
    ab.run("rem", "edit", "ab12", "--notes", "free range")
    assert ab.state()["calls"][-1]["fields"] == sorted(["NotesDocument", *WRITE_FIELDS])
    assert ab.state()["updated"]["desc"] == "free range"
    assert inspect_document(ab.state()["updated"]["notes_doc"])["text"] == "free range"


def test_rem_full_uuid_is_looked_up_directly(ab):
    state = ab.state()
    full = "Reminder/0E9A1F2B-1234-5678-9ABC-DEF012345678"
    state["reminders"].append({"id": full, "list_id": LIST_SHOP, "title": "Eggs"})
    Path(ab.env["FAKE_ICLOUD_STATE"]).write_text(json.dumps(state))
    ab.run("rem", "done", "0E9A1F2B-1234-5678-9ABC-DEF012345678")
    assert ab.state()["calls"][-1]["modify"] == "0E9A1F2B-1234-5678-9ABC-DEF012345678"
    assert not any("list_reminders" in r for r in ab.state().get("reads", []))  # one lookup, no listing


def test_rem_unknown_list_and_ambiguous_id_are_clear_errors(ab):
    proc = ab.run("rem", "ls", "groceries", ok=False)
    assert proc.returncode == 1 and 'no list matches "groceries"' in proc.stderr
    proc = ab.run("rem", "done", "nope", ok=False)
    assert proc.returncode == 1 and "no reminder" in proc.stderr


def test_rem_expired_session_says_how_to_fix_it(ab):
    state = ab.state()
    state["authenticated"] = False
    Path(ab.env["FAKE_ICLOUD_STATE"]).write_text(json.dumps(state))
    proc = ab.run("rem", "ls", ok=False)
    assert proc.returncode == 1 and "abridge setup reminders" in proc.stderr


def test_rem_mirror_is_readable_by_todoman(ab):
    out = ab.run("rem", "mirror").stdout
    assert "2 lists, 3 written" in out
    mirror = ab.data / "reminders"
    assert (mirror / "AAAA0000-1111-2222-3333-444455556666" / "displayname").read_text() == "Shopping"
    if not tool("todo"):
        pytest.skip("todoman not installed")
    listing = ab.run("todo", "list").stdout
    assert "Milk" in listing and "Send report" in listing
    assert "Bread" not in listing  # todoman hides completed by default


def on_phone(ab, edit):
    """Change iCloud the way the iPhone would. edit(state) changes it in place
    and returns the records it touched, which get the next change number, as
    with CloudKit's sync tokens. A deletion returns a tombstone it added."""
    state = ab.state()
    for raw in edit(state):
        state["seq"] = state.get("seq", 0) + 1
        raw["seq"] = state["seq"]
    Path(ab.env["FAKE_ICLOUD_STATE"]).write_text(json.dumps(state))


def reads(ab, kind):
    return [r[kind] for r in ab.state().get("reads", []) if kind in r]


def record(state, kind, rid):
    return next(r for r in state[kind] if r["id"] == rid)


def test_rem_lists_come_from_a_cache_kept_up_to_date(ab):
    ab.run("rem", "lists")
    assert reads(ab, "list_changes") == [None]  # the first time, everything

    def rename_and_add(state):
        work = record(state, "lists", LIST_WORK)
        work["title"] = "Office"
        travel = {"id": "List/CCCC0000-1111-2222-3333-444455556666", "title": "Travel"}
        state["lists"].append(travel)
        return [work, travel]

    on_phone(ab, rename_and_add)
    out = ab.run("rem", "lists").stdout
    assert "Office" in out and "Travel" in out and "Work" not in out
    assert reads(ab, "list_changes") == [None, "0"]

    def delete_shopping(state):
        state["lists"] = [l for l in state["lists"] if l["id"] != LIST_SHOP]
        tombstone = {"id": LIST_SHOP}
        state.setdefault("tombstones", []).append(tombstone)
        return [tombstone]

    on_phone(ab, delete_shopping)
    assert "Shopping" not in ab.run("rem", "lists").stdout
    assert reads(ab, "list_changes") == [None, "0", "2"]
    assert reads(ab, "lists") == []  # pyicloud's own full walk was never needed


def test_rem_lists_cache_starts_over_when_it_cannot_continue(ab):
    cache = ab.home / ".local/state/apple-bridge/reminders-lists.json"
    ab.run("rem", "lists")

    def tweak(**fields):
        cache.write_text(json.dumps({**json.loads(cache.read_text()), **fields}))

    state = ab.state()
    state["seq"] = state["oldest_token"] = 5  # iCloud no longer knows our token
    Path(ab.env["FAKE_ICLOUD_STATE"]).write_text(json.dumps(state))
    assert "Shopping" in ab.run("rem", "lists").stdout
    assert reads(ab, "list_changes") == [None, "0", None]

    tweak(full=json.loads(cache.read_text())["full"] - 86400)  # a day old
    ab.run("rem", "lists")
    tweak(apple_id="someone@icloud.com")
    ab.run("rem", "lists")
    cache.write_text("{")
    ab.run("rem", "lists")
    assert reads(ab, "list_changes")[3:] == [None, None, None]
    ab.run("rem", "lists")
    assert reads(ab, "list_changes")[-1] == "5"


def test_rem_mirror_fetches_only_what_changed(ab):
    shop = ab.data / "reminders" / LIST_SHOP.split("/")[1]
    work = ab.data / "reminders" / LIST_WORK.split("/")[1]
    assert "2 lists, 3 written" in ab.run("rem", "mirror").stdout
    whole_lists = len(reads(ab, "list_reminders"))
    assert whole_lists == 2  # the first time, everything
    assert "0 written, 3 unchanged, 0 removed" in ab.run("rem", "mirror").stdout

    def edits(state):
        milk = record(state, "reminders", "Reminder/AB12CD34-0000")
        milk["title"] = "Oat milk"
        report = record(state, "reminders", "Reminder/99887766-0000")
        report["list_id"] = LIST_SHOP  # moved
        state["reminders"] = [r for r in state["reminders"] if r["id"] != "Reminder/EF56AB78-0000"]
        bread = {"id": "Reminder/EF56AB78-0000"}
        state.setdefault("tombstones", []).append(bread)
        new = {"id": "Reminder/12345678-0000", "list_id": LIST_WORK, "title": "Call Ada"}
        state["reminders"].append(new)
        return [milk, report, bread, new]

    on_phone(ab, edits)
    assert "3 written, 0 unchanged, 2 removed" in ab.run("rem", "mirror").stdout
    assert len(reads(ab, "list_reminders")) == whole_lists
    assert sorted(p.name for p in shop.glob("*.ics")) == ["99887766-0000.ics", "AB12CD34-0000.ics"]
    assert [p.name for p in work.glob("*.ics")] == ["12345678-0000.ics"]
    assert "SUMMARY:Oat milk" in (shop / "AB12CD34-0000.ics").read_text()
    assert "CATEGORIES:Shopping" in (shop / "99887766-0000.ics").read_text()

    # Every file carries its list's name, so a renamed list is copied whole.
    def rename(state):
        work_list = record(state, "lists", LIST_WORK)
        work_list["title"] = "Office"
        return [work_list]

    on_phone(ab, rename)
    ab.run("rem", "mirror")
    assert reads(ab, "list_reminders")[whole_lists:] == [LIST_WORK.split("/")[1]]
    assert (work / "displayname").read_text() == "Office"
    assert "CATEGORIES:Office" in (work / "12345678-0000.ics").read_text()


def test_rem_mirror_copies_everything_when_it_cannot_continue(ab):
    saved = ab.data / "reminders/.abridge-sync.json"
    ab.run("rem", "mirror")
    state = ab.state()
    state["seq"] = state["oldest_token"] = 9  # iCloud no longer knows our token
    Path(ab.env["FAKE_ICLOUD_STATE"]).write_text(json.dumps(state))
    ab.run("rem", "mirror")
    assert len(reads(ab, "list_reminders")) == 4
    assert json.loads(saved.read_text())["token"] == "9"

    saved.write_text(json.dumps({**json.loads(saved.read_text()), "full": 0}))  # long ago
    ab.run("rem", "mirror")
    assert len(reads(ab, "list_reminders")) == 6
    ab.run("rem", "mirror")
    assert len(reads(ab, "list_reminders")) == 6
    assert reads(ab, "reminder_changes")[-1] == "9"


# ---------------------------------------------------------- calendar/contacts


@pytest.fixture
def vdirsyncer_stub(ab):
    python = tool("python3") if not TOOLS else str(Path(TOOLS) / "python")
    probe = subprocess.run([python, "-c", "import vdirsyncer"], capture_output=True)
    if probe.returncode != 0:
        pytest.skip("vdirsyncer is not importable; set ABRIDGE_TEST_TOOLS to a venv bin that has it")
    report = ab.tmp / "vdirsyncer-report.json"
    cal = ab.data / "calendars"
    con = ab.data / "contacts"
    write_exe(
        ab.tmp / "stubs/vdirsyncer",
        f"""#!/bin/sh
echo "$*" >> "$HOME/vdirsyncer.log"
VALIDATE_REPORT="{report}" "{python}" "{FAKES / 'validate_vdirsyncer.py'}" || exit 8
if [ "$1" = discover ]; then
  mkdir -p "{cal}/home" "{con}/card"
  echo Home > "{cal}/home/displayname"
fi
""",
    )
    return report


EVENT = """BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//test//EN\r
BEGIN:VEVENT\r
UID:dentist-1\r
DTSTAMP:20261001T000000Z\r
DTSTART:20261015T100000Z\r
DTEND:20261015T110000Z\r
SUMMARY:Dentist\r
END:VEVENT\r
END:VCALENDAR\r
"""

CARD = """BEGIN:VCARD\r
VERSION:3.0\r
UID:ada-1\r
FN:Ada Lovelace\r
N:Lovelace;Ada;;;\r
TEL;TYPE=CELL:+44 20 7946 0000\r
END:VCARD\r
"""


def test_setup_calendar_writes_configs_the_real_tools_accept(ab, vdirsyncer_stub):
    ab.run("setup", "calendar", input="abcd-efgh-ijkl-mnop\n")
    assert (ab.home / "vdirsyncer.log").read_text().split("\n")[:3] == ["discover", "metasync", "sync"]

    report = json.loads(vdirsyncer_stub.read_text())
    assert report["pairs"] == ["icloud_calendar", "icloud_contacts"]
    remote = report["storages"]["icloud_calendar_remote"]
    assert remote == {"type": "caldav", "password": "abcd-efgh-ijkl-mnop", "item_types": ["VEVENT"]}
    assert report["storages"]["icloud_contacts_remote"]["type"] == "carddav"

    (ab.data / "calendars/home/dentist-1.ics").write_text(EVENT)
    if tool("khal"):
        out = ab.run("cal", "list", "2026-10-15", "1d").stdout
        assert "Dentist" in out
    (ab.data / "contacts/card/ada-1.vcf").write_text(CARD)
    if tool("khard"):
        assert "Ada Lovelace" in ab.run("contacts", "list").stdout


def test_setup_calendar_without_contacts(ab, vdirsyncer_stub):
    ab.run("setup", "calendar", "--no-contacts", input="abcd-efgh-ijkl-mnop\n")
    report = json.loads(vdirsyncer_stub.read_text())
    assert report["pairs"] == ["icloud_calendar"]


# --------------------------------------------------------------------- notes


def git(ab, *args):
    return subprocess.run(["git", "-C", str(ab.home / "Notes"), *args], capture_output=True, text=True, check=True).stdout


def test_notes_clone_pull_push_keep_a_git_history(ab):
    ab.run("setup", "notes", input="n\n")
    assert "clone" in (ab.home / "icloud-md.log").read_text()
    assert "--filename-as-title" not in (ab.home / "icloud-md.log").read_text()
    assert git(ab, "log", "--format=%s").split("\n")[0] == "Clone from iCloud"
    assert ".icloud-md" not in git(ab, "ls-files")

    ab.run("notes", "pull")
    assert git(ab, "log", "-1", "--format=%s").strip() == "Pull from iCloud"
    assert "eggs" in (ab.home / "Notes/Groceries.md").read_text()

    (ab.home / "Notes/Todo.md").write_text("Todo\n\nship it\n")
    ab.run("notes", "push", "--dry-run")
    assert git(ab, "log", "-1", "--format=%s").strip() == "Local edits before push"
    assert (ab.home / "icloud-md.log").read_text().splitlines()[-1].endswith("Notes --dry-run")


def test_notes_push_needs_the_paragraph_fix(ab):
    ab.run("setup", "notes", input="n\n")
    (ab.data / "node/lib/node_modules/icloud-md/dist/notes/formatReconcile.js").write_text("// as released\n")
    proc = ab.run("notes", "push", ok=False)
    assert proc.returncode == 1 and "install.sh" in proc.stderr
    assert not any(line.startswith("push") for line in (ab.home / "icloud-md.log").read_text().splitlines())
    assert "without apple-bridge's paragraph fix" in ab.run("doctor", ok=False).stderr


def test_notes_pull_with_expired_sign_in_fails_without_touching_files(ab):
    ab.run("setup", "notes", input="n\n")
    (ab.home / "notes-expired").touch()
    proc = ab.run("notes", "pull", ok=False)
    assert proc.returncode != 0 and "reauthenticate" in proc.stderr
    assert "eggs" not in (ab.home / "Notes/Groceries.md").read_text()


def test_setup_notes_refuses_a_non_empty_folder(ab):
    (ab.home / "Notes").mkdir()
    (ab.home / "Notes/mine.txt").write_text("x")
    proc = ab.run("setup", "notes", input="n\n", ok=False)
    assert proc.returncode == 1 and "not empty" in proc.stderr


# ---------------------------------------------------------------------- sync


def test_sync_with_nothing_set_up_says_where_to_start(ab):
    proc = ab.run("sync")
    assert "abridge setup calendar" in proc.stderr


def test_sync_runs_each_part_that_is_set_up(ab):
    (ab.home / ".local/state/apple-bridge/pyicloud").mkdir(parents=True)
    (ab.home / ".local/state/apple-bridge/pyicloud/session").write_text("{}")
    ab.run("setup", "notes", input="n\n")
    proc = ab.run("sync")
    assert "Reminders" in proc.stderr and "Notes" in proc.stderr
    assert (ab.data / "reminders" / ".abridge-mirror").exists()
    assert git(ab, "log", "-1", "--format=%s").strip() == "Pull from iCloud"


def test_sync_reports_failure(ab):
    ab.run("setup", "notes", input="n\n")
    (ab.home / "notes-expired").touch()
    assert ab.run("sync", ok=False).returncode == 1


# ---------------------------------------------------------------- phone bits


def test_airdrop_needs_install_first(ab):
    proc = ab.run("airdrop", "send", "/etc/hostname", ok=False)
    assert proc.returncode == 1 and "abridge airdrop install" in proc.stderr


def test_airdrop_send_runs_once_per_file_with_the_receiver(ab, tmp_path):
    log = ab.home / "airdrop.log"
    write_exe(
        ab.data / "src/airdrop-mt7921/airdrop.sh",
        f'#!/bin/sh\necho "$1 $(basename "$2") ACTIVE=$ACTIVE RECEIVER=${{RECEIVER:-}}" >> "{log}"\n',
    )
    a, b = tmp_path / "a.jpg", tmp_path / "b.pdf"
    a.write_text("a")
    b.write_text("b")
    ab.run("airdrop", "send", "--to", "Harsh's iPhone", str(a), str(b))
    assert log.read_text().splitlines() == [
        "send a.jpg ACTIVE=1 RECEIVER=Harsh's iPhone",
        "send b.pdf ACTIVE=1 RECEIVER=Harsh's iPhone",
    ]
    proc = ab.run("airdrop", "send", str(tmp_path / "missing.jpg"), ok=False)
    assert proc.returncode == 1 and "not a file" in proc.stderr


def test_usb_without_a_phone(ab):
    proc = ab.run("usb", "info", ok=False)
    assert proc.returncode == 1
    assert "libimobiledevice" in proc.stderr or "no iPhone found" in proc.stderr


# ------------------------------------------------------------- apps & pair


def test_paths_is_what_the_apps_read(ab):
    out = dict(line.split("=", 1) for line in ab.run("paths").stdout.splitlines())
    assert out["APPLE_ID"] == "me@icloud.com"
    assert out["NOTES_DIR"] == str(ab.home / "Notes")
    assert out["CALENDAR_DIR"] == str(ab.data / "calendars")


def test_sync_one_part_only(ab):
    ab.run("setup", "notes", input="n\n")
    before = git(ab, "log", "--format=%s")
    proc = ab.run("sync", "reminders")
    assert "reminders is not set up yet" in proc.stderr
    assert git(ab, "log", "--format=%s") == before  # notes were not pulled
    ab.run("sync", "notes")
    assert git(ab, "log", "-1", "--format=%s").strip() == "Pull from iCloud"
    assert ab.run("sync", "bogus", ok=False).returncode == 1


def test_apps_install_puts_them_in_the_menu(ab):
    ab.run("apps", "install")
    apps = ab.home / ".local/share/applications"
    for app in ("notes", "calendar", "reminders"):
        entry = (apps / f"abridge-{app}.desktop").read_text()
        assert f"Exec={ABRIDGE} app {app}" in entry
        assert f"StartupWMClass=abridge-{app}" in entry
        assert (ab.home / f".local/share/icons/hicolor/scalable/apps/abridge-{app}.svg").exists()
    ab.run("apps", "remove")
    assert not list(apps.glob("abridge-*.desktop"))


def test_pair_overview(ab):
    ab.run("setup", "notes", input="n\n")
    out = ab.run("pair").stdout
    assert "iCloud Notes" in out and "abridge pair clipboard" in out
    notes_line = next(l for l in out.splitlines() if "iCloud Notes" in l)
    assert "✓" in notes_line
    assert "○" in next(l for l in out.splitlines() if "iCloud Calendar" in l)


def test_app_without_electron_says_how_to_get_it(ab):
    # The names find_electron tries. With one installed, the app would really
    # start (and, with no display in this environment, crash).
    if any(tool(e) for e in ("electron", "electron39", "electron38", "electron37")):
        pytest.skip("electron is installed here")
    proc = ab.run("app", "notes", ok=False)
    assert "pacman" in proc.stderr or "dist is missing" in proc.stderr


def test_rem_titles_starting_with_a_dash(ab):
    # What the Reminders app sends: options as --opt=value, positionals after --.
    ab.run("rem", "add", "--due=2026-10-21", "--", "Shopping", "- buy snacks")
    call = ab.state()["calls"][-1]["create"]
    assert (call["title"], call["list_id"], call["all_day"]) == ("- buy snacks", LIST_SHOP, True)
    # (Editing a title that starts with a dash: test_rem_title_edits_continue_one_document.)
