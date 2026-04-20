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
let rv_markers = [];                  // Active map markers
let rv_polylines = [];                // Active route polylines
let rv_zoneBoundary = null;           // Active zone polygon overlay
let rv_odDataRaw = null;              // Raw parsed OD data rows
let rv_shapefileGdf = null;           // Shapefile loaded flag
let rv_dataLoaded = false;
let rv_expandedRow = -1;              // Currently expanded details row
let rv_statusInterval = null;         // Backend status polling

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
}

// ── Data Loading ─────────────────────────────────────────────────────────────

/**
 * Load Data handler:
 * - If project data is already available from setup wizard, use it.
 * - Otherwise open a file picker to load a ZIP.
 */
async function rvLoadData() {
    // If we already have processed OD data from the main app, reprocess it
    if (typeof allUnmatchedPlaces !== 'undefined' && allUnmatchedPlaces.length > 0) {
        rvProcessLoadedData();
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

        if (!file) return;
        await rvParseProjectZip(file);
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('R&V Load Data failed:', err);
            alert('Failed to load data: ' + err.message);
        }
    }
}

/**
 * Parse a project ZIP independently for R&V mode.
 */
async function rvParseProjectZip(file) {
    if (typeof JSZip === 'undefined') {
        alert('JSZip library not loaded.');
        return;
    }

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

    // Upload to backend for parsing
    const formData = new FormData();
    formData.append('file', new File([odBlob], 'od_dataset.xlsx'));
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
            const shpForm = new FormData();
            shpForm.append('file', new File([shpBlob], 'shapefile.zip'));
            await fetch('/api/upload/shapefile', { method: 'POST', body: shpForm });
            rv_shapefileGdf = true;
        }

        // Load resolutions to get zone assignments
        const resFile = zip.file('resolutions.json');
        let resolutions = {};
        if (resFile) {
            resolutions = JSON.parse(await resFile.async('string'));
        }

        // Store raw data and process for intrazonal trips
        rv_odDataRaw = result.data;
        rvDetectIntrazonalTrips(result.data, resolutions);
        rv_dataLoaded = true;

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
function rvDetectIntrazonalTrips(apiData, resolutions) {
    rv_intrazonalData = [];
    const tripMap = new Map();
    const resolutionsUpper = {};

    for (const [k, v] of Object.entries(resolutions)) {
        resolutionsUpper[k.toUpperCase()] = v;
    }

    if (!apiData || !Array.isArray(apiData)) return;

    for (const item of apiData) {
        if (!item.analytics || !item.analytics.vehicleInteractions) continue;

        for (const [vehicleClass, interactions] of Object.entries(item.analytics.vehicleInteractions)) {
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
                        tripMap.set(key, {
                            zone: oZoneClean,
                            origin: oName,
                            destination: dName,
                            tripCount: 0,
                            vehicleBreakdown: {},
                            status: 'Pending',
                            originCoords: oRes.coords || { lat: oRes.lat, lng: oRes.lng } || null,
                            destCoords: dRes.coords || { lat: dRes.lat, lng: dRes.lng } || null,
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
                    <span class="rv-status-badge ${statusClass}">${trip.status}</span>
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

    if (originCoords) {
        const marker = new google.maps.Marker({
            position: originCoords,
            map: rv_map,
            label: { text: 'O', color: '#fff', fontSize: '11px', fontWeight: '700' },
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: '#3b82f6',
                fillOpacity: 1,
                strokeColor: '#fff',
                strokeWeight: 2
            },
            title: `Origin: ${trip.origin}`
        });
        rv_markers.push(marker);
    }

    if (destCoords) {
        const marker = new google.maps.Marker({
            position: destCoords,
            map: rv_map,
            label: { text: 'D', color: '#fff', fontSize: '11px', fontWeight: '700' },
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 12,
                fillColor: '#ef4444',
                fillOpacity: 1,
                strokeColor: '#fff',
                strokeWeight: 2
            },
            title: `Destination: ${trip.destination}`
        });
        rv_markers.push(marker);
    }

    // 3. Draw driving route between origin and destination
    if (originCoords && destCoords) {
        try {
            const directionsService = new google.maps.DirectionsService();
            const directionsRenderer = new google.maps.DirectionsRenderer({
                map: rv_map,
                suppressMarkers: true,
                polylineOptions: {
                    strokeColor: '#4ade80',
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
        rv_map.fitBounds(bounds, 60);
    } else if (originCoords) {
        rv_map.setCenter(originCoords);
        rv_map.setZoom(12);
    } else if (destCoords) {
        rv_map.setCenter(destCoords);
        rv_map.setZoom(12);
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

            // Search in commodity interactions
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
            
            // Deduplicate commodities
            commodities = [...new Set(commodities)];

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

function rvExport() {
    if (rv_intrazonalData.length === 0) {
        alert('No data to export.');
        return;
    }

    // Build CSV
    const headers = ['S.No', 'Zone No.', 'Origin', 'Destination', 'Trip Count', 'Status'];
    const rows = rv_intrazonalData.map((trip, idx) => [
        idx + 1,
        trip.zone,
        `"${(trip.origin || '').replace(/"/g, '""')}"`,
        `"${(trip.destination || '').replace(/"/g, '""')}"`,
        trip.tripCount,
        trip.status
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ODIN_Intrazonal_Trips_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
