/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REVIEW & VISUALIZATION MODE — Isolated Module
 *  This module is ENTIRELY separate from Zone Assign / Place Assign.
 *  All state is prefixed with rv_ to prevent collisions.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ── R&V State ────────────────────────────────────────────────────────────────
let rv_map = null;                    // Google Maps instance for R&V
let rv_mapInitialized = false;
let rv_currentSubTab = 'intrazonal';  // 'intrazonal' | 'illogical'
let rv_intrazonalData = [];           // Detected intrazonal trips
let rv_illogicalData = [];            // Detected illogical pairs
let rv_markers = [];                  // Active map markers
let rv_polylines = [];                // Active route polylines
let rv_suggestionMarkers = [];        // Temporary markers for suggestions
let rv_activeInfoWindow = null;       // Active popup info window
let rv_zoneBoundary = null;           // Active zone polygon overlay
let rv_odDataRaw = null;              // Raw parsed OD data rows
let rv_shapefileGdf = null;           // Shapefile loaded flag
let rv_dataLoaded = false;
let rv_expandedRow = -1;              // Currently expanded details row
let rv_statusInterval = null;         // Backend status polling

// Edit Mode State
let rv_isEditMode = false;
let rv_editingTripIdx = -1;
let rv_editingPoint = null;           // 'O' or 'D'
let rv_autocompleteInstance = null;
let rv_projectZipFile = null;         // Store the uploaded ZIP for export
let rv_projectOdBlob = null;          // OD Excel blob for export
let rv_projectShpBlob = null;         // Shapefile blob for export
let rv_resolutions = {};              // Resolutions from project ZIP
let rv_plazaMapping = {};             // Plaza mapping from project ZIP
let rv_validatorName = '';            // Validator's name (entered after data load)

// ── Helpers ──────────────────────────────────────────────────────────────────

function rvCleanZoneId(zone) {
    if (!zone) return 'Unknown';
    let s = String(zone).trim();
    // Strip "Polygon_" prefix (case-insensitive)
    if (s.toLowerCase().startsWith('polygon_')) {
        s = s.substring(8);
    }
    // Strip "Zone" prefix
    if (s.toLowerCase().startsWith('zone')) {
        s = s.substring(4).trim();
    }
    // Strip .0 suffix
    if (s.endsWith('.0')) {
        s = s.substring(0, s.length - 2);
    }
    return s || 'Unknown';
}

function rvGetResolvedData(name, resolutions) {
    if (!name || !resolutions) return null;
    const entry = resolutions[name.toUpperCase()];
    if (!entry) return null;

    // Use __all__ if present, otherwise first available key
    let data = entry['__all__'];
    if (!data) {
        const keys = Object.keys(entry);
        if (keys.length > 0) data = entry[keys[0]];
    }
    return data;
}

// ── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Called from the Mode Selection card. Enters the R&V view.
 */
function enterReviewVisualization() {
    switchView('view-review-viz');
    rvStartStatusPolling();
    rvSyncThemeToggle();

    // If project data already loaded from setup wizard, auto-detect intrazonal trips
    if (typeof allUnmatchedPlaces !== 'undefined' && allUnmatchedPlaces.length > 0 && !rv_dataLoaded) {
        rvProcessLoadedData();
    }
}

// ── Navigation ───────────────────────────────────────────────────────────────

function rvGoBack() {
    rvStopStatusPolling();
    rvClearMap();
    switchView('view-mode-selection');
}

// ── Theme Sync ───────────────────────────────────────────────────────────────

function rvSyncThemeToggle() {
    const mainToggle = document.getElementById('theme-toggle');
    const rvToggle = document.getElementById('rv-theme-toggle');
    const rvThumb = document.getElementById('rv-toggle-thumb');
    if (mainToggle && rvToggle) {
        rvToggle.checked = mainToggle.checked;
    }
    if (rvThumb) {
        rvThumb.innerHTML = document.body.classList.contains('light-theme') ? '☀️' : '🌙';
    }
}

// Keep R&V theme toggle in sync (override toggleTheme to sync both)
const _originalToggleTheme = typeof toggleTheme === 'function' ? toggleTheme : null;
function rvPatchedToggleTheme() {
    const body = document.body;
    body.classList.toggle('light-theme');
    const isLight = body.classList.contains('light-theme');

    // Sync all toggle thumbs
    const thumbIds = ['toggle-thumb', 'rv-toggle-thumb'];
    thumbIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = isLight ? '☀️' : '🌙';
    });

    // Sync all toggle checkboxes
    const checkIds = ['theme-toggle', 'rv-theme-toggle'];
    checkIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = isLight;
    });
}

// Replace global toggleTheme once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.toggleTheme = rvPatchedToggleTheme;
});

// ── Sub-Tab Switching ────────────────────────────────────────────────────────

function rvToggleSubTab(tab) {
    rv_currentSubTab = tab;

    // Update button active states
    document.getElementById('rv-tab-intrazonal').classList.toggle('active', tab === 'intrazonal');
    document.getElementById('rv-tab-illogical').classList.toggle('active', tab === 'illogical');

    // Move slider
    const slider = document.getElementById('rv-tab-slider');
    if (tab === 'illogical') {
        slider.style.transform = 'translateX(100%)';
    } else {
        slider.style.transform = 'translateX(0)';
    }

    // Toggle content panels
    const intraContent = document.getElementById('rv-intrazonal-content');
    const illoContent = document.getElementById('rv-illogical-content');
    if (tab === 'intrazonal') {
        intraContent.classList.add('active');
        illoContent.classList.remove('active');
    } else {
        intraContent.classList.remove('active');
        illoContent.classList.add('active');
    }

    // Refresh map when switching tabs
    rvClearMap();
    document.querySelectorAll('.rv-data-row').forEach(r => r.classList.remove('rv-row-active'));
}

// ── Data Loading ─────────────────────────────────────────────────────────────

/**
 * Load Data handler:
 * - If project data is already available from setup wizard, use it.
 * - Otherwise open a file picker to load a ZIP.
 */
async function rvLoadData() {
    const btn = document.getElementById('rv-load-data-btn') || document.querySelector('.rv-toolbar-left .rv-btn-primary');
    const origText = btn ? btn.innerHTML : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg> Load Data';
    if (btn) btn.innerHTML = '<span style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;display:inline-block;margin-right:6px;"></span> Processing...';

    // If we already have processed OD data from the main app, reprocess it
    if (typeof allUnmatchedPlaces !== 'undefined' && allUnmatchedPlaces.length > 0) {
        rvProcessLoadedData();
        if (btn) btn.innerHTML = origText;
        return;
    }

    // Otherwise prompt for a project ZIP
    try {
        let file;
        if ('showOpenFilePicker' in window) {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: 'ODIN Project Bundle (ZIP)',
                    accept: { 'application/zip': ['.zip'] },
                }],
                multiple: false
            });
            file = await handle.getFile();
        } else {
            // Fallback: create a temporary input
            file = await new Promise((resolve, reject) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.zip';
                input.onchange = () => resolve(input.files[0]);
                input.click();
            });
        }

        if (!file) {
            if (btn) btn.innerHTML = origText;
            return;
        }
        await rvParseProjectZip(file);
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('R&V Load Data failed:', err);
            alert('Failed to load data: ' + err.message);
        }
    }
    if (btn) btn.innerHTML = origText;
}

/**
 * Parse a project ZIP independently for R&V mode.
 */
async function rvParseProjectZip(file) {
    if (typeof JSZip === 'undefined') {
        alert('JSZip library not loaded.');
        return;
    }

    rv_projectZipFile = file;
    const zip = await JSZip.loadAsync(file);

    // Load resolutions if present
    const cfgFile = zip.file('project_config.json');
    let projectConfig = {};
    if (cfgFile) {
        projectConfig = JSON.parse(await cfgFile.async('string'));
    }

    // Load OD Dataset
    let odFile = zip.file('od_dataset.xlsx') || zip.file('ODIN_Resolved_OD_Dataset.xlsx');
    if (!odFile) {
        const candidates = Object.keys(zip.files).filter(n => n.endsWith('.xlsx'));
        if (candidates.length > 0) odFile = zip.file(candidates[0]);
    }

    if (!odFile) {
        alert('No Excel dataset found in the ZIP.');
        return;
    }

    const odBlob = await odFile.async('blob');
    rv_projectOdBlob = new File([odBlob], 'od_dataset.xlsx');

    // Upload to backend for parsing
    const formData = new FormData();
    formData.append('file', rv_projectOdBlob);
    formData.append('mode', 'Zone assign');

    try {
        const resp = await fetch('/api/upload/excel', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(await resp.text());
        const result = await resp.json();

        // Upload shapefile too if present
        let shpFile = zip.file('shapefile.zip') || zip.file('Shapefile_Original.zip');
        if (!shpFile) {
            const candidates = Object.keys(zip.files).filter(n => n.endsWith('.zip'));
            if (candidates.length > 0) shpFile = zip.file(candidates[0]);
        }
        if (shpFile) {
            const shpBlob = await shpFile.async('blob');
            rv_projectShpBlob = new File([shpBlob], 'shapefile.zip');
            const shpForm = new FormData();
            shpForm.append('file', rv_projectShpBlob);
            await fetch('/api/upload/shapefile', { method: 'POST', body: shpForm });
            rv_shapefileGdf = true;
        }

        // Load resolutions to get zone assignments
        const resFile = zip.file('resolutions.json');
        rv_resolutions = {};
        if (resFile) {
            rv_resolutions = JSON.parse(await resFile.async('string'));
        }

        // Load plaza mapping if present
        const plazaFile = zip.file('plaza_mapping.json');
        rv_plazaMapping = {};
        if (plazaFile) {
            rv_plazaMapping = JSON.parse(await plazaFile.async('string'));
        }

        // Store raw data and process for intrazonal trips
        rv_odDataRaw = result.data;
        // Identify intrazonal trips using Resolved_rawOD if available, else fallback
        if (result.resolved_raw_od && result.resolved_raw_od.length > 0) {
            rvDetectIntrazonalTripsFromRaw(result.resolved_raw_od, rv_resolutions);
            rvDetectIllogicalTripsFromRaw(result.resolved_raw_od, rv_resolutions);
        } else {
            rvDetectIntrazonalTrips(result.data, rv_resolutions);
            rvDetectIllogicalTrips(result.data, rv_resolutions);
        }
        rv_dataLoaded = true;

        // Show validator name dialog
        rvShowValidatorDialog();

    } catch (err) {
        console.error('R&V data parsing failed:', err);
        alert('Failed to parse dataset: ' + err.message);
    }
}

/**
 * Process data that's already loaded in the main app.
 */
function rvProcessLoadedData() {
    // Build resolutions from the global resolvedPlaces
    const resolutions = (typeof resolvedPlaces !== 'undefined') ? resolvedPlaces : {};

    // allUnmatchedPlaces contains all place data
    // We need to extract OD pairs with zone info from resolutions
    const data = (typeof allUnmatchedPlaces !== 'undefined') ? allUnmatchedPlaces : [];

    if (data.length === 0) {
        alert('No OD data loaded. Please load data first.');
        return;
    }

    rvDetectIntrazonalTripsFromPlaces(data, resolutions);
    rvDetectIllogicalTrips(data, resolutions);
    rv_dataLoaded = true;
}

/**
 * Core Intrazonal Detection Logic (Revised):
 * Iterates through all vehicle interactions to find pairs where Origin Zone == Destination Zone.
 */
function rvDetectIntrazonalTripsFromPlaces(places, resolutions) {
    rv_intrazonalData = [];
    const tripMap = new Map(); // Key: "zone|origin|destination"
    const resolutionsUpper = {};

    // Build uppercase lookup for resolutions
    for (const [k, v] of Object.entries(resolutions)) {
        resolutionsUpper[k.toUpperCase()] = v;
    }

    for (const place of places) {
        if (!place.analytics || !place.analytics.vehicleInteractions) continue;

        // Iterate through all vehicle classes and their interactions
        for (const [vehicleClass, interactions] of Object.entries(place.analytics.vehicleInteractions)) {
            if (!Array.isArray(interactions)) continue;

            for (const interStr of interactions) {
                // Parse "ORIGIN - DESTINATION [count]"
                const match = interStr.match(/^(.+?) - (.+?)\s*\[(\d+)\]$/);
                if (!match) continue;

                const oName = match[1].trim();
                const dName = match[2].trim();
                const count = parseInt(match[3], 10);

                const oRes = rvGetResolvedData(oName, resolutionsUpper);
                const dRes = rvGetResolvedData(dName, resolutionsUpper);

                if (!oRes || !dRes) continue;

                // Use zone value from resolved data
                const oZoneRaw = oRes.zone || '';
                const dZoneRaw = dRes.zone || '';

                if (!oZoneRaw || !dZoneRaw || oZoneRaw === 'Unknown' || dZoneRaw === 'Unknown') continue;

                const oZoneClean = rvCleanZoneId(oZoneRaw);
                const dZoneClean = rvCleanZoneId(dZoneRaw);

                // Check for Intrazonal match
                if (oZoneClean === dZoneClean) {
                    const key = `${oZoneClean}|${oName.toUpperCase()}|${dName.toUpperCase()}`;

                    if (!tripMap.has(key)) {
                        tripMap.set(key, {
                            zone: oZoneClean,
                            origin: oName,
                            destination: dName,
                            tripCount: 0,
                            vehicleBreakdown: {}, // class -> count
                            status: 'Pending',
                            originCoords: oRes.coords || { lat: oRes.lat, lng: oRes.lng } || null,
                            destCoords: dRes.coords || { lat: dRes.lat, lng: dRes.lng } || null,
                            // To find commodities, we need the parent place's interactions
                            parentPlace: place
                        });
                    }

                    const trip = tripMap.get(key);
                    trip.tripCount += count;
                    trip.vehicleBreakdown[vehicleClass] = (trip.vehicleBreakdown[vehicleClass] || 0) + count;
                }
            }
        }
    }

    rv_intrazonalData = Array.from(tripMap.values());
    // Sort by trip count descending
    rv_intrazonalData.sort((a, b) => b.tripCount - a.tripCount);

    rvRenderIntrazonalTable();

    if (!rv_mapInitialized) {
        rvInitMap();
    }
}

/**
 * Detect intrazonal trips from raw API response data (e.g. from File Upload).
 */
/**
 * NEW: Detect intrazonal trips directly from Resolved_rawOD rows.
 * This is the most accurate method as it uses the exact columns specified by the user.
 */
function rvDetectIntrazonalTripsFromRaw(rawRows, resolutions) {
    rv_intrazonalData = [];
    const tripMap = new Map(); // Key: "zone|origin|destination"
    const resolutionsUpper = {};

    for (const [k, v] of Object.entries(resolutions || {})) {
        resolutionsUpper[k.toUpperCase()] = v;
    }

    if (!rawRows || !Array.isArray(rawRows)) return;

    for (const row of rawRows) {
        const oZone = rvCleanZoneId(row.ORIGIN_ZONE);
        const dZone = rvCleanZoneId(row.DESTINATION_ZONE);

        // Analysis: Check if ORIGIN_ZONE == DESTINATION_ZONE
        // Omit if both columns have value 0 (user request) or if zones are Unknown (unresolved)
        if (oZone !== '0' && oZone !== '' && oZone !== 'Unknown' && oZone === dZone) {
            const oName = (row.ORIGIN || '').trim();
            const dName = (row.DESTINATION || '').trim();
            const vClass = (row.MAV_SPLIT || row.VEHICLE_CODE || 'Unknown').trim();

            const count = 1;

            const pName = (row.SURVEY_LOCATION || row.PLAZA_NAME || row.PLAZA || '').trim();
            let pCoords = null;
            if (pName) {
                const keys = Object.keys(rv_plazaMapping);
                const match = keys.find(k => k.toLowerCase() === pName.toLowerCase());
                if (match) pCoords = rv_plazaMapping[match];
            }

            const key = `${oZone}|${oName.toUpperCase()}|${dName.toUpperCase()}`;

            if (!tripMap.has(key)) {
                const oRes = rvGetResolvedData(oName, resolutionsUpper);
                const dRes = rvGetResolvedData(dName, resolutionsUpper);

                tripMap.set(key, {
                    zone: oZone,
                    originalZone: oZone,
                    origin: oName,
                    originalOrigin: oName,
                    destination: dName,
                    originalDestination: dName,
                    plaza: pName,
                    tripCount: 0,
                    vehicleBreakdown: {},
                    status: 'Pending',
                    originCoords: oRes ? (oRes.coords || { lat: oRes.lat, lng: oRes.lng } || null) : null,
                    destCoords: dRes ? (dRes.coords || { lat: dRes.lat, lng: dRes.lng } || null) : null,
                    plazaCoords: pCoords,
                    rawRows: []
                });
            }

            const trip = tripMap.get(key);
            trip.tripCount += count;
            trip.vehicleBreakdown[vClass] = (trip.vehicleBreakdown[vClass] || 0) + count;
            trip.rawRows.push(row);
        }
    }

    rv_intrazonalData = Array.from(tripMap.values());
    rv_intrazonalData.sort((a, b) => b.tripCount - a.tripCount);

    rvRenderIntrazonalTable();

    if (!rv_mapInitialized) {
        rvInitMap();
    }
}

/**
 * Detect intrazonal trips from processed analytics data (Fallback).
 */
function rvDetectIntrazonalTrips(apiData, resolutions) {
    rv_intrazonalData = [];
    const tripMap = new Map();
    const resolutionsUpper = {};

    for (const [k, v] of Object.entries(resolutions)) {
        resolutionsUpper[k.toUpperCase()] = v;
    }

    if (!apiData || !Array.isArray(apiData)) return;

    for (const item of apiData) {
        if (!item.analytics || (!item.analytics.vehicleInteractions && !item.analytics.vehicleInteractionsPlaza)) continue;

        const iteratePlazas = item.analytics.vehicleInteractionsPlaza
            ? Object.entries(item.analytics.vehicleInteractionsPlaza)
            : [['', item.analytics.vehicleInteractions]];

        for (const [plazaName, vehicleInteractions] of iteratePlazas) {
            for (const [vehicleClass, interactions] of Object.entries(vehicleInteractions)) {
                if (!Array.isArray(interactions)) continue;

                for (const interStr of interactions) {
                    const match = interStr.match(/^(.+?) - (.+?)\s*\[(\d+)\]$/);
                    if (!match) continue;

                    const oName = match[1].trim();
                    const dName = match[2].trim();
                    const count = parseInt(match[3], 10);

                    const oRes = rvGetResolvedData(oName, resolutionsUpper);
                    const dRes = rvGetResolvedData(dName, resolutionsUpper);

                    if (!oRes || !dRes) continue;

                    const oZoneClean = rvCleanZoneId(oRes.zone);
                    const dZoneClean = rvCleanZoneId(dRes.zone);

                    if (oZoneClean !== 'Unknown' && oZoneClean === dZoneClean) {
                        const key = `${oZoneClean}|${oName.toUpperCase()}|${dName.toUpperCase()}`;
                        if (!tripMap.has(key)) {
                            let pCoords = null;
                            if (plazaName) {
                                const keys = Object.keys(rv_plazaMapping);
                                const match = keys.find(k => k.toLowerCase() === plazaName.toLowerCase());
                                if (match) pCoords = rv_plazaMapping[match];
                            }

                            tripMap.set(key, {
                                zone: oZoneClean,
                                origin: oName,
                                originalOrigin: oName,
                                destination: dName,
                                originalDestination: dName,
                                plaza: plazaName,
                                tripCount: 0,
                                vehicleBreakdown: {},
                                status: 'Pending',
                                originCoords: oRes.coords || { lat: oRes.lat, lng: oRes.lng } || null,
                                destCoords: dRes.coords || { lat: dRes.lat, lng: dRes.lng } || null,
                                plazaCoords: pCoords,
                                parentPlace: item
                            });
                        }
                        const trip = tripMap.get(key);
                        trip.tripCount += count;
                        trip.vehicleBreakdown[vehicleClass] = (trip.vehicleBreakdown[vehicleClass] || 0) + count;
                    }
                }
            }
        }
    }

    rv_intrazonalData = Array.from(tripMap.values());
    rv_intrazonalData.sort((a, b) => b.tripCount - a.tripCount);

    rvRenderIntrazonalTable();

    if (!rv_mapInitialized) {
        rvInitMap();
    }
}

// ── Table Rendering ──────────────────────────────────────────────────────────

function rvRenderIntrazonalTable() {
    const tbody = document.getElementById('rv-intrazonal-body');
    if (!tbody) return;

    if (rv_intrazonalData.length === 0) {
        tbody.innerHTML = `
            <tr class="rv-empty-state">
                <td colspan="7">
                    <div class="rv-empty-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="1.5">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                            <polyline points="22 4 12 14.01 9 11.01"></polyline>
                        </svg>
                        <p style="color: var(--success);">No intrazonal trips detected. All trips are inter-zonal.</p>
                    </div>
                </td>
            </tr>`;
        return;
    }

    let html = '';
    rv_intrazonalData.forEach((trip, idx) => {
        const statusClass = trip.status === 'Pending' ? 'rv-status-pending'
            : trip.status === 'Removed from data' ? 'rv-status-removed'
                : 'rv-status-resolved';

        html += `
            <tr class="rv-data-row ${trip.status === 'Removed from data' ? 'rv-row-removed' : ''}" id="rv-row-${idx}">
                <td class="rv-cell-sno">${idx + 1}</td>
                <td class="rv-cell-zone">${trip.zone}</td>
                <td class="rv-cell-origin" title="${trip.origin}">${rvTruncate(trip.origin, 30)}</td>
                <td class="rv-cell-dest" title="${trip.destination}">${rvTruncate(trip.destination, 30)}</td>
                <td class="rv-cell-count">${trip.tripCount}</td>
                <td class="rv-cell-actions">
                    <div class="rv-action-group">
                        <button class="rv-action-btn rv-btn-mapview" onclick="rvMapView(${idx})" title="Map View">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"></path><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>
                            Map
                        </button>
                        <button class="rv-action-btn rv-btn-details" onclick="rvShowDetails(${idx})" title="Details">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                            Details
                        </button>
                        <button class="rv-action-btn rv-btn-remove" onclick="rvRemoveTrip(${idx})" title="Remove" ${trip.status === 'Removed from data' ? 'disabled' : ''}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            Remove
                        </button>
                    </div>
                </td>
                <td class="rv-cell-status">
                    <span class="rv-status-badge ${statusClass}">${trip.status === 'Removed from data' ? 'Deleted' : trip.status}</span>
                </td>
            </tr>
            <tr class="rv-details-row" id="rv-details-${idx}" style="display: none;">
                <td colspan="7">
                    <div class="rv-details-content" id="rv-details-content-${idx}"></div>
                </td>
            </tr>`;
    });

    tbody.innerHTML = html;
}

function rvTruncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '…' : str;
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * Show zone boundary, origin/destination markers, and route on the map.
 */
async function rvMapView(idx) {
    const trip = rv_intrazonalData[idx];
    if (!trip) return;

    // Reset Edit State for new map
    rv_editingTripIdx = idx;
    rvCloseSearch(true);
    rv_isEditMode = true; // Automatically enable edit mode
    document.getElementById('rv-map').classList.add('editing-map');

    const editBar = document.getElementById('rv-edit-bar');
    if (editBar) {
        editBar.style.display = 'none'; // Hide until search is active
    }

    // Highlight selected row
    document.querySelectorAll('.rv-data-row').forEach(r => r.classList.remove('rv-row-active'));
    const row = document.getElementById(`rv-row-${idx}`);
    if (row) row.classList.add('rv-row-active');

    rvClearMap();

    if (!rv_map) {
        rvInitMap();
        await new Promise(r => setTimeout(r, 500));
    }

    if (!rv_map) return;

    // Remove placeholder
    const placeholder = document.getElementById('rv-map-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    // 1. Fetch zone boundary from backend
    try {
        const sugResp = await fetch(`/api/suggestions?name=${encodeURIComponent(trip.origin)}&zone_restriction=${encodeURIComponent(trip.zone)}`);
        if (sugResp.ok) {
            const sugData = await sugResp.json();
            if (sugData.zoneGeometry) {
                rvDrawZoneBoundary(sugData.zoneGeometry);
            }
        }
    } catch (e) {
        console.warn('Failed to fetch zone boundary:', e);
    }

    // 2. Use stored resolved coordinates
    const originCoords = trip.originCoords;
    const destCoords = trip.destCoords;
    const plazaCoords = trip.plazaCoords;

    if (originCoords) {
        const mO = new google.maps.Marker({
            position: originCoords,
            map: rv_map,
            label: { text: 'O', color: '#fff', fontSize: '11px', fontWeight: '700' },
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: '#1ade48ff',
                fillOpacity: 1,
                strokeColor: '#fff',
                strokeWeight: 2
            },
            title: `Origin`
        });
        mO.addListener('click', () => {
            if (rv_isEditMode) rvStartRelocate('O');
        });
        rv_markers.push(mO);
    }

    if (destCoords) {
        const mD = new google.maps.Marker({
            position: destCoords,
            map: rv_map,
            label: { text: 'D', color: '#fff', fontSize: '11px', fontWeight: '700' },
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: '#d33e3eff',
                fillOpacity: 1,
                strokeColor: '#fff',
                strokeWeight: 2
            },
            title: `Destination`
        });
        mD.addListener('click', () => {
            if (rv_isEditMode) rvStartRelocate('D');
        });
        rv_markers.push(mD);
    }

    if (plazaCoords) {
        const mP = new google.maps.Marker({
            position: plazaCoords,
            map: rv_map,
            label: { text: 'P', color: '#ffffffff', fontSize: '11px', fontWeight: '700' },
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: '#0b78f5ff',
                fillOpacity: 1,
                strokeColor: '#740000ff',
                strokeWeight: 2
            },
            title: trip.plaza ? 'Plaza: ' + trip.plaza : 'Survey Location'
        });
        rv_markers.push(mP);
    }

    // 3. Draw driving route between origin and destination
    if (originCoords && destCoords) {
        try {
            const directionsService = new google.maps.DirectionsService();
            const directionsRenderer = new google.maps.DirectionsRenderer({
                map: rv_map,
                suppressMarkers: true,
                polylineOptions: {
                    strokeColor: '#348bddff',
                    strokeWeight: 4,
                    strokeOpacity: 0.8
                }
            });

            const result = await new Promise((resolve, reject) => {
                directionsService.route({
                    origin: originCoords,
                    destination: destCoords,
                    travelMode: google.maps.TravelMode.DRIVING
                }, (result, status) => {
                    if (status === 'OK') resolve(result);
                    else reject(status);
                });
            });

            directionsRenderer.setDirections(result);
            rv_polylines.push(directionsRenderer);
        } catch (e) {
            // Fallback: simple polyline
            const line = new google.maps.Polyline({
                path: [originCoords, destCoords],
                geodesic: true,
                strokeColor: '#4ade80',
                strokeOpacity: 0.8,
                strokeWeight: 3,
                map: rv_map
            });
            rv_polylines.push(line);
        }

        // Fit bounds
        const bounds = new google.maps.LatLngBounds();
        bounds.extend(originCoords);
        bounds.extend(destCoords);
        if (plazaCoords) bounds.extend(plazaCoords);
        rv_map.fitBounds(bounds, 60);
    } else if (originCoords) {
        rv_map.setCenter(originCoords);
        rv_map.setZoom(12);
    } else if (destCoords) {
        rv_map.setCenter(destCoords);
        rv_map.setZoom(12);
    }
}

/* ── Edit Mode Functions ─────────────────────────────────────────────────────── */

function rvStartRelocate(point) {
    rv_editingPoint = point;
    const bar = document.getElementById('rv-edit-bar');
    const label = document.getElementById('rv-edit-point-label');
    const input = document.getElementById('rv-edit-search-input');

    // Update label and placeholder
    label.textContent = point === 'O' ? 'Origin' : 'Dest';
    if (point === 'O') input.placeholder = "Search new Origin location...";
    else input.placeholder = "Search new Destination location...";

    input.value = '';
    input.disabled = false;

    // Show the bar and focus
    bar.style.display = 'flex';
    setTimeout(() => input.focus(), 50);

    // Initialize autocomplete once
    if (!rv_autocompleteInstance) {
        rv_autocompleteInstance = new google.maps.places.Autocomplete(input);
        rv_autocompleteInstance.addListener('place_changed', rvHandlePlaceSelection);
    }

    // Immediately fetch and plot suggestions for the clicked point
    rvFetchAndPlotSuggestions(point);
}

async function rvFetchAndPlotSuggestions(point) {
    if (rv_editingTripIdx === -1) return;
    const tripData = rv_currentSubTab === 'intrazonal' ? rv_intrazonalData : rv_illogicalData;
    const trip = tripData[rv_editingTripIdx];
    const name = point === 'O' ? trip.origin : trip.destination;
    
    let zone = '';
    if (rv_currentSubTab === 'intrazonal') {
        zone = trip.zone;
    } else {
        zone = point === 'O' ? trip.originZone : trip.destZone;
    }

    // Clear old suggestions
    rv_suggestionMarkers.forEach(m => m.setMap(null));
    rv_suggestionMarkers = [];

    try {
        const resp = await fetch(`/api/suggestions?name=${encodeURIComponent(name)}&zone_restriction=${encodeURIComponent(zone)}`);
        const data = await resp.json();

        if (data.suggestions && data.suggestions.length > 0) {
            let minDistance = Infinity;
            let nearestSuggestion = null;

            if (trip.plazaCoords) {
                data.suggestions.forEach(s => {
                    const dist = calculateHaversine(trip.plazaCoords.lat, trip.plazaCoords.lng, s.lat, s.lng);
                    s._distance = dist;
                    if (dist < minDistance) {
                        minDistance = dist;
                        nearestSuggestion = s;
                    }
                });
            }

            const bounds = new google.maps.LatLngBounds();
            if (trip.originCoords) bounds.extend(trip.originCoords);
            if (trip.destCoords) bounds.extend(trip.destCoords);
            if (trip.plazaCoords) bounds.extend(trip.plazaCoords);

            data.suggestions.forEach(s => {
                const isOutside = s.zone !== zone;
                const markerColor = isOutside ? '#f4a108ff' : '#12c7d7ff'; // Orange if outside, Green if inside

                const m = new google.maps.Marker({
                    position: { lat: s.lat, lng: s.lng },
                    map: rv_map,
                    title: s.name,
                    label: { text: s.name, color: '#aa3c1aff', fontSize: '11px', fontWeight: 'bold', className: 'rv-suggestion-label' },
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 9,
                        fillColor: markerColor,
                        fillOpacity: 1,
                        strokeColor: '#d30e0eff',
                        strokeWeight: 2
                    }
                });

                let distanceHtml = '';
                if (trip.plazaCoords) {
                    const distKm = calculateHaversine(trip.plazaCoords.lat, trip.plazaCoords.lng, s.lat, s.lng).toFixed(2);
                    distanceHtml = `<p style="margin:0 0 10px 0;font-size:11px;color:#64748b;">Distance to survey location: <span style="font-weight:600;color:#000;">${distKm} km</span></p>`;
                }

                const plazaSet = new Set();
                if (trip.rawRows) {
                    trip.rawRows.forEach(r => {
                        const p = (r.SURVEY_LOCATION || r.PLAZA_NAME || r.PLAZA || '').trim();
                        if (p) plazaSet.add(p);
                    });
                }
                if (trip.plaza) plazaSet.add(trip.plaza);
                const plazas = Array.from(plazaSet);

                let plazaCheckboxHtml = '';
                if (plazas.length > 0) {
                    plazaCheckboxHtml = `
                        <div style="margin-bottom:10px;">
                            <label style="font-size:11px;font-weight:600;display:flex;align-items:center;gap:4px;margin-bottom:4px;">
                                <input type="checkbox" id="rv-resolve-all-check" checked> Apply to ALL Survey Locations
                            </label>
                            <div id="rv-plaza-selection-list" style="display:none; margin-left:20px; max-height:80px; overflow-y:auto; border:1px solid #eee; border-radius:4px; padding:4px;">
                                ${plazas.map(p => `
                                    <label style="display:flex; align-items:center; gap:6px; font-size:11px; margin-bottom:3px; padding:2px;">
                                        <input type="checkbox" class="rv-plaza-resolve-item" value="${p}" checked> ${p}
                                    </label>
                                `).join('')}
                            </div>
                        </div>
                    `;
                }

                m.addListener('click', () => {
                    const content = document.createElement('div');
                    content.className = 'suggestion-popup';
                    content.style.cssText = 'padding:10px;min-width:200px;font-family:Inter,sans-serif;';

                    const title = `<h4 style="margin:0 0 5px 0;font-size:14px;color:#1e293b;">${s.name}</h4>`;
                    const details = `<p style="margin:0 0 5px 0;font-size:12px;color:#64748b;">Zone: <span style="font-weight:600;color:${isOutside ? '#ea580c' : '#16a34a'};">${s.zone || 'Unknown'}</span></p>`;

                    content.innerHTML = title + details + distanceHtml + plazaCheckboxHtml;

                    const resolveBtn = document.createElement('button');
                    resolveBtn.textContent = 'Confirm & Resolve';
                    resolveBtn.style.cssText = 'background:#16a34a;color:white;border:none;padding:8px 10px;border-radius:4px;cursor:pointer;width:100%;font-size:12px;font-weight:600;box-shadow:0 2px 4px rgba(0,0,0,0.1);';

                    resolveBtn.addEventListener('click', () => {
                        const allCheck = content.querySelector('#rv-resolve-all-check');
                        if (allCheck && !allCheck.checked) {
                            const checkedPlazas = Array.from(content.querySelectorAll('.rv-plaza-resolve-item:checked')).map(i => i.value);
                            if (checkedPlazas.length === 0) {
                                alert("Please select at least one survey location.");
                                return;
                            }
                            trip.resolvedPlazas = checkedPlazas; // Just store it in the trip for backend export logic potentially later
                        } else {
                            trip.resolvedPlazas = null;
                        }

                        if (rv_activeInfoWindow) rv_activeInfoWindow.close();
                        rvApplyResolution(s.lat, s.lng, s.name, point);
                    });

                    content.appendChild(resolveBtn);

                    const allCheckEl = content.querySelector('#rv-resolve-all-check');
                    if (allCheckEl) {
                        const listEl = content.querySelector('#rv-plaza-selection-list');
                        allCheckEl.addEventListener('change', () => {
                            listEl.style.display = allCheckEl.checked ? 'none' : 'block';
                        });
                    }

                    const iw = new google.maps.InfoWindow({ content });
                    iw.open(rv_map, m);
                    rv_activeInfoWindow = iw;
                });

                rv_suggestionMarkers.push(m);
                bounds.extend({ lat: s.lat, lng: s.lng });

                if (trip.plazaCoords) {
                    const isNearest = (s === nearestSuggestion);
                    const line = new google.maps.Polyline({
                        path: [trip.plazaCoords, { lat: s.lat, lng: s.lng }],
                        strokeColor: isNearest ? 'red' : 'blue',
                        strokeOpacity: isNearest ? 0.8 : 0.4,
                        strokeWeight: isNearest ? 3 : 1,
                        map: rv_map
                    });
                    rv_suggestionMarkers.push(line);
                }
            });
            
            rv_map.fitBounds(bounds, 60);
        }
    } catch (e) {
        console.warn('Failed to fetch suggestions in R&V:', e);
    }
}

function rvCloseSearch(silent = false) {
    const bar = document.getElementById('rv-edit-bar');
    if (bar) {
        bar.style.display = 'none';
    }

    const input = document.getElementById('rv-edit-search-input');
    if (input) {
        input.value = '';
        input.disabled = true;
    }

    // Clear suggestions
    rv_suggestionMarkers.forEach(m => m.setMap(null));
    rv_suggestionMarkers = [];
    if (rv_activeInfoWindow) {
        rv_activeInfoWindow.close();
        rv_activeInfoWindow = null;
    }

    rv_editingPoint = null;
}

async function rvHandlePlaceSelection() {
    if (!rv_autocompleteInstance || rv_editingTripIdx === -1 || !rv_editingPoint) return;

    const place = rv_autocompleteInstance.getPlace();
    if (!place.geometry) {
        alert("No details available for input: '" + place.name + "'");
        return;
    }

    const newLat = place.geometry.location.lat();
    const newLng = place.geometry.location.lng();
    const newName = place.name;

    rvApplyResolution(newLat, newLng, newName, rv_editingPoint);
}

async function rvApplyResolution(newLat, newLng, newName, point) {
    const tripData = rv_currentSubTab === 'intrazonal' ? rv_intrazonalData : rv_illogicalData;
    const trip = tripData[rv_editingTripIdx];

    try {
        const resp = await fetch(`/api/zone?lat=${newLat}&lng=${newLng}`);
        const data = await resp.json();
        const newZone = rvCleanZoneId(data.zone);

        const targetOriginalName = point === 'O' ? trip.originalOrigin : trip.originalDestination;

        // Apply resolution to all matching trips in both tabs
        [rv_intrazonalData, rv_illogicalData].forEach(dataset => {
            dataset.forEach(t => {
                let resolved = false;
                if (t.originalOrigin === targetOriginalName) {
                    t.origin = newName;
                    t.originCoords = { lat: newLat, lng: newLng };
                    if (t.zone !== undefined) t.zone = newZone;
                    if (t.originZone !== undefined) t.originZone = newZone;
                    resolved = true;
                }
                if (t.originalDestination === targetOriginalName) {
                    t.destination = newName;
                    t.destCoords = { lat: newLat, lng: newLng };
                    if (t.zone !== undefined) t.zone = newZone;
                    if (t.destZone !== undefined) t.destZone = newZone;
                    resolved = true;
                }

                if (resolved) {
                    t.status = 'Resolved';
                    // Recompute distances for illogical trips if possible
                    if (t.originCoords && t.destCoords && t.plazaCoords) {
                        t.distOD = calculateHaversine(t.originCoords.lat, t.originCoords.lng, t.destCoords.lat, t.destCoords.lng);
                        t.distOPD = calculateHaversine(t.originCoords.lat, t.originCoords.lng, t.plazaCoords.lat, t.plazaCoords.lng) + calculateHaversine(t.plazaCoords.lat, t.plazaCoords.lng, t.destCoords.lat, t.destCoords.lng);
                    }
                }
            });
        });

        rvCloseSearch();
        rvSave(); // autosave

        if (rv_currentSubTab === 'intrazonal') {
            rvRenderIntrazonalTable();
            rvMapView(rv_editingTripIdx);
        } else {
            rvRenderIllogicalTable();
            rvMapViewIllogical(rv_editingTripIdx);
        }

    } catch (err) {
        console.error("Error updating location:", err);
        alert("Failed to update location.");
    }
}

/**
 * Toggle details dropdown for a row.
 */
function rvShowDetails(idx) {
    const detailsRow = document.getElementById(`rv-details-${idx}`);
    const contentDiv = document.getElementById(`rv-details-content-${idx}`);
    if (!detailsRow || !contentDiv) return;

    // Collapse previously expanded row
    if (rv_expandedRow !== -1 && rv_expandedRow !== idx) {
        const prevRow = document.getElementById(`rv-details-${rv_expandedRow}`);
        if (prevRow) prevRow.style.display = 'none';
    }

    if (detailsRow.style.display === 'none') {
        const trip = rv_intrazonalData[idx];
        const analytics = trip.parentPlace?.analytics || {};
        const pairKey = `${trip.origin.toUpperCase()} - ${trip.destination.toUpperCase()}`;

        // Build mapping of Vehicle -> Commodities for this specific trip
        let vehicleHtml = '';
        const vehicles = Object.keys(trip.vehicleBreakdown).sort();

        for (const vClass of vehicles) {
            const count = trip.vehicleBreakdown[vClass];
            let commodities = [];

            // Case 1: Detect from analytics (Zone/Place assign mode fallback)
            if (trip.parentPlace) {
                const matrices = [analytics.commodityInteractionsAbstract, analytics.commodityInteractionsDetailed];
                for (const matrix of matrices) {
                    if (!matrix) continue;
                    for (const [code, vehicleMap] of Object.entries(matrix)) {
                        const interactions = vehicleMap[vClass];
                        if (Array.isArray(interactions)) {
                            for (const inter of interactions) {
                                if (inter.toUpperCase().startsWith(pairKey)) {
                                    commodities.push(code);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            // Case 2: Detect from rawRows (Direct R&V mode from Resolved_rawOD)
            else if (trip.rawRows) {
                for (const row of trip.rawRows) {
                    const rowVeh = (row.MAV_SPLIT || row.VEHICLE_CODE || '').trim();
                    if (rowVeh === vClass) {
                        if (row.COMMODITY_CODE_ABSTRACT) commodities.push(row.COMMODITY_CODE_ABSTRACT);
                        if (row.COMMODITY_CODE_DETAILED) commodities.push(row.COMMODITY_CODE_DETAILED);
                    }
                }
            }

            // Deduplicate commodities
            commodities = [...new Set(commodities)].filter(c => c && c !== '0' && c !== 'NAN');

            vehicleHtml += `
                <div class="rv-vehicle-detail-row">
                    <span class="rv-detail-chip"><strong>${vClass}</strong>: ${count}</span>
                    <div class="rv-detail-commodities-sub">
                        ${commodities.map(c => `<span class="rv-commodity-tag">${c}</span>`).join('') || '<span class="rv-no-data-tag">No commodities</span>'}
                    </div>
                </div>`;
        }

        contentDiv.innerHTML = `
            <div class="rv-details-expanded">
                <div class="rv-details-section">
                    <h4>Vehicle Breakdown & Associated Commodities</h4>
                    <div class="rv-detail-vehicle-list">${vehicleHtml || '<p>No data available</p>'}</div>
                </div>
            </div>`;

        detailsRow.style.display = 'table-row';
        rv_expandedRow = idx;
    } else {
        detailsRow.style.display = 'none';
        rv_expandedRow = -1;
    }
}

/**
 * Remove trip — marks as "Removed from data".
 */
function rvRemoveTrip(idx) {
    if (!confirm('Are you sure you want to remove these trips from the dataset? This will exclude them from the export.')) return;
    const trip = rv_intrazonalData[idx];
    if (!trip || trip.status === 'Removed from data') return;

    trip.status = 'Removed from data';
    rvRenderIntrazonalTable();
}

// ── Map Utilities ────────────────────────────────────────────────────────────

function rvInitMap() {
    if (rv_mapInitialized) return;
    if (typeof google === 'undefined' || !google.maps) {
        console.warn('R&V: Google Maps not loaded yet.');
        return;
    }

    const container = document.getElementById('rv-map');
    if (!container) return;

    rv_map = new google.maps.Map(container, {
        zoom: 5,
        center: { lat: 20.5937, lng: 78.9629 },
        mapTypeId: 'roadmap'
    });

    rv_mapInitialized = true;

    // Hide placeholder
    const placeholder = document.getElementById('rv-map-placeholder');
    if (placeholder) placeholder.style.display = 'none';
}

function rvClearMap() {
    // Clear markers
    rv_markers.forEach(m => m.setMap(null));
    rv_markers = [];

    // Clear suggestions
    rv_suggestionMarkers.forEach(m => m.setMap(null));
    rv_suggestionMarkers = [];
    if (rv_activeInfoWindow) {
        rv_activeInfoWindow.close();
        rv_activeInfoWindow = null;
    }

    // Clear polylines / directions renderers
    rv_polylines.forEach(p => {
        if (p.setMap) p.setMap(null);
        if (p.setDirections) p.setDirections({ routes: [] });
    });
    rv_polylines = [];

    // Clear zone boundary
    if (rv_zoneBoundary) {
        rv_zoneBoundary.setMap(null);
        rv_zoneBoundary = null;
    }
}

function rvDrawZoneBoundary(geojson) {
    if (!rv_map || !geojson) return;

    try {
        const coords = [];
        const extractCoords = (ring) => ring.map(c => ({ lat: c[1], lng: c[0] }));

        if (geojson.type === 'Polygon') {
            coords.push(extractCoords(geojson.coordinates[0]));
        } else if (geojson.type === 'MultiPolygon') {
            geojson.coordinates.forEach(poly => {
                coords.push(extractCoords(poly[0]));
            });
        }

        if (coords.length > 0) {
            rv_zoneBoundary = new google.maps.Polygon({
                paths: coords,
                strokeColor: '#f59e0b',
                strokeOpacity: 0.8,
                strokeWeight: 2,
                fillColor: '#f59e0b',
                fillOpacity: 0.1,
                map: rv_map
            });
        }
    } catch (e) {
        console.warn('Failed to draw zone boundary:', e);
    }
}

async function rvGeocode(placeName) {
    if (!placeName || typeof google === 'undefined') return null;

    try {
        const geocoder = new google.maps.Geocoder();
        const result = await new Promise((resolve, reject) => {
            geocoder.geocode({ address: placeName + ', India' }, (results, status) => {
                if (status === 'OK' && results.length > 0) {
                    resolve({
                        lat: results[0].geometry.location.lat(),
                        lng: results[0].geometry.location.lng()
                    });
                } else {
                    reject(status);
                }
            });
        });
        return result;
    } catch (e) {
        console.warn(`Geocode failed for "${placeName}":`, e);
        return null;
    }
}

// ── Save / Export ─────────────────────────────────────────────────────────────

function rvSave() {
    // Save R&V state into sessionStorage
    try {
        const state = {
            intrazonalData: rv_intrazonalData,
            currentSubTab: rv_currentSubTab
        };
        sessionStorage.setItem('rv_state', JSON.stringify(state));
        alert('Review & Visualization progress saved.');
    } catch (e) {
        console.error('R&V save failed:', e);
        alert('Save failed: ' + e.message);
    }
}

async function rvExport() {
    if (rv_intrazonalData.length === 0) {
        alert('No data to export.');
        return;
    }

    if (!rv_validatorName) {
        alert('Validator name is required. Please enter your name.');
        rvShowValidatorDialog();
        return;
    }

    // Build updated resolutions from intrazonal edits
    const updatedResolutions = JSON.parse(JSON.stringify(rv_resolutions));
    for (const trip of rv_intrazonalData) {
        if (trip.status === 'Edited' || trip.status === 'Resolved') {
            // Update the resolution entry for the edited origin/destination
            if (trip.origin && trip.originCoords) {
                const key = trip.originalOrigin || trip.origin;
                updatedResolutions[key] = updatedResolutions[key] || {};
                updatedResolutions[key].name = trip.origin;
                updatedResolutions[key].lat = trip.originCoords.lat;
                updatedResolutions[key].lng = trip.originCoords.lng;
                updatedResolutions[key].zone = trip.zone;
                updatedResolutions[key].resolved_by = 'R&V Edit';
            }
            if (trip.destination && trip.destCoords) {
                const key = trip.originalDestination || trip.destination;
                updatedResolutions[key] = updatedResolutions[key] || {};
                updatedResolutions[key].name = trip.destination;
                updatedResolutions[key].lat = trip.destCoords.lat;
                updatedResolutions[key].lng = trip.destCoords.lng;
                updatedResolutions[key].zone = trip.zone;
                updatedResolutions[key].resolved_by = 'R&V Edit';
            }
        }
    }

    const btn = document.getElementById('rv-export-btn');
    const origText = btn ? btn.innerHTML : 'Export';
    if (btn) btn.innerHTML = '<span style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite;display:inline-block;margin-right:6px;"></span> Exporting...';

    try {
        const formData = new FormData();
        formData.append('mapping', JSON.stringify(updatedResolutions));
        formData.append('plaza_mapping', JSON.stringify(rv_plazaMapping));
        formData.append('validator_name', rv_validatorName);
        formData.append('rv_intrazonal_data', JSON.stringify(rv_intrazonalData));

        if (rv_projectOdBlob) {
            formData.append('excel_file', rv_projectOdBlob);
        }
        if (rv_projectShpBlob) {
            formData.append('shapefile_zip', rv_projectShpBlob);
        }

        const resp = await fetch('/api/export/rv_progress', {
            method: 'POST',
            body: formData
        });

        if (!resp.ok) throw new Error(await resp.text());

        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ODIN_RV_Export_Project.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('Export successful!');
    } catch (err) {
        console.error('R&V Export failed:', err);
        alert('Export failed: ' + err.message);
    } finally {
        if (btn) btn.innerHTML = origText;
    }
}

// ── Validator Dialog ─────────────────────────────────────────────────────────

function rvShowValidatorDialog() {
    const overlay = document.getElementById('rv-validator-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    const input = document.getElementById('rv-validator-input');
    const btn = document.getElementById('rv-validator-btn');

    // Reset
    input.value = '';
    btn.disabled = true;

    // Enable button when text is entered
    input.oninput = () => {
        btn.disabled = input.value.trim().length === 0;
    };

    // Allow Enter key to submit
    input.onkeydown = (e) => {
        if (e.key === 'Enter' && input.value.trim().length > 0) {
            rvSubmitValidatorName();
        }
    };

    setTimeout(() => input.focus(), 100);
}

function rvSubmitValidatorName() {
    const input = document.getElementById('rv-validator-input');
    const name = input ? input.value.trim() : '';

    if (!name) {
        alert('Please enter your name.');
        return;
    }

    rv_validatorName = name;

    // Update the user display in the header if it exists
    const userDisplay = document.getElementById('rv-current-user');
    if (userDisplay) userDisplay.textContent = name;

    // Close dialog
    const overlay = document.getElementById('rv-validator-overlay');
    if (overlay) overlay.style.display = 'none';
}


// ── User Dropdown ────────────────────────────────────────────────────────────

function rvToggleUserDropdown() {
    const dd = document.getElementById('rv-user-dropdown');
    if (!dd) return;

    if (dd.classList.contains('show')) {
        dd.classList.remove('show');
        return;
    }

    // Populate with users from main app
    const users = (typeof allUsers !== 'undefined' && allUsers.length > 0) ? allUsers : ['All Users'];
    dd.innerHTML = ['All Users', ...users.filter(u => u !== 'All Users')].map(u =>
        `<div class="user-dropdown-item" onclick="rvSelectUser('${u}')">${u}</div>`
    ).join('');

    dd.classList.add('show');
}

function rvSelectUser(user) {
    const display = document.getElementById('rv-current-user');
    if (display) display.textContent = user;
    const dd = document.getElementById('rv-user-dropdown');
    if (dd) dd.classList.remove('show');
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    const rvUserSel = document.getElementById('rv-user-selector');
    const rvUserDd = document.getElementById('rv-user-dropdown');
    if (rvUserSel && rvUserDd && !rvUserSel.contains(e.target)) {
        rvUserDd.classList.remove('show');
    }
});

// ── Backend Status Polling ───────────────────────────────────────────────────

function rvStartStatusPolling() {
    rvCheckStatus();
    rv_statusInterval = setInterval(rvCheckStatus, 5000);
}

function rvStopStatusPolling() {
    if (rv_statusInterval) {
        clearInterval(rv_statusInterval);
        rv_statusInterval = null;
    }
}

async function rvCheckStatus() {
    const dot = document.getElementById('rv-system-dot');
    if (!dot) return;

    try {
        const resp = await fetch('/api/status', { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
            dot.className = 'status-dot online';
        } else {
            dot.className = 'status-dot offline';
        }
    } catch {
        dot.className = 'status-dot offline';
    }
}

// ── Illogical Trips ──────────────────────────────────────────────────────────

function rvDetectIllogicalTripsFromRaw(rawRows, resolutions) {
    rv_illogicalData = [];
    const tripMap = new Map();
    const resolutionsUpper = {};

    for (const [k, v] of Object.entries(resolutions || {})) {
        resolutionsUpper[k.toUpperCase()] = v;
    }

    if (!rawRows || !Array.isArray(rawRows)) return;

    for (const row of rawRows) {
        const oZone = rvCleanZoneId(row.ORIGIN_ZONE);
        const dZone = rvCleanZoneId(row.DESTINATION_ZONE);

        if (oZone === '0' || oZone === '' || oZone === 'Unknown' || oZone === dZone) continue;

        const oName = (row.ORIGIN || '').trim();
        const dName = (row.DESTINATION || '').trim();
        const vClass = (row.MAV_SPLIT || row.VEHICLE_CODE || 'Unknown').trim();
        const pName = (row.SURVEY_LOCATION || row.PLAZA_NAME || row.PLAZA || '').trim();

        const count = 1;
        const sortedNames = [oName.toUpperCase(), dName.toUpperCase()].sort();
        const key = `${sortedNames[0]}|${sortedNames[1]}|${pName.toUpperCase()}`;

        if (!tripMap.has(key)) {
            const oRes = rvGetResolvedData(oName, resolutionsUpper);
            const dRes = rvGetResolvedData(dName, resolutionsUpper);

            const oCoords = oRes ? (oRes.coords || { lat: oRes.lat, lng: oRes.lng }) : null;
            const dCoords = dRes ? (dRes.coords || { lat: dRes.lat, lng: dRes.lng }) : null;

            let pCoords = null;
            if (pName) {
                const keys = Object.keys(rv_plazaMapping);
                const match = keys.find(k => k.toLowerCase() === pName.toLowerCase());
                if (match) pCoords = rv_plazaMapping[match];
            }

            if (!oCoords || !dCoords || !pCoords || !oCoords.lat || !dCoords.lat || !pCoords.lat) continue;

            const distOD = calculateHaversine(oCoords.lat, oCoords.lng, dCoords.lat, dCoords.lng);
            const distOP = calculateHaversine(oCoords.lat, oCoords.lng, pCoords.lat, pCoords.lng);
            const distPD = calculateHaversine(pCoords.lat, pCoords.lng, dCoords.lat, dCoords.lng);

            let isIllogical = false;
            let reason = '';

            // Logic 1: Significant distance diff (> 20% more route length)
            if (distOD > 0 && (distOP + distPD) > distOD * 1.2) {
                isIllogical = true;
                reason = 'Significant distance difference';
            }

            // Logic 2: U-Turn near plaza (Angle O-P-D < ~36 degrees => cos > 0.8)
            if (!isIllogical && distOP > 0 && distPD > 0) {
                const cosTheta = (distOP * distOP + distPD * distPD - distOD * distOD) / (2 * distOP * distPD);
                if (cosTheta > 0.8) {
                    isIllogical = true;
                    reason = 'U-turn at Plaza';
                }
            }

            if (isIllogical) {
                tripMap.set(key, {
                    originZone: oZone,
                    destZone: dZone,
                    origin: oName,
                    originalOrigin: oName,
                    destination: dName,
                    originalDestination: dName,
                    plaza: pName,
                    tripCount: 0,
                    vehicleBreakdown: {},
                    status: 'Pending',
                    reason: reason,
                    distOD: distOD,
                    distOPD: distOP + distPD,
                    originCoords: oCoords,
                    destCoords: dCoords,
                    plazaCoords: pCoords,
                    rawRows: []
                });
            }
        }

        const trip = tripMap.get(key);
        if (trip) {
            trip.tripCount += count;
            trip.vehicleBreakdown[vClass] = (trip.vehicleBreakdown[vClass] || 0) + count;
            trip.rawRows.push(row);
        }
    }

    rv_illogicalData = Array.from(tripMap.values());
    rv_illogicalData.sort((a, b) => b.tripCount - a.tripCount);
    rvRenderIllogicalTable();
}

function rvDetectIllogicalTrips(apiData, resolutions) {
    rv_illogicalData = [];
    const tripMap = new Map();
    const resolutionsUpper = {};

    for (const [k, v] of Object.entries(resolutions || {})) {
        resolutionsUpper[k.toUpperCase()] = v;
    }

    if (!apiData || !Array.isArray(apiData)) return;

    for (const item of apiData) {
        if (!item.analytics || !item.analytics.vehicleInteractionsPlaza) continue;

        for (const [plazaName, vehicleInteractions] of Object.entries(item.analytics.vehicleInteractionsPlaza)) {
            for (const [vehicleClass, interactions] of Object.entries(vehicleInteractions)) {
                if (!Array.isArray(interactions)) continue;

                for (const interStr of interactions) {
                    const match = interStr.match(/^(.+?) - (.+?)\s*\[(\d+)\]$/);
                    if (!match) continue;

                    const oName = match[1].trim();
                    const dName = match[2].trim();
                    const count = parseInt(match[3], 10);

                    const oRes = rvGetResolvedData(oName, resolutionsUpper);
                    const dRes = rvGetResolvedData(dName, resolutionsUpper);

                    const oZoneClean = oRes ? rvCleanZoneId(oRes.zone) : 'Unknown';
                    const dZoneClean = dRes ? rvCleanZoneId(dRes.zone) : 'Unknown';

                    if (oZoneClean === 'Unknown' || dZoneClean === 'Unknown' || oZoneClean === dZoneClean) continue;

                    const sortedNames = [oName.toUpperCase(), dName.toUpperCase()].sort();
                    const key = `${sortedNames[0]}|${sortedNames[1]}|${plazaName.toUpperCase()}`;

                    if (!tripMap.has(key)) {
                        const oCoords = oRes.coords || { lat: oRes.lat, lng: oRes.lng };
                        const dCoords = dRes.coords || { lat: dRes.lat, lng: dRes.lng };

                        let pCoords = null;
                        const keys = Object.keys(rv_plazaMapping);
                        const matchPlaza = keys.find(k => k.toLowerCase() === plazaName.toLowerCase());
                        if (matchPlaza) pCoords = rv_plazaMapping[matchPlaza];

                        if (!oCoords || !dCoords || !pCoords || !oCoords.lat || !dCoords.lat || !pCoords.lat) continue;

                        const distOD = calculateHaversine(oCoords.lat, oCoords.lng, dCoords.lat, dCoords.lng);
                        const distOP = calculateHaversine(oCoords.lat, oCoords.lng, pCoords.lat, pCoords.lng);
                        const distPD = calculateHaversine(pCoords.lat, pCoords.lng, dCoords.lat, dCoords.lng);

                        let isIllogical = false;
                        let reason = '';

                        if (distOD > 0 && (distOP + distPD) > distOD * 1.2) {
                            isIllogical = true;
                            reason = 'Significant distance difference';
                        }

                        if (!isIllogical && distOP > 0 && distPD > 0) {
                            const cosTheta = (distOP * distOP + distPD * distPD - distOD * distOD) / (2 * distOP * distPD);
                            if (cosTheta > 0.8) {
                                isIllogical = true;
                                reason = 'U-turn at Plaza';
                            }
                        }

                        if (isIllogical) {
                            tripMap.set(key, {
                                originZone: oZoneClean,
                                destZone: dZoneClean,
                                origin: oName,
                                originalOrigin: oName,
                                destination: dName,
                                originalDestination: dName,
                                plaza: plazaName,
                                tripCount: 0,
                                vehicleBreakdown: {},
                                status: 'Pending',
                                reason: reason,
                                distOD: distOD,
                                distOPD: distOP + distPD,
                                originCoords: oCoords,
                                destCoords: dCoords,
                                plazaCoords: pCoords,
                                rawRows: []
                            });
                        }
                    }

                    const trip = tripMap.get(key);
                    if (trip) {
                        trip.tripCount += count;
                        trip.vehicleBreakdown[vehicleClass] = (trip.vehicleBreakdown[vehicleClass] || 0) + count;
                    }
                }
            }
        }
    }

    rv_illogicalData = Array.from(tripMap.values());
    rv_illogicalData.sort((a, b) => b.tripCount - a.tripCount);
    rvRenderIllogicalTable();
}

function rvRenderIllogicalTable() {
    const tbody = document.getElementById('rv-illogical-body');
    if (!tbody) return;

    if (rv_illogicalData.length === 0) {
        tbody.innerHTML = `
            <tr class="rv-empty-state">
                <td colspan="6">
                    <div class="rv-empty-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="1.5">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                            <polyline points="22 4 12 14.01 9 11.01"></polyline>
                        </svg>
                        <p style="color: var(--success);">No illogical trips detected. Routes seem optimal.</p>
                    </div>
                </td>
            </tr>`;
        return;
    }

    let html = '';
    rv_illogicalData.forEach((trip, idx) => {
        const statusClass = trip.status === 'Pending' ? 'rv-status-pending'
            : trip.status === 'Removed from data' ? 'rv-status-removed'
                : 'rv-status-resolved';

        html += `
            <tr class="rv-data-row ${trip.status === 'Removed from data' ? 'rv-row-removed' : ''}" id="rv-ill-row-${idx}">
                <td class="rv-cell-sno">${idx + 1}</td>
                <td class="rv-cell-origin" title="${trip.origin}">${rvTruncate(trip.origin, 30)}</td>
                <td class="rv-cell-dest" title="${trip.destination}">${rvTruncate(trip.destination, 30)}</td>
                <td class="rv-cell-count">${trip.tripCount}</td>
                <td class="rv-cell-actions">
                    <div class="rv-action-group">
                        <button class="rv-action-btn rv-btn-mapview" onclick="rvMapViewIllogical(${idx})" title="Map View">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"></path><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>
                            Map
                        </button>
                        <button class="rv-action-btn rv-btn-details" onclick="rvShowDetailsIllogical(${idx})" title="Details">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                            Details
                        </button>
                        <button class="rv-action-btn rv-btn-remove" onclick="rvRemoveTripIllogical(${idx})" title="Remove" ${trip.status === 'Removed from data' ? 'disabled' : ''}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                            Remove
                        </button>
                    </div>
                </td>
                <td class="rv-cell-status">
                    <span class="rv-status-badge ${statusClass}">${trip.status}</span>
                </td>
            </tr>
            <tr class="rv-details-row" id="rv-ill-details-${idx}" style="display: none;">
                <td colspan="6">
                    <div class="rv-details-content" id="rv-ill-details-content-${idx}"></div>
                </td>
            </tr>`;
    });

    tbody.innerHTML = html;
}

async function rvMapViewIllogical(idx) {
    const trip = rv_illogicalData[idx];
    if (!trip) return;

    // Reset Edit State for new map
    rv_editingTripIdx = idx;
    rvCloseSearch(true);
    rv_isEditMode = true;
    document.getElementById('rv-map').classList.add('editing-map');

    const editBar = document.getElementById('rv-edit-bar');
    if (editBar) editBar.style.display = 'none';

    document.querySelectorAll('.rv-data-row').forEach(r => r.classList.remove('rv-row-active'));
    const row = document.getElementById(`rv-ill-row-${idx}`);
    if (row) row.classList.add('rv-row-active');

    rvClearMap();

    if (!rv_map) {
        rvInitMap();
        await new Promise(r => setTimeout(r, 500));
    }
    if (!rv_map) return;

    const placeholder = document.getElementById('rv-map-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    const addMarker = (coords, label, title, color, strokeColor = '#fff') => {
        if (!coords) return null;
        const marker = new google.maps.Marker({
            position: coords,
            map: rv_map,
            label: { text: label, color: '#fff', fontSize: '11px', fontWeight: '700' },
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: color, fillOpacity: 1, strokeColor: strokeColor, strokeWeight: 2 },
            title: title
        });
        rv_markers.push(marker);
        return marker;
    };

    const mO = addMarker(trip.originCoords, 'O', 'Origin', '#1ade48ff');
    const mD = addMarker(trip.destCoords, 'D', 'Destination', '#d33e3eff');
    
    if (trip.plazaCoords) {
        const mP = new google.maps.Marker({
            position: trip.plazaCoords,
            map: rv_map,
            label: { text: 'P', color: '#ffffffff', fontSize: '11px', fontWeight: '700' },
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: '#0b78f5ff',
                fillOpacity: 1,
                strokeColor: '#740000ff',
                strokeWeight: 2
            },
            title: trip.plaza ? 'Plaza: ' + trip.plaza : 'Survey Location'
        });
        rv_markers.push(mP);
    }

    if (mO) mO.addListener('click', () => { if (rv_isEditMode) rvStartRelocate('O'); });
    if (mD) mD.addListener('click', () => { if (rv_isEditMode) rvStartRelocate('D'); });

    if (trip.originCoords && trip.destCoords && trip.plazaCoords) {
        const directionsService = new google.maps.DirectionsService();

        // 1. Red line: O -> P -> D
        const dirRendererRed = new google.maps.DirectionsRenderer({
            map: rv_map,
            suppressMarkers: true,
            polylineOptions: { strokeColor: 'red', strokeWeight: 4, strokeOpacity: 0.8 }
        });
        rv_polylines.push(dirRendererRed);

        directionsService.route({
            origin: trip.originCoords,
            destination: trip.destCoords,
            waypoints: [{ location: trip.plazaCoords, stopover: true }],
            travelMode: google.maps.TravelMode.DRIVING
        }, (res, status) => { if (status === 'OK') dirRendererRed.setDirections(res); });

        // 2. Blue dotted line: O -> D
        directionsService.route({
            origin: trip.originCoords,
            destination: trip.destCoords,
            travelMode: google.maps.TravelMode.DRIVING
        }, (res, status) => {
            if (status === 'OK') {
                const path = res.routes[0].overview_path;
                const dottedLine = new google.maps.Polyline({
                    path: path,
                    strokeOpacity: 0,
                    icons: [{
                        icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: 'blue', strokeWeight: 4, scale: 2 },
                        offset: '0',
                        repeat: '20px'
                    }],
                    map: rv_map
                });
                rv_polylines.push(dottedLine);
            } else {
                // Fallback basic line
                const line = new google.maps.Polyline({
                    path: [trip.originCoords, trip.destCoords],
                    strokeColor: 'blue', strokeOpacity: 0.5, strokeWeight: 3, map: rv_map
                });
                rv_polylines.push(line);
            }
        });

        const bounds = new google.maps.LatLngBounds();
        bounds.extend(trip.originCoords);
        bounds.extend(trip.destCoords);
        bounds.extend(trip.plazaCoords);
        rv_map.fitBounds(bounds, 60);
    } else if (trip.originCoords) {
        rv_map.setCenter(trip.originCoords);
        rv_map.setZoom(12);
    }
}

function rvShowDetailsIllogical(idx) {
    const detailsRow = document.getElementById(`rv-ill-details-${idx}`);
    const contentDiv = document.getElementById(`rv-ill-details-content-${idx}`);
    const trip = rv_illogicalData[idx];

    if (detailsRow.style.display === 'table-row') {
        detailsRow.style.display = 'none';
        rv_expandedRow = -1;
        return;
    }

    if (rv_expandedRow !== -1 && rv_expandedRow !== idx) {
        const oldRow = document.getElementById(`rv-ill-details-${rv_expandedRow}`);
        if (oldRow) oldRow.style.display = 'none';
    }

    let breakHtml = '';
    for (const [vClass, count] of Object.entries(trip.vehicleBreakdown)) {
        breakHtml += `<span class="rv-detail-chip" style="margin-right: 8px; margin-bottom: 8px; display: inline-block;"><strong>${vClass}</strong>: ${count}</span>`;
    }

    const distODStr = trip.distOD ? trip.distOD.toFixed(2) : '--';
    const distOPDStr = trip.distOPD ? trip.distOPD.toFixed(2) : '--';

    contentDiv.innerHTML = `
        <div class="rv-details-grid">
            <div class="rv-details-col">
                <h4 style="color: var(--warning); margin-bottom: 0.5rem; display:flex; align-items:center; gap:0.5rem;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                    Reason
                </h4>
                <p style="font-weight: 500; color: #fff;">${trip.reason}</p>
                <p style="color: var(--text-secondary); margin-top: 0.5rem; font-size: 0.8rem;">Plaza: ${trip.plaza}</p>
                <div style="margin-top: 1rem; font-size: 0.85rem; color: #94a3b8;">
                    <div><strong style="color:#cbd5e1;">Origin - Destination:</strong> ${distODStr} km</div>
                    <div style="margin-top:4px;"><strong style="color:#cbd5e1;">Origin - Survey Location - Destination:</strong> ${distOPDStr} km</div>
                </div>
            </div>
            <div class="rv-details-col">
                <h4>Vehicle Breakdown</h4>
                <div class="rv-vclass-list" style="display:flex; flex-wrap:wrap; gap:8px;">${breakHtml}</div>
            </div>
            <div class="rv-details-col rv-details-actions">
                <h4>Resolution</h4>
                ${trip.status !== 'Pending' ? `
                    <div style="margin-bottom: 1rem;">
                        <span class="rv-status-badge ${trip.status === 'Removed from data' ? 'rv-status-removed' : 'rv-status-resolved'}">${trip.status}</span>
                    </div>
                ` : '<div style="margin-bottom: 1rem;"><span class="rv-status-badge rv-status-pending">Pending</span></div>'}
            </div>
        </div>
    `;

    detailsRow.style.display = 'table-row';
    rv_expandedRow = idx;
}

function rvRemoveTripIllogical(idx) {
    if (!confirm('Are you sure you want to remove these trips from the dataset? This will exclude them from the export.')) return;
    const trip = rv_illogicalData[idx];
    trip.status = 'Removed from data';
    rvRenderIllogicalTable();
}
