/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLACE ASSIGN MODE — Isolated Module
 *  Entirely separate from Zone Assign / Review & Visualization.
 *  All state is prefixed with pa_ to prevent collisions.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ── PA State ──────────────────────────────────────────────────────────────────
let pa_map = null;
let pa_mapInitialized = false;
let pa_markers = [];
let pa_lines = [];
let pa_activeInfoWindow = null;
let pa_resolvedPlaces = {};
let pa_plazaMapping = {};
let pa_allPlaces = [];
let pa_unmatchedPlaces = [];
let pa_currentIndex = 0;
let pa_projectOdBlob = null;
let pa_projectShpBlob = null;
let pa_geoJsonData = null;        // Parsed GeoJSON for overlay
let pa_geoJsonBlob = null;        // Raw file blob for export
let pa_currentUser = 'All Users';
let pa_allUsers = [];
let pa_autoSaveHandle = null;
let pa_autoSaveTimer = null;
let pa_pickingPlaza = null;
let pa_plazaVerificationMarkers = {};
let pa_selectedStates = [];
let pa_placeOccurrencesMap = {};
let pa_globalTotalOccurrences = 0;
let pa_pendingReturnToPlaceId = null;
let pa_zoneBoundaryLayer = null;
let pa_currentMode = 'Place assign';
let pa_components = [];
let pa_activeComponentId = null;
let pa_selectedZones = new Set();
let pa_componentLabels = [];

// ── Entry / Exit ──────────────────────────────────────────────────────────────

function enterPlaceAssign() {
    switchView('view-place-assign');
    paStartStatusPolling();
    paSyncThemeToggle();
    paShowDataSourceDialog();
}

function paGoBack() {
    paStopStatusPolling();
    paClearMap();
    // Reset state
    pa_resolvedPlaces = {};
    pa_plazaMapping = {};
    pa_allPlaces = [];
    pa_unmatchedPlaces = [];
    pa_currentIndex = 0;
    pa_projectOdBlob = null;
    pa_projectShpBlob = null;
    pa_geoJsonData = null;
    pa_geoJsonBlob = null;
    pa_autoSaveHandle = null;
    pa_mapInitialized = false;
    pa_map = null;
    switchView('view-mode-selection');
}

// ── Status Polling ────────────────────────────────────────────────────────────

let pa_statusInterval = null;

function paStartStatusPolling() {
    paCheckBackendStatus();
    pa_statusInterval = setInterval(paCheckBackendStatus, 5000);
}

function paStopStatusPolling() {
    if (pa_statusInterval) {
        clearInterval(pa_statusInterval);
        pa_statusInterval = null;
    }
}

async function paCheckBackendStatus() {
    const dot = document.getElementById('pa-system-dot');
    if (!dot) return;
    try {
        const resp = await fetch('/api/status', { signal: AbortSignal.timeout(3000) });
        dot.style.background = resp.ok ? '#4ade80' : '#ef4444';
    } catch {
        dot.style.background = '#ef4444';
    }
}

// ── Theme Sync ────────────────────────────────────────────────────────────────

function paSyncThemeToggle() {
    const mainToggle = document.getElementById('theme-toggle');
    const paToggle = document.getElementById('pa-theme-toggle');
    const paThumb = document.getElementById('pa-toggle-thumb');
    if (mainToggle && paToggle) paToggle.checked = mainToggle.checked;
    if (paThumb) {
        paThumb.innerHTML = document.body.classList.contains('light-theme') ? '☀️' : '🌙';
    }
}

function paToggleTheme() {
    const body = document.body;
    body.classList.toggle('light-theme');
    const isLight = body.classList.contains('light-theme');
    ['toggle-thumb', 'pa-toggle-thumb'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = isLight ? '☀️' : '🌙';
    });
    ['theme-toggle', 'pa-theme-toggle'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = isLight;
    });
}

// ── Data Source Dialog ────────────────────────────────────────────────────────

function paShowDataSourceDialog() {
    const overlay = document.getElementById('pa-datasource-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function paDismissDataSourceDialog() {
    const overlay = document.getElementById('pa-datasource-overlay');
    if (overlay) overlay.style.display = 'none';
    paGoBack();
}

async function paLoadNewProject() {
    const overlay = document.getElementById('pa-datasource-overlay');
    if (overlay) overlay.style.display = 'none';

    try {
        let file;
        if ('showOpenFilePicker' in window) {
            const [handle] = await window.showOpenFilePicker({
                types: [{ description: 'ODIN Zone Assign ZIP', accept: { 'application/zip': ['.zip'] } }],
                multiple: false
            });
            file = await handle.getFile();
        } else {
            file = await new Promise((resolve) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.zip';
                input.onchange = () => resolve(input.files[0]);
                input.click();
            });
        }

        if (!file) { paShowDataSourceDialog(); return; }

        paShowLoadingOverlay('Parsing Zone Assign project bundle...');
        await paParseZoneAssignZip(file);

    } catch (err) {
        paHideLoadingOverlay();
        if (err.name === 'AbortError') {
            paShowDataSourceDialog();
        } else {
            console.error('PA Load failed:', err);
            alert('Failed to load: ' + err.message);
            paShowDataSourceDialog();
        }
    }
}

// ── Parse Zone Assign ZIP ─────────────────────────────────────────────────────

async function paParseZoneAssignZip(file) {
    if (typeof JSZip === 'undefined') { alert('JSZip not loaded.'); return; }

    const zip = await JSZip.loadAsync(file);

    // 1. Restore resolutions
    const resFile = zip.file('resolutions.json');
    if (resFile) {
        pa_resolvedPlaces = JSON.parse(await resFile.async('string'));
    } else {
        alert('This ZIP does not contain a resolutions.json. Please export from Zone Assign first.');
        paHideLoadingOverlay();
        paShowDataSourceDialog();
        return;
    }

    // 2. Restore plaza mapping
    const pzFile = zip.file('plaza_mapping.json');
    if (pzFile) {
        pa_plazaMapping = JSON.parse(await pzFile.async('string'));
    }

    // 3. Restore config / users
    const cfgFile = zip.file('project_config.json');
    if (cfgFile) {
        const cfg = JSON.parse(await cfgFile.async('string'));
        if (cfg.users && Array.isArray(cfg.users) && cfg.users.length > 0) {
            pa_allUsers = cfg.users;
        }
        if (cfg.components && Array.isArray(cfg.components)) {
            pa_components = cfg.components;
        }
    }
    if (pa_allUsers.length === 0) pa_allUsers = ['User 1'];
    pa_currentUser = pa_allUsers[0];

    // 4. Find & upload Excel dataset
    let odFile = zip.file('od_dataset.xlsx') || zip.file('ODIN_Resolved_OD_Dataset.xlsx');
    if (!odFile) {
        const candidates = Object.keys(zip.files).filter(n => n.endsWith('.xlsx'));
        if (candidates.length > 0) odFile = zip.file(candidates[0]);
    }
    if (!odFile) {
        alert('No Excel dataset found in the ZIP.');
        paHideLoadingOverlay();
        paShowDataSourceDialog();
        return;
    }

    const odBlob = await odFile.async('blob');
    pa_projectOdBlob = new File([odBlob], 'od_dataset.xlsx');

    paShowLoadingOverlay('Uploading OD dataset to backend...');

    const formData = new FormData();
    formData.append('file', pa_projectOdBlob);
    formData.append('mode', 'Zone assign'); // parse as Zone Assign data

    try {
        const resp = await fetch('/api/upload/excel', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(await resp.text());
        const result = await resp.json();

        if (result.data && result.data.length > 0) {
            pa_placeOccurrencesMap = {};
            pa_globalTotalOccurrences = 0;
            result.data.forEach(p => {
                pa_placeOccurrencesMap[p.original_name] = p.total_occurrences || 0;
                pa_globalTotalOccurrences += (p.total_occurrences || 0);
            });

            pa_allPlaces = [...result.data];

            // Apply assigned_zone from resolutions to each place
            pa_allPlaces.forEach(place => {
                const res = pa_resolvedPlaces[place.original_name];
                if (res) {
                    const entry = res['__all__'] || Object.values(res)[0];
                    if (entry && entry.zone) {
                        place.assigned_zone = entry.zone;
                    }
                }
            });

            // Filter to only places that are fully resolved (have a zone)
            pa_unmatchedPlaces = pa_allPlaces.filter(p => p.assigned_zone);
            pa_currentIndex = 0;
        }
    } catch (err) {
        paHideLoadingOverlay();
        alert('Failed to parse OD dataset: ' + err.message);
        paShowDataSourceDialog();
        return;
    }

    // 5. Find & upload shapefile
    paShowLoadingOverlay('Uploading shapefile...');
    let shpFile = zip.file('shapefile.zip') || zip.file('Shapefile_Original.zip');
    if (!shpFile) {
        const candidates = Object.keys(zip.files).filter(n => n.endsWith('.zip'));
        if (candidates.length > 0) shpFile = zip.file(candidates[0]);
    }
    if (shpFile) {
        const shpBlob = await shpFile.async('blob');
        pa_projectShpBlob = new File([shpBlob], 'shapefile.zip');
        const shpForm = new FormData();
        shpForm.append('file', pa_projectShpBlob);
        try {
            await fetch('/api/upload/shapefile', { method: 'POST', body: shpForm });
        } catch (e) {
            console.warn('PA: Shapefile upload failed:', e);
        }
    }
    
    // 6. Find & upload GeoJSON
    let gjsonFile = zip.file('zoning_scheme.geojson');
    if (!gjsonFile) {
        const candidates = Object.keys(zip.files).filter(n => n.endsWith('.geojson'));
        if (candidates.length > 0) gjsonFile = zip.file(candidates[0]);
    }
    if (gjsonFile) {
        const gjsonText = await gjsonFile.async('string');
        pa_geoJsonData = JSON.parse(gjsonText);
        pa_geoJsonFile = new File([gjsonText], 'zoning_scheme.geojson', { type: 'application/json' });
    }

    paHideLoadingOverlay();

    // Reveal GeoJSON upload option now that ZIP is loaded
    const geoJsonSection = document.getElementById('pa-geojson-upload-section');
    if (geoJsonSection) geoJsonSection.style.display = 'block';

    // Setup auto-save
    try {
        pa_autoSaveHandle = await window.showSaveFilePicker({
            suggestedName: `ODIN_PlaceAssign_${new Date().toISOString().split('T')[0]}.zip`,
            types: [{ description: 'ODIN Project Bundle (ZIP)', accept: { 'application/zip': ['.zip'] } }],
        });
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('PA: Auto-save not set up:', e);
    }

    paRenderUserDropdown();
    paInitMapAndRender();
}

// ── Map Initialization ────────────────────────────────────────────────────────

async function paInitMapAndRender() {
    if (!window.google || !window.google.maps) {
        paShowLoadingOverlay('Waiting for Google Maps...');
        setTimeout(paInitMapAndRender, 500);
        return;
    }

    paShowLoadingOverlay('Rendering map...');

    if (!pa_mapInitialized) {
        const mapEl = document.getElementById('pa-map');
        if (!mapEl) { paHideLoadingOverlay(); return; }

        pa_map = new google.maps.Map(mapEl, {
            zoom: 5,
            center: { lat: 20.5937, lng: 78.9629 },
            mapTypeId: 'roadmap',
            mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT }
        });


        pa_mapInitialized = true;
    }

    await paRenderInitialMap();
    paRenderNavigator();
    paUpdateProgress();
    paHideLoadingOverlay();
}

function paShowManualPinConfirm(place, lat, lng, zoneId, nearestName) {
    const content = document.createElement('div');
    content.style.cssText = 'color:black;min-width:220px;font-family:sans-serif;padding:5px;';

    const plazas = place.analytics?.plazas?.headers || [];
    const resolvedFor = pa_resolvedPlaces[place.original_name] || {};

    content.innerHTML = `
        <div style="font-weight:bold;font-size:14px;margin-bottom:3px;border-bottom:1px solid #eee;padding-bottom:5px;">${nearestName}</div>
        <div style="font-size:11px;color:#666;margin-bottom:5px;">📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
        <div style="font-size:12px;color:#d59563;font-weight:bold;margin-bottom:8px;">🗺️ Zone: ${zoneId}</div>
        <div style="margin-bottom:12px;">
            <label style="font-size:11px;font-weight:600;color:#666;display:block;margin-bottom:5px;">RESOLVE FOR:</label>
            <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;margin-bottom:6px;">
                <input type="checkbox" id="pa-resolve-all-check" checked> Apply to ALL Plazas
            </label>
            <div id="pa-plaza-selection-list" style="display:none;margin-left:20px;max-height:100px;overflow-y:auto;border:1px solid #eee;border-radius:4px;padding:4px;">
                ${plazas.map(p => `
                    <label style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:3px;${resolvedFor[p] ? 'color:#999;text-decoration:line-through;' : ''}">
                        <input type="checkbox" class="pa-plaza-resolve-item" value="${p}" ${resolvedFor[p] ? 'disabled' : 'checked'}> ${p}
                    </label>
                `).join('')}
            </div>
        </div>
    `;

    const btn = document.createElement('button');
    btn.textContent = 'Confirm & Resolve';
    btn.style.cssText = 'background:#16a34a;color:white;border:none;padding:8px 10px;border-radius:4px;cursor:pointer;width:100%;font-size:12px;font-weight:600;';
    btn.addEventListener('click', () => {
        const resolveAll = content.querySelector('#pa-resolve-all-check').checked;
        let selectedPlazas = null;
        if (!resolveAll) {
            selectedPlazas = Array.from(content.querySelectorAll('.pa-plaza-resolve-item:checked')).map(i => i.value);
            if (selectedPlazas.length === 0) { alert("Select at least one plaza."); return; }
        }
        if (pa_activeInfoWindow) pa_activeInfoWindow.close();
        paSelectSuggestion(place.id, { name: nearestName, lat, lng, zone: zoneId }, selectedPlazas);
        paTriggerAutoSave();
    });
    content.appendChild(btn);

    const allCheck = content.querySelector('#pa-resolve-all-check');
    const subList = content.querySelector('#pa-plaza-selection-list');
    allCheck.addEventListener('change', () => { subList.style.display = allCheck.checked ? 'none' : 'block'; });

    const iw = new google.maps.InfoWindow({ content });
    if (pa_activeInfoWindow) pa_activeInfoWindow.close();
    iw.open(pa_map, pa_map.tempMarker);
    pa_activeInfoWindow = iw;
}

// ── Initial Overview Map ──────────────────────────────────────────────────────

async function paRenderInitialMap() {
    if (!pa_map) return;

    paClearMap();

    const bounds = new google.maps.LatLngBounds();
    let hasPoints = false;

    // 1. Shapefile overlay
    try {
        const resp = await fetch('/api/shapefile/geojson');
        if (resp.ok) {
            const geojson = await resp.json();
            pa_map.data.addGeoJson(geojson);
            pa_map.data.setStyle({
                fillColor: '#4285F4', fillOpacity: 0.07,
                strokeColor: '#4285F4', strokeWeight: 1.5, clickable: false
            });
            const tmp = new google.maps.Data();
            tmp.addGeoJson(geojson);
            tmp.forEach(f => f.getGeometry().forEachLatLng(ll => { bounds.extend(ll); hasPoints = true; }));
        }
    } catch (e) { console.warn('PA: shapefile geojson fetch failed', e); }

    // 2. Red circles: resolved places
    const plotted = new Set();
    for (const [origName, resEntry] of Object.entries(pa_resolvedPlaces)) {
        const targets = [];
        if (typeof resEntry === 'object' && resEntry !== null) {
            for (const [, rd] of Object.entries(resEntry)) {
                if (rd && rd.lat && rd.lng) targets.push(rd);
            }
        }
        for (const rd of targets) {
            const key = `${parseFloat(rd.lat).toFixed(6)},${parseFloat(rd.lng).toFixed(6)}`;
            if (plotted.has(key)) continue;
            plotted.add(key);
            const pos = { lat: parseFloat(rd.lat), lng: parseFloat(rd.lng) };
            const m = new google.maps.Marker({
                position: pos, map: pa_map, title: `${origName}\n${rd.name || ''}`,
                icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: '#EF4444', fillOpacity: 0.9, strokeColor: '#991B1B', strokeWeight: 1 },
                zIndex: 10
            });
            const iw = new google.maps.InfoWindow({ content: `<div style="color:#000;min-width:140px;"><b>${origName}</b><br><span style="color:#555;font-size:11px;">${rd.name || ''}</span></div>` });
            m.addListener('click', () => { if (pa_activeInfoWindow) pa_activeInfoWindow.close(); iw.open(pa_map, m); pa_activeInfoWindow = iw; });
            pa_markers.push(m);
            bounds.extend(pos);
            hasPoints = true;
        }
    }

    // 3. Blue circles: plaza locations
    for (const [plazaName, pos] of Object.entries(pa_plazaMapping)) {
        if (!pos || !pos.lat || !pos.lng) continue;
        const p = { lat: parseFloat(pos.lat), lng: parseFloat(pos.lng) };
        const m = new google.maps.Marker({
            position: p, map: pa_map, title: plazaName,
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 6, fillColor: '#3B82F6', fillOpacity: 0.9, strokeColor: '#1E40AF', strokeWeight: 1.5 },
            zIndex: 20
        });
        const iw = new google.maps.InfoWindow({ content: `<div style="color:#000;min-width:130px;"><b>Survey: ${plazaName}</b><br><span style="font-size:11px;color:#2563eb;">Survey Location</span></div>` });
        m.addListener('click', () => { if (pa_activeInfoWindow) pa_activeInfoWindow.close(); iw.open(pa_map, m); pa_activeInfoWindow = iw; });
        pa_markers.push(m);
        bounds.extend(p);
        hasPoints = true;
    }

    if (hasPoints && !bounds.isEmpty()) {
        pa_map.fitBounds(bounds);
        const listener = google.maps.event.addListener(pa_map, 'idle', () => {
            if (pa_map.getZoom() > 12) pa_map.setZoom(12);
            google.maps.event.removeListener(listener);
        });
    }
}

function paClearMap() {
    if (!pa_map) return;
    pa_markers.forEach(m => m.setMap(null)); pa_markers = [];
    pa_lines.forEach(l => { if (l.line) l.line.setMap(null); }); pa_lines = [];
    if (pa_map.data) pa_map.data.forEach(f => pa_map.data.remove(f));
    if (pa_activeInfoWindow) { pa_activeInfoWindow.close(); pa_activeInfoWindow = null; }
    if (pa_map.tempMarker) { pa_map.tempMarker.setMap(null); pa_map.tempMarker = null; }
    if (pa_zoneBoundaryLayer) { pa_zoneBoundaryLayer.setMap(null); pa_zoneBoundaryLayer = null; }
    // Re-apply GeoJSON overlay if data is loaded
    if (pa_geoJsonData && pa_map) paApplyGeoJsonOverlay();
}

// ── Render Current Place (Place Assign suggestion flow) ───────────────────────

async function paRenderCurrentPlace() {
    if (!pa_unmatchedPlaces || pa_unmatchedPlaces.length === 0) return;

    const place = pa_unmatchedPlaces[pa_currentIndex];
    const nameEl = document.getElementById('pa-selected-place-name');
    if (nameEl) nameEl.textContent = place.original_name;

    const zoneDisplay = document.getElementById('pa-place-zone-display');
    if (zoneDisplay) zoneDisplay.textContent = place.assigned_zone || '--';

    paClearMap();

    // Show zone boundary
    if (place.assigned_zone) {
        try {
            const params = new URLSearchParams({ name: place.original_name });
            if (pa_selectedStates.length > 0) params.append('state', pa_selectedStates.join(','));
            params.append('zone_restriction', place.assigned_zone);

            const plazaNames = place.analytics?.plazas?.headers || [];
            const realCoords = [], realMeta = [];
            plazaNames.forEach(pName => {
                const coord = pa_plazaMapping[pName];
                if (coord && coord.lat && coord.lng) { realCoords.push({ lat: coord.lat, lng: coord.lng }); realMeta.push(pName); }
            });
            if (realCoords.length > 0) {
                params.append('plaza_coords', JSON.stringify(realCoords));
                params.append('plaza_names', JSON.stringify(realMeta));
            }

            if (!place.suggestions || place.suggestions.length === 0) {
                const resp = await fetch(`/api/suggestions?${params.toString()}`);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.error) {
                        console.error('PA suggestion error:', data.error);
                    } else {
                        place.suggestions = data.suggestions || [];
                        place.zoneGeometry = data.zoneGeometry || null;
                    }
                }
            }
        } catch (e) { console.error('PA: suggestion fetch failed', e); }
    }

    paRenderMapElements(place);
}

function paRenderMapElements(place) {
    if (!pa_map) return;

    const bounds = new google.maps.LatLngBounds();
    let hasPoints = false;
    const strictBounds = new google.maps.LatLngBounds();
    let hasStrictPoints = false;

    // Zone boundary
    if (place.zoneGeometry) {
        pa_map.data.addGeoJson({ type: 'Feature', geometry: place.zoneGeometry });
        pa_map.data.setStyle({ fillColor: '#4285F4', fillOpacity: 0.05, strokeColor: '#4285F4', strokeWeight: 2, clickable: false });
        const tmp = new google.maps.Data();
        tmp.addGeoJson({ type: 'Feature', geometry: place.zoneGeometry });
        tmp.forEach(f => f.getGeometry().forEachLatLng(ll => { strictBounds.extend(ll); hasStrictPoints = true; }));
    }

    // Plaza markers (blue stars)
    const plazas = place.analytics?.plazas;
    if (plazas && plazas.headers) {
        plazas.headers.forEach((pName, i) => {
            const coord = pa_plazaMapping[pName] || (plazas.coords && plazas.coords[i] ? { lat: parseFloat(plazas.coords[i].lat), lng: parseFloat(plazas.coords[i].lng) } : null);
            if (!coord || !coord.lat || !coord.lng) return;
            const pos = { lat: parseFloat(coord.lat), lng: parseFloat(coord.lng) };
            const m = new google.maps.Marker({
                position: pos, map: pa_map, title: pName,
                icon: { url: 'http://maps.google.com/mapfiles/ms/icons/blue-dot.png', scaledSize: new google.maps.Size(28, 28) },
                zIndex: 20
            });
            pa_markers.push(m);
            bounds.extend(pos); hasPoints = true;
            strictBounds.extend(pos); hasStrictPoints = true;
        });
    }

    // Suggestion markers + polylines
    if (place.suggestions) {
        const plazaHeaders = plazas?.headers || [];
        place.suggestions.forEach(s => {
            if (!s.lat || !s.lng) return;
            const pos = { lat: s.lat, lng: s.lng };

            const m = new google.maps.Marker({
                position: pos, map: pa_map, title: s.name,
                icon: { url: 'http://maps.google.com/mapfiles/ms/icons/red-dot.png', scaledSize: new google.maps.Size(25, 25) },
                label: { text: s.name, color: '#B91C1C', className: 'suggestion-marker-label', fontSize: '12px', fontWeight: '600' },
                zIndex: 10
            });

            m.addListener('click', () => {
                if (pa_activeInfoWindow) pa_activeInfoWindow.close();
                const resolvedFor = pa_resolvedPlaces[place.original_name] || {};
                const content = document.createElement('div');
                content.style.cssText = 'color:black;min-width:220px;font-family:sans-serif;padding:5px;';
                content.innerHTML = `
                    <div style="font-weight:bold;font-size:14px;margin-bottom:4px;border-bottom:1px solid #eee;padding-bottom:5px;">${s.name}</div>
                    ${s.formatted_address ? `<div style="font-size:11px;color:#555;margin-bottom:8px;">📌 ${s.formatted_address}</div>` : ''}
                    ${s.zone ? `<div style="font-size:12px;margin-bottom:10px;">🗺️ Zone: <strong>${s.zone}</strong></div>` : ''}
                    <div style="margin-bottom:12px;">
                        <label style="font-size:11px;font-weight:600;color:#666;display:block;margin-bottom:5px;">RESOLVE FOR:</label>
                        <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;margin-bottom:6px;">
                            <input type="checkbox" id="pa-resolve-all-check" checked> Apply to ALL Plazas
                        </label>
                        <div id="pa-plaza-selection-list" style="display:none;margin-left:20px;max-height:100px;overflow-y:auto;border:1px solid #eee;border-radius:4px;padding:4px;">
                            ${plazaHeaders.map(p => `
                                <label style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:3px;${resolvedFor[p] ? 'color:#999;text-decoration:line-through;' : ''}">
                                    <input type="checkbox" class="pa-plaza-resolve-item" value="${p}" ${resolvedFor[p] ? 'disabled' : 'checked'}> ${p}
                                </label>
                            `).join('')}
                        </div>
                    </div>
                `;
                const btn = document.createElement('button');
                btn.textContent = 'Confirm & Resolve';
                btn.style.cssText = 'background:#16a34a;color:white;border:none;padding:8px 10px;border-radius:4px;cursor:pointer;width:100%;font-size:12px;font-weight:600;';
                btn.addEventListener('click', () => {
                    const resolveAll = content.querySelector('#pa-resolve-all-check').checked;
                    let selectedPlazas = null;
                    if (!resolveAll) {
                        selectedPlazas = Array.from(content.querySelectorAll('.pa-plaza-resolve-item:checked')).map(i => i.value);
                        if (selectedPlazas.length === 0) { alert("Select at least one plaza."); return; }
                    }
                    if (pa_activeInfoWindow) pa_activeInfoWindow.close();
                    paSelectSuggestion(place.id, s, selectedPlazas);
                    paTriggerAutoSave();
                });
                const allCheck = content.querySelector('#pa-resolve-all-check');
                const subList = content.querySelector('#pa-plaza-selection-list');
                allCheck.addEventListener('change', () => { subList.style.display = allCheck.checked ? 'none' : 'block'; });
                content.appendChild(btn);
                const iw = new google.maps.InfoWindow({ content });
                iw.open(pa_map, m);
                pa_activeInfoWindow = iw;
            });

            pa_markers.push(m);
            bounds.extend(pos); hasPoints = true;

            // Draw polylines from plazas to suggestion
            if (plazas && plazas.headers) {
                plazas.headers.forEach((pName, i) => {
                    const coord = pa_plazaMapping[pName] || (plazas.coords && plazas.coords[i] ? { lat: parseFloat(plazas.coords[i].lat), lng: parseFloat(plazas.coords[i].lng) } : null);
                    if (!coord || !coord.lat) return;
                    const line = new google.maps.Polyline({
                        path: [{ lat: parseFloat(coord.lat), lng: parseFloat(coord.lng) }, pos],
                        geodesic: true, strokeColor: '#4285F4', strokeOpacity: 0.7, strokeWeight: 1.5, map: pa_map
                    });
                    pa_lines.push({ line });
                });
            }
        });
    }

    if (hasStrictPoints) {
        pa_map.fitBounds(strictBounds);
    } else if (hasPoints) {
        pa_map.fitBounds(bounds);
    }
    const listener = google.maps.event.addListener(pa_map, 'idle', () => {
        if (pa_map.getZoom() > 14) pa_map.setZoom(14);
        google.maps.event.removeListener(listener);
    });
}

// ── Selection Logic ───────────────────────────────────────────────────────────

async function paSelectSuggestion(rowId, suggestion, selectedPlazas = null) {
    const place = pa_unmatchedPlaces[pa_currentIndex];

    const resolveData = {
        name: suggestion.name,
        lat: suggestion.lat,
        lng: suggestion.lng,
        zone: suggestion.zone || place.assigned_zone || 'Unknown',
        resolved_by: pa_currentUser,
        rawPlaceInfo: place
    };

    // Add to DB
    if (suggestion.name && suggestion.name.trim()) {
        fetch('/api/database/add_place', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: suggestion.name.trim() })
        }).catch(() => {});
    }

    if (!pa_resolvedPlaces[place.original_name]) pa_resolvedPlaces[place.original_name] = {};

    if (!selectedPlazas) {
        pa_resolvedPlaces[place.original_name]['__all__'] = resolveData;
    } else {
        selectedPlazas.forEach(p => { pa_resolvedPlaces[place.original_name][p] = resolveData; });
    }

    // Check fully resolved
    const plazaHeaders = place.analytics?.plazas?.headers || [];
    const mapping = pa_resolvedPlaces[place.original_name];
    const isFullyResolved = mapping['__all__'] || plazaHeaders.every(p => mapping[p]);

    if (isFullyResolved) {
        pa_unmatchedPlaces.splice(pa_currentIndex, 1);
        const gi = pa_allPlaces.findIndex(p => p.id === place.id);
        if (gi !== -1) pa_allPlaces.splice(gi, 1);
        if (pa_currentIndex >= pa_unmatchedPlaces.length) {
            pa_currentIndex = Math.max(0, pa_unmatchedPlaces.length - 1);
        }
    }

    paUpdateProgress();
    paRenderNavigator();
    if (pa_unmatchedPlaces.length > 0) {
        await paRenderCurrentPlace();
    } else {
        paClearMap();
        await paRenderInitialMap();
        const nameEl = document.getElementById('pa-selected-place-name');
        if (nameEl) nameEl.textContent = 'All places resolved!';
    }
    paTriggerAutoSave();
}

// ── Navigation ────────────────────────────────────────────────────────────────

function paNavigatePlace(direction) {
    const newIdx = pa_currentIndex + direction;
    if (newIdx >= 0 && newIdx < pa_unmatchedPlaces.length) {
        pa_currentIndex = newIdx;
        paRenderNavigator();
        paRenderCurrentPlace();
    }
}

function paRenderNavigator() {
    const el = document.getElementById('pa-selected-place-name');
    const countEl = document.getElementById('pa-pending-count');
    if (el && pa_unmatchedPlaces.length > 0) {
        el.textContent = pa_unmatchedPlaces[pa_currentIndex]?.original_name || '--';
    } else if (el) {
        el.textContent = 'No pending places';
    }
    if (countEl) countEl.textContent = `Pending: ${pa_unmatchedPlaces.length}`;
}

function paUpdateProgress() {
    const total = (pa_allPlaces.length + Object.keys(pa_resolvedPlaces).length) || 1;
    const resolved = Object.keys(pa_resolvedPlaces).length;
    const pct = Math.round((resolved / total) * 100);
    const el = document.getElementById('pa-completion-progress');
    if (el) el.textContent = `${pct}%`;
}

// ── User Management ───────────────────────────────────────────────────────────

function paRenderUserDropdown() {
    const dropdown = document.getElementById('pa-user-dropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';
    const allItem = document.createElement('div');
    allItem.className = 'user-dropdown-item' + (pa_currentUser === 'All Users' ? ' active' : '');
    allItem.textContent = 'All Users';
    allItem.onclick = () => paSelectUser('All Users');
    dropdown.appendChild(allItem);
    pa_allUsers.forEach(name => {
        const item = document.createElement('div');
        item.className = 'user-dropdown-item' + (pa_currentUser === name ? ' active' : '');
        item.textContent = name;
        item.onclick = () => paSelectUser(name);
        dropdown.appendChild(item);
    });
    const display = document.getElementById('pa-current-user-display');
    if (display) display.textContent = pa_currentUser;
}

function paToggleUserDropdown() {
    document.getElementById('pa-user-dropdown')?.classList.toggle('show');
}

function paSelectUser(user) {
    pa_currentUser = user;
    const display = document.getElementById('pa-current-user-display');
    if (display) display.textContent = user;
    document.getElementById('pa-user-dropdown')?.classList.remove('show');
    paRenderUserDropdown();
}

// ── Zone Lookup ───────────────────────────────────────────────────────────────

async function paFetchZone(lat, lng) {
    try {
        const resp = await fetch(`/api/zone?lat=${lat}&lng=${lng}`);
        if (!resp.ok) return null;
        return await resp.json();
    } catch { return null; }
}

// ── Plaza Marker ──────────────────────────────────────────────────────────────

function paAddPlazaMarker(plazaName, pos) {
    if (!pa_map) return;
    if (pa_plazaVerificationMarkers[plazaName]) pa_plazaVerificationMarkers[plazaName].setMap(null);
    const m = new google.maps.Marker({
        position: pos, map: pa_map, title: `Survey: ${plazaName}`,
        icon: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png',
        animation: google.maps.Animation.DROP
    });
    pa_plazaVerificationMarkers[plazaName] = m;
}

// ── GeoJSON Overlay ───────────────────────────────────────────────────────────

function paHandleGeoJsonUpload(input) {
    const file = input.files ? input.files[0] : null;
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            pa_geoJsonData = JSON.parse(e.target.result);
            pa_geoJsonBlob = file;
            // Update dialog label if visible
            const dialogLabel = document.getElementById('pa-geojson-btn-label');
            if (dialogLabel) dialogLabel.textContent = `✓ ${file.name}`;
            // Update toolbar button
            const toolbarBtn = document.getElementById('pa-geojson-toolbar-btn');
            if (toolbarBtn) {
                toolbarBtn.style.borderColor = '#4ade80';
                toolbarBtn.style.color = '#4ade80';
                toolbarBtn.childNodes[0].textContent = `✓ ${file.name.length > 12 ? file.name.substring(0, 12) + '…' : file.name}`;
            }
            if (pa_mapInitialized && pa_map) paApplyGeoJsonOverlay();
        } catch (err) {
            alert('Invalid GeoJSON file: ' + err.message);
        }
    };
    reader.readAsText(file);
}

function paApplyGeoJsonOverlay() {
    if (!pa_map || !pa_geoJsonData) return;
    
    // Clear any existing GeoJSON features
    pa_map.data.forEach(f => pa_map.data.remove(f));
    
    // Add new GeoJSON
    pa_map.data.addGeoJson(pa_geoJsonData);
    
    // Assign an internal ID to features if they don't have one
    pa_map.data.forEach(feature => {
        if (!feature.getProperty('__odin_id')) {
            const possibleId = paExtractRawZoneNumber(feature);
            feature.setProperty('__odin_id', possibleId ? possibleId : 'z_' + Math.random().toString(36).substr(2, 9));
        }
    });

    // Handle clicks for component assignment
    google.maps.event.clearListeners(pa_map.data, 'click');
    pa_map.data.addListener('click', (event) => {
        if (pa_activeComponentId !== null) {
            const fid = event.feature.getProperty('__odin_id');
            const activeComp = pa_components.find(c => c.id === pa_activeComponentId);
            
            // If zone is already assigned to the ACTIVE component, deselect/remove it
            if (activeComp && activeComp.assigned_zones.includes(fid)) {
                activeComp.assigned_zones = activeComp.assigned_zones.filter(z => z !== fid);
                pa_selectedZones.delete(fid);
                paRenderComponentsList();
            } else if (pa_selectedZones.has(fid)) {
                // Deselect pending (red -> blue)
                pa_selectedZones.delete(fid);
            } else {
                pa_selectedZones.add(fid);
            }
            paUpdateMapStyles();
        }
    });
    
    paUpdateMapStyles();
}

// ── Export ────────────────────────────────────────────────────────────────────

async function paDownloadProgress() {
    if (Object.keys(pa_resolvedPlaces).length === 0) {
        alert('No places resolved yet.'); return;
    }

    paShowLoadingOverlay('Generating Place Assign Export...');

    const formData = new FormData();
    formData.append('mapping', JSON.stringify(pa_resolvedPlaces));
    formData.append('plaza_mapping', JSON.stringify(pa_plazaMapping));
    if (pa_projectOdBlob) formData.append('excel_file', pa_projectOdBlob, 'ODIN_Dataset.xlsx');
    if (pa_projectShpBlob) formData.append('shapefile_zip', pa_projectShpBlob);
    if (pa_geoJsonBlob) formData.append('geojson_file', pa_geoJsonBlob, 'zones.geojson');

    // Add project configuration
    formData.append('project_config', JSON.stringify({ 
        mode: pa_currentMode,
        users: pa_allUsers,
        components: pa_components
    }));
    formData.append('components', JSON.stringify(pa_components));
    try {
        const resp = await fetch('/api/export/pa_progress', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(await resp.text());
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ODIN_PlaceAssign_Export.zip';
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        paHideLoadingOverlay();
        setTimeout(() => alert('Place Assign export downloaded!'), 50);
    } catch (err) {
        paHideLoadingOverlay();
        alert('Export failed: ' + err.message);
    }
}

// ── Auto-Save ─────────────────────────────────────────────────────────────────

function paTriggerAutoSave() {
    if (!pa_autoSaveHandle) return;
    if (pa_autoSaveTimer) clearTimeout(pa_autoSaveTimer);
    pa_autoSaveTimer = setTimeout(async () => {
        try { await paPerformAutoSave(); } catch (e) { console.error('PA auto-save failed:', e); }
    }, 1000);
}

async function paPerformAutoSave() {
    if (!pa_autoSaveHandle || typeof JSZip === 'undefined') return;
    const zip = new JSZip();
    zip.file('resolutions.json', JSON.stringify(pa_resolvedPlaces));
    zip.file('plaza_mapping.json', JSON.stringify(pa_plazaMapping));
    zip.file('project_config.json', JSON.stringify({ mode: 'Place assign', users: pa_allUsers, components: pa_components }));
    if (pa_projectOdBlob) zip.file('od_dataset.xlsx', pa_projectOdBlob);
    if (pa_projectShpBlob) zip.file('shapefile.zip', pa_projectShpBlob);
    const blob = await zip.generateAsync({ type: 'blob' });
    const writable = await pa_autoSaveHandle.createWritable();
    await writable.write(blob); await writable.close();
    console.log('PA: auto-saved.');
}

// ── Loading Overlay ───────────────────────────────────────────────────────────

function paShowLoadingOverlay(text) {
    const overlay = document.getElementById('pa-loading-overlay');
    const textEl = document.getElementById('pa-loading-text');
    if (textEl) textEl.textContent = text || 'Loading...';
    if (overlay) overlay.classList.add('active');
}

function paHideLoadingOverlay() {
    document.getElementById('pa-loading-overlay')?.classList.remove('active');
}

// ── Manual Text Search ────────────────────────────────────────────────────────

async function paManualTextSearch() {
    const input = document.getElementById('pa-manual-search-input');
    if (!input) return;
    const query = input.value.trim();
    if (!query) return;

    if (!pa_unmatchedPlaces || pa_unmatchedPlaces.length === 0) {
        alert('No pending places to resolve.'); return;
    }

    const place = pa_unmatchedPlaces[pa_currentIndex];
    paShowLoadingOverlay('Searching...');

    try {
        const params = new URLSearchParams({ name: query });
        if (place.assigned_zone) params.append('zone_restriction', place.assigned_zone);
        const plazaNames = place.analytics?.plazas?.headers || [];
        const realCoords = [], realMeta = [];
        plazaNames.forEach(pName => {
            const coord = pa_plazaMapping[pName];
            if (coord && coord.lat && coord.lng) { realCoords.push({ lat: coord.lat, lng: coord.lng }); realMeta.push(pName); }
        });
        if (realCoords.length > 0) {
            params.append('plaza_coords', JSON.stringify(realCoords));
            params.append('plaza_names', JSON.stringify(realMeta));
        }

        const resp = await fetch(`/api/suggestions?${params.toString()}`);
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();

        paHideLoadingOverlay();

        if (data.suggestions && data.suggestions.length > 0) {
            const s = data.suggestions[0];
            paShowManualPinConfirm(place, s.lat, s.lng, s.zone || place.assigned_zone || 'Unknown', s.name);
            if (pa_map) pa_map.panTo({ lat: s.lat, lng: s.lng });
        } else {
            alert(`No results found for "${query}". Try clicking on the map directly.`);
        }
    } catch (e) {
        paHideLoadingOverlay();
        alert('Search failed: ' + e.message);
    }
}

// ── Toggle Review Dropdown (resolved places) ──────────────────────────────────

function paToggleReviewDropdown() {
    const dropdown = document.getElementById('pa-review-dropdown');
    if (!dropdown) return;
    if (dropdown.classList.contains('show')) {
        dropdown.classList.remove('show'); return;
    }
    dropdown.innerHTML = '';
    const resolvedKeys = Object.keys(pa_resolvedPlaces).reverse();
    if (resolvedKeys.length === 0) {
        dropdown.innerHTML = '<div style="padding:1rem;color:#94a3b8;font-size:0.8rem;">No places resolved yet.</div>';
    } else {
        resolvedKeys.forEach(origName => {
            const mapping = pa_resolvedPlaces[origName];
            const item = document.createElement('div');
            item.className = 'review-dropdown-item';
            const entry = mapping['__all__'] || Object.values(mapping)[0];
            item.innerHTML = `<b style="font-size:0.7rem;">${origName}</b><div style="font-size:9px;color:#777;">&rarr; ${entry?.name || ''} <span style="color:#3b82f6;">(Zone ${entry?.zone || '?'})</span></div>`;
            dropdown.appendChild(item);
        });
    }
    dropdown.classList.add('show');
}

// ── UI View Modes (Zones / Components) ───────────────────────────────────────

function paSetViewMode(mode) {
    const btnZones = document.getElementById('pa-toggle-zones');
    const btnComps = document.getElementById('pa-toggle-components');
    const sidebar = document.getElementById('pa-components-sidebar');
    
    if (mode === 'zones') {
        btnZones.classList.add('active');
        btnZones.style.background = 'var(--accent)';
        btnZones.style.color = 'white';
        btnComps.classList.remove('active');
        btnComps.style.background = 'transparent';
        btnComps.style.color = 'var(--text-muted)';
        
        sidebar.style.display = 'none';
        
        // Restore markers
        if (pa_markers) {
            pa_markers.forEach(m => m.setMap(pa_map));
        }
    } else if (mode === 'components') {
        btnComps.classList.add('active');
        btnComps.style.background = 'var(--accent)';
        btnComps.style.color = 'white';
        btnZones.classList.remove('active');
        btnZones.style.background = 'transparent';
        btnZones.style.color = 'var(--text-muted)';
        // Show Dialog or Proceed
        if (pa_components && pa_components.length > 0) {
            paProceedToComponents();
        } else {
            document.getElementById('pa-components-dialog').style.display = 'flex';
        }
    }
}

function paProceedToComponents() {
    document.getElementById('pa-components-dialog').style.display = 'none';
    const sidebar = document.getElementById('pa-components-sidebar');
    sidebar.style.display = 'flex';
    
    // Hide markers but keep zones
    if (pa_markers) {
        pa_markers.forEach(m => m.setMap(null));
    }
}

function paRenderComponentsList() {
    const list = document.getElementById('pa-components-list');
    list.innerHTML = '';
    
    pa_components.forEach(comp => {
        const item = document.createElement('div');
        // Single horizontal row: [ID] - [Name] - [✏️] - [Assign]
        item.style.padding = '0.5rem 0.75rem';
        item.style.border = pa_activeComponentId === comp.id
            ? '1px solid var(--accent)'
            : '1px solid var(--border)';
        item.style.borderRadius = '8px';
        item.style.marginBottom = '0.5rem';
        item.style.background = pa_activeComponentId === comp.id ? 'rgba(59,130,246,0.15)' : 'var(--bg-dark)';
        item.style.cursor = 'pointer';
        item.style.display = 'flex';
        item.style.flexDirection = 'row';
        item.style.alignItems = 'center';
        item.style.gap = '0.5rem';
        item.onclick = () => paSelectComponent(comp.id);
        
        // ID badge
        const idBadge = document.createElement('span');
        idBadge.textContent = comp.id;
        idBadge.style.cssText = 'min-width:22px;height:22px;background:var(--accent);color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:bold;flex-shrink:0;';
        
        // Name
        const nameEl = document.createElement('span');
        nameEl.textContent = comp.name;
        nameEl.style.cssText = 'flex:1;color:white;font-size:0.8rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        
        // Zone count
        const countEl = document.createElement('span');
        countEl.textContent = `${comp.assigned_zones.length}z`;
        countEl.style.cssText = 'font-size:0.7rem;color:var(--text-muted);flex-shrink:0;';
        
        // Edit button
        const editBtn = document.createElement('button');
        editBtn.innerHTML = '✏️';
        editBtn.title = 'Edit name';
        editBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;font-size:0.8rem;padding:2px;flex-shrink:0;';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            const newName = prompt('Enter new component name:', comp.name);
            if (newName && newName.trim()) {
                comp.name = newName.trim();
                paRenderComponentsList();
                paUpdateMapStyles();
            }
        };
        
        // Assign button
        const assignBtn = document.createElement('button');
        assignBtn.textContent = 'Assign';
        assignBtn.className = 'btn btn-sm btn-primary';
        assignBtn.style.cssText = 'padding:2px 8px;font-size:0.7rem;flex-shrink:0;';
        assignBtn.onclick = (e) => {
            e.stopPropagation();
            paAssignZones(comp.id);
        };
        
        item.appendChild(idBadge);
        item.appendChild(nameEl);
        item.appendChild(countEl);
        item.appendChild(editBtn);
        item.appendChild(assignBtn);
        list.appendChild(item);
    });
}

const pa_compColors = ['#f44336', '#9c27b0', '#3f51b5', '#009688', '#ff9800', '#795548', '#607d8b', '#e91e63', '#673ab7', '#2196f3', '#00bcd4', '#4caf50', '#ff5722'];

function paAddComponent() {
    const newId = pa_components.length > 0 ? Math.max(...pa_components.map(c => c.id)) + 1 : 1;
    const newColor = pa_compColors[(newId - 1) % pa_compColors.length];
    pa_components.push({
        id: newId,
        name: `Component ${newId}`,
        color: newColor,
        assigned_zones: []
    });
    paRenderComponentsList();
}

function paSelectComponent(id) {
    pa_activeComponentId = id;
    pa_selectedZones.clear();
    paRenderComponentsList();
    paUpdateMapStyles();
}

function paAssignZones(id) {
    const comp = pa_components.find(c => c.id === id);
    if (!comp) return;
    
    // Assign currently selected zones to this component
    pa_selectedZones.forEach(zoneId => {
        // Remove from any other component first
        pa_components.forEach(c => {
            c.assigned_zones = c.assigned_zones.filter(z => z !== zoneId);
        });
        // Add to this component
        if (!comp.assigned_zones.includes(zoneId)) {
            comp.assigned_zones.push(zoneId);
        }
    });
    
    pa_selectedZones.clear();
    paRenderComponentsList();
    paUpdateMapStyles();
}

/**
 * Extract raw zone number from a GeoJSON feature's properties (returns null if not found).
 */
function paExtractRawZoneNumber(feature) {
    const keys = ['Zone_num','zone_num','ZONE_NUM','ZoneNum','zonenum','ZONENUM',
                  'zone_no','ZONE_NO','ZoneNo','zoneno','ZONENO','zone_numb','ZONE_NUMB',
                  'zonenumb','ZONENUMB','ZONE_NUMBER','zone_number','ZONE','zone','id','ID'];
    for (const k of keys) {
        const v = feature.getProperty(k);
        if (v !== null && v !== undefined && v !== '') return String(v);
    }
    return null;
}

/**
 * Extract zone number from a GeoJSON feature's properties.
 * Looks for common field name variations.
 */
function paGetZoneNumber(feature) {
    const raw = paExtractRawZoneNumber(feature);
    if (raw !== null) return raw;
    return feature.getProperty('__odin_id') || '';
}

/**
 * Extract zone name from a GeoJSON feature's properties.
 * Looks for common field name variations.
 */
function paGetZoneName(feature) {
    const keys = ['dtname','DTNAME','DtName','dt_name','DT_NAME','name','NAME','Name',
                  'zone_name','ZONE_NAME','ZoneName','zonename','ZONENAME','district','DISTRICT'];
    for (const k of keys) {
        const v = feature.getProperty(k);
        if (v !== null && v !== undefined && v !== '') return String(v);
    }
    return '';
}

function paUpdateMapStyles() {
    if (!pa_map || !pa_map.data) return;
    
    // Clear old labels
    pa_componentLabels.forEach(m => m.setMap(null));
    pa_componentLabels = [];
    
    pa_map.data.setStyle((feature) => {
        const fid = feature.getProperty('__odin_id');
        let style = {
            fillColor: '#4a90d9',
            fillOpacity: 0.12,
            strokeColor: '#4a90d9',
            strokeWeight: 1.5,
            strokeOpacity: 0.7,
            clickable: pa_activeComponentId !== null
        };
        
        // Check if assigned to any component
        const assignedComp = pa_components.find(c => c.assigned_zones.includes(fid));
        
        if (assignedComp) {
            const compColor = assignedComp.color || '#22c55e';
            style.fillColor = compColor;
            style.fillOpacity = 0.3;
            style.strokeColor = compColor;
            style.strokeWeight = 2;
            style.strokeOpacity = 1.0;
        }
        
        // Red overrides green if currently selected (pending assign)
        if (pa_selectedZones.has(fid)) {
            style.fillColor = '#ef4444';
            style.fillOpacity = 0.3;
            style.strokeColor = '#ef4444';
            style.strokeWeight = 2;
            style.strokeOpacity = 1.0;
        }
        
        return style;
    });
    
    // Add labels AFTER setStyle (otherwise Google Maps batches and may not update)
    // We iterate features to render labels for assigned zones
    pa_map.data.forEach(feature => {
        const fid = feature.getProperty('__odin_id');
        const assignedComp = pa_components.find(c => c.assigned_zones.includes(fid));
        const zoneName = paGetZoneName(feature);
        const geometry = feature.getGeometry();
        if (!geometry) return;
        
        const bounds = new google.maps.LatLngBounds();
        if (geometry.getType() === 'Polygon') {
            geometry.getArray()[0].forEachLatLng(latlng => bounds.extend(latlng));
        } else if (geometry.getType() === 'MultiPolygon') {
            geometry.getArray()[0].getArray()[0].forEachLatLng(latlng => bounds.extend(latlng));
        }
        const center = bounds.getCenter();
        if (!center) return;
        
        if (assignedComp) {
            // Assigned label: component number + zone name
            const labelText = zoneName ? `[${assignedComp.id}] ${zoneName}` : `[${assignedComp.id}]`;
            const compColor = assignedComp.color || '#22c55e';
            const labelMarker = new google.maps.Marker({
                position: center,
                map: pa_map,
                label: {
                    text: labelText,
                    color: compColor,
                    fontSize: '11px',
                    fontWeight: 'bold'
                },
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 0  // invisible icon, label only
                },
                clickable: false,
                zIndex: 10
            });
            pa_componentLabels.push(labelMarker);
        } else if (zoneName) {
            // Default label: just the zone name (shown in components mode)
            const labelMarker = new google.maps.Marker({
                position: center,
                map: pa_map,
                label: {
                    text: zoneName,
                    color: '#1e40af',
                    fontSize: '9px',
                    fontWeight: '500'
                },
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 0
                },
                clickable: false,
                zIndex: 5
            });
            pa_componentLabels.push(labelMarker);
        }
    });
}
