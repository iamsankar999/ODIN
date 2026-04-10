import pandas as pd
from typing import Dict, Any
from io import BytesIO
from app.core.algorithms import perform_point_in_polygon, get_india_districts_gdf
import geopandas as gpd
from shapely.geometry import Point

def clean_zone_export(z_val):
    """Strips Polygon_ prefix if it exists in the shapefile"""
    sv = str(z_val).strip()
    if sv.lower().startswith('polygon_'):
        sv = sv[8:]
    return sv

def _get_batch_spatial_info(mapping: Dict[str, Any], shapefile_gdf: gpd.GeoDataFrame, districts_gdf: gpd.GeoDataFrame) -> Dict[str, Dict[str, str]]:
    """Helper to resolve spatial info for all unique resolved entries in one go."""
    if not mapping:
        return {}
        
    points_data = []
    # Collect unique coordinates from the mapping (including per-plaza mappings)
    for orig_name, res_entry in mapping.items():
        # Handle both flat mapping (old) and nested mapping (new)
        targets = []
        if isinstance(res_entry, dict) and any(isinstance(v, dict) for v in res_entry.values()):
            # New structure: { "__all__": {...}, "Plaza 1": {...} }
            for p_key, res_data in res_entry.items():
                targets.append((f"{orig_name}|{p_key}", res_data))
        else:
            # Old structure or simple mapping
            targets.append((orig_name, res_entry))
            
        for lookup_id, res_data in targets:
            lat, lng = res_data.get('lat'), res_data.get('lng')
            if pd.notna(lat) and pd.notna(lng):
                points_data.append({
                    'lookup_id': lookup_id,
                    'geometry': Point(lng, lat),
                    'frontend_zone': res_data.get('zone')
                })
            
    if not points_data:
        return {}
        
    points_gdf = gpd.GeoDataFrame(points_data, crs="EPSG:4326")
    results = {p['lookup_id']: {'zone': p['frontend_zone'], 'district': '', 'state': ''} for p in points_data}

    # 1. Batch District/State lookup
    if districts_gdf is not None:
        try:
            joined = gpd.sjoin(points_gdf, districts_gdf, how="left", predicate="within")
            for _, row in joined.iterrows():
                d, s = "", ""
                for col in joined.columns:
                    c_up = str(col).upper()
                    if not d and ('DIST' in c_up or 'DT' in c_up): d = row[col]
                    if not s and ('STATE' in c_up or 'ST' in c_up): s = row[col]
                
                lid = row['lookup_id']
                if lid in results:
                    results[lid]['district'] = str(d).strip() if pd.notna(d) else ""
                    results[lid]['state'] = str(s).strip() if pd.notna(s) else ""
        except Exception as e:
            print(f"Batch district join failed: {e}")

    # 2. Batch Zone lookup
    if shapefile_gdf is not None:
        try:
            if shapefile_gdf.crs and shapefile_gdf.crs.to_epsg() != 4326:
                shapefile_gdf = shapefile_gdf.to_crs(epsg=4326)
            joined_z = gpd.sjoin(points_gdf, shapefile_gdf, how="left", predicate="within")
            for _, row in joined_z.iterrows():
                z_val = None
                for cand in ['ZONE_NO', 'Zone', 'zone', 'ZONE', 'ID', 'Name', 'NAME', 'zonenumber']:
                    if cand in joined_z.columns:
                        z_val = row[cand]
                        break
                
                lid = row['lookup_id']
                if lid in results:
                    f_z = results[lid]['zone']
                    if not f_z or f_z in ["Unknown Zone", "Calculating...", "Unknown"]:
                        results[lid]['zone'] = str(z_val).strip() if pd.notna(z_val) else "Unknown"
        except Exception as e:
            print(f"Batch zone join failed: {e}")
            
    return results

def generate_export_excel(original_excel_bytes: bytes, shapefile_gdf: gpd.GeoDataFrame, mapping: Dict[str, Any]) -> bytes:
    xl = pd.ExcelFile(BytesIO(original_excel_bytes))
    if "Auto_OD_input" not in xl.sheet_names:
        raise ValueError("Original excel missing Auto_OD_input sheet.")
    df = xl.parse("Auto_OD_input")
    
    # Pre-calculate spatial info in bulk
    districts_gdf = get_india_districts_gdf()
    spatial_lookup = _get_batch_spatial_info(mapping, shapefile_gdf, districts_gdf)
    
    def get_resolved(val, plaza_name):
        clean_val = str(val).strip().upper() if pd.notna(val) else ""
        p_name = str(plaza_name).strip() if pd.notna(plaza_name) else ""
        
        entry = mapping.get(clean_val)
        if not entry:
            return None, {}
            
        # Per-plaza logic
        if isinstance(entry, dict) and any(isinstance(v, dict) for v in entry.values()):
            res_data = entry.get(p_name) or entry.get("__all__")
            if res_data:
                lookup_id = f"{clean_val}|{p_name}" if p_name in entry else f"{clean_val}|__all__"
                return res_data, spatial_lookup.get(lookup_id, {})
        else:
            return entry, spatial_lookup.get(clean_val, {})
        
        return None, {}

    # Bulk assignment initialization
    new_cols = ['RESOLVED_ORIGIN', 'O_LAT', 'O_LNG', 'O_ZONE', 'O_DISTRICT', 'O_STATE', 'O_RESOLVED_BY',
                'RESOLVED_DEST', 'D_LAT', 'D_LNG', 'D_ZONE', 'D_DISTRICT', 'D_STATE', 'D_RESOLVED_BY',
                'Origin_code', 'Destination_code']
    for col in new_cols:
        df[col] = '' if 'LAT' not in col and 'LNG' not in col else None
    
    # Identify PLAZA column
    plaza_col = next((c for c in df.columns if str(c).upper() in ['PLAZA_NAME', 'SURVEY_LOCATION', 'PLAZA']), None)

    # Process rows
    for idx, row in df.iterrows():
        p_val = row.get(plaza_col) if plaza_col else None
        
        # Origin
        o_res, o_spatial = get_resolved(row.get('ORIGIN'), p_val)
        if o_res:
            df.at[idx, 'RESOLVED_ORIGIN'] = o_res.get('name', '')
            df.at[idx, 'O_LAT'] = o_res.get('lat')
            df.at[idx, 'O_LNG'] = o_res.get('lng')
            df.at[idx, 'O_RESOLVED_BY'] = o_res.get('resolved_by', '')
            oz = clean_zone_export(o_spatial.get('zone', ''))
            df.at[idx, 'O_ZONE'] = oz
            df.at[idx, 'Origin_code'] = oz
            df.at[idx, 'O_DISTRICT'] = o_spatial.get('district', '')
            df.at[idx, 'O_STATE'] = o_spatial.get('state', '')
            
        # Destination
        d_res, d_spatial = get_resolved(row.get('DESTINATION'), p_val)
        if d_res:
            df.at[idx, 'RESOLVED_DEST'] = d_res.get('name', '')
            df.at[idx, 'D_LAT'] = d_res.get('lat')
            df.at[idx, 'D_LNG'] = d_res.get('lng')
            df.at[idx, 'D_RESOLVED_BY'] = d_res.get('resolved_by', '')
            dz = clean_zone_export(d_spatial.get('zone', ''))
            df.at[idx, 'D_ZONE'] = dz
            df.at[idx, 'Destination_code'] = dz
            df.at[idx, 'D_DISTRICT'] = d_spatial.get('district', '')
            df.at[idx, 'D_STATE'] = d_spatial.get('state', '')
            
    output = BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, sheet_name='Validated_OD', index=False)
        for sheet in xl.sheet_names:
            if sheet != "Auto_OD_input":
                xl.parse(sheet).to_excel(writer, sheet_name=sheet, index=False)
    return output.getvalue()

def generate_progress_excel(mapping: Dict[str, Any], shapefile_gdf: gpd.GeoDataFrame, original_excel_bytes: bytes = None) -> bytes:
    districts_gdf = get_india_districts_gdf()
    spatial_lookup = _get_batch_spatial_info(mapping, shapefile_gdf, districts_gdf)
    
    rows = []
    for orig_name, res_entry in mapping.items():
        targets = []
        if isinstance(res_entry, dict) and any(isinstance(v, dict) for v in res_entry.values()):
            for p_key, res_data in res_entry.items():
                targets.append((orig_name, p_key, res_data, f"{orig_name}|{p_key}"))
        else:
            targets.append((orig_name, "All", res_entry, orig_name))
            
        for o_name, p_name, res_data, lid in targets:
            spatial = spatial_lookup.get(lid, {})
            rows.append({
                "Original Name": o_name,
                "Survey Location": p_name,
                "Resolved Name": res_data.get('name', ''),
                "Latitude": res_data.get('lat'),
                "Longitude": res_data.get('lng'),
                "Zone Number": clean_zone_export(spatial.get('zone', '')),
                "District": spatial.get('district', ''),
                "State": spatial.get('state', ''),
                "Resolved By": res_data.get('resolved_by', '')
            })
        
    df = pd.DataFrame(rows)
    output = BytesIO()
    
    orig_key_mapping = {str(k).strip().lower(): k for k in mapping.keys()}

    def get_zone(val, plaza_name):
        if pd.isna(val): return ""
        val_clean = str(val).strip().lower()
        if val_clean not in orig_key_mapping: return ""
        
        orig_k = orig_key_mapping[val_clean]
        p_name = str(plaza_name).strip() if pd.notna(plaza_name) else ""
        
        entry = mapping[orig_k]
        
        if isinstance(entry, dict) and any(isinstance(v, dict) for v in entry.values()):
            if p_name in entry:
                res_data = entry[p_name]
                lookup_id = f"{orig_k}|{p_name}"
            elif "__all__" in entry:
                res_data = entry["__all__"]
                lookup_id = f"{orig_k}|__all__"
            else:
                return ""
                
            spatial = spatial_lookup.get(lookup_id, {})
            frontend_zone = res_data.get('zone', '')
            if frontend_zone and frontend_zone not in ["Unknown", "Calculating...", "Unknown Zone"]:
                return clean_zone_export(frontend_zone)
            return clean_zone_export(spatial.get('zone', ''))
        else:
            spatial = spatial_lookup.get(orig_k, {})
            frontend_zone = entry.get('zone', '')
            if frontend_zone and frontend_zone not in ["Unknown", "Calculating...", "Unknown Zone"]:
                return clean_zone_export(frontend_zone)
            return clean_zone_export(spatial.get('zone', ''))
            
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        if original_excel_bytes:
            xl = pd.ExcelFile(BytesIO(original_excel_bytes))
            for sheet in xl.sheet_names:
                try:
                    xl.parse(sheet).to_excel(writer, sheet_name=sheet, index=False)
                except: continue
                
            if "Auto_OD_input" in xl.sheet_names:
                df_raw = xl.parse("Auto_OD_input")
                cols_to_keep = [
                    "VEHICLE_CODE", "MAV_SPLIT", "ORIGIN", "DESTINATION", 
                    "COMMODITY_TRIP_PURPOSE", "DIRECTION", "PLAZA_NAME", 
                    "COMMODITY_CODE_DETAILED", "COMMODITY_CODE_ABSTRACT"
                ]
                
                plaza_col = "PLAZA_NAME" 
                for cand in ["PLAZA_NAME", "PLAZA", "SURVEY_LOCATION"]:
                    if cand in df_raw.columns:
                        plaza_col = cand
                        break
                        
                out_data = []
                for _, row in df_raw.iterrows():
                    out_row = {}
                    for c in cols_to_keep:
                        if c == "PLAZA_NAME" and c not in df_raw.columns:
                            out_row[c] = row.get(plaza_col, "")
                        else:
                            out_row[c] = row.get(c, "")
                    
                    p_val = row.get(plaza_col, "")
                    out_row["ORIGIN_ZONE"] = get_zone(row.get("ORIGIN"), p_val)
                    out_row["DESTINATION_ZONE"] = get_zone(row.get("DESTINATION"), p_val)
                    out_data.append(out_row)
                    
                df_out = pd.DataFrame(out_data)
                
                final_cols = [
                    "VEHICLE_CODE", "MAV_SPLIT", "ORIGIN", "DESTINATION", "COMMODITY_TRIP_PURPOSE", 
                    "DIRECTION", "PLAZA_NAME", "ORIGIN_ZONE", "DESTINATION_ZONE", 
                    "COMMODITY_CODE_DETAILED", "COMMODITY_CODE_ABSTRACT"
                ]
                df_out = df_out[[c for c in final_cols if c in df_out.columns]]
                df_out.to_excel(writer, sheet_name="Resolved_rawOD", index=False)
                
        df.to_excel(writer, sheet_name='Resolved_Places', index=False)
    return output.getvalue()

def generate_survey_locations_excel(plaza_mapping: Dict[str, Any]) -> bytes:
    """Creates a simple excel file containing all verified survey location coordinates."""
    rows = []
    for name, pos in plaza_mapping.items():
        if pos and 'lat' in pos and 'lng' in pos:
            rows.append({
                "Survey Location Name": name,
                "Latitude": pos['lat'],
                "Longitude": pos['lng']
            })
    
    df = pd.DataFrame(rows)
    output = BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, sheet_name='Survey_Locations', index=False)
    return output.getvalue()
