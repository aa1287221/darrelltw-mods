"""
fetch-quotes-shioaji.py's give-up rule, run for real: the script's own main
loop in a subprocess against a stub `shioaji` package, with GIVE_UP_AFTER_S
shrunk to a fraction of a second so a dead session gives up within a few
ticks. A heartbeat naming only `tf` makes every tick a futures-only tick
(夜盤).

  - a --futures code that resolves to no contract (expired month, typo) has
    nothing to price: a healthy session must keep running, not exit and
    re-login every GIVE_UP_AFTER_S;
  - a code that resolves but whose snapshots come back empty is a dead
    session: it must give up (exit 1) - on the futures side and, with a `tw`
    heartbeat, on the stock side alike.
"""
import json
import subprocess
import sys
import textwrap
import time
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]

FAKE_SHIOAJI = textwrap.dedent(
    """
    import types

    class _Book:
        def __init__(self, known=None):
            self.known = known
        def __getitem__(self, code):
            if self.known is not None and code not in self.known:
                return None
            return types.SimpleNamespace(code=code, name=code, target_code=code, reference=100.0)

    class Shioaji:
        def __init__(self):
            self.Contracts = types.SimpleNamespace(
                Stocks=_Book(),
                Futures=_Book(known={"TXFR1"}),
                Indexs=types.SimpleNamespace(TSE=_Book(), OTC=_Book()),
            )
            self.stock_account = None
            self.futopt_account = None
        def login(self, **kw): pass
        def logout(self): pass
        def snapshots(self, contracts): return []  # healthy or dead, only the codes decide here
        def list_positions(self, *a, **k): return []
        def set_on_tick_stk_v1_callback(self, f): pass
        def set_on_tick_fop_v1_callback(self, f): pass
        def set_event_callback(self, f): pass

    class _Enum:
        def __getattr__(self, name): return name

    constant = types.SimpleNamespace(QuoteType=_Enum(), QuoteVersion=_Enum())
    """
)

RUNNER = textwrap.dedent(
    """
    import runpy, sys
    scripts, fake = sys.argv[1], sys.argv[2]
    sys.path[:0] = [scripts, fake]
    import _common
    _common.GIVE_UP_AFTER_S = 0.3  # 3 ticks at --interval 0.1
    sys.argv = [scripts + "/fetch-quotes-shioaji.py"] + sys.argv[3:]
    runpy.run_path(sys.argv[0], run_name="__main__")
    """
)


def start_fetcher(tmp_path, futures_code, markets=("tf",), extra=()):
    fake = tmp_path / "fake"
    (fake / "shioaji").mkdir(parents=True)
    (fake / "shioaji" / "__init__.py").write_text(FAKE_SHIOAJI, encoding="utf-8")
    env_file = tmp_path / "sinobon.env"
    env_file.write_text("SINOBON_API_KEY=k\nSINOBON_SECRET_KEY=s\n", encoding="utf-8")
    heartbeat = tmp_path / "heartbeat.json"
    heartbeat.write_text(json.dumps({"ts": time.time() * 1000, "markets": list(markets)}), encoding="utf-8")
    project = tmp_path / "project"
    project.mkdir()
    out = tmp_path / "out"
    out.mkdir()
    args = [
        "--project", str(project), "--out-dir", str(out), "--env", str(env_file),
        "--heartbeat", str(heartbeat), "--futures", futures_code, "--interval", "0.1", *extra,
    ]
    return subprocess.Popen(
        [sys.executable, "-c", RUNNER, str(SCRIPTS), str(fake), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def test_unresolvable_futures_code_is_not_a_dead_session(tmp_path):
    proc = start_fetcher(tmp_path, "MXFJ6")  # expired month: resolves to no contract
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass  # still running after ~10x the give-up window: correct
    finally:
        if proc.poll() is None:
            proc.kill()
        output = proc.communicate()[0]
    assert "結束讓 band 重新登入" not in output, output
    assert proc.returncode != 1, output


def test_resolved_futures_code_with_empty_snapshots_gives_up(tmp_path):
    proc = start_fetcher(tmp_path, "TXFR1")
    try:
        output = proc.communicate(timeout=15)[0]
    finally:
        if proc.poll() is None:
            proc.kill()
    assert proc.returncode == 1, output
    assert "結束讓 band 重新登入" in output


def test_stock_codes_with_empty_snapshots_give_up(tmp_path):
    proc = start_fetcher(tmp_path, "MXFJ6", markets=("tw",), extra=("--codes", "2330"))
    try:
        output = proc.communicate(timeout=15)[0]
    finally:
        if proc.poll() is None:
            proc.kill()
    assert proc.returncode == 1, output
    assert "結束讓 band 重新登入" in output
