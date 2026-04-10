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
                potential_names = ['ZONENUMBER', 'ZONENUM', 'ZONE_NO', 'ZONE', 'ID', 'NAME', 'FID', 'OBJECTID']
                
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
        return {
            "message": "Excel file parsed successfully",
            "total_rows": len(parsed_data["main_data"]),
            "ca_codes_abstract": parsed_data.get("ca_codes_abstract", []),
            "ca_codes_detailed": parsed_data.get("ca_codes_detailed", []),
            "data": processed_data
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing file: {str(e)}")

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
                zone_val = None
                for col_candidate in ['ZONE_NO', 'Zone', 'zone', 'ZONE', 'ID', 'Name', 'NAME']:
                    if col_candidate in global_gdf.columns:
                        zone_val = str(row[col_candidate])
                        break
                
                # If no clear column is found, fallback to index
                if not zone_val:
                    zone_val = f"Polygon_{idx}"
                    
                return {"zone": zone_val}
                
        return {"zone": None, "message": "Outside all zones"}
    except Exception as e:
        return {"zone": None, "error": str(e)}

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

from app.core.exporter import generate_progress_excel

@router.post("/export/progress")
async def export_progress(
    mapping: str = Form(...),
    excel_file: UploadFile = File(None),
    shapefile_zip: UploadFile = File(None),
    plaza_mapping: Optional[str] = Form(None)
):
    try:
        mapping_dict = json.loads(mapping)
        plaza_mapping_dict = json.loads(plaza_mapping) if plaza_mapping else {}
        
        excel_bytes = None
        if excel_file is not None:
            excel_bytes = await excel_file.read()
            
        gdf = None
        shape_bytes = None
        if shapefile_zip is not None:
            shape_bytes = await shapefile_zip.read()
            gdf = process_shapefile_zip(shape_bytes)
            
        # 1. Generate Resolved Places Excel
        resolved_xlsx = generate_progress_excel(mapping_dict, gdf, excel_bytes)
        
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

            # 4. Add Metadata for Re-opening
            zip_file.writestr("resolutions.json", mapping)
            if plaza_mapping:
                zip_file.writestr("plaza_mapping.json", plaza_mapping)
                
        zip_buffer.seek(0)
        
        return Response(
            content=zip_buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=ODIN_Export_Project.zip"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Progress export failed: {str(e)}")

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
    bat_path = PROJECT_ROOT / "_apply_update.bat"
    odin_launch = PROJECT_ROOT / "ODIN_Launch.bat"

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
netstat -aon 2>nul | findstr ":8000 " >nul 2>&1
if not errorlevel 1 goto wait_loop
echo  Server stopped.

:: Copy new files over old ones
:: Exclude: python-embed, .env, _update_staging, _apply_update.bat
echo  Copying updated files...
xcopy "{source_root}\\*" "{PROJECT_ROOT}\\" /s /y /q /exclude:{staging_dir}\\xcopy_exclude.txt >nul 2>&1

:: Delete the packages sentinel so any new requirements get installed
if exist "{PROJECT_ROOT}\\python-embed\\.packages_ok" del /q "{PROJECT_ROOT}\\python-embed\\.packages_ok"

:: Clean up staging
echo  Cleaning up...
rmdir /s /q "{staging_dir}" 2>nul
del /q "{zip_path}" 2>nul

echo.
echo  Update applied successfully!
echo  Restarting ODIN...
echo.

:: Relaunch ODIN
start "" "{odin_launch}"

:: Self-delete this batch file
(goto) 2>nul & del "%~f0"
"""
    bat_path.write_text(bat_content, encoding="utf-8")

    # Write xcopy exclusion list
    exclude_path = staging_dir / "xcopy_exclude.txt"
    exclude_path.write_text(
        "python-embed\\\n"
        ".env\n"
        "_update_staging\\\n"
        "_apply_update.bat\n"
        ".git\\\n",
        encoding="utf-8",
    )

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
