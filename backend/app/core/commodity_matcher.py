import os
import pandas as pd
from pathlib import Path
from difflib import SequenceMatcher

# Module-level variables for caching
COMMODITY_DB = None
COMMODITY_UNICODE = None
# commodity.lower() -> full row dict including 'Commodity', 'Detailed_Comm_code', etc.
EXACT_MATCH_DICT = {}
CODE_TO_NAME_DICT = {}  # Detailed_Comm_code -> Detailed_Comm_Name
DB_RECORDS = []   # All rows of Commodity_DB as dicts (for fuzzy matching)

def load_commodity_databases():
    global COMMODITY_DB, COMMODITY_UNICODE, EXACT_MATCH_DICT, DB_RECORDS, CODE_TO_NAME_DICT
    
    project_root = Path(__file__).resolve().parent.parent.parent.parent
    db_path = project_root / "database" / "Commodity_DB.csv"
    unicode_path = project_root / "database" / "Commodity_unicode.csv"
    
    try:
        if db_path.exists():
            COMMODITY_DB = pd.read_csv(db_path, dtype=str).fillna("")
            DB_RECORDS = COMMODITY_DB.to_dict(orient="records")
            # Build exact match dictionary (case-insensitive, strip whitespace)
            # Key: commodity.lower() -> full row including original Commodity name
            for row in DB_RECORDS:
                comm = str(row.get('Commodity', '')).strip()
                code = str(row.get('Detailed_Comm_code', '')).strip()
                name = str(row.get('Detailed_Comm_Name', '')).strip()
                if code and name and code not in CODE_TO_NAME_DICT:
                    CODE_TO_NAME_DICT[code] = name
                
                if comm:
                    EXACT_MATCH_DICT[comm.lower()] = {
                        'Commodity': comm,                                             # original DB commodity name
                        'Detailed_Comm_code': code,
                        'Detailed_Comm_Name': name,
                        'Abstract_Comm_code': str(row.get('Abstract_Comm_code', '')).strip(),
                        'Abstract_Comm_Name': str(row.get('Abstract_Comm_Name', '')).strip(),
                    }
            print(f"Loaded Commodity_DB: {len(DB_RECORDS)} rows, {len(EXACT_MATCH_DICT)} unique entries.")

        else:
            print(f"Warning: Commodity_DB.csv not found at {db_path}")
    except Exception as e:
        print(f"Failed to load Commodity_DB.csv: {e}")

    try:
        if unicode_path.exists():
            df_uni = pd.read_csv(unicode_path, dtype=str).fillna("")
            COMMODITY_UNICODE = df_uni.to_dict(orient="records")
            print(f"Loaded Commodity_unicode: {len(COMMODITY_UNICODE)} rows.")
        else:
            print(f"Warning: Commodity_unicode.csv not found at {unicode_path}")
    except Exception as e:
        print(f"Failed to load Commodity_unicode.csv: {e}")


def get_commodity_suggestions():
    """Returns the full Commodity_unicode list."""
    global COMMODITY_UNICODE
    if COMMODITY_UNICODE is None:
        return []
    return COMMODITY_UNICODE


def exact_match_commodity(commodity_str):
    """
    Returns the full DB row dict (including original Commodity name) if
    commodity_str is a 100% case-insensitive match in Commodity_DB.
    Returns None if no match.
    """
    global EXACT_MATCH_DICT
    if not commodity_str or pd.isna(commodity_str):
        return None
    comm_clean = str(commodity_str).strip().lower()
    return EXACT_MATCH_DICT.get(comm_clean)


def get_detailed_name_for_code(code_str):
    """Returns Detailed_Comm_Name for a given Detailed_Comm_code."""
    global CODE_TO_NAME_DICT
    if not code_str or pd.isna(code_str):
        return ''
    return CODE_TO_NAME_DICT.get(str(code_str).strip(), '')


def fuzzy_suggestions_for_commodity(commodity_str, top_n=10):
    """
    Returns top_n fuzzy matches from Commodity_DB for a given unresolved commodity string.
    Matches against the 'Commodity' column in DB_RECORDS (NOT deduplicated by code —
    we want to show the actual matching DB entry).
    Each result has: Commodity (DB name), Detailed_Comm_code, Detailed_Comm_Name, score.
    Results are deduplicated by Detailed_Comm_code so user sees distinct code options.
    """
    global DB_RECORDS
    if not commodity_str:
        return []

    query = str(commodity_str).strip().lower()
    
    # Score each DB record against the Commodity column
    scored = []
    for row in DB_RECORDS:
        comm = str(row.get('Commodity', '')).strip()
        if not comm:
            continue
        comm_lower = comm.lower()
        ratio = SequenceMatcher(None, query, comm_lower).ratio()
        # Boost substring matches
        if query in comm_lower or comm_lower in query:
            ratio = max(ratio, 0.6)
        scored.append((ratio, comm, row))
    
    scored.sort(key=lambda x: x[0], reverse=True)
    
    # Return top_n, deduplicated by Detailed_Comm_code
    seen_codes = set()
    results = []
    for ratio, comm_name, row in scored:
        code = str(row.get('Detailed_Comm_code', '')).strip()
        if code and code not in seen_codes:
            seen_codes.add(code)
            results.append({
                'Commodity': comm_name,                                          # the matching DB entry name
                'Detailed_Comm_code': code,
                'Detailed_Comm_Name': str(row.get('Detailed_Comm_Name', '')).strip(),
                'Abstract_Comm_code': str(row.get('Abstract_Comm_code', '')).strip(),
                'Abstract_Comm_Name': str(row.get('Abstract_Comm_Name', '')).strip(),
                'score': round(ratio, 3)
            })
        if len(results) >= top_n:
            break
    
    return results


def get_suggestions_for_unresolved(unresolved_list, top_n=10):
    """
    Given a list of unresolved commodity strings, returns a dict:
    { commodity_str: [list of top_n suggestions] }
    """
    result = {}
    for comm in unresolved_list:
        result[comm] = fuzzy_suggestions_for_commodity(comm, top_n=top_n)
    return result
