from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from .api import endpoints
from app.core.ihmcl import load_ihmcl_data
from app.version import LOCAL_VERSION, PROJECT_ROOT

# Frontend directory
FRONTEND_DIR = PROJECT_ROOT / "frontend"

app = FastAPI(title="OD Place-Name Validation System API")

@app.on_event("startup")
def startup_event():
    load_ihmcl_data()

# Configure CORS to allow the frontend to access the API from anywhere
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allow all origins, including opening index.html directly
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(endpoints.router, prefix="/api")

# HEALTH CHECK ENDPOINT
@app.get("/api/health")
def health_check():
    return {"status": "ok", "version": LOCAL_VERSION}

# Serve frontend as static files – MUST be mounted LAST
# http://127.0.0.1:8000/ → frontend/index.html
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")