import re
import math
from thefuzz import fuzz, process
import phonetics
import pandas as pd
import geopandas as gpd
from shapely.geometry import Point
import googlemaps
import concurrent.futures
import os
from dotenv import load_dotenv

# Load .env so GOOGLE_MAPS_API_KEY is available to os.environ
load_dotenv()

# Initialize Global Reference Dictionary lazily
_reference_names = []
_reference_phonetics = []

def get_reference_dictionary() -> tuple:
    """
    Loads the D:\\iamsa\\Documents\\Antigravity_projects\\od_validation_system\\database\\unique_names.csv 
    file into memory once.
    Returns a tuple of (original_names_list, phonetics_list)
    """
    global _reference_names
    global _reference_phonetics
    
    if not _reference_names:
        BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        DATABASE_DIR = os.path.join(BASE_DIR, "database")
        csv_path = os.path.join(DATABASE_DIR, "unique_names.csv")
        if os.path.exists(csv_path):
            try:
                # Read CSV, assume 'name' column exists or take first column
                df = pd.read_csv(csv_path)
                col_name = 'name' if 'name' in df.columns else df.columns[0]
                
                # Filter out strings and dropna
                names = df[col_name].dropna().astype(str).tolist()
                
                valid_names = []
                for n in names:
                    clean = n.strip()
                    if clean and clean.upper() != 'NAN':
                        valid_names.append(clean)
                        
                _reference_names = list(set(valid_names)) # Unique names only
                
                # Pre-compute phonetic codes for performance
                _reference_phonetics = [compute_phonetic_code(standardize_place_name(n)) for n in _reference_names]
                
                print(f"Loaded {len(_reference_names)} reference names from DB.")
            except Exception as e:
                print(f"Error loading reference CSV: {e}")
                
    return _reference_names, _reference_phonetics

def add_place_to_database(name: str) -> dict:
    """
    Appends a new place name to unique_names.csv if it's not already there
    and updates the in-memory cache.
    """
    global _reference_names
    global _reference_phonetics
    
    clean_name = name.strip()
    if not clean_name:
        return {"status": "error", "message": "Empty name"}

    # Ensure reference dictionary is loaded
    get_reference_dictionary()
    
    # Perform case-insensitive check using standardized names
    standardized_new = standardize_place_name(clean_name)
    exists = False
    for n in _reference_names:
        if standardize_place_name(n) == standardized_new:
            exists = True
            break
            
    if exists:
        return {"status": "skipped", "message": f"Place '{clean_name}' already exists in database."}

    # Locate the CSV path
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    DATABASE_DIR = os.path.join(BASE_DIR, "database")
    csv_path = os.path.join(DATABASE_DIR, "unique_names.csv")

    try:
        # Append name to CSV file (ensuring it starts on a new line)
        with open(csv_path, 'a', encoding='utf-8') as f:
            f.write(f"\n{clean_name}")
            
        # Update in-memory cache to reflect changes immediately for next search
        _reference_names.append(clean_name)
        _reference_phonetics.append(compute_phonetic_code(standardized_new))
        
        print(f"SUCCESS: Added new place '{clean_name}' to system database.")
        return {"status": "success", "message": f"Added '{clean_name}' to database."}
    except Exception as e:
        print(f"DATABASE UPDATE FAILED for '{clean_name}': {e}")
        return {"status": "error", "message": str(e)}

# Initialize Google Maps Client lazily
_gmaps_client = None

_india_districts_gdf = None

def get_india_districts_gdf() -> gpd.GeoDataFrame:
    """
    Loads the D:\\iamsa\\Documents\\Antigravity_projects\\od_validation_system\\database\\INDIA_DISTRICTSoriginal.geojson
    file lazily into memory for extracting District and State information during export.
    """
    global _india_districts_gdf
    if _india_districts_gdf is None:
        BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        DATABASE_DIR = os.path.join(BASE_DIR, "database")
        geojson_path = os.path.join(DATABASE_DIR, "INDIA_DISTRICTSoriginal.geojson")
        if os.path.exists(geojson_path):
            try:
                gdf = gpd.read_file(geojson_path)
                if gdf.crs is None or gdf.crs.to_epsg() != 4326:
                    gdf = gdf.to_crs(epsg=4326)
                _india_districts_gdf = gdf
                print(f"Loaded canonical India Districts geo-database: {len(gdf)} regions.")
            except Exception as e:
                print(f"Error loading India Districts GeoJSON: {e}")
    return _india_districts_gdf

def get_gmaps_client():
    global _gmaps_client
    if _gmaps_client is None:
        api_key = os.environ.get("GOOGLE_MAPS_API_KEY")
        if api_key:
            _gmaps_client = googlemaps.Client(key=api_key)
    return _gmaps_client

def standardize_place_name(name: str) -> str:
    """
    Light normalization: lowercase, remove non-alpha characters (except spaces),
    and collapse extra whitespace. Does NOT rewrite suffixes so that place names
    from all regions of India (e.g. South Indian '-puram', '-eri', '-ur') are
    preserved intact and the geocoding API receives the original spelling.
    """
    if not isinstance(name, str):
        return ""

    # Lowercase and strip leading/trailing whitespace
    name = name.lower().strip()

    # Remove punctuation / special chars, keep letters and spaces only
    name = re.sub(r'[^a-z\s]', '', name)

    # Collapse multiple spaces into one
    name = re.sub(r'\s+', ' ', name).strip()

    return name


def compute_phonetic_code(name: str) -> str:
    """
    Computes Double Metaphone representation of a place name.
    """
    try:
        # Depending on phonetics version, it might return a tuple
        result = phonetics.metaphone(name)
        if isinstance(result, tuple):
            return result[0] if result[0] else ""
        return result or ""
    except Exception:
        return ""

def clean_formatted_address(address: str, state: str) -> str:
    """
    Strips state name, 6-digit pincode, and 'India' from a Google formatted_address
    when a state filter is already active (user already knows the state).
    """
    clean = address
    # Remove ", India" at end
    clean = re.sub(r',?\s*India\s*$', '', clean, flags=re.IGNORECASE)
    # Remove state name
    clean = re.sub(r',?\s*' + re.escape(state) + r'\s*', '', clean, flags=re.IGNORECASE)
    # Remove 6-digit Indian pincode
    clean = re.sub(r'\s*\d{6}\s*', '', clean)
    # Clean up artifacts (double commas, trailing commas, extra spaces)
    clean = re.sub(r',\s*,', ',', clean)
    clean = re.sub(r'\s+', ' ', clean)
    clean = clean.strip().rstrip(',').strip()
    return clean

def get_internal_suggestions(target_name: str, limit: int = 5) -> list:
    """
    Compares the target name against the global reference dictionary using 
    phonetic matching first, then fuzzy scoring.
    """
    cleaned_target = standardize_place_name(target_name)
    if not cleaned_target:
        return []
        
    target_phonetic = compute_phonetic_code(cleaned_target)
    target_len = len(cleaned_target)
    
    ref_names, ref_phonetics = get_reference_dictionary()
    
    candidates = []
    
    # 1. Phonetic Matching pass
    for i, name in enumerate(ref_names):
        ref_phonetic = ref_phonetics[i]
        
        # If phonetic codes match exactly, or one is a substantial prefix of another
        if target_phonetic and ref_phonetic and (target_phonetic == ref_phonetic or 
           target_phonetic.startswith(ref_phonetic) or ref_phonetic.startswith(target_phonetic)):
            # Reject very short spurious matches (e.g. "Pura" or "Rohi" matching "Mohamadpur")
            # The candidate name length must be at least 50% of the target length
            candidate_len = len(standardize_place_name(name))
            if candidate_len < target_len * 0.5 and candidate_len < 5:
                continue
            candidates.append(name)
            
    # 2. Score the phonetic candidates with fuzzy matching.
    scored_candidates = []
    
    for candidate in candidates:
        # Use token_set_ratio which is good for names with extra words/suffixes
        score = fuzz.token_set_ratio(cleaned_target, standardize_place_name(candidate))
        if score > 85:  # Tighter threshold to avoid irrelevant matches
            scored_candidates.append({
                "name": candidate,
                "lat": None,
                "lng": None,
                "score": score,
                "dist_km": None,
                "source": "Internal DB"
            })
            
    # Sort by fuzzy score descending
    scored_candidates.sort(key=lambda x: x["score"], reverse=True)
    
    # Take top N
    return scored_candidates[:limit]

def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """
    Returns great-circle distance in km between two lat/lng points.
    """
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def generate_suggestions(target_name: str, limit: int = 10, plaza_coords: list = None, plaza_names: list = None, zone_polygon=None, state: str = None) -> list:
    """
    Generates location suggestions using:
      1. Phonetic (Double Metaphone) matching against the reference CSV dictionary
      2. Fuzzy (token_set_ratio) scoring to rank the phonetic candidates
      3. Google Maps Geocoding API to resolve coordinates for each matched name

    When plaza_coords are provided, results are re-ranked by proximity to the
    nearest survey location (plaza). If multiple plazas are present, the nearest
    one is chosen per suggestion, and its name is returned as `nearest_plaza`.
    
    When zone_polygon is provided (Place Assign mode), results are strictly filtered
    to ensure their geocoded coordinates fall inside the polygon.
    """
    client = get_gmaps_client()

    if not client:
        # No API key — return the raw internal matches (no coordinates)
        return get_internal_suggestions(target_name, limit=limit)

    # Validate and pair plaza coords with names
    valid_plazas = []  # list of { lat, lng, name }
    if plaza_coords and len(plaza_coords) > 0:
        names_list = plaza_names or []
        for i, c in enumerate(plaza_coords):
            if c.get('lat') is not None and c.get('lng') is not None:
                valid_plazas.append({
                    'lat': c['lat'],
                    'lng': c['lng'],
                    'name': names_list[i] if i < len(names_list) else f"Plaza {i+1}"
                })

    try:
        # Step 1 & 2: Phonetic match → fuzzy score → top candidates from CSV
        fetch_limit = limit * 2 if zone_polygon is not None else limit
        raw_internal = get_internal_suggestions(target_name, limit=fetch_limit)

        # --- FIX: Also inject the original target_name as a candidate ---
        # This ensures the exact user-typed spelling is always geocoded on
        # Google Maps, even if the DB fuzzy/phonetic pipeline didn't surface it.
        original_already_present = False
        standardized_target = standardize_place_name(target_name)
        for item in raw_internal:
            if standardize_place_name(item["name"]) == standardized_target:
                original_already_present = True
                break

        if not original_already_present and target_name.strip():
            raw_internal.insert(0, {
                "name": target_name.strip(),
                "lat": None,
                "lng": None,
                "score": 95,  # High score — it's the exact name the user typed
                "dist_km": None,
                "source": "Original Spelling"
            })

        suggestions = []

        # Step 3: Search Google Places (Text Search) for each candidate name.
        # Text Search returns MULTIPLE locations for the same name (e.g.
        # 4 different Mohammadpurs within Bihar) — unlike geocode() which
        # typically returns only the single most prominent result.
        def process_candidate(item):
            name_to_geocode = item["name"]
            results = []
            try:
                # Build query string
                search_query = f"{name_to_geocode}, India"
                if state and state != "All States":
                    search_query = f"{name_to_geocode}, {state}, India"

                # PRIMARY: Use Places Text Search for multiple results
                place_entries = []
                try:
                    places_result = client.places(query=search_query)
                    if places_result and places_result.get('results'):
                        place_entries = places_result['results']
                except Exception:
                    pass  # Fallback below

                # FALLBACK: If Places API returned nothing, try geocode()
                if not place_entries:
                    geo_result = client.geocode(search_query)
                    if geo_result:
                        for g in geo_result:
                            place_entries.append({
                                "name": name_to_geocode,
                                "geometry": g.get("geometry", {}),
                                "formatted_address": g.get("formatted_address", "")
                            })

                for geo_entry in place_entries:
                    # State verification via formatted_address
                    if state and state != "All States":
                        addr = geo_entry.get("formatted_address", "")
                        if state.lower() not in addr.lower():
                            continue

                    geom = geo_entry.get("geometry", {}).get("location", {})
                    g_lat = geom.get("lat")
                    g_lng = geom.get("lng")
                    if g_lat is None or g_lng is None:
                        continue

                    # Use Google's own name for the place, NOT the DB name
                    google_name = geo_entry.get("name", name_to_geocode)
                    formatted_address = geo_entry.get("formatted_address", "")

                    # Detect Google Plus Codes (e.g. "RH9V+7W9") and replace
                    # with the first meaningful part of formatted_address
                    if re.match(r'^[A-Z0-9]{4,}\+[A-Z0-9]+', google_name):
                        # Extract a proper name from the formatted address
                        addr_parts = [p.strip() for p in formatted_address.split(',')]
                        # First part is usually the locality name
                        if addr_parts and not re.match(r'^[A-Z0-9]{4,}\+', addr_parts[0]):
                            google_name = addr_parts[0]
                        elif len(addr_parts) > 1:
                            google_name = addr_parts[1]

                    # Strip state/pincode/India from address when state filter active
                    if state and state != "All States":
                        formatted_address = clean_formatted_address(formatted_address, state)

                    result_item = {
                        "name": google_name,
                        "lat": g_lat,
                        "lng": g_lng,
                        "score": item["score"],
                        "dist_km": None,
                        "source": item.get("source", "Internal DB"),
                        "formatted_address": formatted_address,
                    }

                    # --- Place Assign In-Zone Check ---
                    result_item["in_zone"] = False
                    if zone_polygon is not None:
                        pt = Point(g_lng, g_lat)
                        if pt.within(zone_polygon):
                            result_item["in_zone"] = True

                    # --- Compute distance to each plaza and pick nearest ---
                    if valid_plazas:
                        min_dist = None
                        nearest_name = None
                        for plaza in valid_plazas:
                            d = haversine_km(plaza['lat'], plaza['lng'], g_lat, g_lng)
                            if min_dist is None or d < min_dist:
                                min_dist = d
                                nearest_name = plaza['name']

                        proximity_bonus = 20 * math.exp(-min_dist / 150.0)
                        result_item["dist_km"] = round(min_dist, 1)
                        result_item["nearest_plaza"] = nearest_name
                        result_item["score"] = round(min(100, result_item["score"] + proximity_bonus))
                    else:
                        result_item["dist_km"] = None
                        result_item["nearest_plaza"] = None

                    results.append(result_item)

            except Exception as geo_err:
                print(f"Places search failed for '{name_to_geocode}': {geo_err}")
            return results

        # Execute in parallel to save time
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            future_to_item = {executor.submit(process_candidate, item): item for item in raw_internal}
            for future in concurrent.futures.as_completed(future_to_item):
                res_list = future.result()
                if res_list:
                    suggestions.extend(res_list)


        # Deduplicate by coordinates (lat+lng rounded to 4dp) — same-name but different locations are kept
        seen_coords = set()
        unique_suggestions = []
        for s in suggestions:
            coord_key = (round(s["lat"], 4), round(s["lng"], 4))
            if coord_key not in seen_coords:
                seen_coords.add(coord_key)
                unique_suggestions.append(s)

        # Re-rank by composite score descending
        unique_suggestions.sort(key=lambda x: x["score"], reverse=True)
        top_suggestions = unique_suggestions[:limit]

        # Route Distance API check
        if top_suggestions and valid_plazas:
            try:
                origins = [(p['lat'], p['lng']) for p in valid_plazas]
                destinations = [(s["lat"], s["lng"]) for s in top_suggestions]
                dm_res = client.distance_matrix(origins=origins, destinations=destinations)
                if dm_res.get('status') == 'OK':
                    for j, s in enumerate(top_suggestions):
                        min_dist_val = None
                        nearest_idx = -1
                        for i, p in enumerate(valid_plazas):
                            el = dm_res['rows'][i]['elements'][j]
                            if el.get('status') == 'OK':
                                val = el['distance']['value']
                                if min_dist_val is None or val < min_dist_val:
                                    min_dist_val = val
                                    nearest_idx = i
                        if min_dist_val is not None:
                            s["dist_km"] = round(min_dist_val / 1000.0, 1)
                            s["nearest_plaza"] = valid_plazas[nearest_idx]['name']
            except Exception as e:
                print(f"Error fetching distance matrix: {e}")

        return top_suggestions

    except Exception as e:
        print(f"Suggestion generation error for '{target_name}': {e}")
        return []



def perform_point_in_polygon(lat: float, lng: float, zones_gdf: gpd.GeoDataFrame) -> dict:
    """
    Maps a latitude/longitude point to its respective zone in the shapefile.
    """
    point = Point(lng, lat)  # Longitude first for Shapely
    
    # Assuming zones_gdf is loaded and has a spatial index (sindex)
    # CRS must match (typically EPSG:4326 for standard Lat/Lng)
    point_series = gpd.GeoSeries([point], crs="EPSG:4326")
    
    # Ensure shapefile is in the same CRS
    if zones_gdf.crs and zones_gdf.crs.to_epsg() != 4326:
        zones_gdf = zones_gdf.to_crs(epsg=4326)
        
    # Find intersecting polygons using spatial join
    joined = gpd.sjoin(gpd.GeoDataFrame(geometry=point_series), zones_gdf, how="left", predicate="within")
    
    if not joined.empty and pd.notna(joined.iloc[0].get('index_right')):
        # Return the 'zonenumber' attribute of the matched zone
        matched_row = joined.iloc[0]
        
        # Try to dynamically locate District and State columns
        district = ""
        state = ""
        for col in matched_row.keys():
            col_upper = str(col).upper()
            if not district and ('DIST' in col_upper or 'DT' in col_upper):
                district = matched_row[col]
            if not state and ('STATE' in col_upper or 'ST' in col_upper):
                state = matched_row[col]
                
        return {
            "matched": True,
            "zonenumber": matched_row.get('zonenumber', None),
            "district": str(district).strip() if pd.notna(district) else "",
            "state": str(state).strip() if pd.notna(state) else ""
        }
    
    return {"matched": False, "zonenumber": None, "district": "", "state": ""}

