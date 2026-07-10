import os
import pandas as pd
from pathlib import Path

# Module-level variables for caching
COMMODITY_DB = None
COMMODITY_UNICODE = None
EXACT_MATCH_DICT = {}

def load_commodity_databases():
    global COMMODITY_DB, COMMODITY_UNICODE, EXACT_MATCH_DICT
    
    # Define paths
    project_root = Path(__file__).resolve().parent.parent.parent.parent
    db_path = project_root / "database" / "Commodity_DB.csv"
    unicode_path = project_root / "database" / "Commodity_unicode.csv"
    
    try:
        if db_path.exists():
            COMMODITY_DB = pd.read_csv(db_path, dtype=str)
            # Create exact match dictionary (case-insensitive)
            for _, row in COMMODITY_DB.iterrows():
                comm = str(row.get('Commodity', '')).strip().lower()
                if comm and pd.notna(row.get('Commodity')):
                    EXACT_MATCH_DICT[comm] = {
                        'Detailed_Comm_code': str(row.get('Detailed_Comm_code', '')).strip(),
                        'Abstract_Comm_code': str(row.get('Abstract_Comm_code', '')).strip()
                    }
    except Exception as e:
        print(f"Failed to load Commodity_DB.csv: {e}")

    try:
        if unicode_path.exists():
            COMMODITY_UNICODE = pd.read_csv(unicode_path, dtype=str)
            COMMODITY_UNICODE = COMMODITY_UNICODE.fillna("").to_dict(orient="records")
    except Exception as e:
        print(f"Failed to load Commodity_unicode.csv: {e}")

def get_commodity_suggestions():
    global COMMODITY_UNICODE
    if COMMODITY_UNICODE is None:
        return []
    return COMMODITY_UNICODE

def exact_match_commodity(commodity_str):
    global EXACT_MATCH_DICT
    if not commodity_str or pd.isna(commodity_str):
        return None
    comm_clean = str(commodity_str).strip().lower()
    return EXACT_MATCH_DICT.get(comm_clean)
