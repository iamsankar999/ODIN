import geopandas as gpd
import zipfile
import tempfile
import os

zip_path = r"D:\iamsa\Documents\Antigravity_projects\ODIN-2.5.4\Dummy Data\bael_zoning_final.zip"

with tempfile.TemporaryDirectory() as tmpdir:
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        zip_ref.extractall(tmpdir)
    
    shp_file = None
    for root, dirs, files in os.walk(tmpdir):
        for file in files:
            if file.endswith(".shp"):
                shp_file = os.path.join(root, file)
                break
                
    if shp_file:
        gdf = gpd.read_file(shp_file)
        print("Columns:", gdf.columns.tolist())
        print("Sample row:")
        print(gdf.head(1))
    else:
        print("No shapefile found in zip.")
