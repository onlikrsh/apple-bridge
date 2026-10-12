"""The clipboard bridge (libexec/abridge-clipd), served for real on a local
port, with fake wl-copy/wl-paste standing in for the desktop clipboard."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import stat
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_loader = importlib.machinery.SourceFileLoader("abridge_clipd", str(ROOT / "libexec" / "abridge-clipd"))
_spec = importlib.util.spec_from_loader("abridge_clipd", _loader)
clipd = importlib.util.module_from_spec(_spec)
_loader.exec_module(clipd)

FAKE_COPY = """#!/bin/sh
# fake wl-copy: [--type MIME] < data
type=text/plain
[ "$1" = --type ] && type="$2"
cat > "$CLIP_DIR/data"
printf '%s\\n' "$type" > "$CLIP_DIR/types"
"""
FAKE_PASTE = """#!/bin/sh
# fake wl-paste: --list-types | --no-newline [--type MIME]
[ -f "$CLIP_DIR/data" ] || exit 1
if [ "$1" = --list-types ]; then cat "$CLIP_DIR/types"; exit 0; fi
cat "$CLIP_DIR/data"
"""


def exe(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


@pytest.fixture
def server(tmp_path, monkeypatch):
    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    exe(fakebin / "wl-copy", FAKE_COPY)
    exe(fakebin / "wl-paste", FAKE_PASTE)
    clip_dir = tmp_path / "clip"
    clip_dir.mkdir()
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("CLIP_DIR", str(clip_dir))
    monkeypatch.setattr(clipd, "CONFIG_DIR", tmp_path / "config")
    monkeypatch.setattr(clipd, "CONFIG", tmp_path / "config" / "clip.json")
    monkeypatch.setattr(clipd, "PAIR", tmp_path / "config" / "clip-pair.json")
    monkeypatch.setattr(clipd, "notify", lambda *a: None)
    cfg = clipd.ensure_config()
    env = {"WAYLAND_DISPLAY": "wayland-0", "PATH": os.environ["PATH"], "CLIP_DIR": str(clip_dir)}
    handler = type("H", (clipd.Handler,), {"cfg": cfg, "clipboard_env": env, "log_message": lambda *a: None})
    httpd = clipd.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def call(path, method="GET", data=None, token=cfg["token"], ctype="text/plain"):
        req = urllib.request.Request(base + path, data=data, method=method)
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        if data is not None:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read(), resp.headers.get("Content-Type")
        except urllib.error.HTTPError as err:
            return err.code, err.read(), err.headers.get("Content-Type")

    yield type("S", (), {"call": staticmethod(call), "cfg": cfg, "clip": clip_dir, "base": base})
    httpd.shutdown()


def test_token_is_required(server):
    assert server.call("/ping", token=None)[0] == 401
    assert server.call("/ping", token="wrong")[0] == 401
    assert server.call("/ping")[:2] == (200, b"ok\n")


def test_text_round_trip(server):
    status, _, _ = server.call("/clipboard", "POST", "héllo from the iPhone 📱".encode())
    assert status == 200
    time.sleep(0.2)
    assert (server.clip / "data").read_text() == "héllo from the iPhone 📱"
    status, body, ctype = server.call("/clipboard")
    assert (status, body.decode(), ctype) == (200, "héllo from the iPhone 📱", "text/plain; charset=utf-8")


def test_images_both_ways(server):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    assert server.call("/clipboard", "POST", png, ctype="image/png")[0] == 200
    time.sleep(0.2)
    assert (server.clip / "types").read_text().strip() == "image/png"
    status, body, ctype = server.call("/clipboard")
    assert (status, body, ctype) == (200, png, "image/png")


def test_empty_clipboard_is_204(server):
    assert server.call("/clipboard")[0] == 204


def test_body_limits(server, monkeypatch):
    monkeypatch.setattr(clipd, "MAX_BODY", 10)
    assert server.call("/clipboard", "POST", b"x" * 11)[0] == 413
    assert server.call("/clipboard", "POST", b"")[0] == 400


def test_pair_page_needs_a_fresh_code(server):
    assert server.call("/pair?code=123456", token=None)[0] == 403
    clipd.PAIR.write_text(json.dumps({"code": "123456", "expires": time.time() + 60}))
    status, body, ctype = server.call("/pair?code=123456", token=None)
    assert status == 200 and ctype.startswith("text/html")
    page = body.decode()
    assert f"Bearer {server.cfg['token']}" in page
    assert f"{server.base}/clipboard" in page
    assert server.call("/pair?code=000000", token=None)[0] == 403
    clipd.PAIR.write_text(json.dumps({"code": "123456", "expires": time.time() - 1}))
    assert server.call("/pair?code=123456", token=None)[0] == 403


def test_only_local_networks():
    for ok in ("127.0.0.1", "192.168.1.20", "10.0.0.7", "172.20.1.1", "169.254.3.3", "::1", "fe80::1%wlan0", "::ffff:192.168.1.9", "fd00::5"):
        assert clipd.client_allowed(ok), ok
    for bad in ("8.8.8.8", "1.1.1.1", "2001:4860::8888", "nonsense"):
        assert not clipd.client_allowed(bad), bad


def test_config_is_private_and_reset_changes_the_token(server):
    assert stat.S_IMODE(clipd.CONFIG.stat().st_mode) == 0o600
    old = server.cfg["token"]
    clipd.main(["abridge-clipd", "reset"])
    assert json.loads(clipd.CONFIG.read_text())["token"] != old


def test_without_a_display_it_says_what_to_do():
    assert "no graphical session" in clipd.Clipboard({"PATH": "/nonexistent"}).available()
    assert "wl-clipboard" in clipd.Clipboard({"WAYLAND_DISPLAY": "w", "PATH": "/nonexistent"}).available()
