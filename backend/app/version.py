"""
ODIN Version Information
Loaded once at import time from version.json at the project root.
"""

import json
from pathlib import Path

# backend/app/version.py -> backend/app -> backend -> od_validation_system
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

VERSION_FILE = PROJECT_ROOT / "version.json"
LOCAL_VERSION = "0.0.0"
LOCAL_RELEASE_DATE = "unknown"

try:
    _vdata = json.loads(VERSION_FILE.read_text(encoding="utf-8"))
    LOCAL_VERSION = _vdata.get("version", LOCAL_VERSION)
    LOCAL_RELEASE_DATE = _vdata.get("release_date", LOCAL_RELEASE_DATE)
except Exception:
    pass  # version.json missing or malformed — use defaults
