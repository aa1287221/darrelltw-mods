"""The scripts under test import `_common` from their own folder, which is
sys.path[0] when they run as scripts. Loaded here by file path instead, so
that folder goes on sys.path for them."""
import sys
from pathlib import Path

SCRIPTS = str(Path(__file__).resolve().parents[1])
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)
