"""
fetch-quotes-capital.py's main loop against a fake SKCOM, one scripted
未實現損益 answer per tick: the subscription follows the holdings file (a
sold code stops being subscribed and priced), and a failed or missing
answer is logged once per change rather than every tick.
"""
import importlib.util
import sys
import types
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fetch_quotes_capital_loop", SCRIPTS / "fetch-quotes-capital.py")
capital = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = capital
spec.loader.exec_module(capital)

WATCH = "2330"
PRICES = {"2330": 1100.0, "2454": 1500.0, "0050": 190.0, "TSEA": 20000.0}


def pl_row(code: str, qty: int = 1000) -> str:
    fields = [""] * capital.PL_MIN_FIELDS
    fields[capital.PL_NAME] = code
    fields[capital.PL_CODE] = code
    fields[capital.PL_QTY] = str(qty)
    fields[capital.PL_PRICE] = str(PRICES[code])
    fields[capital.PL_CHANGE] = "0"
    fields[capital.PL_COST] = str(PRICES[code])
    fields[capital.PL_TRADE_TYPE] = "0"
    return ",".join(fields)


def fake_capital(script):
    """A Capital stand-in whose request_holdings answers script[tick]; the
    pump after the last scripted tick ends the run."""

    class FakeCapital:
        subscriptions: list = []

        def __init__(self, dll_path, log_dir):
            self.connected = True
            self.connection_error = ""
            self.pl_status = ""
            self.pl_rows: list = []
            self.tick = 0

        def load(self):
            pass

        def login(self, user_id, password):
            pass

        def enter_monitor(self, timeout, progress=None):
            pass

        def init_order(self, user_id):
            return "TS-ACCOUNT"  # any non-empty account: the fake answers every query

        def quote_state(self):
            return capital.QUOTE_STATE_READY

        def subscribe(self, codes):
            FakeCapital.subscriptions.append(list(codes))

        def stock(self, code):
            price = PRICES.get(code)
            if price is None:
                return None
            return types.SimpleNamespace(sDecimal=2, nClose=int(price * 100), nRef=int(price * 100), nTradingDay=0, nDealTime=0)

        def request_holdings(self, user_id, account):
            self.pl_status, self.pl_rows = script[self.tick]

        def pump(self, seconds):
            self.tick += 1
            if self.tick > len(script):
                raise KeyboardInterrupt

        def logout(self):
            pass

    return FakeCapital


def run(tmp_path, monkeypatch, script):
    env = tmp_path / "capital.env"
    env.write_text("CAPITAL_USER_ID=fake-user\nCAPITAL_PASSWORD=x\n", encoding="utf-8")
    out = tmp_path / "out"
    fake = fake_capital(script)
    monkeypatch.setattr(capital, "Capital", fake)
    monkeypatch.chdir(tmp_path)  # main() chdirs into the out dir; this restores the cwd afterwards
    monkeypatch.setattr(sys, "argv", [
        "fetch-quotes-capital.py", "--project", str(tmp_path), "--out-dir", str(out), "--env", str(env),
        "--dll", str(tmp_path / "SKCOM.dll"), "--codes", WATCH, "--indices", "TSEA:TAIEX", "--interval", "1",
    ])
    capital.main()
    return fake.subscriptions, out


OK = "000,查詢成功"


def test_the_subscription_follows_the_held_codes_both_ways(tmp_path, monkeypatch):
    subs, out = run(tmp_path, monkeypatch, [
        (OK, [pl_row("2454"), pl_row("0050")]),
        (OK, [pl_row("0050")]),  # 2454 sold
        (OK, [pl_row("0050")]),
    ])
    assert subs == [
        ["2330", "TSEA"],
        ["2330", "2454", "0050", "TSEA"],
        ["2330", "0050", "TSEA"],
    ]
    quotes = (out / "stock-quotes.json").read_text(encoding="utf-8")
    assert '"0050"' in quotes and '"2454"' not in quotes  # the tick after the shrink prices the new set


def test_a_failed_or_missing_answer_is_logged_once_per_change(tmp_path, monkeypatch, capsys):
    subs, _ = run(tmp_path, monkeypatch, [
        (OK, [pl_row("2454")]),
        ("601,查無帳號資料", []),
        ("601,查無帳號資料", []),
        ("", []),
        (OK, [pl_row("2454")]),
    ])
    err = capsys.readouterr().err
    assert err.count("庫存查詢失敗") == 1 and "601,查無帳號資料" in err
    assert err.count("沒有回應") == 1
    assert err.count("庫存查詢恢復正常") == 1
    # a tick with no holdings answer keeps the held codes it had
    assert subs == [["2330", "TSEA"], ["2330", "2454", "TSEA"]]
