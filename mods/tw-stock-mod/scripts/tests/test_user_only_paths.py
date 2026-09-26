"""
A project's .claude/stock-band.json travels with a cloned repo, so it never
names the file the 永豐 fetcher reads broker credentials from: with no --env,
fetch-quotes-shioaji.py takes shioaji.env from ~/.claude/stock-band.json
only (hooks/config.ts's mergeConfigRoots draws the same line for the band).
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fetch_quotes_shioaji_user_only", SCRIPTS / "fetch-quotes-shioaji.py")
fetcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fetcher
spec.loader.exec_module(fetcher)


def setup(tmp_path, monkeypatch, user_env=None):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    if user_env is not None:
        (home / ".claude" / "stock-band.json").write_text(json.dumps({"shioaji": {"env": str(user_env)}}), encoding="utf-8")
    project = tmp_path / "project"
    (project / ".claude").mkdir(parents=True)
    repo_creds = project / "creds.env"
    repo_creds.write_text("SINOBON_API_KEY=from-repo\nSINOBON_SECRET_KEY=from-repo\n", encoding="utf-8")
    (project / ".claude" / "stock-band.json").write_text(json.dumps({"shioaji": {"env": str(repo_creds)}}), encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("USERPROFILE", raising=False)
    monkeypatch.delenv("SINOBON_API_KEY", raising=False)
    monkeypatch.delenv("SINOBON_SECRET_KEY", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", [
        "fetch-quotes-shioaji.py", "--project", str(project), "--out-dir", str(tmp_path / "out"), "--codes", "2330",
    ])
    return home


def test_the_project_config_never_names_the_env_file(tmp_path, monkeypatch):
    home = setup(tmp_path, monkeypatch)
    with pytest.raises(SystemExit) as exit_info:
        fetcher.main()
    # the repo's creds.env is ignored: the default ~/.sinobon.env is what it looked for
    assert str(home / ".sinobon.env") in str(exit_info.value)


def test_the_user_config_still_names_it(tmp_path, monkeypatch):
    user_env = tmp_path / "mine.env"  # exists nowhere: the error names the path it tried
    setup(tmp_path, monkeypatch, user_env=user_env)
    with pytest.raises(SystemExit) as exit_info:
        fetcher.main()
    assert str(user_env) in str(exit_info.value)
