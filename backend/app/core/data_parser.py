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

    def clean_df(df):
        """Ensures a DataFrame is JSON-serializable by replacing NaN/Inf with None."""
        if df is None: return None
        # Must explicitly cast to object to prevent pandas from casting None back to NaN in float columns
        df = df.astype(object)
        return df.replace([float('inf'), float('-inf')], None).where(pd.notnull(df), None)

    df_main = clean_df(xl.parse("Auto_OD_input"))
    
    unresolved_commodities = []
    if mode == "Zone assign":
        from app.core.commodity_matcher import exact_match_commodity
        if 'COMMODITY_TRIP_PURPOSE' in df_main.columns:
            if 'COMMODITY_CODE_1_28' not in df_main.columns:
                df_main['COMMODITY_CODE_1_28'] = None
            if 'COMMODITY_CODE_1_17' not in df_main.columns:
                df_main['COMMODITY_CODE_1_17'] = None
                
            unique_unresolved = set()
            for idx, row in df_main.iterrows():
                purpose = row.get('COMMODITY_TRIP_PURPOSE')
                if pd.notna(purpose):
                    # Check if already manually coded in the excel sheet
                    code_28 = row.get('COMMODITY_CODE_1_28')
                    if pd.notna(code_28) and str(code_28).strip():
                        continue
                        
                    match = exact_match_commodity(purpose)
                    if match:
                        df_main.at[idx, 'COMMODITY_CODE_1_28'] = match.get('Detailed_Comm_code')
                        df_main.at[idx, 'COMMODITY_CODE_1_17'] = match.get('Abstract_Comm_code')
                    else:
                        unique_unresolved.add(str(purpose).strip())
            
            unresolved_commodities = sorted(list(unique_unresolved))
            # Keep df_main clean
            df_main = clean_df(df_main)

    print(f"Parsed Auto_OD_input. Shape: {df_main.shape}")
    print(f"Columns: {df_main.columns.tolist()}")
    
    ca_codes_abstract = []
    if "CA_code_ABSTRACT" in xl.sheet_names:
        ca_codes_abstract = clean_df(xl.parse("CA_code_ABSTRACT")).to_dict(orient="records")
    elif "CA_code" in xl.sheet_names:
        # Fallback for older files
        ca_codes_abstract = clean_df(xl.parse("CA_code")).to_dict(orient="records")
        
    ca_codes_detailed = []
    if "CA_code_DETAILED" in xl.sheet_names:
        ca_codes_detailed = clean_df(xl.parse("CA_code_DETAILED")).to_dict(orient="records")
        
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

    # [R&V MODE] NEW: Parse Resolved_rawOD if it exists
    resolved_raw_od = []
    if "Resolved_rawOD" in xl.sheet_names:
        # Ensure JSON serializability by replacing NaN/Nat/Inf with None
        resolved_raw_od = clean_df(xl.parse("Resolved_rawOD")).to_dict(orient="records")

    return {
        "main_data": df_main.to_dict(orient="records"),
        "ca_codes_abstract": ca_codes_abstract,
        "ca_codes_detailed": ca_codes_detailed,
        "od_codes": od_codes,
        "resolved_raw_od": resolved_raw_od,
        "unresolved_commodities": unresolved_commodities if 'unresolved_commodities' in locals() else []
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
