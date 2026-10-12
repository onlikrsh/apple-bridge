"""share/patches/icloud-md-*.patch against a real icloud-md package.

Uses the icloud-md install.sh puts under ~/.local/share/apple-bridge, or the
package directory named by ABRIDGE_TEST_ICLOUD_MD; skipped without one of the
pinned version (or without node and patch). The package is copied twice, one
copy left as released and one patched, and tests/icloud_md_scenarios.mjs runs
the same edits through both.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.search(r'ABRIDGE_ICLOUD_MD_VERSION:-([^}"]+)', (ROOT / "lib/common.sh").read_text()).group(1)
PATCH = ROOT / "share/patches" / f"icloud-md-{VERSION}.patch"
SCENARIOS = ROOT / "tests/icloud_md_scenarios.mjs"
MARKER = "apple-bridge patch: uniform paragraph styles"
INSTALLED = Path.home() / ".local/share/apple-bridge/node/lib/node_modules/icloud-md"


def patch(package: Path, *flags: str) -> subprocess.CompletedProcess:
    with PATCH.open("rb") as f:
        return subprocess.run(["patch", "-d", str(package), "-p1", "-s", *flags], stdin=f, capture_output=True)


@pytest.fixture(scope="module")
def packages(tmp_path_factory):
    source = Path(os.environ.get("ABRIDGE_TEST_ICLOUD_MD", INSTALLED))
    if not (source / "package.json").exists():
        pytest.skip(f"icloud-md not installed at {source}")
    if json.loads((source / "package.json").read_text())["version"] != VERSION:
        pytest.skip(f"icloud-md at {source} is not {VERSION}")
    if not (shutil.which("node") and shutil.which("patch")):
        pytest.skip("needs node and patch")
    base = tmp_path_factory.mktemp("icloud-md")
    released = base / "released"
    shutil.copytree(source, released, symlinks=True)
    if MARKER in (released / "dist/notes/formatReconcile.js").read_text():
        assert patch(released, "-R").returncode == 0, "the installed icloud-md's patch doesn't reverse cleanly"
    patched = base / "patched"
    shutil.copytree(released, patched, symlinks=True)
    result = patch(patched, "-N")
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode()
    return released, patched


def run_scenarios(edit_with: Path, detect_with: Path) -> dict[str, dict]:
    proc = subprocess.run(
        ["node", str(SCENARIOS), str(edit_with / "dist"), str(detect_with / "dist")],
        capture_output=True, text=True, check=True,
    )
    rows = [json.loads(line) for line in proc.stdout.splitlines()]
    return {r["name"]: r for r in rows}


def test_patch_applies_to_the_pinned_release(packages):
    released, patched = packages
    assert MARKER not in (released / "dist/notes/formatReconcile.js").read_text()
    assert MARKER in (patched / "dist/notes/formatReconcile.js").read_text()
    assert "mixedParagraphStyles" in (patched / "dist/commands/push.js").read_text()


def test_released_icloud_md_leaves_mixed_paragraphs_its_own_check_misses(packages):
    released, patched = packages
    results = run_scenarios(released, patched)
    for name in ("type at the start of a checklist item", "type at the start of a heading after a list"):
        r = results[name]
        assert r["startMixed"] == []
        assert r["mixed"], f"{name}: expected the released icloud-md to leave a mixed paragraph"
        assert r["verified"], f"{name}: icloud-md's own verification should (wrongly) accept it"
        assert r["detected"] == r["mixed"], f"{name}: the patch's push guard must catch it"


def test_patched_icloud_md_keeps_every_paragraph_uniform(packages):
    _, patched = packages
    scenarios = {n: r for n, r in run_scenarios(patched, patched).items() if r["kind"] == "scenario"}
    assert len(scenarios) >= 6
    for name, r in scenarios.items():
        assert r["mixed"] == [] and r["detected"] == [], name
        assert r["verified"], f"{name}: the patched result must still pass icloud-md's verification"


def test_the_guard_ignores_what_apple_writes_itself(packages):
    _, patched = packages
    results = run_scenarios(patched, patched)
    assert results["same style"]["detected"] == []
    assert results["explicit vs implicit zero"]["detected"] == []
    assert results["body vs checklist"]["detected"] == [0]
