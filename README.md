# 🛰️ ODIN: Origin-Destination Insights & Navigator

**ODIN** is a professional-grade geospatial validation and analytical platform designed to automate the complex process of Origin-Destination (OD) data coding. It transforms raw, manually-surveyed place names into validated, geocoded, and zone-mapped datasets.

![Version](https://img.shields.io/badge/version-v2.5.8-blue.svg)
![Python](https://img.shields.io/badge/python-3.10+-yellow.svg)
![FastAPI](https://img.shields.io/badge/backend-FastAPI-green.svg)
![Leaflet](https://img.shields.io/badge/maps-Leaflet.js-orange.svg)

---

## 🚀 Key Features

*   **Spatial Intelligence Engine**: Automated Point-in-Polygon (PIP) lookups using local Shapefiles for administrative alignment.
*   **Progressive Resolution**: Batch-resolve survey locations using phonetic matching (Double Metaphone) and fuzzy similarity.
*   **Review & Visualization (R&V)**: Advanced analytics for detecting intrazonal trips and illogical OD pairs with interactive map suggestions.
*   **Transparent Auto-Save**: Background synchronization using the modern **File System Access API**.
*   **Portable Deployment**: One-click launch on Windows via an embedded Python environment.

---

## 📂 Repository Anatomy

Understanding the file structure is key to navigating the ODIN codebase:

### 🖥️ Frontend (`/frontend`)
The frontend is a high-performance Single Page Application (SPA) built with Vanilla JS for maximum speed.

*   **[`index.html`](frontend/index.html)**: The primary interface. Contains the multi-mode dashboard, wizard steps, and map containers.
*   **[`js/app.js`](frontend/js/app.js)**: The "brain" of the core modes. Manages state for Zone/Place assignment, file uploads, and ZIP project bundling.
*   **[`js/review_viz.js`](frontend/js/review_viz.js)**: Dedicated logic for the R&V module. Handles spatial filtering, illogical trip detection, and dynamic map markers.
*   **[`css/styles.css`](frontend/css/)**: Custom design system built for professional engineering workflows (dark mode support, glassmorphism).

### ⚙️ Backend (`/backend`)
A FastAPI-powered REST layer handling heavy computational geometry and data processing.

*   **[`app/main.py`](backend/app/main.py)**: The FastAPI entry point. Configures CORS, middleware, and routes.
*   **[`app/api/endpoints.py`](backend/app/api/endpoints.py)**: Defines the REST API interface.
*   **[`app/core/`](backend/app/core/)**: The engine of ODIN:
    *   **`algorithms.py`**: Implementation of Double Metaphone, fuzzy scoring, and spatial re-ranking.
    *   **`processor.py`**: Orchestrates Point-in-Polygon (PIP) lookups and geometric validation.
    *   **`exporter.py`**: Logic for generating the final multi-sheet validated Excel reports.
    *   **`data_parser.py`**: Robust handlers for `.xlsx` and Shapefile ingestion.
*   **[`requirements.txt`](requirements.txt)**: Lists essential libraries including `GeoPandas`, `Shapely`, and `FastAPI`.

### 🛠️ Infrastructure & Scripts
*   **[`ODIN_Launch.bat`](ODIN_Launch.bat)**: Automates the startup sequence (installs deps, starts backend, opens browser).
*   **[`python-embed/`](python-embed/)**: (Optional) A local, zero-install Python environment for portability.
*   **[`version.json`](version.json)**: Tracks the current system version for synchronization across modules.
### 📁 Sample Data ([`/Dummy Data`](Dummy%20Data/))
To help you get started quickly, a sample dataset is included for testing purposes:
*   **[`od_dataset.xlsx`](Dummy%20Data/od_dataset.xlsx)**: A pre-formatted Excel survey containing sample origin, destination, and plaza entries.
*   **[`testdata_shapefile.zip`](Dummy%20Data/testdata_shapefile.zip)**: A sample zonal shapefile for Point-in-Polygon (PIP) validation testing.



---

## 🛠️ Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | Vanilla JS, Leaflet.js, JSZip, Google Maps API |
| **Backend** | Python, FastAPI, Uvicorn |
| **Spatial** | GeoPandas, Shapely, PyProj |
| **Logic** | TheFuzz (Fuzzy Matching), Double Metaphone |
| **Data** | Pandas, OpenPyXL (Excel Processing) |

---

## 🏁 Getting Started

### Prerequisites
- Python 3.10 or higher
- **Google Maps API Key**: Requires a GCP project with the following services enabled:
    - **Maps JavaScript API**: For frontend map rendering and interactive selection.
    - **Geocoding API**: For converting place names to coordinates and vice-versa.
    - **Places API**: For location search, autocomplete, and enriched spatial metadata.
    - **Distance Matrix API**: For calculating accurate road distances between survey points and destinations.

### Quick Start (Windows)
1.  Clone the repository.
2.  Double-click **`ODIN_Launch.bat`**.
3.  The system will automatically:
    *   Initialize a virtual environment.
    *   Install dependencies.
    *   Start the FastAPI server.
    *   Launch the ODIN dashboard in your default browser.
4.  **Try it out**: Use the sample files in the `/Dummy Data` folder to test the system immediately.



### Manual Setup
1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
2. Start the backend:
   ```bash
   cd backend
   uvicorn app.main:app --reload --port 8000
   ```
3. Open `frontend/index.html` in a web browser (requires a local server or Chrome's File System Access permission).

---

## 📊 Operational Logic

### Data Input Specifications

To ensure seamless operation, your input files should adhere to the following structure:

#### 1. OD Survey Excel (`.xlsx`)
The system parses multiple sheets from the uploaded Excel:
- **`Auto_OD_input` (Main Sheet)**:
    - `ORIGIN`: Starting point name (String).
    - `DESTINATION`: Ending point name (String).
    - `PLAZA_NAME`: Survey location / Toll plaza name.
    - `MAV_SPLIT`: Vehicle classification (e.g., CAR, LCV, MAV).
    - *Optional*: `DIRECTION`, `COMMODITY_CODE_ABSTRACT`, `COMMODITY_CODE_DETAILED`.
- **`CA_code_ABSTRACT` / `CA_code_DETAILED`**: Reference sheets for commodity descriptions.
- **`OD_code`**: (Optional) Use this to provide pre-assigned zone mappings.
    - Required Columns: A Name column (`NAME`, `PLACE`, or `ORIGIN`) and a Zone column (`ZONE`, `ZONE_NO`).
- **`Resolved_rawOD`**: (Optional) Used in R&V mode to load previous progress.

#### 2. Zonal Shapefile (`.zip`)
- **Format**: Must be a `.zip` archive containing at least the `.shp`, `.shx`, `.dbf`, and `.prj` files.
- **CRS**: Geographic coordinate system (EPSG:4326) is recommended.
- **Attribute Columns**: The system automatically scans for zone IDs in these columns (case-insensitive):
    - `ZONENUMBER`, `ZONENUM`, `ZONE_NO`, `ZONE`, `ID`, `NAME`, `FID`, `OBJECTID`.

### Data Flow
1. **Input**: User uploads a Shapefile (Zonal boundaries) and an OD Survey Excel.
2. **Processing**: Backend extracts unique names and maps them to zones via PIP.
3. **Resolution**: User validates locations using map-based suggestions.
4. **Analytics**: The R&V mode flags trips that are intrazonal or spatially illogical.
5. **Output**: A formatted Excel report and a `.zip` project file for future sessions.

---

© 2025 ODIN Project Team. Built for transportation excellence.
