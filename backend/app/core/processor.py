import pandas as pd
from typing import List, Dict
import math
# generate_suggestions import removed — suggestions now fetched lazily via /api/suggestions

def process_od_data(main_data: List[Dict], ca_codes: List[Dict], od_codes: Dict[str, str] = None) -> List[Dict]:
    df = pd.DataFrame(main_data)
    
    if df.empty:
        return []
    
    # Map back original columns to standard names if they exist
    standard_cols = ['ORIGIN', 'DESTINATION', 'PLAZA_NAME', 'MAV_SPLIT', 'COMMODITY_TRIP_PURPOSE', 'DIRECTION', 'VEHICLE_CODE', 'COMMODITY_CODE_DETAILED', 'COMMODITY_CODE_ABSTRACT']
    
    # Check if exact match is already present natively. If not, do lightweight rename
    rename_dict = {}
    for col in df.columns:
        stripped_col = str(col).strip().upper()
        if stripped_col in standard_cols and col != stripped_col:
            rename_dict[col] = stripped_col
            
    df = df.rename(columns=rename_dict)
    
    # Ensure required columns exist (now matching the standardized uppercase names)
    required_cols = ['ORIGIN', 'DESTINATION', 'PLAZA_NAME', 'MAV_SPLIT']
    # If using newer format, both should exist. If older, we fallback.
    for col in required_cols:
        if col not in df.columns:
            df[col] = ''
            
    # Fallback/Alignment for old vs new commodity columns
    if 'COMMODITY_CODE_ABSTRACT' not in df.columns and 'COMMODITY_CODE_1_17' in df.columns:
        df['COMMODITY_CODE_ABSTRACT'] = df['COMMODITY_CODE_1_17']
    if 'COMMODITY_CODE_DETAILED' not in df.columns and 'COMMODITY_CODE_1_28' in df.columns:
        df['COMMODITY_CODE_DETAILED'] = df['COMMODITY_CODE_1_28']
            
    # Normalize origin and destination
    df['ORIGIN'] = df['ORIGIN'].astype(str).str.strip().str.upper()
    df['DESTINATION'] = df['DESTINATION'].astype(str).str.strip().str.upper()
    
    # We need Pair for vehicle interactions
    df['Pair'] = df['ORIGIN'] + " - " + df['DESTINATION']
 
    # 1. Pull ORIGIN & DESTINATION columns to make a single list of unique names
    unique_origins = set(df['ORIGIN'].dropna().unique())
    unique_destinations = set(df['DESTINATION'].dropna().unique())
    unique_names = list(unique_origins.union(unique_destinations))
    
    # Clean up blank names
    unique_names = [name for name in unique_names if name and str(name).upper() != 'NAN' and str(name).strip() != '']
    
    # Count occurrences of each unique name across both ORIGIN and DESTINATION
    origin_counts = df['ORIGIN'].value_counts()
    dest_counts = df['DESTINATION'].value_counts()
    all_counts = origin_counts.add(dest_counts, fill_value=0)

    # Sort unique names by descending total count (most-used names first)
    unique_names.sort(key=lambda n: all_counts.get(n, 0), reverse=True)

    frontend_data = []
    
    # --- PERFORMANCE OPTIMIZATION ---
    from collections import defaultdict
    name_to_records = defaultdict(list)
    
    records = df.to_dict('records')
    for rec in records:
        origin = rec.get('ORIGIN')
        dest = rec.get('DESTINATION')
        if pd.notna(origin):
            name_to_records[origin].append(rec)
        if pd.notna(dest) and dest != origin:
            name_to_records[dest].append(rec)
            
    for idx, name in enumerate(unique_names):
        recs = name_to_records.get(name, [])
        if not recs:
            continue
            
        df_filtered = pd.DataFrame(recs)
            
        # --- Analytics: Plazas with Directional Pairs ---
        plaza_counts = df_filtered['PLAZA_NAME'].value_counts()
        plazas = {"headers": [], "counts": [], "coords": [], "directions": {}}
        for plaza_name, count in plaza_counts.items():
            if str(plaza_name).strip() and str(plaza_name).upper() != 'NAN' and count > 0:
                p_name_str = str(plaza_name)
                plazas["headers"].append(p_name_str)
                plazas["counts"].append(int(count))
                
                # Coords will now be assigned via frontend plazaMapping
                plazas["coords"].append({"lat": 20.0, "lng": 78.0}) 
                    
                # Calculate Directional OD pairs
                if 'DIRECTION' in df_filtered.columns:
                    plaza_df = df_filtered[df_filtered['PLAZA_NAME'] == plaza_name]
                    dir_dict = {}
                    for direction, dir_group in plaza_df.groupby('DIRECTION'):
                        dir_str = str(direction).strip()
                        if dir_str and dir_str.upper() != 'NAN':
                            pair_counts = dir_group['Pair'].value_counts().sort_values(ascending=False)
                            if not pair_counts.empty:
                                dir_dict[dir_str] = [f"{k} [{int(v)}]" for k, v in pair_counts.items()]
                    if dir_dict:
                        plazas["directions"][p_name_str] = dir_dict
            
        # --- Analytics: Vehicles and Interactions (Total and Per-Plaza) ---
        vehicle_counts = df_filtered['MAV_SPLIT'].value_counts()
        vehicles = {str(k): int(v) for k, v in vehicle_counts.items() if str(k).strip() and str(k).upper() != 'NAN' and v > 0}
        
        interactions = {}
        for vehtype, group in df_filtered.groupby('MAV_SPLIT'):
            v_str = str(vehtype).strip()
            if v_str and v_str.upper() != 'NAN':
                dir_dict = {}
                if 'DIRECTION' in df_filtered.columns:
                    for direction, dir_group in group.groupby('DIRECTION'):
                        dir_str = str(direction).strip()
                        if dir_str and dir_str.upper() != 'NAN':
                            pair_counts = dir_group['Pair'].value_counts().sort_values(ascending=False)
                            if not pair_counts.empty:
                                dir_dict[dir_str] = [f"{k} [{int(v)}]" for k, v in pair_counts.items()]
                
                if dir_dict:
                    interactions[v_str] = dir_dict
                else:
                    pair_counts = group['Pair'].value_counts().sort_values(ascending=False)
                    if not pair_counts.empty:
                        interactions[v_str] = [f"{k} [{int(v)}]" for k, v in pair_counts.items()]

        vehicles_plaza = {}
        vehicle_interactions_plaza = {}
        for (plaza, vehtype), group in df_filtered.groupby(['PLAZA_NAME', 'MAV_SPLIT']):
            p_str = str(plaza).strip()
            v_str = str(vehtype).strip()
            if p_str and p_str.upper() != 'NAN' and v_str and v_str.upper() != 'NAN':
                count = len(group)
                if count > 0:
                    if p_str not in vehicles_plaza: vehicles_plaza[p_str] = {}
                    vehicles_plaza[p_str][v_str] = count
                    
                    dir_dict = {}
                    if 'DIRECTION' in df_filtered.columns:
                        for direction, dir_group in group.groupby('DIRECTION'):
                            dir_str = str(direction).strip()
                            if dir_str and dir_str.upper() != 'NAN':
                                pair_counts = dir_group['Pair'].value_counts().sort_values(ascending=False)
                                if not pair_counts.empty:
                                    dir_dict[dir_str] = [f"{k} [{int(v)}]" for k, v in pair_counts.items()]
                                    
                    if p_str not in vehicle_interactions_plaza: vehicle_interactions_plaza[p_str] = {}
                    
                    if dir_dict:
                        vehicle_interactions_plaza[p_str][v_str] = dir_dict
                    else:
                        pair_counts = group['Pair'].value_counts().sort_values(ascending=False)
                        if not pair_counts.empty:
                            vehicle_interactions_plaza[p_str][v_str] = [f"{k} [{int(v)}]" for k, v in pair_counts.items()]
                            
        # --- Analytics: Commodity Matrix (Abstract & Detailed) ---
        commodity_matrix_abstract = {}
        commodity_interactions_abstract = {}
        cm_abstract_plaza = {}
        ci_abstract_plaza = {}
        
        commodity_matrix_detailed = {}
        commodity_interactions_detailed = {}
        cm_detailed_plaza = {}
        ci_detailed_plaza = {}

        # Helper method for grouping logic
        def process_commodity_grouping(group_cols, is_plaza=False):
            cm_dict = {}
            ci_dict = {}
            for keys, group in df_filtered.groupby(group_cols):
                if is_plaza:
                    plaza, comm_code, splits = keys
                else:
                    comm_code, splits = keys
                    plaza = None
                    
                try: code_int = str(int(float(comm_code)))
                except (ValueError, TypeError): continue
                v_str = str(splits).strip()
                if not v_str or v_str.upper() == 'NAN': continue
                
                if is_plaza:
                    p_str = str(plaza).strip()
                    if not p_str or p_str.upper() == 'NAN': continue
                
                count = len(group)
                if count > 0:
                    dir_dict = {}
                    if 'DIRECTION' in df_filtered.columns:
                        for direction, dir_group in group.groupby('DIRECTION'):
                            dir_str = str(direction).strip()
                            if dir_str and dir_str.upper() != 'NAN':
                                pair_counts = dir_group['Pair'].value_counts().sort_values(ascending=False)
                                if not pair_counts.empty:
                                    dir_dict[dir_str] = [f"{k} [{int(v)}]" for k, v in pair_counts.items()]
                                    
                    final_interactions = dir_dict
                    if not final_interactions:
                        pair_counts = group['Pair'].value_counts().sort_values(ascending=False)
                        if not pair_counts.empty:
                            final_interactions = [f"{k} [{int(v)}]" for k, v in pair_counts.items()]
                            
                    if is_plaza:
                        if p_str not in cm_dict: cm_dict[p_str] = {}
                        if code_int not in cm_dict[p_str]: cm_dict[p_str][code_int] = {}
                        cm_dict[p_str][code_int][v_str] = count
                        
                        if final_interactions:
                            if p_str not in ci_dict: ci_dict[p_str] = {}
                            if code_int not in ci_dict[p_str]: ci_dict[p_str][code_int] = {}
                            ci_dict[p_str][code_int][v_str] = final_interactions
                    else:
                        if code_int not in cm_dict: cm_dict[code_int] = {}
                        cm_dict[code_int][v_str] = count
                        
                        if final_interactions:
                            if code_int not in ci_dict: ci_dict[code_int] = {}
                            ci_dict[code_int][v_str] = final_interactions
            return cm_dict, ci_dict

        if 'COMMODITY_CODE_ABSTRACT' in df_filtered.columns:
            commodity_matrix_abstract, commodity_interactions_abstract = process_commodity_grouping(['COMMODITY_CODE_ABSTRACT', 'MAV_SPLIT'], False)
            cm_abstract_plaza, ci_abstract_plaza = process_commodity_grouping(['PLAZA_NAME', 'COMMODITY_CODE_ABSTRACT', 'MAV_SPLIT'], True)

        if 'COMMODITY_CODE_DETAILED' in df_filtered.columns:
            commodity_matrix_detailed, commodity_interactions_detailed = process_commodity_grouping(['COMMODITY_CODE_DETAILED', 'MAV_SPLIT'], False)
            cm_detailed_plaza, ci_detailed_plaza = process_commodity_grouping(['PLAZA_NAME', 'COMMODITY_CODE_DETAILED', 'MAV_SPLIT'], True)

        frontend_data.append({
            "id": idx + 1,
            "original_name": name,
            "total_occurrences": int(all_counts.get(name, 0)),
            "context": "Aggregated",
            "assigned_user": None, # Will be assigned via frontend User Management
            "assigned_zone": od_codes.get(name, None) if od_codes else None,
            "plaza_coords": plazas["coords"],
            "analytics": {
                "plazas": plazas,
                "vehicles": vehicles,
                "vehiclesPlaza": vehicles_plaza,
                "vehicleInteractions": interactions,
                "vehicleInteractionsPlaza": vehicle_interactions_plaza,
                "commodityMatrixAbstract": commodity_matrix_abstract,
                "commodityMatrixDetailed": commodity_matrix_detailed,
                "commodityMatrixAbstractPlaza": cm_abstract_plaza,
                "commodityMatrixDetailedPlaza": cm_detailed_plaza,
                "commodityInteractionsAbstract": commodity_interactions_abstract,
                "commodityInteractionsDetailed": commodity_interactions_detailed,
                "commodityInteractionsAbstractPlaza": ci_abstract_plaza,
                "commodityInteractionsDetailedPlaza": ci_detailed_plaza
            },
            "suggestions": []
        })
        
    return frontend_data
