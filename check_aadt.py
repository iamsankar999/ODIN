import pandas as pd
import os

def check():
    csv_path = r"d:\iamsa\Documents\Antigravity_projects\od_validation_system\database\IHMCL.csv"
    df = pd.read_csv(csv_path)
    df['Month_Num'] = pd.to_numeric(df['Month'], errors='coerce')
    df['Date'] = pd.to_datetime(df['Month_Num'], unit='D', origin='1899-12-30', errors='coerce')
    df = df.dropna(subset=['Date'])
    
    # Ensure LCV_CNT and others are numeric
    df['LCV_CNT'] = pd.to_numeric(df['LCV_CNT'], errors='coerce').fillna(0)
    
    # Pick a plaza
    plaza = "Plaza 1 @ Km 14+825"
    fy_label = "FY2023" # User's label for year ending March 2023
    
    # Data for FY 2023: April 2022 to March 2023
    mask = (df['PLAZA_NAME'] == plaza) & (
        ((df['Date'].dt.year == 2022) & (df['Date'].dt.month >= 4)) |
        ((df['Date'].dt.year == 2023) & (df['Date'].dt.month <= 3))
    )
    
    plaza_df = df[mask].copy()
    plaza_df = plaza_df.sort_values('Date')
    
    if plaza_df.empty:
        print(f"No data found for {plaza} in FY {fy_label}")
        return

    print(f"--- CALCULATION EXAMPLE FOR {plaza} ({fy_label}) ---")
    print(f"Period: April 2022 to March 2023")
    print("-" * 50)
    
    total_lcv = 0
    total_days = 0
    
    for _, row in plaza_df.iterrows():
        month_name = row['Date'].strftime('%b %Y')
        lcv = int(row['LCV_CNT'])
        days = row['Date'].days_in_month
        total_lcv += lcv
        total_days += days
        print(f"{month_name}: Traffic = {lcv}, Days = {days}")
        
    aadt_lcv = total_lcv / total_days
    
    print("-" * 50)
    print(f"Sum of Monthly LCV Traffic: {total_lcv}")
    print(f"Total Days in period: {total_days}")
    print(f"AADT Formula: {total_lcv} / {total_days}")
    print(f"Result AADT LCV: {aadt_lcv:.2f}")

if __name__ == "__main__":
    check()
