import pandas as pd
import os
from typing import List, Dict

IHMCL_DF = None

def load_ihmcl_data():
    global IHMCL_DF
    # Dynamically find the path: backend/app/core -> backend/app -> backend -> project_root -> database/IHMCL.csv
    current_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(current_dir)))
    csv_path = os.path.join(project_root, "database", "IHMCL.csv")
    
    if not os.path.exists(csv_path):
        print(f"Warning: IHMCL database not found at {csv_path}")
        return
        
    try:
        # Load CSV
        df = pd.read_csv(csv_path)
        
        # The 'Month' column is an Excel serial date string or number (e.g., 44652 for Apr 1, 2022)
        # Determine if it's numeric and convert from Excel epoch (1899-12-30)
        df['Month_Num'] = pd.to_numeric(df['Month'], errors='coerce')
        df['Date'] = pd.to_datetime(df['Month_Num'], unit='D', origin='1899-12-30', errors='coerce')
        
        # For any rows where 'Month' was not a valid number (e.g. string header rows mixed in), drop them
        df = df.dropna(subset=['Date'])
        
        # Ensure all Count and Amount columns are numeric
        cols_to_fix = [c for c in df.columns if c.endswith('_CNT') or c.endswith('_AMT')]
        for col in cols_to_fix:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
            
        # Calculate Financial Year. FY starts in April.
        # If month >= 4, FY = year. If month < 4, FY = year - 1
        df['FY_Start_Year'] = df['Date'].dt.year - (df['Date'].dt.month < 4).astype(int)
        
        # Format as strings like "FY2022-23" or similar
        df['FY'] = 'FY' + df['FY_Start_Year'].astype(str) + '-' + (df['FY_Start_Year'] + 1).astype(str).str[-2:]
        
        # Add basic Month Name / Year for easy grouping on frontend
        df['Month_Name'] = df['Date'].dt.strftime('%b')
        df['Month_Idx'] = df['Date'].dt.month
        df['Year'] = df['Date'].dt.year
        df['Days_In_Month'] = df['Date'].dt.daysinmonth
        
        IHMCL_DF = df
        print(f"Successfully loaded IHMCL database: {len(df)} records.")
    except Exception as e:
        print(f"Failed to load IHMCL database: {e}")

def get_unique_plazas() -> List[str]:
    if IHMCL_DF is None:
        return []
    # Get unique, non-null plazas
    plazas = IHMCL_DF['PLAZA_NAME'].dropna().unique().tolist()
    return sorted([str(p).strip() for p in plazas if str(p).strip() != ''])

def get_plaza_data(plaza_names: List[str]) -> Dict[str, List[Dict]]:
    if IHMCL_DF is None:
        return {}
    
    result = {}
    for plaza in plaza_names:
        # Filter for the requested plaza
        plaza_df = IHMCL_DF[IHMCL_DF['PLAZA_NAME'] == plaza].copy()
        
        # Replace NaNs with None for secure JSON serialization
        plaza_df = plaza_df.where(pd.notnull(plaza_df), None)
        
        # Convert complex types (like pandas Timestamp) to standard python types using records dump
        records = plaza_df.to_dict(orient='records')
        
        # Clean up datetime objects
        for rec in records:
            if rec['Date'] is not None and not isinstance(rec['Date'], str):
                rec['Date'] = rec['Date'].strftime('%Y-%m-%d')
                
        result[plaza] = records
        
    return result
