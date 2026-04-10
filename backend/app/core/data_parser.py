import pandas as pd
import geopandas as gpd
from io import BytesIO
import zipfile
import tempfile
import os

def parse_excel_data(file_bytes: bytes, mode: str = None):
    """Parses the 3 sheets of the uploaded Excel file."""
    xl = pd.ExcelFile(BytesIO(file_bytes))
    
    if "Auto_OD_input" not in xl.sheet_names:
        raise ValueError("Sheet 'Auto_OD_input' not found in the uploaded Excel file.")
    
    df_main = xl.parse("Auto_OD_input")
    
    print(f"Parsed Auto_OD_input. Shape: {df_main.shape}")
    print(f"Columns: {df_main.columns.tolist()}")
    
    ca_codes_abstract = []
    if "CA_code_ABSTRACT" in xl.sheet_names:
        ca_codes_abstract = xl.parse("CA_code_ABSTRACT").to_dict(orient="records")
    elif "CA_code" in xl.sheet_names:
        # Fallback for older files
        ca_codes_abstract = xl.parse("CA_code").to_dict(orient="records")
        
    ca_codes_detailed = []
    if "CA_code_DETAILED" in xl.sheet_names:
        ca_codes_detailed = xl.parse("CA_code_DETAILED").to_dict(orient="records")
        
    # OD_code parsing remains for Place assign mode

    # Parse OD_code sheet for pre-assigned zones if it exists
    od_codes = {}
    if "OD_code" in xl.sheet_names:
        df_od = xl.parse("OD_code")
        # Need to identify the Name column and Zone column.
        # Often named ORIGIN / DESTINATION / NAME and ZONE / ZONE_NO.
        # We'll just take the first two columns if headers aren't obvious.
        if not df_od.empty and len(df_od.columns) >= 2:
            # Let's try to find them by keywords first
            name_col = next((c for c in df_od.columns if str(c).upper() in ['NAME', 'ORIGIN', 'DESTINATION', 'PLACE', 'ROW LABELS']), df_od.columns[0])
            zone_col = next((c for c in df_od.columns if 'ZONE' in str(c).upper() or 'OD CODING' in str(c).upper() or 'ZONENUMBER' in str(c).upper()), df_od.columns[1])
            
            for _, row in df_od.iterrows():
                name_val = str(row[name_col]).strip().upper()
                zone_val = str(row[zone_col]).strip()
                if zone_val.endswith('.0'):
                    zone_val = zone_val[:-2]
                    
                if name_val and name_val != 'NAN' and zone_val and zone_val != 'NAN':
                    od_codes[name_val] = zone_val

    return {
        "main_data": df_main.to_dict(orient="records"),
        "ca_codes_abstract": ca_codes_abstract,
        "ca_codes_detailed": ca_codes_detailed,
        "od_codes": od_codes
    }


def process_shapefile_zip(zip_bytes: bytes) -> gpd.GeoDataFrame:
    """Reads a zipped shapefile into a GeoPandas DataFrame."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Save zip to temp dir
        zip_path = os.path.join(tmpdir, "shapefile.zip")
        with open(zip_path, "wb") as f:
            f.write(zip_bytes)
            
        # Extract zip
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(tmpdir)
            
        # Find the .shp file
        shp_file = None
        for root, dirs, files in os.walk(tmpdir):
            for file in files:
                if file.endswith(".shp"):
                    shp_file = os.path.join(root, file)
                    break
            if shp_file:
                break
                
        if not shp_file:
            raise ValueError("No .shp file found in the uploaded zip.")
            
        # Read the shapefile
        gdf = gpd.read_file(shp_file)
        return gdf
