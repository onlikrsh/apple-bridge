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
    ab.run("rem", "done", "ab12")
    assert ab.state()["calls"][-1] == {"update": "AB12CD34-0000", "completed": True}
    ab.run("rem", "undo", "AB12CD34")
    assert ab.state()["calls"][-1] == {"update": "AB12CD34-0000", "completed": False}
    ab.run("rem", "rm", "99887766")
    assert ab.state()["calls"][-1] == {"delete": "99887766-0000"}


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
