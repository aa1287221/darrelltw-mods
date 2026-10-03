"""
`--detach` (scripts/_common.py's relaunch_detached), which is how the band
starts the 永豐 fetcher on Windows - there is no `/bin/sh` or `nohup` there -
and how it has always started 群益's:

  - the child gets the caller's arguments minus `--detach`, run by the same
    interpreter against the CALLER's script (not _common.py), with no stdin
    and its output appended to the log;
  - the log handle appends in the kernel, so cap_log() cutting the file back
    never leaves the child writing at the old offset (on Windows a plain `a`
    handle did: the gap came back as NULs);
  - fetch-quotes-shioaji.py hands off before it chdir()s, claims the pidfile
    or logs in, and its --check no longer refuses win32;
  - run for real against a stub `shioaji`: the launcher returns at once even
    with its own output on pipes (what the band's one-shot `$.process.run`
    waits on), and the detached child logs to --log, exits on a stale
    heartbeat and gives the pidfile back.
"""
import importlib.util
import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

import _common

SCRIPTS = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("fetch_quotes_shioaji_detach", SCRIPTS / "fetch-quotes-shioaji.py")
fetcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fetcher
spec.loader.exec_module(fetcher)


class FakePopen:
    """Records one Popen call instead of starting anything."""

    calls = []

    def __init__(self, argv, **kwargs):
        FakePopen.calls.append((argv, kwargs))


@pytest.fixture(autouse=True)
def _reset_fake_popen():
    FakePopen.calls = []


# --- relaunch_detached ---------------------------------------------------------


def test_relaunch_drops_detach_and_runs_the_callers_script(tmp_path):
    log_path = tmp_path / "logs" / "stock-shioaji.log"
    script = str(tmp_path / "fetch-quotes-shioaji.py")
    _common.relaunch_detached(
        script, log_path, argv=["--out-dir", "o", "--detach", "--log", str(log_path), "--codes", "2330"], popen=FakePopen,
    )
    (argv, kwargs), = FakePopen.calls
    assert argv == [sys.executable, script, "--out-dir", "o", "--log", str(log_path), "--codes", "2330"]
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["stdout"] is kwargs["stderr"]  # one log for both
    assert kwargs["close_fds"] is True  # the launcher's own pipes stay out of the child
    assert log_path.parent.is_dir()  # created for the child to append to


def test_relaunch_detaches_the_platform_way(tmp_path):
    _common.relaunch_detached("s.py", tmp_path / "x.log", argv=[], popen=FakePopen)
    (_, kwargs), = FakePopen.calls
    if os.name == "nt":
        expected = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        assert kwargs["creationflags"] == expected
        assert "start_new_session" not in kwargs
    else:
        assert kwargs["start_new_session"] is True
        assert "creationflags" not in kwargs


def test_relaunch_cwd_defaults_to_the_log_folder_and_takes_the_callers(tmp_path):
    log_path = tmp_path / "logs" / "x.log"
    _common.relaunch_detached("s.py", log_path, argv=[], popen=FakePopen)
    _common.relaunch_detached("s.py", log_path, cwd=str(tmp_path), argv=[], popen=FakePopen)
    assert [kwargs["cwd"] for _, kwargs in FakePopen.calls] == [str(log_path.parent), str(tmp_path)]


def test_relaunch_defaults_to_this_process_argv(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["fetch-quotes-capital.py", "--detach", "--interval", "10"])
    _common.relaunch_detached("s.py", tmp_path / "x.log", popen=FakePopen)
    (argv, _), = FakePopen.calls
    assert argv[2:] == ["--interval", "10"]


# Echoes each stdin line to stderr - a stand-in for a detached fetcher that
# writes to an inherited log handle whenever it likes. Bytes in, bytes out: a
# text stream would turn "\n" into "\r\n" on Windows.
ECHO_CHILD = "import sys\nfor line in sys.stdin.buffer:\n    sys.stderr.buffer.write(line)\n    sys.stderr.buffer.flush()\n"


def wait_for(path, needle, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle in path.read_bytes():
            return
        time.sleep(0.02)
    raise AssertionError(f"{needle!r} never reached {path}: {path.read_bytes()!r}")


def test_append_log_survives_cap_log_in_a_child(tmp_path):
    # the child holds the handle open_append_log made (as a detached fetcher
    # does); cap_log cuts the file under it, and the child's next line must
    # land at the NEW end - no NUL padding up to the old offset
    path = tmp_path / "stock-shioaji.log"
    path.write_bytes(b"x" * 4000 + b"\n")
    with _common.open_append_log(path) as log_file:
        child = subprocess.Popen([sys.executable, "-c", ECHO_CHILD], stdin=subprocess.PIPE, stdout=log_file, stderr=log_file)
    try:
        child.stdin.write(b"before cap\n")
        child.stdin.flush()
        wait_for(path, b"before cap\n")
        assert _common.cap_log(path, max_bytes=100, keep_bytes=20) is True
        child.stdin.write(b"after cap\n")
        child.stdin.close()
        child.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.kill()
    data = path.read_bytes()
    assert b"\0" not in data, data[:80]
    assert data == b"before cap\nafter cap\n"


# --- fetch-quotes-shioaji.py ---------------------------------------------------


@pytest.mark.parametrize("platform", ["win32", "darwin", "linux"])
def test_check_platform_passes_everywhere_and_names_it(platform, monkeypatch, capsys):
    monkeypatch.setattr(sys, "platform", platform)
    assert fetcher.check_platform() is True
    out = capsys.readouterr().out
    assert f"✅ 平台 {platform}" in out
    assert ("--detach" in out) == (platform == "win32")


def test_main_detach_hands_off_before_chdir_pidfile_or_login(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(fetcher, "relaunch_detached", lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(fetcher, "claim_pidfile", lambda *a: pytest.fail("the launcher must not claim the pidfile"))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", [
        "fetch-quotes-shioaji.py", "--project", ".", "--out-dir", "out", "--env", "creds.env",
        "--pidfile", "out/p.pid", "--log", "logs/sj.log", "--codes", "2330", "--detach",
    ])
    fetcher.main()
    assert Path.cwd() == tmp_path  # no chdir into out_dir: that is the child's
    (args, kwargs), = calls
    assert args[0].endswith("fetch-quotes-shioaji.py") and os.path.isabs(args[0])
    assert args[1] == tmp_path / "logs" / "sj.log"  # --log, made absolute
    assert kwargs["cwd"] == str(tmp_path)  # relative args mean the same in the child
    assert not (tmp_path / "out" / "p.pid").exists()


def test_main_detach_logs_to_the_out_dir_by_default(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(fetcher, "relaunch_detached", lambda *a, **k: calls.append(a))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["fetch-quotes-shioaji.py", "--out-dir", "out", "--env", "creds.env", "--detach"])
    fetcher.main()
    args, = calls
    assert args[1] == (tmp_path / "out").resolve() / "stock-shioaji.log"


# --- the real thing, against a stub shioaji -------------------------------------

FAKE_SHIOAJI = textwrap.dedent(
    """
    import types

    class _Book:
        def __getitem__(self, code):
            return types.SimpleNamespace(code=code, name=code, target_code=code, reference=100.0)

    class Shioaji:
        def __init__(self):
            self.Contracts = types.SimpleNamespace(
                Stocks=_Book(), Futures=_Book(), Indexs=types.SimpleNamespace(TSE=_Book(), OTC=_Book()),
            )
            self.stock_account = None
            self.futopt_account = None
        def login(self, **kw): print("stub login", flush=True)
        def logout(self): pass
        def snapshots(self, contracts): return []
        def list_positions(self, *a, **k): return []
        def set_on_tick_stk_v1_callback(self, f): pass
        def set_on_tick_fop_v1_callback(self, f): pass
        def set_event_callback(self, f): pass

    class _Enum:
        def __getattr__(self, name): return name

    constant = types.SimpleNamespace(QuoteType=_Enum(), QuoteVersion=_Enum())
    """
)


def test_detached_fetcher_runs_past_its_launcher_and_cleans_up(tmp_path):
    fake = tmp_path / "fake"
    (fake / "shioaji").mkdir(parents=True)
    (fake / "shioaji" / "__init__.py").write_text(FAKE_SHIOAJI, encoding="utf-8")
    env_file = tmp_path / "sinobon.env"
    env_file.write_text("SINOBON_API_KEY=k\nSINOBON_SECRET_KEY=s\n", encoding="utf-8")
    # stale from the start: the first tick is exempt, the second one exits
    heartbeat = tmp_path / "heartbeat.json"
    heartbeat.write_text(json.dumps({"ts": time.time() * 1000 - 600_000, "markets": ["tf"]}), encoding="utf-8")
    out = tmp_path / "out"
    log_path = tmp_path / "logs" / "stock-shioaji.log"
    pidfile = out / "stock-shioaji.pid"
    env = dict(os.environ, PYTHONPATH=os.pathsep.join([str(fake), os.environ.get("PYTHONPATH", "")]).rstrip(os.pathsep))

    started = time.monotonic()
    # capture_output: the launcher's stdout/stderr are pipes, like the band's
    # run() - it returns only once nothing holds them open any more
    launcher = subprocess.run(
        [
            sys.executable, str(SCRIPTS / "fetch-quotes-shioaji.py"), "--project", str(tmp_path), "--out-dir", str(out),
            "--env", str(env_file), "--heartbeat", str(heartbeat), "--pidfile", str(pidfile), "--futures", "TXFR1",
            "--interval", "0.2", "--log", str(log_path), "--detach",
        ],
        capture_output=True, timeout=30, env=env, cwd=str(tmp_path),
    )
    assert launcher.returncode == 0, launcher.stderr
    assert time.monotonic() - started < 15

    deadline = time.monotonic() + 30
    text = ""
    while time.monotonic() < deadline:
        text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        if "已登出" in text and not pidfile.exists():
            break
        time.sleep(0.1)
    assert "stub login" in text, text
    assert "心跳逾時" in text, text  # the detached child ran its loop and left on the stale heartbeat
    assert "已登出" in text, text
    assert "Traceback" not in text, text
    assert not pidfile.exists(), "the detached child gave its pidfile back"
