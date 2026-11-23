from fastapi import APIRouter, UploadFile, File, HTTPException, Query, Form, Body
from typing import List, Optional, Dict
from app.core.data_parser import parse_excel_data, process_shapefile_zip
from app.core.processor import process_od_data
from app.core.algorithms import generate_suggestions
from app.core.ihmcl import get_unique_plazas, get_plaza_data
import geopandas as gpd
from shapely.geometry import Point
import json
import zipfile
from io import BytesIO

router = APIRouter()

# Global state to keep the uploaded shapefile in memory for fast PIP lookups
global_gdf = None

def clean_zone_str(val):
    s = str(val).strip()
    if s.endswith('.0'):
        s = s[:-2]
    # Remove common prefixes to ensure 'Zone 44' or 'Polygon_44' matches '44'
    s = s.replace("Zone ", "").replace("ZONE ", "").replace("Polygon_", "").replace("POLYGON_", "")
    return s

@router.get("/suggestions")
def get_suggestions(
    name: str = Query(..., description="The place name to search suggestions for"),
    plaza_coords: Optional[str] = Query(None, description="JSON array of {lat, lng} plaza coordinates for geo-biasing"),
    plaza_names: Optional[str] = Query(None, description="JSON array of plaza names corresponding to plaza_coords"),
    zone_restriction: Optional[str] = Query(None, description="Strictly restrict results to this zone polygon limit"),
    state: Optional[str] = Query(None, description="Restrict search to this Indian state")
):
    """
    Lazy suggestion endpoint. Called by the frontend when the user navigates to
    a specific place. Runs phonetic→fuzzy matching against the reference CSV,
    then geocodes each matched name via the Google Maps Geocoding API.
    Never called during upload — only on-demand.
    """
    try:
        coords = json.loads(plaza_coords) if plaza_coords else []
    except Exception:
        coords = []

    try:
        names = json.loads(plaza_names) if plaza_names else []
    except Exception:
        names = []

    zone_polygon = None
    zone_geojson = None
    
    if zone_restriction:
        if global_gdf is not None:
            clean_restriction = clean_zone_str(zone_restriction)
            try:
                # 1. Identify the likely ID column case-insensitively
                id_col = None
                potential_names = ['ZONENUMBER', 'ZONENUM', 'ZONE_NUM', 'ZONE_NO', 'ZONE', 'ID', 'NAME', 'FID', 'OBJECTID']
                
                # Check actual columns case-insensitively
                cols_upper = {c.upper(): c for c in global_gdf.columns}
                for p in potential_names:
                    if p in cols_upper:
                        id_col = cols_upper[p]
                        break
                
                if id_col:
                    for idx, row in global_gdf.iterrows():
                        val = row[id_col]
                        if clean_zone_str(val) == clean_restriction:
                            zone_polygon = row['geometry']
                            break
            except Exception as e:
                print(f"Error fetching zone polygon for restriction: {e}")
        
        # If restriction is requested but NO polygon is found (e.g. no shapefile or wrong name)
        # we MUST return empty so we don't accidentally fall back to "All over India"
        if zone_polygon is None:
            return {
                "suggestions": [], 
                "zoneGeometry": None,
                "error": f"Zone {zone_restriction} not found in Shapefile, or Shapefile not uploaded."
            }
        else:
            from shapely.geometry import mapping
            zone_geojson = mapping(zone_polygon)

    suggestions = generate_suggestions(name, limit=10, plaza_coords=coords, plaza_names=names, zone_polygon=zone_polygon, state=state)
    return {"suggestions": suggestions, "zoneGeometry": zone_geojson}


@router.get("/status")
def get_status():
    return {"status": "ok"}

import time
import os
import threading

@router.post("/shutdown")
def api_shutdown():
    """Shuts down the backend server."""
    def _shutdown():
        time.sleep(0.5)
        os._exit(0)
    threading.Thread(target=_shutdown, daemon=True).start()
    return {"status": "shutting down"}

@router.post("/upload/excel")
async def upload_excel(
    file: UploadFile = File(...),
    mode: Optional[str] = Form(None)
):
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(status_code=400, detail="Invalid file format. Please upload an Excel file.")
    try:
        file_bytes = await file.read()
        parsed_data = parse_excel_data(file_bytes, mode=mode)
            
        # Process data without legacy Excel-based users or survey locations
        processed_data = process_od_data(
            parsed_data["main_data"],
            parsed_data["ca_codes_abstract"], # Default to abstract for initial processing logic if needed, but processor now handles both
            od_codes=parsed_data.get("od_codes", {})
        )
        def clean_json(obj):
            import math
            import numpy as np

            # Recurse into containers
            if isinstance(obj, list):
                return [clean_json(x) for x in obj]
            if isinstance(obj, dict):
                return {k: clean_json(v) for k, v in obj.items()}

            # Convert numpy types to native Python FIRST
            if isinstance(obj, np.bool_):
                return bool(obj)
            if isinstance(obj, np.integer):
                return int(obj)
            if isinstance(obj, np.floating):
                val = float(obj)
                if math.isnan(val) or math.isinf(val):
                    return None
                return val

            # Handle standard Python float NaN/Inf
            if isinstance(obj, float):
                if math.isnan(obj) or math.isinf(obj):
                    return None

            # Catch-all for any remaining null-like values (None, NaT, etc.)
            if obj is None:
                return None
            try:
                # Safely check for pandas NA types (NaT, NA, etc.)
                import pandas as pd
                if pd.isna(obj):
                    return None
            except (ValueError, TypeError):
                pass

            return obj

        # --- Calculate Preliminary Analysis Data ---
        import pandas as pd
        preliminary_analysis = {}
        prelim_df = pd.DataFrame(parsed_data["main_data"])
        if not prelim_df.empty:
            rename_dict = {}
            for col in prelim_df.columns:
                stripped_col = str(col).strip().upper()
                if stripped_col in ['PLAZA_NAME', 'DIRECTION', 'MAV_SPLIT'] and col != stripped_col:
                    rename_dict[col] = stripped_col
            prelim_df = prelim_df.rename(columns=rename_dict)
            
            if 'PLAZA_NAME' in prelim_df.columns and 'DIRECTION' in prelim_df.columns and 'MAV_SPLIT' in prelim_df.columns:
                grouped = prelim_df.groupby(['PLAZA_NAME', 'DIRECTION', 'MAV_SPLIT']).size().reset_index(name='count')
                for _, row in grouped.iterrows():
                    plaza = str(row['PLAZA_NAME']).strip()
                    direction = str(row['DIRECTION']).strip()
                    mav = str(row['MAV_SPLIT']).strip()
                    count = int(row['count'])
                    
                    if not plaza or plaza.upper() == 'NAN': continue
                    if not direction or direction.upper() == 'NAN': direction = "Unknown"
                    if not mav or mav.upper() == 'NAN': continue
                    
                    if plaza not in preliminary_analysis:
                        preliminary_analysis[plaza] = {}
                    if direction not in preliminary_analysis[plaza]:
                        preliminary_analysis[plaza][direction] = {}
                    preliminary_analysis[plaza][direction][mav] = count

        response_data = {
            "message": "Excel file parsed successfully",
            "total_rows": len(parsed_data["main_data"]),
            "ca_codes_abstract": parsed_data.get("ca_codes_abstract", []),
            "ca_codes_detailed": parsed_data.get("ca_codes_detailed", []),
            "resolved_raw_od": parsed_data.get("resolved_raw_od", []),
            "preliminary_analysis": preliminary_analysis,
            "data": processed_data,
            "unresolved_commodities": parsed_data.get("unresolved_commodities", []),
            "auto_matched_commodities": parsed_data.get("auto_matched_commodities", {}),
            "commodity_suggestions": {}
        }
        
        if mode in ["Zone assign", "Place Search"]:
            from app.core.commodity_matcher import get_suggestions_for_unresolved
            unresolved = parsed_data.get("unresolved_commodities", [])
            response_data["commodity_suggestions"] = get_suggestions_for_unresolved(unresolved)
            
        return clean_json(response_data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing file: {str(e)}")

import uuid
TEMP_EXCEL_STORE = {}

@router.post("/upload/append_excel/process")
async def append_excel(
    base_excel: UploadFile = File(...),
    new_excel: UploadFile = File(...),
    mode: Optional[str] = Form(None)
):
    try:
        import pandas as pd
        from io import BytesIO
        import math
        import numpy as np

        base_bytes = await base_excel.read()
        new_bytes = await new_excel.read()
        
        base_xl = pd.ExcelFile(BytesIO(base_bytes))
        new_xl = pd.ExcelFile(BytesIO(new_bytes))
        
        if "Auto_OD_input" not in base_xl.sheet_names:
            raise ValueError("Base project file must have 'Auto_OD_input' sheet.")
        if "Auto_OD_input" not in new_xl.sheet_names:
            raise ValueError("Appended file must have 'Auto_OD_input' sheet.")
            
        base_df = base_xl.parse("Auto_OD_input")
        new_df = new_xl.parse("Auto_OD_input")
        
        # Concatenate - only Auto_OD_input data
        merged_df = pd.concat([base_df, new_df], ignore_index=True)
        
        # Build merged output: only Auto_OD_input + CA code reference sheets from base
        CA_SHEETS = ["CA_code_ABSTRACT", "CA_code_DETAILED", "CA_code", "OD_code"]
        merged_output = BytesIO()
        with pd.ExcelWriter(merged_output, engine='openpyxl') as writer:
            merged_df.to_excel(writer, sheet_name='Auto_OD_input', index=False)
            for sheet in CA_SHEETS:
                if sheet in base_xl.sheet_names:
                    try:
                        base_xl.parse(sheet).to_excel(writer, sheet_name=sheet, index=False)
                    except: pass
                     
        merged_bytes = merged_output.getvalue()
        file_id = str(uuid.uuid4())
        TEMP_EXCEL_STORE[file_id] = merged_bytes
        
        # Parse the ENTIRE merged dataset so analytics are globally updated
        parsed_merged = parse_excel_data(merged_bytes, mode=mode)
        processed_merged = process_od_data(
            parsed_merged["main_data"],
            parsed_merged.get("ca_codes_abstract", []),
            od_codes=parsed_merged.get("od_codes", {})
        )
        
        def clean_json(obj):
            if isinstance(obj, list): return [clean_json(x) for x in obj]
            if isinstance(obj, dict): return {k: clean_json(v) for k, v in obj.items()}
            if isinstance(obj, np.bool_): return bool(obj)
            if isinstance(obj, np.integer): return int(obj)
            if isinstance(obj, (np.floating, float)):
                val = float(obj)
                if math.isnan(val) or math.isinf(val): return None
                return val
            if obj is None: return None
            try:
                import pandas as pd
                if pd.isna(obj): return None
            except: pass
            return obj

        # Calculate preliminary analysis for NEW DATA only
        preliminary_analysis = {}
        if not new_df.empty:
            rename_dict = {}
            for col in new_df.columns:
                stripped_col = str(col).strip().upper()
                if stripped_col in ['PLAZA_NAME', 'DIRECTION', 'MAV_SPLIT'] and col != stripped_col:
                    rename_dict[col] = stripped_col
            new_df_renamed = new_df.rename(columns=rename_dict)
            
            if 'PLAZA_NAME' in new_df_renamed.columns and 'DIRECTION' in new_df_renamed.columns and 'MAV_SPLIT' in new_df_renamed.columns:
                grouped = new_df_renamed.groupby(['PLAZA_NAME', 'DIRECTION', 'MAV_SPLIT']).size().reset_index(name='count')
                for _, row in grouped.iterrows():
                    plaza = str(row['PLAZA_NAME']).strip()
                    direction = str(row['DIRECTION']).strip()
                    mav = str(row['MAV_SPLIT']).strip()
                    count = int(row['count'])
                    
                    if not plaza or plaza.upper() == 'NAN': continue
                    if not direction or direction.upper() == 'NAN': direction = "Unknown"
                    if not mav or mav.upper() == 'NAN': continue
                    
                    if plaza not in preliminary_analysis:
                        preliminary_analysis[plaza] = {}
                    if direction not in preliminary_analysis[plaza]:
                        preliminary_analysis[plaza][direction] = {}
                    preliminary_analysis[plaza][direction][mav] = count

        return clean_json({
            "message": "Files merged successfully",
            "temp_id": file_id,
            "data": processed_merged,
            "preliminary_analysis": preliminary_analysis
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error appending files: {str(e)}")

@router.get("/download/temp_excel/{file_id}")
async def download_temp_excel(file_id: str):
    if file_id not in TEMP_EXCEL_STORE:
        raise HTTPException(status_code=404, detail="Merged file not found or expired.")
    return Response(
        content=TEMP_EXCEL_STORE[file_id],
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=od_dataset.xlsx"}
    )

@router.post("/upload/shapefile")
async def upload_shapefile(file: UploadFile = File(...)):
    global global_gdf
    if not file.filename.endswith('.zip'):
        raise HTTPException(status_code=400, detail="Please upload the shapefile as a .zip archive.")
    try:
        contents = await file.read()
        global_gdf = process_shapefile_zip(contents)
        
        # Ensure it is currently in a geographic CRS for lat/lon lookups if it's not already
        if global_gdf.crs and not global_gdf.crs.is_geographic:
             global_gdf = global_gdf.to_crs(epsg=4326)

        return {
            "message": "Shapefile loaded successfully",
            "features_count": len(global_gdf),
            "crs": str(global_gdf.crs)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing shapefile: {str(e)}")

@router.get("/zone")
def get_zone(lat: float, lng: float):
    global global_gdf
    if global_gdf is None:
        return {"zone": None, "message": "No shapefile loaded"}
        
    try:
        # Create a Shapely Point from the query
        point = Point(lng, lat)
        
        # Find exactly which polygon contains this point
        # Assumes the shapefile has a column like 'ZONE', 'ID', or 'NAME' we can return
        # Here we just iterate directly over geometry which is very fast for small shapefiles
        for idx, row in global_gdf.iterrows():
            if row['geometry'].contains(point):
                # Try to find a reasonable identifier column 
                potential_names = ['ZONENUMBER', 'ZONENUM', 'ZONE_NUM', 'ZONE_NO', 'ZONE', 'ID', 'NAME', 'FID', 'OBJECTID']
                cols_upper = {c.upper(): c for c in global_gdf.columns}
                for p in potential_names:
                    if p in cols_upper:
                        zone_val = str(row[cols_upper[p]])
                        break
                
                # If no clear column is found, fallback to index
                if not zone_val:
                    zone_val = f"Polygon_{idx}"
                    
                return {"zone": zone_val}
                
        return {"zone": None, "message": "Outside all zones"}
    except Exception as e:
        return {"zone": None, "error": str(e)}


@router.get("/shapefile/geojson")
def get_shapefile_geojson():
    """
    Returns the currently loaded shapefile (global_gdf) as a standard GeoJSON
    FeatureCollection so the frontend can overlay it on the map.
    """
    global global_gdf
    if global_gdf is None:
        return {"type": "FeatureCollection", "features": []}
    try:
        # Ensure geographic CRS
        gdf = global_gdf
        if gdf.crs and gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs(epsg=4326)
        return json.loads(gdf.to_json())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to serialise shapefile: {str(e)}")

from fastapi import Form
from fastapi.responses import Response
import json
from app.core.exporter import generate_export_excel, generate_survey_locations_excel

@router.post("/export")
async def export_excel(
    mapping: str = Form(...),
    excel_file: UploadFile = File(...),
    shapefile_zip: UploadFile = File(None)
):
    try:
        mapping_dict = json.loads(mapping)
        
        excel_bytes = await excel_file.read()
        
        gdf = None
        if shapefile_zip is not None:
            shape_bytes = await shapefile_zip.read()
            gdf = process_shapefile_zip(shape_bytes)
            
        output_bytes = generate_export_excel(excel_bytes, gdf, mapping_dict)
        
        return Response(
            content=output_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=Validated_OD_Output.xlsx"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")

from app.core.exporter import generate_progress_excel, generate_survey_locations_excel

@router.post("/export/progress")
async def export_progress(
    mapping: str = Form(...),
    excel_file: UploadFile = File(None),
    shapefile_zip: UploadFile = File(None),
    plaza_mapping: Optional[str] = Form(None),
    project_config: Optional[str] = Form(None),
    mode: Optional[str] = Form(None),
    commodity_mapping: Optional[str] = Form(None)
):
    try:
        from app.core.exporter import update_zones_with_shapefile
        mapping_dict = json.loads(mapping)
        plaza_mapping_dict = json.loads(plaza_mapping) if plaza_mapping else {}
        commodity_mapping_dict = json.loads(commodity_mapping) if commodity_mapping else {}
        
        excel_bytes = None
        if excel_file is not None:
            excel_bytes = await excel_file.read()
            
        gdf = None
        shape_bytes = None
        if shapefile_zip is not None:
            shape_bytes = await shapefile_zip.read()
            gdf = process_shapefile_zip(shape_bytes)
            if gdf.crs and not gdf.crs.is_geographic:
                gdf = gdf.to_crs(epsg=4326)

        # Removed Place assign logic for Zone Assign export

        # 1. Generate Resolved Places Excel
        resolved_xlsx = generate_progress_excel(mapping_dict, gdf, excel_bytes, commodity_mapping=commodity_mapping_dict)
        
        # 2. Generate Survey Locations Excel
        survey_xlsx = generate_survey_locations_excel(plaza_mapping_dict)
        
        # 3. Bundle into Zip
        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            # Add Resolved Places (Original sheets + Resolved Places sheet)
            zip_file.writestr("ODIN_Resolved_OD_Dataset.xlsx", resolved_xlsx)
            
            # Add Survey Locations
            zip_file.writestr("ODIN_Survey_Location_Mapping.xlsx", survey_xlsx)
            
            # Add Original Shapefile if it exists
            if shape_bytes:
                zip_file.writestr("Shapefile_Original.zip", shape_bytes)

            # 4. Add Metadata for Re-opening (use updated mapping)
            zip_file.writestr("resolutions.json", mapping)
            if plaza_mapping:
                zip_file.writestr("plaza_mapping.json", plaza_mapping)
            if project_config:
                zip_file.writestr("project_config.json", project_config)
                
        zip_buffer.seek(0)
        
        return Response(
            content=zip_buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=ODIN_Export_Project.zip"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Progress export failed: {str(e)}")

@router.post("/export/pa_progress")
async def export_pa_progress(
    mapping: str = Form(...),
    excel_file: UploadFile = File(None),
    shapefile_zip: UploadFile = File(None),
    geojson_file: UploadFile = File(None),
    plaza_mapping: Optional[str] = Form(None),
    project_config: Optional[str] = Form(None),
    components: Optional[str] = Form(None)
):
    try:
        from app.core.exporter import update_zones_with_shapefile, generate_progress_excel, generate_survey_locations_excel
        mapping_dict = json.loads(mapping)
        plaza_mapping_dict = json.loads(plaza_mapping) if plaza_mapping else {}
        
        excel_bytes = None
        if excel_file is not None:
            excel_bytes = await excel_file.read()
            
        gdf = None
        shape_bytes = None

        # Prefer GeoJSON over shapefile for PIP in Place Assign
        if geojson_file is not None:
            geojson_bytes = await geojson_file.read()
            try:
                import geopandas as gpd
                gdf = gpd.read_file(BytesIO(geojson_bytes))
                if gdf.crs and not gdf.crs.is_geographic:
                    gdf = gdf.to_crs(epsg=4326)
            except Exception as e:
                print(f"GeoJSON parse failed: {e}")

        if gdf is None and shapefile_zip is not None:
            shape_bytes = await shapefile_zip.read()
            gdf = process_shapefile_zip(shape_bytes)
            if gdf.crs and not gdf.crs.is_geographic:
                gdf = gdf.to_crs(epsg=4326)

        # Place assign: re-zone all resolved places using PIP
        if gdf is not None:
            mapping_dict = update_zones_with_shapefile(mapping_dict, gdf)
            mapping = json.dumps(mapping_dict)

        # include_zone=True so Zone Number column appears in Place Assign Resolved_Places
        components_list = json.loads(components) if components else []
        geojson_bytes_for_export = None
        if geojson_file is not None:
            # Re-read the geojson bytes for the exporter (already consumed above)
            pass
        resolved_xlsx = generate_progress_excel(mapping_dict, gdf, excel_bytes, include_zone=True, components=components_list)
        survey_xlsx = generate_survey_locations_excel(plaza_mapping_dict)
        
        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            zip_file.writestr("ODIN_Resolved_OD_Dataset.xlsx", resolved_xlsx)
            zip_file.writestr("ODIN_Survey_Location_Mapping.xlsx", survey_xlsx)
            if shape_bytes:
                zip_file.writestr("Shapefile_Original.zip", shape_bytes)
            zip_file.writestr("resolutions.json", mapping)
            if plaza_mapping:
                zip_file.writestr("plaza_mapping.json", plaza_mapping)
            if project_config:
                zip_file.writestr("project_config.json", project_config)
            if geojson_file is not None:
                await geojson_file.seek(0)
                g_bytes = await geojson_file.read()
                zip_file.writestr("zoning_scheme.geojson", g_bytes)
                
        zip_buffer.seek(0)
        
        return Response(
            content=zip_buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=ODIN_PA_Export_Project.zip"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Place Assign export failed: {str(e)}")

from app.core.exporter import generate_rv_progress_excel

@router.post("/export/rv_progress")
async def export_rv_progress(
    mapping: str = Form(...),
    excel_file: UploadFile = File(None),
    shapefile_zip: UploadFile = File(None),
    plaza_mapping: Optional[str] = Form(None),
    validator_name: Optional[str] = Form(None),
    rv_intrazonal_data: Optional[str] = Form(None)
):
    try:
        mapping_dict = json.loads(mapping)
        plaza_mapping_dict = json.loads(plaza_mapping) if plaza_mapping else {}
        intrazonal_list = json.loads(rv_intrazonal_data) if rv_intrazonal_data else []
        v_name = validator_name or ''

        excel_bytes = None
        if excel_file is not None:
            excel_bytes = await excel_file.read()

        gdf = None
        shape_bytes = None
        if shapefile_zip is not None:
            shape_bytes = await shapefile_zip.read()
            gdf = process_shapefile_zip(shape_bytes)

        # 1. Generate Resolved Places Excel (same as Zone Assign) with validator name column
        resolved_xlsx = generate_rv_progress_excel(mapping_dict, gdf, excel_bytes, intrazonal_list, v_name)

        # 2. Generate Survey Locations Excel
        survey_xlsx = generate_survey_locations_excel(plaza_mapping_dict)

        # 3. Bundle into ZIP (exact same format as Zone Assign)
        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            zip_file.writestr("ODIN_Resolved_OD_Dataset.xlsx", resolved_xlsx)
            zip_file.writestr("ODIN_Survey_Location_Mapping.xlsx", survey_xlsx)

            if shape_bytes:
                zip_file.writestr("Shapefile_Original.zip", shape_bytes)

            # Metadata for re-opening
            zip_file.writestr("resolutions.json", mapping)
            if plaza_mapping:
                zip_file.writestr("plaza_mapping.json", plaza_mapping)

        zip_buffer.seek(0)

        return Response(
            content=zip_buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=ODIN_RV_Export_Project.zip"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"R&V Progress export failed: {str(e)}")
# --- IHMCL Base Number Endpoints ---

@router.get("/ihmcl/plazas")
def api_get_ihmcl_plazas():
    """Retrieves all unique plaza names from the preloaded IHMCL database."""
    plazas = get_unique_plazas()
    return {"plazas": plazas}

@router.post("/ihmcl/plaza_data")
def api_get_ihmcl_plaza_data(plaza_names: List[str] = Body(...)):
    """Retrieves the complete monthly traffic/revenue history for the requested plazas."""
    try:
        data = get_plaza_data(plaza_names)
        return {"data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch IHMCL data: {str(e)}")

# --- Database Management Endpoints ---

from app.core.algorithms import add_place_to_database

@router.post("/database/add_place")
async def api_add_place_to_database(payload: Dict[str, str] = Body(...)):
    """
    Adds a new place name to the global unique_names.csv database.
    Used when a user resolves a place found via manual search that wasn't in suggestions.
    """
    name = payload.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    
    result = add_place_to_database(name)
    if result["status"] == "error":
        raise HTTPException(status_code=500, detail=result["message"])
        
    return result

# ═══════════════════════════════════════════════════════════════════════════════
#  CONFIGURATION ENDPOINTS (Google API Key)
# ═══════════════════════════════════════════════════════════════════════════════

import dotenv
from pydantic import BaseModel

class APIKeyPayload(BaseModel):
    key: str

@router.get("/config/maps-key")
def get_maps_api_key():
    """
    Returns the Google Maps API key if available in the environment.
    Safe for local desktop-app use.
    """
    import os
    key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    return {"has_key": bool(key), "key": key}

@router.post("/config/maps-key")
def set_maps_api_key(payload: APIKeyPayload):
    """
    Saves the user-provided Google Maps API key to os.environ only for the current session.
    It is no longer saved to backend/.env to ensure it resets on app shutdown.
    """
    import os
    
    key = payload.key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="API Key cannot be empty.")
        
    # Update current runtime environment ONLY
    os.environ["GOOGLE_MAPS_API_KEY"] = key
    
    return {"status": "success", "message": "API key successfully set for this session."}


# ═══════════════════════════════════════════════════════════════════════════════
#  VERSION CHECK & SELF-UPDATE ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

import requests as _requests
import subprocess
import shutil
import time as _time
import os
import sys
import threading
from packaging.version import Version, InvalidVersion
from pathlib import Path as _Path

from app.version import LOCAL_VERSION, PROJECT_ROOT

# ── Configuration ─────────────────────────────────────────────────────────────
GITHUB_REPO_OWNER = "iamsankar999"
GITHUB_REPO_NAME  = "ODIN"
GITHUB_API_URL    = f"https://api.github.com/repos/{GITHUB_REPO_OWNER}/{GITHUB_REPO_NAME}/releases/latest"

# ── Cache (avoid hammering GitHub API) ────────────────────────────────────────
_update_cache = {"data": None, "timestamp": 0}
_CACHE_TTL = 3600  # 1 hour


def _parse_version(v: str) -> Version:
    """Strip leading 'v' and parse as PEP-440 version."""
    return Version(v.lstrip("vV"))


@router.get("/version/check")
def check_for_update():
    """
    Compare the local version (from version.json) against the latest
    GitHub release.  Returns update availability + download URL.
    """
    now = _time.time()

    # Return cached result if fresh
    if _update_cache["data"] and (now - _update_cache["timestamp"]) < _CACHE_TTL:
        return _update_cache["data"]

    result = {
        "local_version": LOCAL_VERSION,
        "latest_version": LOCAL_VERSION,
        "update_available": False,
        "download_url": None,
        "release_notes": None,
    }

    try:
        resp = _requests.get(
            GITHUB_API_URL,
            headers={"Accept": "application/vnd.github.v3+json"},
            timeout=8,
        )
        if resp.status_code == 200:
            data = resp.json()
            latest_tag = data.get("tag_name", LOCAL_VERSION)
            latest_ver = _parse_version(latest_tag)
            local_ver  = _parse_version(LOCAL_VERSION)

            result["latest_version"] = str(latest_ver)
            result["update_available"] = latest_ver > local_ver
            result["download_url"] = data.get("html_url")
            result["release_notes"] = data.get("body", "")
            result["zipball_url"] = data.get("zipball_url")
        # else: GitHub unreachable or rate-limited — silently keep defaults
    except Exception:
        pass  # Offline or network error — do not disrupt the user

    _update_cache["data"] = result
    _update_cache["timestamp"] = now
    return result


@router.post("/version/update")
def apply_update():
    """
    Download the latest release from GitHub and perform a self-update.
    
    Flow:
      1. Download the source ZIP (zipball) from GitHub Releases.
      2. Extract to  _update_staging/  folder.
      3. Generate  _apply_update.bat  that copies new files over old ones.
      4. Launch the bat script (detached) and shut down the server.
      5. The bat script waits for the server to stop, copies files,
         deletes the staging folder, and relaunches ODIN_Launch.bat.
    """
    # 1. Fetch latest release info
    try:
        resp = _requests.get(
            GITHUB_API_URL,
            headers={"Accept": "application/vnd.github.v3+json"},
            timeout=10,
        )
        resp.raise_for_status()
        release = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach GitHub: {e}")

    zipball_url = release.get("zipball_url")
    if not zipball_url:
        raise HTTPException(status_code=502, detail="No zipball URL in release data.")

    staging_dir = PROJECT_ROOT / "_update_staging"
    extract_dir = staging_dir / "extracted"

    # Clean previous staging
    if staging_dir.exists():
        shutil.rmtree(staging_dir, ignore_errors=True)
    staging_dir.mkdir(parents=True)
    extract_dir.mkdir(parents=True)

    # 2. Download the zipball
    zip_path = staging_dir / "update.zip"
    try:
        dl = _requests.get(zipball_url, stream=True, timeout=60)
        dl.raise_for_status()
        with open(zip_path, "wb") as f:
            for chunk in dl.iter_content(chunk_size=8192):
                f.write(chunk)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Download failed: {e}")

    # 3. Extract the ZIP
    import zipfile as _zipfile
    try:
        with _zipfile.ZipFile(str(zip_path), "r") as zf:
            zf.extractall(str(extract_dir))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction failed: {e}")

    # GitHub zipball has one top-level directory, e.g. "iamsankar999-ODIN-abc1234/"
    subdirs = [d for d in extract_dir.iterdir() if d.is_dir()]
    if len(subdirs) == 1:
        source_root = subdirs[0]
    else:
        source_root = extract_dir

    # 4. Generate _apply_update.bat
    #    Uses robocopy instead of xcopy.  xcopy's /exclude matches against the
    #    full *source* path, so putting "_update_staging\" in the exclusion list
    #    causes it to skip every file (they all live under _update_staging\).
    #    robocopy's /XD and /XF match by directory/file *name*, which is correct.
    bat_path = PROJECT_ROOT / "_apply_update.bat"

    bat_content = f"""@echo off
setlocal
title ODIN — Applying Update...
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║    ODIN  —  Applying Update...           ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Wait for the server process to release port 8000
echo  Waiting for ODIN server to stop...
:wait_loop
timeout /t 1 /nobreak >nul
netstat -aon 2>nul | findstr ":8000 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto wait_loop
echo  Server stopped.
timeout /t 2 /nobreak >nul

cd /d "{PROJECT_ROOT}"

:: Copy new files over old ones using robocopy
:: /E           = copy subdirectories including empty ones
:: /XD          = exclude directories by name (not path substring)
:: /XF          = exclude files by name
:: /R:1 /W:1    = retry once, wait 1 sec (avoid hangs on locked files)
:: /NFL /NDL /NP = suppress per-file/dir/progress logging (keep summary)
:: /IS /IT      = include same and tweaked files (forces overwrite even if timestamp is older)
echo  Copying updated files...
robocopy "{source_root}" "." /E /XD .git python-embed _update_staging __pycache__ /XF .env _apply_update.bat /R:1 /W:1 /NFL /NDL /NP /IS /IT
:: robocopy exit codes: 0-7 = success, 8+ = error
if errorlevel 8 (
    echo  [WARNING] Some files may not have been copied. Check permissions.
)

:: Delete the packages sentinel so any new requirements get installed
if exist "python-embed\\.packages_ok" del /q "python-embed\\.packages_ok"

:: Clean up staging
echo  Cleaning up...
rmdir /s /q "_update_staging" 2>nul

echo.
echo  Update applied successfully!
echo  Restarting ODIN...
echo.

:: Relaunch ODIN with --no-browser flag (existing browser tab will auto-reload)
start "" "ODIN_Launch.bat" --no-browser

:: Self-delete this batch file
(goto) 2>nul & del "%~f0"
"""
    bat_path.write_text(bat_content, encoding="utf-8")

    # 5. Launch the bat and shut down
    def _launch_and_exit():
        _time.sleep(0.5)
        subprocess.Popen(
            f'cmd /c "{bat_path}"',
            shell=True,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
        _time.sleep(0.5)
        os._exit(0)  # Hard exit to release port 8000

    threading.Thread(target=_launch_and_exit, daemon=True).start()

    return {
        "status": "ok",
        "message": "Update downloaded. ODIN will restart automatically.",
        "version": release.get("tag_name", "unknown"),
    }


# ═══════════════════════════════════════════════════════════════════════
#  CREATE ZONES — Districts API
# ═══════════════════════════════════════════════════════════════════════

import os as _os
import json
import zipfile
from io import BytesIO
from fastapi.responses import StreamingResponse, JSONResponse, Response as FastResponse

_possible_paths = [
    _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..", "..", "database", "INDIA_DISTRICTSoriginal.geojson")),
    _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..", "..", "..", "database", "INDIA_DISTRICTSoriginal.geojson")),
    _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..", "..", "..", "od_validation_system", "database", "INDIA_DISTRICTSoriginal.geojson")),
]
_DISTRICTS_PATH = next((p for p in _possible_paths if _os.path.exists(p)), _possible_paths[0])
_cached_states = None
_cached_states_gdf = None

_possible_states_paths = [
    _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..", "..", "database", "INDIA_STATES.geojson")),
    _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..", "..", "..", "database", "INDIA_STATES.geojson")),
]
_STATES_PATH = next((p for p in _possible_states_paths if _os.path.exists(p)), _possible_states_paths[0])

def _get_states_gdf():
    global _cached_states_gdf
    if _cached_states_gdf is None and _os.path.exists(_STATES_PATH):
        try:
            gdf = gpd.read_file(_STATES_PATH)
            if gdf.crs is None or gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)
            st_col = next((c for c in gdf.columns if c.upper() in ["STNAME", "STATE_NAME", "STATE"]), None)
            if st_col:
                gdf["_st_norm"] = gdf[st_col].astype(str).str.strip().str.upper()
            _cached_states_gdf = gdf
        except Exception as e:
            print(f"Error loading states gdf: {e}")
    return _cached_states_gdf

@router.get("/states/geojson")
def get_states_geojson():
    """Stream the India states GeoJSON (INDIA_STATES.geojson, ~2.3MB, read-only)."""
    if not _os.path.exists(_STATES_PATH):
        raise HTTPException(status_code=404, detail="INDIA_STATES.geojson not found in database folder.")
    def _stream():
        with open(_STATES_PATH, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                yield chunk
    return StreamingResponse(_stream(), media_type="application/json",
                             headers={"Content-Disposition": "inline; filename=states.geojson"})


@router.post("/states/dissolve")
def dissolve_states(payload: dict = Body(...)):
    """Accept a list of state names and return the dissolved outer boundary GeoJSON feature."""
    states = payload.get("states", [])
    if not states:
        raise HTTPException(status_code=400, detail="No states specified")
    gdf = _get_states_gdf()
    if gdf is None or "_st_norm" not in gdf.columns:
        raise HTTPException(status_code=500, detail="States spatial database not available")
    st_upper = [str(s).strip().upper() for s in states if s]
    sub = gdf[gdf["_st_norm"].isin(st_upper)]
    if sub.empty:
        raise HTTPException(status_code=404, detail="No matching states found for dissolve")
    try:
        dissolved = sub.dissolve()
        geom = dissolved.geometry.values[0]
        geom_json = json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"]
        return {
            "type": "Feature",
            "properties": {"states": states},
            "geometry": geom_json
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Dissolve failed: {str(e)}")


@router.get("/districts/geojson")
def get_districts_geojson():
    """Stream the India districts GeoJSON from the database folder (read-only, never modified)."""
    if not _os.path.exists(_DISTRICTS_PATH):
        raise HTTPException(status_code=404, detail="INDIA_DISTRICTSoriginal.geojson not found in database folder.")
    def _stream():
        with open(_DISTRICTS_PATH, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                yield chunk
    return StreamingResponse(_stream(), media_type="application/json",
                             headers={"Content-Disposition": "inline; filename=districts.geojson"})


@router.get("/districts/states")
def get_districts_states():
    """Return a sorted list of unique state names from the districts GeoJSON."""
    global _cached_states
    if _cached_states is not None:
        return {"states": _cached_states}
    if not _os.path.exists(_DISTRICTS_PATH):
        raise HTTPException(status_code=404, detail="INDIA_DISTRICTSoriginal.geojson not found.")
    try:
        with open(_DISTRICTS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            states = set()
            for feat in data.get("features", []):
                st = feat.get("properties", {}).get("stname")
                if st:
                    states.add(str(st).strip())
            _cached_states = sorted(list(states))
        return {"states": _cached_states}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read states: {str(e)}")


@router.post("/districts/dissolve")
async def dissolve_districts(payload: dict = Body(...)):
    """
    Accept zone definitions and component assignments, dissolve per-zone geometries
    (states, merged states, districts, merged districts, or custom scissor splits),
    then return a ZIP containing:
      - zones.geojson  (dissolved, with zone_num, zone_name, district_region, stname, component_name)
      - zones_summary.xlsx  (Zoning_scheme sheet + Component_list sheet)
    """
    import pandas as pd
    from shapely.geometry import shape as _shape

    zones = payload.get("zones", [])
    if not zones:
        raise HTTPException(status_code=400, detail="No zones provided.")

    try:
        from app.core.algorithms import get_india_districts_gdf
        gdf = get_india_districts_gdf()
        if gdf is None:
            if not _os.path.exists(_DISTRICTS_PATH):
                raise HTTPException(status_code=404, detail="INDIA_DISTRICTSoriginal.geojson not found.")
            gdf = gpd.read_file(_DISTRICTS_PATH)
            if gdf.crs is None or gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)

        # Load states GDF if available for fast state dissolving
        states_gdf = None
        if _os.path.exists(_STATES_PATH):
            try:
                states_gdf = gpd.read_file(_STATES_PATH)
                if states_gdf.crs is None or states_gdf.crs.to_epsg() != 4326:
                    states_gdf = states_gdf.to_crs(epsg=4326)
                # Normalise column
                for c in ["STNAME", "stname"]:
                    if c in states_gdf.columns:
                        states_gdf["_st_norm"] = states_gdf[c].astype(str).str.strip().str.upper()
                        break
            except Exception as e:
                print(f"Warning: could not load states_gdf: {e}")

        dissolved_features = []
        for z in zones:
            z_num  = z.get("zone_num", "")
            z_name = z.get("zone_name", "")
            dists  = z.get("districts", [])
            stname = z.get("stname", "")
            states = z.get("states", []) or ([stname] if stname else [z_name])
            comp_num  = z.get("component_num", "")
            comp_name = z.get("component_name", "")
            geom_type = z.get("type", "districts")  # 'state' | 'state-merged' | 'districts' | 'split'

            # 1. Custom scissor split geometry supplied directly
            if geom_type == "split" or z.get("geometry"):
                raw_geom = z.get("geometry")
                if raw_geom:
                    geom = _shape(raw_geom)
                    reg = z.get("district_region") or z.get("district") or z_name
                    dissolved_features.append({
                        "type": "Feature",
                        "geometry": json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"],
                        "properties": {
                            "zone_num": str(z_num), "zone_name": str(z_name),
                            "district_region": str(reg), "stname": str(stname),
                            "component_num": str(comp_num), "component_name": str(comp_name)
                        }
                    })
                continue

            # 2. State-level zone (single state or merged states)
            if geom_type in ["state", "state-merged"] or (not dists and states):
                dissolved_geom = None
                # Expand composite state strings (e.g. "ASSAM + MEGHALAYA")
                expanded_states = []
                for s in states:
                    if not s:
                        continue
                    s_str = str(s).strip()
                    if " + " in s_str:
                        for part in s_str.split(" + "):
                            p = part.strip()
                            if p and p not in expanded_states:
                                expanded_states.append(p)
                    elif s_str not in expanded_states:
                        expanded_states.append(s_str)

                st_upper = [s.strip().upper() for s in expanded_states if s]
                if states_gdf is not None and "_st_norm" in states_gdf.columns:
                    st_sub = states_gdf[states_gdf["_st_norm"].isin(st_upper)]
                    if not st_sub.empty:
                        dissolved_geom = st_sub.dissolve().geometry.values[0]

                if dissolved_geom is None:
                    # Fallback to dissolving districts of those states
                    dt_sub = gdf[gdf["stname"].astype(str).str.strip().str.upper().isin(st_upper)]
                    if not dt_sub.empty:
                        dissolved_geom = dt_sub.dissolve().geometry.values[0]

                if dissolved_geom is not None:
                    reg = z.get("district_region") or ", ".join(expanded_states)
                    dissolved_features.append({
                        "type": "Feature",
                        "geometry": json.loads(gpd.GeoSeries([dissolved_geom]).to_json())["features"][0]["geometry"],
                        "properties": {
                            "zone_num": str(z_num), "zone_name": str(z_name),
                            "district_region": str(reg), "stname": str(stname or (expanded_states[0] if expanded_states else "")),
                            "component_num": str(comp_num), "component_name": str(comp_name)
                        }
                    })
                continue

            # 3. District-level zone (single or merged districts)
            if dists:
                st_val = str(stname or "").strip().upper()
                if not st_val and states:
                    st_val = str(states[0] or "").strip().upper()

                if st_val:
                    subset = gdf[
                        (gdf["dtname"].isin(dists)) &
                        (gdf["stname"].astype(str).str.strip().str.upper() == st_val)
                    ]
                    if subset.empty:
                        subset = gdf[gdf["dtname"].isin(dists)]
                else:
                    subset = gdf[gdf["dtname"].isin(dists)]

                if not subset.empty:
                    dissolved = subset.dissolve()
                    dissolved_geom = dissolved.geometry.values[0]
                    reg = z.get("district_region") or (", ".join(dists) if len(dists) > 1 else dists[0])
                    dissolved_features.append({
                        "type": "Feature",
                        "geometry": json.loads(gpd.GeoSeries([dissolved_geom]).to_json())["features"][0]["geometry"],
                        "properties": {
                            "zone_num": str(z_num), "zone_name": str(z_name),
                            "district_region": str(reg), "stname": str(stname),
                            "component_num": str(comp_num), "component_name": str(comp_name)
                        }
                    })

        geojson_out = {"type": "FeatureCollection", "features": dissolved_features}
        geojson_bytes = json.dumps(geojson_out, ensure_ascii=False).encode("utf-8")

        # Build Excel summary
        scheme_rows = []
        for z in zones:
            g_type = z.get("type", "districts")
            d_list = z.get("districts", [])
            s_list = z.get("states", []) or ([z.get("stname")] if z.get("stname") else [])
            if g_type == "split":
                reg = z.get("district_region") or z.get("district") or z.get("zone_name", "")
            elif d_list:
                reg = ", ".join(d_list)
            else:
                reg = ", ".join(s_list) if s_list else z.get("zone_name", "")

            scheme_rows.append({
                "Zone Number": z.get("zone_num", ""),
                "Zone Name": z.get("zone_name", ""),
                "District / Region": reg,
                "State Name": z.get("stname") or (s_list[0] if s_list else ""),
                "Component Number": z.get("component_num", ""),
                "Component Name": z.get("component_name", ""),
            })

        # Aggregate component list
        comp_map = {}
        for z in zones:
            cn = str(z.get("component_num", "")).strip()
            cname = str(z.get("component_name", "")).strip()
            if cn:
                if cn not in comp_map:
                    comp_map[cn] = {"Component Number": cn, "Component Name": cname, "Zone Numbers": []}
                comp_map[cn]["Zone Numbers"].append(str(z.get("zone_num", "")))
        comp_rows = [{"Component Number": v["Component Number"], "Component Name": v["Component Name"],
                      "Zone Numbers": ", ".join(v["Zone Numbers"])} for v in comp_map.values()]

        xl_buf = BytesIO()
        with pd.ExcelWriter(xl_buf, engine="openpyxl") as xl_writer:
            pd.DataFrame(scheme_rows).to_excel(xl_writer, sheet_name="Zoning_scheme", index=False)
            if comp_rows:
                pd.DataFrame(comp_rows).to_excel(xl_writer, sheet_name="Component_list", index=False)
        xl_bytes = xl_buf.getvalue()

        # Bundle into ZIP
        zip_buf = BytesIO()
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("zones.geojson", geojson_bytes)
            zf.writestr("zones_summary.xlsx", xl_bytes)
        zip_buf.seek(0)

        return FastResponse(
            content=zip_buf.read(),
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=zones_export.zip"}
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Dissolve failed: {str(e)}")


_cached_districts_gdf = None

def _get_districts_gdf():
    global _cached_districts_gdf
    if _cached_districts_gdf is None:
        from app.core.algorithms import get_india_districts_gdf
        gdf = get_india_districts_gdf()
        if gdf is None and _os.path.exists(_DISTRICTS_PATH):
            gdf = gpd.read_file(_DISTRICTS_PATH)
            if gdf.crs is None or gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)
        _cached_districts_gdf = gdf
    return _cached_districts_gdf

@router.post("/districts/dissolve-boundary")
def dissolve_districts_boundary(payload: dict = Body(...)):
    """Accept a list of district names and return the dissolved outer boundary GeoJSON feature."""
    districts = payload.get("districts", [])
    if not districts:
        raise HTTPException(status_code=400, detail="No districts specified")
    gdf = _get_districts_gdf()
    if gdf is None:
        raise HTTPException(status_code=500, detail="Districts spatial database not available")
    st_name = (payload.get("stname") or payload.get("state") or "").strip().upper()
    if st_name:
        sub = gdf[(gdf["dtname"].isin(districts)) & (gdf["stname"].astype(str).str.strip().str.upper() == st_name)]
        if sub.empty:
            sub = gdf[gdf["dtname"].isin(districts)]
    else:
        sub = gdf[gdf["dtname"].isin(districts)]
    if sub.empty:
        raise HTTPException(status_code=404, detail="No matching districts found")
    try:
        dissolved = sub.dissolve()
        geom = dissolved.geometry.values[0]
        geom_json = json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"]
        return {
            "type": "Feature",
            "properties": {"districts": districts},
            "geometry": geom_json
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"District dissolve failed: {str(e)}")


def _extend_line(line, dist=0.08):
    import math
    from shapely.geometry import LineString
    coords = list(line.coords)
    if len(coords) < 2:
        return line
    dx0 = coords[0][0] - coords[1][0]
    dy0 = coords[0][1] - coords[1][1]
    L0 = math.hypot(dx0, dy0) or 1.0
    p0 = (coords[0][0] + (dx0 / L0) * dist, coords[0][1] + (dy0 / L0) * dist)

    dx1 = coords[-1][0] - coords[-2][0]
    dy1 = coords[-1][1] - coords[-2][1]
    L1 = math.hypot(dx1, dy1) or 1.0
    p1 = (coords[-1][0] + (dx1 / L1) * dist, coords[-1][1] + (dy1 / L1) * dist)
    return LineString([p0] + coords + [p1])


@router.post("/districts/split")
async def split_district(payload: dict = Body(...)):
    """
    Split or clip a district polygon using a user-drawn line or polygon (DrawingManager output).
    Supports:
      - LineString (scissor cut across district borders or closed loop)
      - Polygon (scissor polygon / lasso cut)
      - Sequential multi-cuts via existing_parts
    Returns sub-feature GeoJSON Features for each sub-zone.
    """
    district_name = payload.get("district")
    clip_geom_raw  = payload.get("clip_polygon") or payload.get("cut_geometry")
    existing_parts = payload.get("existing_parts")
    if not district_name or not clip_geom_raw:
        raise HTTPException(status_code=400, detail="district and clip geometry are required.")

    try:
        from shapely.geometry import shape as _shape, mapping as _mapping, Polygon, MultiPolygon
        from shapely.ops import split as _shapely_split
        import math

        gdf = _get_districts_gdf()
        if gdf is None:
            raise HTTPException(status_code=404, detail="INDIA_DISTRICTSoriginal.geojson not found.")

        st_filter = (payload.get("stname") or payload.get("state") or "").strip().upper()
        if st_filter:
            district_row = gdf[(gdf["dtname"] == district_name) & (gdf["stname"].astype(str).str.strip().str.upper() == st_filter)]
            if district_row.empty:
                district_row = gdf[gdf["dtname"] == district_name]
        else:
            district_row = gdf[gdf["dtname"] == district_name]
        if district_row.empty:
            raise HTTPException(status_code=404, detail=f"District '{district_name}' not found.")

        district_geom = district_row.geometry.values[0]
        clip_geom = _shape(clip_geom_raw)
        st_name = district_row["stname"].values[0] if "stname" in district_row.columns else ""

        # Check if line is closed loop on itself
        is_closed_loop = False
        if clip_geom.geom_type in ["LineString", "MultiLineString"]:
            coords = list(clip_geom.coords)
            if len(coords) >= 3:
                d_endpoints = math.hypot(coords[0][0] - coords[-1][0], coords[0][1] - coords[-1][1])
                # If start and end point within ~0.008 degrees, treat as closed polygon
                if d_endpoints < 0.008 or coords[0] == coords[-1]:
                    is_closed_loop = True
                    if coords[0] != coords[-1]:
                        coords.append(coords[0])
                    clip_geom = Polygon(coords)

        def _split_geom(base_geom):
            if is_closed_loop or clip_geom.geom_type in ["Polygon", "MultiPolygon"]:
                inner = base_geom.intersection(clip_geom)
                outer = base_geom.difference(clip_geom)
                pieces = []
                for res in [inner, outer]:
                    if res and not res.is_empty:
                        for g in getattr(res, "geoms", [res]):
                            if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty and g.area > 1e-9:
                                pieces.append(g)
                return pieces if len(pieces) >= 2 else [base_geom]
            else:
                # LineString cut
                split_result = _shapely_split(base_geom, clip_geom)
                sub_geoms = [g for g in getattr(split_result, "geoms", [split_result])
                             if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty and g.area > 1e-9]

                if len(sub_geoms) < 2:
                    ext1 = _extend_line(clip_geom, dist=0.06)
                    split_result = _shapely_split(base_geom, ext1)
                    sub_geoms = [g for g in getattr(split_result, "geoms", [split_result])
                                 if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty and g.area > 1e-9]

                if len(sub_geoms) < 2:
                    ext2 = _extend_line(clip_geom, dist=0.18)
                    split_result = _shapely_split(base_geom, ext2)
                    sub_geoms = [g for g in getattr(split_result, "geoms", [split_result])
                                 if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty and g.area > 1e-9]

                if len(sub_geoms) < 2:
                    buf = clip_geom.buffer(0.0008)
                    diff = base_geom.difference(buf)
                    sub_geoms = [g for g in getattr(diff, "geoms", [diff])
                                 if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty and g.area > 1e-9]

                return sub_geoms if len(sub_geoms) >= 2 else [base_geom]

        final_geoms = []
        if existing_parts and len(existing_parts) >= 2:
            any_split = False
            for p in existing_parts:
                p_raw = p.get("geometry") if isinstance(p, dict) and "geometry" in p else p
                if not p_raw:
                    continue
                p_geom = _shape(p_raw)
                if p_geom.intersects(clip_geom):
                    pieces = _split_geom(p_geom)
                    if len(pieces) > 1:
                        any_split = True
                        final_geoms.extend(pieces)
                    else:
                        final_geoms.append(p_geom)
                else:
                    final_geoms.append(p_geom)

            if not any_split or len(final_geoms) <= len(existing_parts):
                final_geoms = _split_geom(district_geom)
        else:
            final_geoms = _split_geom(district_geom)

        features = []
        for idx, g in enumerate(final_geoms):
            features.append({
                "type": "Feature",
                "geometry": _mapping(g),
                "properties": {
                    "sub_label": f"Part {idx + 1}",
                    "district": district_name,
                    "stname": st_name
                }
            })

        if not features:
            raise HTTPException(status_code=400, detail="Split produced no valid geometry parts.")

        return {
            "type": "FeatureCollection",
            "features": features
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Split failed: {str(e)}")


@router.post("/custom/merge")
async def merge_custom_geometries(payload: dict = Body(...)):
    """
    Union multiple custom GeoJSON geometries together using shapely.ops.unary_union.
    """
    geometries = payload.get("geometries", [])
    if len(geometries) < 2:
        raise HTTPException(status_code=400, detail="At least 2 geometries required to merge.")
    try:
        from shapely.geometry import shape as _shape, mapping as _mapping
        from shapely.ops import unary_union
        shapes = [_shape(g) for g in geometries if g]
        merged = unary_union(shapes)
        return {"type": "Feature", "geometry": _mapping(merged)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Custom merge failed: {str(e)}")


