/**
 * create_zones.js  v3.3
 *
 * Step 1 - State Level  : Map-driven state selection, Merge / Unmerge / Split (push to district level)
 * Step 2 - District Level: Focus-state isolation, district merge/unmerge/push-to-custom
 * Step 3 - Custom Split  : Focus-district isolation, polyline pen tool cut, undo/redo & sub-zone naming
 * Table View             : 50/50 split with live map, row-highlighting on map, full editing, Excel + GeoJSON export
 * Components Mode        : Dynamic injection of all created zones into Components assignment mode
 */

'use strict';

// ── Module State ──────────────────────────────────────────────────────────────

window.czState = {
    statesGeoJson:         null,
    districtsGeoJson:      null,
    statesLayer:           null,
    districtsLayer:        null,
    customLayer:           null,
    step:                  'state',   // 'state' | 'district' | 'custom'

    // Step 1: State Level
    stateZones:            [],        // { id, name, color, mergedWith: [], type: 'state'|'state-merged', component_num, component_name }
    selectedStateNames:    new Set(),
    statesForDistricts:    new Set(),
    stateUndoStack:        [],
    stateRedoStack:        [],

    // Step 2: District Level
    focusedState:          null,      // currently focused state in district step
    districtZones:         [],        // { id, name, color, districts: [], stname, type: 'districts', component_num, component_name }
    autoDistrictZones:     {},        // dtname -> { id, name, color, districts: [dtname], stname, type: 'districts', component_num, component_name }
    selectedDistrictNames: new Set(),
    districtsForCustom:    new Set(),
    districtUndoStack:     [],
    districtRedoStack:     [],
    _districtIndex:        {},        // dtname -> stname
    _stateDistrictsMap:    {},        // stname -> Set of dtname

    // Step 3: Custom Split
    focusedDistrict:       null,      // currently focused district in custom step
    customZones:           [],        // { id, name, color, geometry, district, stname, type: 'custom', component_num, component_name }
    activeCustomDistrict:  null,
    splitUndoStack:        [],
    splitRedoStack:        [],
    drawingManager:        null,
    _activePolyOverlay:    null,

    // Pen tool (multi-point polyline scissors)
    scissorsActive:        false,
    scissorPoints:         [],
    scissorMarkers:        [],
    scissorPolyline:       null,
    _scissorMapClickListener: null,
    _scissorMapDblClickListener: null,
    _scissorMouseMoveListener: null,
    selectedCustomZoneIds: new Set(),
    cutSnapVertices:       [],
    cutVertexMarkers:      [],
    snapIndicatorMarker:   null,

    // Table view & sorting
    tableLayoutMode:       '50',      // '50' | 'full' | 'collapse'
    sortCol:               'id',      // 'id' | 'name' | 'district_region' | 'stname' | 'component_name'
    sortDir:               'asc',     // 'asc' | 'desc'
    nextId:                1,
};

const CZ_COLORS = [
    '#2563eb', '#22c55e', '#0284c7', '#0d9488', '#f59e0b',
    '#3b82f6', '#10b981', '#06b6d4', '#14b8a6', '#84cc16',
    '#38bdf8', '#16a34a', '#0ea5e9', '#059669', '#f97316'
];
let _czColorIdx = 0;
function czColor() {
    return CZ_COLORS[(_czColorIdx++) % CZ_COLORS.length];
}

// ── Activate / Deactivate ─────────────────────────────────────────────────────

function czActivate() {
    const sb = document.getElementById('cz-sidebar');
    if (sb) sb.style.display = 'flex';
    czCloseTable();
    czGoToStep('state');
    czLoadStatesOverlay();
}

function czDeactivate() {
    const sb = document.getElementById('cz-sidebar');
    if (sb) sb.style.display = 'none';
    const tp = document.getElementById('cz-table-panel');
    if (tp) tp.style.display = 'none';
    const expBtn = document.getElementById('cz-table-expand-btn');
    if (expBtn) expBtn.style.display = 'none';

    czCancelScissors();
    if (czState.statesLayer)          czState.statesLayer.setMap(null);
    if (czState.districtsLayer)       czState.districtsLayer.setMap(null);
    if (czState.customLayer)          czState.customLayer.setMap(null);
    if (_czMergeOutlineLayer)         _czMergeOutlineLayer.setMap(null);
    if (_czDistrictMergeOutlineLayer) _czDistrictMergeOutlineLayer.setMap(null);
    if (czState.cutVertexMarkers) {
        czState.cutVertexMarkers.forEach(m => m.setMap(null));
        czState.cutVertexMarkers = [];
    }
    if (czState.snapIndicatorMarker) {
        czState.snapIndicatorMarker.setMap(null);
    }
}

// ── Step Navigation ───────────────────────────────────────────────────────────

function czGoToStep(step) {
    czState.step = step;
    ['state', 'district', 'custom'].forEach(s => {
        const p = document.getElementById('cz-panel-' + s);
        if (p) p.style.display = (s === step) ? 'flex' : 'none';
        const b = document.getElementById('cz-bc-' + s);
        if (b) b.classList.toggle('cz-bc-active', s === step);
    });
    if (step === 'state') {
        czRenderPushedStatesList();
    } else if (step === 'district') {
        czRenderStep2Dropdown();
        czRenderPushedDistrictsList();
    } else if (step === 'custom') {
        czRenderStep3Dropdown();
        czRenderStep3Results();
    }
    czRefreshMapLayers();
    czRefreshColors();
}
function czRefreshMapLayers() {
    const map = window.pa_map;
    if (!map) return;
    const s = czState;

    if (!s.customLayer) {
        s.customLayer = new google.maps.Data();
        s.customLayer.addListener('click', e => {
            if (czState.scissorsActive) {
                if (typeof _czOnScissorClick === 'function') _czOnScissorClick(e.latLng);
                return;
            }
            const zid = e.feature.getProperty('zone_id');
            if (zid) {
                czToggleCustomZoneSelection(zid);
            }
        });
    }

    if (s.step !== 'custom') {
        if (czState.cutVertexMarkers) {
            czState.cutVertexMarkers.forEach(m => m.setMap(null));
            czState.cutVertexMarkers = [];
        }
        if (czState.snapIndicatorMarker) {
            czState.snapIndicatorMarker.setMap(null);
        }
    }

    if (s.step === 'state') {
        if (s.statesLayer)    s.statesLayer.setMap(map);
        if (s.districtsLayer) s.districtsLayer.setMap(null);
        if (s.customLayer)    s.customLayer.setMap(null);
    } else if (s.step === 'district') {
        // District step: if focusedState is set, hide statesLayer; districtsLayer is on map
        if (s.statesLayer)    s.statesLayer.setMap(s.focusedState ? null : map);
        if (s.districtsLayer) s.districtsLayer.setMap(map);
        if (s.customLayer)    s.customLayer.setMap(null);
    } else if (s.step === 'custom') {
        // Custom step: hide statesLayer, districtsLayer and customLayer are on map
        if (s.statesLayer)    s.statesLayer.setMap(null);
        if (s.districtsLayer) s.districtsLayer.setMap(map);
        if (s.customLayer)    s.customLayer.setMap(map);
    }
}

// ── Load State Overlay ────────────────────────────────────────────────────────

async function czLoadStatesOverlay() {
    const map = window.pa_map;
    if (!map) { setTimeout(czLoadStatesOverlay, 400); return; }
    if (czState.statesLayer) { czRefreshMapLayers(); czRefreshColors(); return; }

    try {
        const resp = await fetch('/api/states/geojson');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const geoJson = await resp.json();

        // Normalise properties (uppercase STNAME to stname)
        geoJson.features.forEach(f => {
            if (!f.properties) f.properties = {};
            if (!f.properties.stname && f.properties.STNAME) {
                f.properties.stname = String(f.properties.STNAME).trim();
            }
        });
        czState.statesGeoJson = geoJson;

        const layer = new google.maps.Data();
        layer.addGeoJson(geoJson, { idPropertyName: 'stname' });
        layer.setMap(map);
        czState.statesLayer = layer;

        // Auto-create initial one-zone-per-state
        geoJson.features.forEach(f => {
            const st = f.properties.stname;
            if (!st || czState.stateZones.find(z => z.name === st)) return;
            czState.stateZones.push({
                id: czState.nextId++,
                name: st,
                color: czColor(),
                mergedWith: [],
                type: 'state',
                stname: st,
                component_num: '',
                component_name: ''
            });
        });

        layer.addListener('click', e => {
            if (czState.step !== 'state') return;
            const st = e.feature.getProperty('stname');
            if (st) czToggleStateSelection(st);
        });

        // Fit India bounds on initial load
        const bounds = new google.maps.LatLngBounds();
        layer.forEach(f => f.getGeometry().forEachLatLng(ll => bounds.extend(ll)));
        map.fitBounds(bounds);

        czRefreshColors();
        czRenderStep1Info();
        czRenderZonesList();
    } catch (e) {
        console.error('CZ: State overlay failed', e);
        czToast('Failed to load state overlay.', 'error');
    }
}

// ── Load District Overlay ─────────────────────────────────────────────────────

let _czDistLoading = false;

async function czLoadDistrictsOverlay() {
    const map = window.pa_map;
    if (!map) { setTimeout(czLoadDistrictsOverlay, 400); return; }
    if (czState.districtsLayer || _czDistLoading) {
        czRefreshMapLayers(); czRefreshColors(); return;
    }
    _czDistLoading = true;

    try {
        czToast('Loading district boundaries…');
        const resp = await fetch('/api/districts/geojson');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const geoJson = await resp.json();
        czState.districtsGeoJson = geoJson;

        // Build indices
        czState._districtIndex = {};
        czState._stateDistrictsMap = {};
        geoJson.features.forEach(f => {
            const dt = f.properties.dtname;
            const st = f.properties.stname;
            if (dt && st) {
                czState._districtIndex[dt] = st;
                if (!czState._stateDistrictsMap[st]) czState._stateDistrictsMap[st] = new Set();
                czState._stateDistrictsMap[st].add(dt);
            }
        });

        const layer = new google.maps.Data();
        layer.addGeoJson(geoJson, { idPropertyName: 'dtname' });
        czState.districtsLayer = layer;

        layer.addListener('click', e => {
            if (czState.scissorsActive) {
                if (typeof _czOnScissorClick === 'function') _czOnScissorClick(e.latLng);
                return;
            }
            const dt = e.feature.getProperty('dtname');
            if (!dt) return;
            if (czState.step === 'district') {
                czToggleDistrictSelection(dt);
            } else if (czState.step === 'custom') {
                const sel = document.getElementById('cz-s3-district-select');
                if (sel) { sel.value = dt; czOnStep3DistrictSelect(dt); }
            }
        });

        czRefreshMapLayers();
        czRefreshColors();
        czToast('District map loaded.');
    } catch (e) {
        console.error('CZ: District overlay failed', e);
        czToast('Failed to load district overlay.', 'error');
    } finally {
        _czDistLoading = false;
    }
}

// ── Color Styling ─────────────────────────────────────────────────────────────

// Merged-state thick border overlay layer
let _czMergeOutlineLayer = null;
// Merged-district thick border overlay layer
let _czDistrictMergeOutlineLayer = null;

async function czUpdateMergeOutlines() {
    const s = czState;
    const map = window.pa_map;
    if (!map) return;

    // ── State merge outlines (Step 1 only) ──
    if (!_czMergeOutlineLayer) {
        _czMergeOutlineLayer = new google.maps.Data();
        _czMergeOutlineLayer.setStyle({
            fillOpacity: 0,
            strokeColor: '#38bdf8',
            strokeWeight: 4,
            strokeOpacity: 0.95,
            zIndex: 20,
            clickable: false,
        });
    }
    _czMergeOutlineLayer.forEach(f => _czMergeOutlineLayer.remove(f));

    if (s.step === 'state') {
        const mergedGroups = s.stateZones.filter(z => (z.mergedWith && z.mergedWith.length > 0) || (z.states && z.states.length > 1));
        if (mergedGroups.length) {
            await Promise.all(mergedGroups.map(async zone => {
                const statesList = czGetZoneConstituentStates(zone).filter(st => !s.statesForDistricts.has(st));
                if (!statesList.length) return;
                try {
                    const r = await fetch('/api/states/dissolve', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ states: statesList })
                    });
                    if (!r.ok) return;
                    const feat = await r.json();
                    _czMergeOutlineLayer.addGeoJson({ type: 'FeatureCollection', features: [feat] });
                } catch (e) {
                    console.warn('CZ: state merge outline fetch failed', e);
                }
            }));
            _czMergeOutlineLayer.setMap(map);
        } else {
            _czMergeOutlineLayer.setMap(null);
        }
    } else {
        _czMergeOutlineLayer.setMap(null);
    }

    // ── District merge outlines (Step 2 only) ──
    if (!_czDistrictMergeOutlineLayer) {
        _czDistrictMergeOutlineLayer = new google.maps.Data();
        _czDistrictMergeOutlineLayer.setStyle({
            fillOpacity: 0,
            strokeColor: '#38bdf8',
            strokeWeight: 4,
            strokeOpacity: 0.95,
            zIndex: 25,
            clickable: false,
        });
    }
    _czDistrictMergeOutlineLayer.forEach(f => _czDistrictMergeOutlineLayer.remove(f));

    if (s.step === 'district') {
        let mergedDistrictGroups = s.districtZones.filter(z => z.districts && z.districts.length > 1);
        if (s.focusedState) {
            mergedDistrictGroups = mergedDistrictGroups.filter(z => z.stname === s.focusedState);
        }
        if (mergedDistrictGroups.length) {
            await Promise.all(mergedDistrictGroups.map(async zone => {
                try {
                    const r = await fetch('/api/districts/dissolve-boundary', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ districts: zone.districts })
                    });
                    if (!r.ok) return;
                    const feat = await r.json();
                    _czDistrictMergeOutlineLayer.addGeoJson({ type: 'FeatureCollection', features: [feat] });
                } catch (e) {
                    console.warn('CZ: district merge outline fetch failed', e);
                }
            }));
            _czDistrictMergeOutlineLayer.setMap(map);
        } else {
            _czDistrictMergeOutlineLayer.setMap(null);
        }
    } else {
        _czDistrictMergeOutlineLayer.setMap(null);
    }
}

function czRefreshColors() {
    const s = czState;

    // 1. States Layer Styling
    if (s.statesLayer) {
        s.statesLayer.setStyle(feat => {
            const st = feat.getProperty('stname');

            // In Step 2 (district) or Step 3 (custom): hide statesLayer features completely
            if (s.step === 'district' || s.step === 'custom') {
                return { visible: false };
            }

            // Step 1: State level
            // If pushed to district level: hide state boundary
            if (s.statesForDistricts.has(st)) {
                return { visible: false };
            }
            // If selected: green highlight
            if (s.selectedStateNames.has(st)) {
                return {
                    fillColor: '#16a34a', fillOpacity: 0.45,
                    strokeColor: '#22c55e', strokeWeight: 2.5, strokeOpacity: 1, zIndex: 10,
                    clickable: !s.scissorsActive,
                };
            }
            // All other states: single uniform minimalist color
            return {
                fillColor: '#0f1f38', fillOpacity: 0.35,
                strokeColor: '#334155', strokeWeight: 1, strokeOpacity: 0.7,
                clickable: !s.scissorsActive,
            };
        });
    }

    // 2. Districts Layer Styling
    if (s.districtsLayer) {
        czEnsureAutoDistrictZones();

        s.districtsLayer.setStyle(feat => {
            const dt = feat.getProperty('dtname');
            const st = feat.getProperty('stname');

            // In Step 1: Hide all districts
            if (s.step === 'state') {
                return { visible: false };
            }

            // In Step 2 (district):
            if (s.step === 'district') {
                // If a state is selected in Focus State: ONLY that state's districts are visible!
                if (s.focusedState) {
                    if (st !== s.focusedState) {
                        return { visible: false };
                    }
                } else {
                    // No focus state: only show districts of pushed states
                    if (!s.statesForDistricts.has(st)) {
                        return { visible: false };
                    }
                }

                // If district was pushed to custom: hide district shell in district step
                if (s.districtsForCustom.has(dt)) {
                    return { visible: false };
                }

                // Selected in Step 2: green highlight
                if (s.selectedDistrictNames.has(dt)) {
                    return {
                        fillColor: '#16a34a', fillOpacity: 0.45,
                        strokeColor: '#22c55e', strokeWeight: 2.5, strokeOpacity: 1, zIndex: 10,
                        clickable: !s.scissorsActive,
                    };
                }

                // Explicitly merged district zone — teal accent
                const mergedZone = s.districtZones.find(z => z.districts && z.districts.includes(dt));
                if (mergedZone) {
                    return {
                        fillColor: '#0d9488', fillOpacity: 0.35,
                        strokeColor: '#5eead4', strokeWeight: 1.5, strokeOpacity: 0.9,
                        clickable: !s.scissorsActive,
                    };
                }

                // Auto individual district zone — neutral
                return {
                    fillColor: '#0f1f38', fillOpacity: 0.25,
                    strokeColor: '#334155', strokeWeight: 1, strokeOpacity: 0.65,
                    clickable: !s.scissorsActive,
                };
            }

            // In Step 3 (custom):
            if (s.step === 'custom') {
                // If a district is focused: ONLY that district is visible!
                if (s.focusedDistrict) {
                    if (dt !== s.focusedDistrict) {
                        return { visible: false };
                    }
                    // The focused district is ALWAYS VISIBLE as an outer boundary
                    const hasSubZones = s.customZones.some(cz => cz.district === dt && cz.geometry);
                    return {
                        fillColor: '#0f2744',
                        fillOpacity: hasSubZones ? 0.05 : 0.20,
                        strokeColor: '#38bdf8',
                        strokeWeight: 2.5,
                        strokeOpacity: 1,
                        zIndex: 5,
                        clickable: !s.scissorsActive,
                    };
                } else {
                    // No focused district: show all districts in districtsForCustom
                    if (!s.districtsForCustom.has(dt)) {
                        return { visible: false };
                    }
                    return {
                        fillColor: '#0f1f38', fillOpacity: 0.25,
                        strokeColor: '#334155', strokeWeight: 1, strokeOpacity: 0.65,
                        clickable: !s.scissorsActive,
                    };
                }
            }

            return { visible: false };
        });
    }

    // 3. Custom Layer Styling (sub-zones from scissors)
    if (s.customLayer) {
        s.customLayer.forEach(f => s.customLayer.remove(f));
        if (s.step === 'custom') {
            const zonesForLayer = s.focusedDistrict
                ? s.customZones.filter(cz => cz.district === s.focusedDistrict)
                : s.customZones;
            const validFeatures = zonesForLayer
                .filter(cz => cz.geometry)
                .map(cz => ({
                    type: 'Feature',
                    geometry: cz.geometry,
                    properties: { zone_id: cz.id, color: cz.color, name: cz.name }
                }));
            if (validFeatures.length) {
                s.customLayer.addGeoJson({
                    type: 'FeatureCollection',
                    features: validFeatures
                });
            }
            s.customLayer.setStyle(feat => {
                const zid = feat.getProperty('zone_id');
                const isSelected = s.selectedCustomZoneIds && s.selectedCustomZoneIds.has(zid);
                return {
                    fillColor: isSelected ? '#16a34a' : (feat.getProperty('color') || '#2563eb'),
                    fillOpacity: isSelected ? 0.45 : 0.30, // 30% opacity as requested!
                    strokeColor: isSelected ? '#4ade80' : '#ffffff',
                    strokeWeight: isSelected ? 4 : 3.5,
                    strokeOpacity: 1,
                    zIndex: isSelected ? 40 : 35,
                    clickable: !s.scissorsActive,
                };
            });
            czRenderCutVertices();
        }
    }

    // State & district merge outlines (async, fire-and-forget)
    czUpdateMergeOutlines();

    czRenderZonesList();
}

function czEnsureAutoDistrictZones() {
    const s = czState;
    s.statesForDistricts.forEach(st => {
        const dists = s._stateDistrictsMap[st];
        if (!dists) return;
        dists.forEach(dt => {
            const key = `${st}__${dt}`;
            // If merged in districtZones or pushed to custom: skip
            const isMerged = s.districtZones.some(z => z.districts && z.districts.includes(dt) && (!z.stname || z.stname === st));
            if (isMerged || s.districtsForCustom.has(dt)) {
                delete s.autoDistrictZones[key];
                delete s.autoDistrictZones[dt];
                return;
            }
            if (!s.autoDistrictZones[key] && !s.autoDistrictZones[dt]) {
                s.autoDistrictZones[key] = {
                    id: s.nextId++,
                    name: dt,
                    color: czColor(),
                    districts: [dt],
                    stname: st,
                    type: 'districts',
                    component_num: '',
                    component_name: ''
                };
            }
        });
    });
}

// ── Step 1: State Level ───────────────────────────────────────────────────────

function czToggleStateSelection(st) {
    if (czState.selectedStateNames.has(st)) {
        czState.selectedStateNames.delete(st);
    } else {
        czState.selectedStateNames.add(st);
    }
    czRefreshColors();
    czRenderStep1Info();
}

function czRenderStep1Info() {
    const el = document.getElementById('cz-s1-selection');
    if (!el) return;
    const sel = Array.from(czState.selectedStateNames);
    el.textContent = sel.length ? sel.join(', ') : 'No states selected';
    czRenderPushedStatesList();
}

function czRenderPushedStatesList() {
    const el = document.getElementById('cz-pushed-states-list');
    if (!el) return;
    const list = Array.from(czState.statesForDistricts).sort();
    if (!list.length) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = '<div style="font-size:0.68rem;color:#94a3b8;margin-top:6px;font-weight:600;">Bifurcated States:</div>' +
        list.map(st => `
            <div class="cz-pushed-item">
                <span title="${st}">${st}</span>
                <button class="cz-pushed-remove" onclick="czUnpushState('${st}')" title="Undo bifurcation for ${st}">✕</button>
            </div>
        `).join('');
}

function _czPushStateSnapshot() {
    const snap = JSON.stringify({
        stateZones: czState.stateZones,
        statesForDistricts: Array.from(czState.statesForDistricts)
    });
    czState.stateUndoStack.push(snap);
    czState.stateRedoStack = [];
}

function czUndoStateAction() {
    if (!czState.stateUndoStack || !czState.stateUndoStack.length) {
        czToast('Nothing to undo in State level.');
        return;
    }
    const currentSnap = JSON.stringify({
        stateZones: czState.stateZones,
        statesForDistricts: Array.from(czState.statesForDistricts)
    });
    czState.stateRedoStack.push(currentSnap);
    const snap = JSON.parse(czState.stateUndoStack.pop());
    czState.stateZones = snap.stateZones || [];
    czState.statesForDistricts = new Set(snap.statesForDistricts || []);
    czState.selectedStateNames.clear();
    czRefreshColors();
    czRenderStep1Info();
    czRenderZonesList();
    czRenderTable();
    czToast('State action undone.');
}

function czRedoStateAction() {
    if (!czState.stateRedoStack || !czState.stateRedoStack.length) {
        czToast('Nothing to redo in State level.');
        return;
    }
    const currentSnap = JSON.stringify({
        stateZones: czState.stateZones,
        statesForDistricts: Array.from(czState.statesForDistricts)
    });
    czState.stateUndoStack.push(currentSnap);
    const snap = JSON.parse(czState.stateRedoStack.pop());
    czState.stateZones = snap.stateZones || [];
    czState.statesForDistricts = new Set(snap.statesForDistricts || []);
    czState.selectedStateNames.clear();
    czRefreshColors();
    czRenderStep1Info();
    czRenderZonesList();
    czRenderTable();
    czToast('State action redone.');
}

function czUnpushState(st) {
    _czPushStateSnapshot();
    czState.statesForDistricts.delete(st);
    if (czState.focusedState === st) czState.focusedState = null;

    // Restore state in stateZones if not already present
    if (!czState.stateZones.some(z => z.name === st || (z.mergedWith && z.mergedWith.includes(st)))) {
        czState.stateZones.push({
            id: czState.nextId++,
            name: st,
            color: czColor(),
            mergedWith: [],
            type: 'state',
            stname: st,
            component_num: '',
            component_name: ''
        });
    }

    // Clean up district level zones for that state
    czState.districtZones = czState.districtZones.filter(z => z.stname !== st);
    Object.keys(czState.autoDistrictZones).forEach(k => {
        const z = czState.autoDistrictZones[k];
        if (z && (z.stname === st || czState._districtIndex[z.name] === st)) {
            delete czState.autoDistrictZones[k];
        }
    });

    // Clean up custom zones for that state
    czState.customZones = czState.customZones.filter(z => z.stname !== st);

    // Clean up districts pushed to custom
    const distsOfSt = czState._stateDistrictsMap[st] || new Set();
    distsOfSt.forEach(dt => czState.districtsForCustom.delete(dt));

    czRenderPushedStatesList();
    czRenderStep2Dropdown();
    czRefreshColors();
    czToast(`Reverted ${st} to state level.`);
}

function czGetZoneConstituentStates(zone) {
    if (!zone) return [];
    const set = new Set();
    const candidates = [
        ...(zone.states || []),
        zone.stname,
        zone.name,
        ...(zone.mergedWith || [])
    ];
    candidates.forEach(c => {
        if (!c) return;
        String(c).split(/\s*\+\s*/).forEach(part => {
            const s = part.trim();
            if (s) set.add(s);
        });
    });
    return Array.from(set);
}

function czMergeStates() {
    const sel = Array.from(czState.selectedStateNames);
    if (sel.length < 2) {
        czToast('Select 2 or more states to merge.', 'error');
        return;
    }
    _czPushStateSnapshot();

    const base = czState.stateZones.find(z => czGetZoneConstituentStates(z).includes(sel[0]));
    if (!base) return;

    const mergedStatesSet = new Set(czGetZoneConstituentStates(base));

    for (let i = 1; i < sel.length; i++) {
        const st = sel[i];
        const idx = czState.stateZones.findIndex(z => czGetZoneConstituentStates(z).includes(st));
        if (idx === -1 || czState.stateZones[idx] === base) continue;
        const removed = czState.stateZones.splice(idx, 1)[0];
        czGetZoneConstituentStates(removed).forEach(s => mergedStatesSet.add(s));
    }
    const allStates = Array.from(mergedStatesSet);
    base.type = 'state-merged';
    base.states = allStates;
    base.stname = allStates[0];
    base.mergedWith = allStates.slice(1);
    base.name = allStates.join(' + ');

    czState.selectedStateNames.clear();
    czRefreshColors();
    czRenderStep1Info();
    czToast('States merged into one zone.');
}

function czUnmergeStates() {
    const sel = Array.from(czState.selectedStateNames);
    if (!sel.length) {
        czToast('Select a merged state on the map first.', 'error');
        return;
    }
    _czPushStateSnapshot();
    let unmergedCount = 0;
    sel.forEach(st => {
        const idx = czState.stateZones.findIndex(z => czGetZoneConstituentStates(z).includes(st));
        if (idx === -1) return;
        const zone = czState.stateZones[idx];
        const allConstituents = czGetZoneConstituentStates(zone);
        if (allConstituents.length <= 1) return;
        czState.stateZones.splice(idx, 1);
        allConstituents.forEach(s => {
            czState.stateZones.push({
                id: czState.nextId++,
                name: s,
                color: czColor(),
                mergedWith: [],
                states: [s],
                type: 'state',
                stname: s,
                component_num: '',
                component_name: ''
            });
            unmergedCount++;
        });
    });
    czState.selectedStateNames.clear();
    czRefreshColors();
    czRenderStep1Info();
    czToast(unmergedCount ? 'States unmerged.' : 'Selected states are not merged.');
}

function czSplitStatesToDistricts() {
    const sel = Array.from(czState.selectedStateNames);
    if (!sel.length) {
        czToast('Select state(s) on map to split to district level.', 'error');
        return;
    }
    _czPushStateSnapshot();

    sel.forEach(st => {
        const idx = czState.stateZones.findIndex(z => z.name === st || (z.mergedWith && z.mergedWith.includes(st)));
        if (idx !== -1) {
            const zone = czState.stateZones[idx];
            const remaining = [zone.name, ...(zone.mergedWith || [])].filter(s => !sel.includes(s));
            if (remaining.length) {
                zone.name = remaining[0];
                zone.mergedWith = remaining.slice(1);
            } else {
                czState.stateZones.splice(idx, 1);
            }
        }
        czState.statesForDistricts.add(st);
    });

    czState.selectedStateNames.clear();
    czGoToStep('district');
    czRenderStep2Dropdown();
    czLoadDistrictsOverlay();
    czToast(`Dividing to district level: ${sel.join(', ')}`);
}

// ── Step 2: District Level ────────────────────────────────────────────────────

function czRenderStep2Dropdown() {
    const el = document.getElementById('cz-s2-state-select');
    if (!el) return;
    const states = Array.from(czState.statesForDistricts).sort();
    el.innerHTML = '<option value="">— focus on state —</option>' +
        states.map(s => `<option value="${s}">${s}</option>`).join('');
}

function czOnStep2StateSelect(st) {
    czState.focusedState = st || null;
    czState.selectedDistrictNames.clear();
    czRefreshColors();
    czRenderStep2Info();
    if (!st || !window.pa_map || !czState.districtsLayer) return;

    const bounds = new google.maps.LatLngBounds();
    let found = false;
    czState.districtsLayer.forEach(f => {
        if (f.getProperty('stname') === st) {
            f.getGeometry().forEachLatLng(ll => { bounds.extend(ll); found = true; });
        }
    });
    if (found) window.pa_map.fitBounds(bounds);
}

function czToggleDistrictSelection(dt) {
    const st = czState._districtIndex[dt];
    if (!st || !czState.statesForDistricts.has(st) || czState.districtsForCustom.has(dt)) return;
    if (czState.selectedDistrictNames.has(dt)) {
        czState.selectedDistrictNames.delete(dt);
    } else {
        czState.selectedDistrictNames.add(dt);
    }
    czRefreshColors();
    czRenderStep2Info();
}

function czRenderStep2Info() {
    const el = document.getElementById('cz-s2-selection');
    if (!el) return;
    const sel = Array.from(czState.selectedDistrictNames);
    el.textContent = sel.length ? sel.join(', ') : 'No districts selected';
    czRenderPushedDistrictsList();
}

function czRenderPushedDistrictsList() {
    const el = document.getElementById('cz-pushed-districts-list');
    if (!el) return;
    const list = Array.from(czState.districtsForCustom).sort();
    if (!list.length) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = '<div style="font-size:0.68rem;color:#94a3b8;margin-top:6px;font-weight:600;">Custom Bifurcated Districts:</div>' +
        list.map(dt => `
            <div class="cz-pushed-item">
                <span title="${dt}">${dt}</span>
                <button class="cz-pushed-remove" onclick="czUnpushDistrict('${dt}')" title="Undo custom division for ${dt}">✕</button>
            </div>
        `).join('');
}

function _czPushDistrictSnapshot() {
    const snap = JSON.stringify({
        districtZones: czState.districtZones,
        autoDistrictZones: czState.autoDistrictZones,
        districtsForCustom: Array.from(czState.districtsForCustom)
    });
    czState.districtUndoStack.push(snap);
    czState.districtRedoStack = [];
}

function czUndoDistrictAction() {
    if (!czState.districtUndoStack || !czState.districtUndoStack.length) {
        czToast('Nothing to undo in District level.');
        return;
    }
    const currentSnap = JSON.stringify({
        districtZones: czState.districtZones,
        autoDistrictZones: czState.autoDistrictZones,
        districtsForCustom: Array.from(czState.districtsForCustom)
    });
    czState.districtRedoStack.push(currentSnap);
    const snap = JSON.parse(czState.districtUndoStack.pop());
    czState.districtZones = snap.districtZones || [];
    czState.autoDistrictZones = snap.autoDistrictZones || {};
    czState.districtsForCustom = new Set(snap.districtsForCustom || []);
    czState.selectedDistrictNames.clear();
    czRefreshColors();
    czRenderStep2Info();
    czRenderZonesList();
    czRenderTable();
    czToast('District action undone.');
}

function czRedoDistrictAction() {
    if (!czState.districtRedoStack || !czState.districtRedoStack.length) {
        czToast('Nothing to redo in District level.');
        return;
    }
    const currentSnap = JSON.stringify({
        districtZones: czState.districtZones,
        autoDistrictZones: czState.autoDistrictZones,
        districtsForCustom: Array.from(czState.districtsForCustom)
    });
    czState.districtUndoStack.push(currentSnap);
    const snap = JSON.parse(czState.districtRedoStack.pop());
    czState.districtZones = snap.districtZones || [];
    czState.autoDistrictZones = snap.autoDistrictZones || {};
    czState.districtsForCustom = new Set(snap.districtsForCustom || []);
    czState.selectedDistrictNames.clear();
    czRefreshColors();
    czRenderStep2Info();
    czRenderZonesList();
    czRenderTable();
    czToast('District action redone.');
}

function czUnpushDistrict(dt) {
    _czPushDistrictSnapshot();
    czState.districtsForCustom.delete(dt);
    if (czState.focusedDistrict === dt) {
        czState.focusedDistrict = null;
        czState.activeCustomDistrict = null;
    }

    // Clean up any custom sub-zones for this district
    czState.customZones = czState.customZones.filter(z => z.district !== dt);

    // Re-ensure auto district zone
    czEnsureAutoDistrictZones();

    czRenderPushedDistrictsList();
    czRenderStep3Dropdown();
    czRefreshColors();
    czToast(`Reverted ${dt} to district level.`);
}

function czMergeDistricts() {
    const sel = Array.from(czState.selectedDistrictNames);
    if (sel.length < 2) {
        czToast('Select 2 or more districts to merge.', 'error');
        return;
    }
    _czPushDistrictSnapshot();
    const stname = czState._districtIndex[sel[0]] || '';

    // Remove any auto individual district zones for these
    Object.keys(czState.autoDistrictZones).forEach(k => {
        const z = czState.autoDistrictZones[k];
        if (z && sel.includes(z.name)) {
            delete czState.autoDistrictZones[k];
        }
    });

    const existingIdx = czState.districtZones.findIndex(z => z.districts && z.districts.some(d => sel.includes(d)));
    if (existingIdx !== -1) {
        sel.forEach(d => {
            if (!czState.districtZones[existingIdx].districts.includes(d)) {
                czState.districtZones[existingIdx].districts.push(d);
            }
        });
        czState.districtZones[existingIdx].name = czState.districtZones[existingIdx].districts.join(' + ');
    } else {
        czState.districtZones.push({
            id: czState.nextId++,
            name: sel.join(' + '),
            color: czColor(),
            districts: [...sel],
            stname,
            type: 'districts',
            component_num: '',
            component_name: ''
        });
    }

    czState.selectedDistrictNames.clear();
    czRefreshColors();
    czRenderStep2Info();
    czToast('Districts merged.');
}

function czUnmergeDistricts() {
    const sel = Array.from(czState.selectedDistrictNames);
    if (!sel.length) {
        czToast('Select districts on map to unmerge.', 'error');
        return;
    }
    _czPushDistrictSnapshot();
    sel.forEach(dt => {
        const idx = czState.districtZones.findIndex(z => z.districts && z.districts.includes(dt));
        if (idx === -1) return;
        czState.districtZones[idx].districts = czState.districtZones[idx].districts.filter(d => d !== dt);
        if (!czState.districtZones[idx].districts.length) {
            czState.districtZones.splice(idx, 1);
        } else {
            czState.districtZones[idx].name = czState.districtZones[idx].districts.join(' + ');
        }
    });

    czState.selectedDistrictNames.clear();
    czRefreshColors();
    czRenderStep2Info();
    czToast('Districts unmerged.');
}

function czSplitDistrictsToCustom() {
    const sel = Array.from(czState.selectedDistrictNames);
    if (!sel.length) {
        czToast('Select district(s) to push to custom scissor split.', 'error');
        return;
    }
    _czPushDistrictSnapshot();
    sel.forEach(dt => {
        czState.districtsForCustom.add(dt);
    });
    Object.keys(czState.autoDistrictZones).forEach(k => {
        const z = czState.autoDistrictZones[k];
        if (z && sel.includes(z.name)) {
            delete czState.autoDistrictZones[k];
        }
    });

    czState.selectedDistrictNames.clear();
    czRefreshColors();
    czRenderStep2Info();
    czGoToStep('custom');
    czRenderStep3Dropdown();
    if (sel.length) {
        const el = document.getElementById('cz-s3-district-select');
        if (el) { el.value = sel[0]; czOnStep3DistrictSelect(sel[0]); }
    }
    czToast(`Moved to custom split: ${sel.join(', ')}`);
}

// ── Step 3: Custom Scissor Split ──────────────────────────────────────────────

function czRenderStep3Dropdown() {
    const el = document.getElementById('cz-s3-district-select');
    if (!el) return;
    const dists = Array.from(czState.districtsForCustom).sort();
    el.innerHTML = '<option value="">— select district —</option>' +
        dists.map(d => `<option value="${d}">${d}</option>`).join('');
}

function czOnStep3DistrictSelect(dt) {
    czState.activeCustomDistrict = dt || null;
    czState.focusedDistrict = dt || null;
    if (!dt || !window.pa_map || !czState.districtsLayer) {
        czRefreshColors();
        czRenderStep3Results();
        return;
    }

    const bounds = new google.maps.LatLngBounds();
    let found = false;
    czState.districtsLayer.forEach(f => {
        if (f.getProperty('dtname') === dt) {
            f.getGeometry().forEachLatLng(ll => { bounds.extend(ll); found = true; });
        }
    });
    if (found) window.pa_map.fitBounds(bounds);
    czRefreshColors();
    czRenderStep3Results();
}

// ── Vertex Snapping & Display for Custom Cut Lines ───────────────────────────

function czExtractVertices(geom) {
    const pts = [];
    if (!geom) return pts;
    const addCoords = (arr) => {
        if (!arr || !arr.length) return;
        if (typeof arr[0] === 'number') {
            pts.push(new google.maps.LatLng(arr[1], arr[0]));
        } else {
            arr.forEach(addCoords);
        }
    };
    addCoords(geom.coordinates);
    return pts;
}

function czGetCutLineVertices(subZones) {
    if (!subZones || subZones.length < 2) {
        return [];
    }

    // Extract per-subzone unique vertex lists
    const subZoneVertexLists = subZones.map(z => {
        if (!z.geometry) return [];
        const raw = czExtractVertices(z.geometry);
        const uniq = [];
        raw.forEach(p => {
            if (!uniq.some(u => Math.hypot(u.lng() - p.lng(), u.lat() - p.lat()) < 0.0002)) {
                uniq.push(p);
            }
        });
        return uniq;
    });

    const cutVertices = [];

    // Any vertex that appears in 2 or more different subzones is on an internal cut line!
    for (let i = 0; i < subZoneVertexLists.length; i++) {
        for (const p of subZoneVertexLists[i]) {
            if (cutVertices.some(c => Math.hypot(c.lng() - p.lng(), c.lat() - p.lat()) < 0.0003)) {
                continue;
            }
            let shared = false;
            for (let j = 0; j < subZoneVertexLists.length; j++) {
                if (i === j) continue;
                if (subZoneVertexLists[j].some(o => Math.hypot(o.lng() - p.lng(), o.lat() - p.lat()) < 0.0003)) {
                    shared = true;
                    break;
                }
            }
            if (shared) {
                cutVertices.push(p);
            }
        }
    }

    return cutVertices;
}

function czRenderCutVertices() {
    if (czState.cutVertexMarkers) {
        czState.cutVertexMarkers.forEach(m => m.setMap(null));
    }
    czState.cutVertexMarkers = [];
    czState.cutSnapVertices = [];

    const dist = czState.focusedDistrict || czState.activeCustomDistrict;
    if (czState.step !== 'custom' || !dist) return;

    const myZones = czState.customZones.filter(z => z.district === dist && z.geometry);
    if (!myZones.length) return;

    const vertices = czGetCutLineVertices(myZones);
    czState.cutSnapVertices = vertices;

    const map = window.pa_map;
    if (!map) return;

    vertices.forEach(v => {
        const marker = new google.maps.Marker({
            position: v,
            map: map,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 5,
                fillColor: '#38bdf8',
                fillOpacity: 1,
                strokeColor: '#ffffff',
                strokeWeight: 2,
            },
            zIndex: 100,
            clickable: true,
            title: 'Cut Vertex (click to snap)'
        });
        marker.addListener('click', () => {
            if (czState.scissorsActive && typeof _czOnScissorClick === 'function') {
                _czOnScissorClick(v);
            }
        });
        czState.cutVertexMarkers.push(marker);
    });
}

function czFindSnapVertex(latLng, thresholdDeg = 0.008) {
    if (!latLng) return null;
    let best = null;
    let bestDist = thresholdDeg;

    // Check cut snap vertices
    if (czState.cutSnapVertices && czState.cutSnapVertices.length) {
        czState.cutSnapVertices.forEach(v => {
            const dx = v.lng() - latLng.lng();
            const dy = v.lat() - latLng.lat();
            const d = Math.hypot(dx, dy);
            if (d < bestDist) {
                bestDist = d;
                best = v;
            }
        });
    }

    // Also snap to first point if >= 2 points placed (for closing loop)
    if (czState.scissorPoints && czState.scissorPoints.length >= 2) {
        const p0 = czState.scissorPoints[0];
        const dx = p0.lng() - latLng.lng();
        const dy = p0.lat() - latLng.lat();
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
            bestDist = d;
            best = p0;
        }
    }

    return best;
}

function _czOnScissorClick(latLng) {
    if (!czState.scissorsActive || !latLng) return;
    const map = window.pa_map;
    if (!map) return;

    // Magnetic snap attraction to cut line vertices if in vicinity
    const snapV = czFindSnapVertex(latLng, 0.008);
    if (snapV) {
        latLng = snapV;
    }

    // If user clicked within ~0.008 deg of first point after 2+ points, auto-finish closed shape!
    if (czState.scissorPoints.length >= 2) {
        const p0 = czState.scissorPoints[0];
        const dx = p0.lng() - latLng.lng();
        const dy = p0.lat() - latLng.lat();
        if (Math.hypot(dx, dy) < 0.008) {
            czExecuteCut();
            return;
        }
    }

    czState.scissorPoints.push(latLng);
    if (czState.scissorPolyline) {
        czState.scissorPolyline.setPath(czState.scissorPoints);
    }
    if (czState.scissorPreviewLine) {
        czState.scissorPreviewLine.setPath([]);
    }

    // Place visible vertex dot on map
    const m = new google.maps.Marker({
        position: latLng,
        map: map,
        icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 4.5,
            fillColor: '#22c55e',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5,
        },
        clickable: false,
        zIndex: 10000,
    });
    czState.scissorMarkers.push(m);

    const ptCount = document.getElementById('cz-pt-count');
    if (ptCount) ptCount.textContent = czState.scissorPoints.length;

    const infoSpan = document.getElementById('cz-scissor-info');
    if (infoSpan) {
        const n = czState.scissorPoints.length;
        infoSpan.innerHTML = `Placed <strong>${n}</strong> point${n > 1 ? 's' : ''}. Double-click or click 'Cut District' to split.`;
    }
}

function czScissorUndoPoint() {
    if (!czState.scissorPoints.length) return;
    czState.scissorPoints.pop();
    if (czState.scissorPolyline) {
        czState.scissorPolyline.setPath(czState.scissorPoints);
    }
    if (czState.scissorPreviewLine) {
        czState.scissorPreviewLine.setPath([]);
    }
    const m = czState.scissorMarkers.pop();
    if (m) m.setMap(null);

    const ptCount = document.getElementById('cz-pt-count');
    if (ptCount) ptCount.textContent = czState.scissorPoints.length;

    const infoSpan = document.getElementById('cz-scissor-info');
    if (infoSpan) {
        const n = czState.scissorPoints.length;
        infoSpan.innerHTML = n ? `Placed <strong>${n}</strong> point${n > 1 ? 's' : ''}.` : 'Click points across district to draw cut line.';
    }
}

function czActivateScissors() {
    const dt = czState.focusedDistrict || czState.activeCustomDistrict;
    if (!dt) {
        czToast('Select a district from the dropdown first.', 'error');
        return;
    }
    czState.activeCustomDistrict = dt;
    czState.focusedDistrict = dt;
    const map = window.pa_map;
    if (!map) return;

    czCancelScissors(false);
    czState.scissorsActive = true;
    czRefreshColors();

    map.setOptions({ disableDoubleClickZoom: true, draggableCursor: 'crosshair' });

    czState.scissorPolyline = new google.maps.Polyline({
        path: [],
        strokeColor: '#22c55e',
        strokeWeight: 3.5,
        strokeOpacity: 0.95,
        zIndex: 9999,
        map: map,
        clickable: false,
    });
    czState.scissorPreviewLine = new google.maps.Polyline({
        path: [],
        strokeColor: '#4ade80',
        strokeWeight: 2.5,
        strokeOpacity: 0.85,
        map: map,
        clickable: false,
        zIndex: 9998,
    });
    czState.scissorPoints = [];
    czState.scissorMarkers = [];

    // Show top-left scissor toolbar with breathing green badge
    const toolbar = document.getElementById('cz-scissor-toolbar');
    if (toolbar) toolbar.style.display = 'flex';
    const ptCount = document.getElementById('cz-pt-count');
    if (ptCount) ptCount.textContent = '0';

    // Remove legacy banner if present
    const oldBanner = document.getElementById('cz-scissor-banner');
    if (oldBanner) oldBanner.style.display = 'none';

    czState._scissorMapClickListener = map.addListener('click', e => _czOnScissorClick(e.latLng));
    czState._scissorMapDblClickListener = map.addListener('dblclick', e => {
        if (e && e.stop) e.stop();
        czExecuteCut();
    });

    // Magnetic snapping mousemove listener + live preview polyline
    czState._scissorMouseMoveListener = map.addListener('mousemove', e => {
        if (!czState.scissorsActive || !e.latLng) return;
        const snapV = czFindSnapVertex(e.latLng, 0.008);
        const targetPt = snapV || e.latLng;

        if (snapV) {
            if (!czState.snapIndicatorMarker) {
                czState.snapIndicatorMarker = new google.maps.Marker({
                    position: snapV,
                    map: map,
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 9,
                        fillColor: '#22c55e',
                        fillOpacity: 0.45,
                        strokeColor: '#16a34a',
                        strokeWeight: 2.5,
                    },
                    zIndex: 11000,
                    clickable: false
                });
            } else {
                czState.snapIndicatorMarker.setPosition(snapV);
                czState.snapIndicatorMarker.setMap(map);
            }
        } else {
            if (czState.snapIndicatorMarker) {
                czState.snapIndicatorMarker.setMap(null);
            }
        }

        if (czState.scissorPreviewLine && czState.scissorPoints && czState.scissorPoints.length > 0) {
            const lastPt = czState.scissorPoints[czState.scissorPoints.length - 1];
            czState.scissorPreviewLine.setPath([lastPt, targetPt]);
        }
    });
}

async function czExecuteCut() {
    if (!czState.scissorsActive) return;
    const path = czState.scissorPoints.map(ll => [ll.lng(), ll.lat()]);
    if (path.length < 2) {
        czToast('Place at least 2 points across the district to cut.', 'error');
        return;
    }

    // Check if loop / closed shape
    let isClosed = false;
    if (path.length >= 3) {
        const dx = path[0][0] - path[path.length - 1][0];
        const dy = path[0][1] - path[path.length - 1][1];
        const dist = Math.hypot(dx, dy);
        if (dist < 0.008 || (path[0][0] === path[path.length - 1][0] && path[0][1] === path[path.length - 1][1])) {
            isClosed = true;
            if (path[0][0] !== path[path.length - 1][0] || path[0][1] !== path[path.length - 1][1]) {
                path.push(path[0]);
            }
        }
    }

    const clipGeom = isClosed
        ? { type: 'Polygon', coordinates: [path] }
        : { type: 'LineString', coordinates: path };

    // Pass existing sub-zones so sequential multi-cuts split the intersected sub-polygon
    const existingParts = czState.customZones
        .filter(z => z.district === czState.activeCustomDistrict && z.geometry)
        .map(z => ({
            geometry: z.geometry,
            sub_label: z.sub_label || z.name || ''
        }));

    try {
        czToast('Cutting district…');
        const r = await fetch('/api/districts/split', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                district: czState.activeCustomDistrict,
                clip_polygon: clipGeom,
                existing_parts: existingParts.length ? existingParts : undefined
            }),
        });
        if (!r.ok) {
            const errText = await r.text();
            throw new Error(errText);
        }
        const res = await r.json();
        czCancelScissors(false);
        czHandleSplitResult(res);
    } catch (e) {
        console.error('Cut failed:', e);
        czToast('Cut failed: ' + (e.message || 'Line must cross district boundary or close into a loop'), 'error');
    }
}

function czCancelScissors(resetActive) {
    if (resetActive === undefined) resetActive = true;
    czState.scissorsActive = false;
    const map = window.pa_map;
    if (map) {
        map.setOptions({ disableDoubleClickZoom: false, draggableCursor: null });
        if (czState._scissorMapClickListener) {
            google.maps.event.removeListener(czState._scissorMapClickListener);
            czState._scissorMapClickListener = null;
        }
        if (czState._scissorMapDblClickListener) {
            google.maps.event.removeListener(czState._scissorMapDblClickListener);
            czState._scissorMapDblClickListener = null;
        }
        if (czState._scissorMouseMoveListener) {
            google.maps.event.removeListener(czState._scissorMouseMoveListener);
            czState._scissorMouseMoveListener = null;
        }
    }
    if (czState.snapIndicatorMarker) {
        czState.snapIndicatorMarker.setMap(null);
    }
    if (czState.scissorPolyline) {
        czState.scissorPolyline.setMap(null);
        czState.scissorPolyline = null;
    }
    if (czState.scissorPreviewLine) {
        czState.scissorPreviewLine.setMap(null);
        czState.scissorPreviewLine = null;
    }
    if (czState.scissorMarkers) {
        czState.scissorMarkers.forEach(m => m.setMap(null));
        czState.scissorMarkers = [];
    }
    czState.scissorPoints = [];

    const toolbar = document.getElementById('cz-scissor-toolbar');
    if (toolbar) toolbar.style.display = 'none';

    const b = document.getElementById('cz-scissor-banner');
    if (b) b.style.display = 'none';

    if (resetActive) {
        czState.activeCustomDistrict = null;
        czState.focusedDistrict = null;
    }
    czRefreshColors();
}

function czRenderStep3Results() {
    const container = document.getElementById('cz-s3-results');
    if (!container) return;
    const dist = czState.focusedDistrict || czState.activeCustomDistrict;
    if (!dist) {
        container.innerHTML = '';
        return;
    }
    const myZones = czState.customZones.filter(z => z.district === dist);
    if (!myZones.length) {
        container.innerHTML = '';
        return;
    }
    const selCount = czState.selectedCustomZoneIds.size;
    container.innerHTML = `<div style="font-size:0.72rem;color:#38bdf8;margin-bottom:6px;font-weight:600;display:flex;justify-content:space-between;align-items:center;">` +
        `<span>Sub-zones (${myZones.length}):</span>` +
        `<span style="font-size:0.65rem;color:#94a3b8;">${selCount ? `${selCount} selected` : 'Select to merge'}</span>` +
        `</div>`;
    myZones.forEach(z => {
        const isSel = czState.selectedCustomZoneIds.has(z.id);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;' +
            (isSel ? 'background:rgba(22,163,74,0.18);border:1px solid #22c55e;' : 'background:#0f172a;border:1px solid #1e293b;') +
            'border-radius:7px;padding:5px 8px;margin-bottom:4px;cursor:pointer;transition:all 0.15s;';
        row.onclick = (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
            czToggleCustomZoneSelection(z.id);
        };
        row.innerHTML = `<input type="checkbox" ${isSel ? 'checked' : ''} style="cursor:pointer;" onclick="event.stopPropagation();czToggleCustomZoneSelection(${z.id})">` +
            `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${z.color};flex-shrink:0;"></span>` +
            `<input type="text" value="${z.name}" style="flex:1;padding:4px 6px;background:#080e1c;color:#e2e8f0;border:1px solid #334155;border-radius:5px;font-size:0.75rem;" ` +
            `onclick="event.stopPropagation()" onchange="czUpdateCustomZoneName(${z.id}, this.value)">` +
            `<button onclick="event.stopPropagation();czHighlightZone(${z.id})" title="Zoom" style="background:#1e293b;border:1px solid #334155;color:#38bdf8;border-radius:4px;padding:3px 6px;cursor:pointer;font-size:0.7rem;">🔍</button>`;
        container.appendChild(row);
    });
}

function czToggleCustomZoneSelection(zid) {
    if (czState.selectedCustomZoneIds.has(zid)) {
        czState.selectedCustomZoneIds.delete(zid);
    } else {
        czState.selectedCustomZoneIds.add(zid);
    }
    czRefreshColors();
    czRenderStep3Results();
}

async function czMergeCustomZones() {
    const selIds = Array.from(czState.selectedCustomZoneIds);
    if (selIds.length < 2) {
        czToast('Select 2 or more sub-zones to merge.', 'error');
        return;
    }
    const dist = czState.focusedDistrict || czState.activeCustomDistrict;
    const selected = czState.customZones.filter(z => selIds.includes(z.id));
    if (selected.length < 2) {
        czToast('Select 2 or more sub-zones to merge.', 'error');
        return;
    }

    try {
        czToast('Merging sub-zones…');
        const r = await fetch('/api/custom/merge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                geometries: selected.map(z => z.geometry)
            }),
        });
        if (!r.ok) throw new Error(await r.text());
        const res = await r.json();

        // Save undo snapshot
        czState.splitUndoStack.push(JSON.stringify(czState.customZones));
        czState.splitRedoStack = [];

        // Remove individual pieces
        czState.customZones = czState.customZones.filter(z => !selIds.includes(z.id));

        // Create unified merged sub-zone
        const stname = selected[0].stname;
        const mergedLabel = selected.map(z => z.sub_label || z.name.replace(`${dist} - `, '')).join(' + ');
        const mergedZone = {
            id: czState.nextId++,
            name: `${dist} - ${mergedLabel}`,
            sub_label: mergedLabel,
            color: czColor(),
            geometry: res.geometry,
            district: dist,
            stname: stname,
            type: 'custom',
            mergedPieces: selected,
            component_num: '',
            component_name: ''
        };
        czState.customZones.push(mergedZone);
        czState.selectedCustomZoneIds.clear();

        czRefreshColors();
        czRenderStep3Results();
        czRenderTable();
        czToast('Sub-zones merged successfully!');
    } catch (e) {
        console.error('Custom merge failed:', e);
        czToast('Merge failed: ' + e.message, 'error');
    }
}

function czUnmergeCustomZones() {
    const dist = czState.focusedDistrict || czState.activeCustomDistrict;
    const myZones = czState.customZones.filter(z => z.district === dist);
    const selIds = Array.from(czState.selectedCustomZoneIds);

    let candidates = myZones.filter(z => z.mergedPieces && z.mergedPieces.length);
    if (selIds.length) {
        candidates = candidates.filter(z => selIds.includes(z.id));
    }

    if (!candidates.length) {
        czToast('Select a merged sub-zone to unmerge.', 'error');
        return;
    }

    // Save undo snapshot
    czState.splitUndoStack.push(JSON.stringify(czState.customZones));
    czState.splitRedoStack = [];

    candidates.forEach(cand => {
        const idx = czState.customZones.findIndex(z => z.id === cand.id);
        if (idx !== -1) {
            czState.customZones.splice(idx, 1);
            cand.mergedPieces.forEach(piece => {
                czState.customZones.push({
                    ...piece,
                    id: czState.nextId++
                });
            });
        }
    });

    czState.selectedCustomZoneIds.clear();
    czRefreshColors();
    czRenderStep3Results();
    czRenderTable();
    czToast('Sub-zones unmerged.');
}

function czHandleSplitResult(fc) {
    const feats = (fc.features || []).filter(f => f.geometry);
    if (!feats.length) {
        czToast('No geometry returned from split.', 'error');
        return;
    }

    // Save undo snapshot
    czState.splitUndoStack.push(JSON.stringify(czState.customZones));
    czState.splitRedoStack = [];

    const dist = czState.activeCustomDistrict;
    const stname = czState._districtIndex[dist] || '';

    // Remove any previous custom pieces for this same district before adding new ones
    czState.customZones = czState.customZones.filter(z => z.district !== dist);

    // Add new sub-zones
    feats.forEach((feat, idx) => {
        const subLabel = feat.properties && feat.properties.sub_label ? feat.properties.sub_label : `Part ${idx + 1}`;
        const subName = `${dist} - ${subLabel}`;
        czState.customZones.push({
            id: czState.nextId++,
            name: subName,
            color: czColor(),
            geometry: feat.geometry,
            district: dist,
            stname: stname,
            type: 'custom',
            sub_label: subLabel,
            component_num: '',
            component_name: ''
        });
    });

    czRefreshColors();
    czRenderStep3Results();
    czRenderTable();
    czToast(`Split into ${feats.length} custom sub-zones!`);
}

function czUpdateCustomZoneName(id, val) {
    const z = czState.customZones.find(x => x.id === id);
    if (z && val.trim()) {
        z.name = val.trim();
        czRenderZonesList();
        czRenderTable();
    }
}

function czUndoSplit() {
    if (!czState.splitUndoStack.length) {
        czToast('Nothing to undo.');
        return;
    }
    czState.splitRedoStack.push(JSON.stringify(czState.customZones));
    czState.customZones = JSON.parse(czState.splitUndoStack.pop());
    czRefreshColors();
    czRenderStep3Results();
    czRenderTable();
    czToast('Undo completed.');
}

function czRedoSplit() {
    if (!czState.splitRedoStack.length) {
        czToast('Nothing to redo.');
        return;
    }
    czState.splitUndoStack.push(JSON.stringify(czState.customZones));
    czState.customZones = JSON.parse(czState.splitRedoStack.pop());
    czRefreshColors();
    czRenderStep3Results();
    czRenderTable();
    czToast('Redo completed.');
}

// ── All Zones Aggregator ──────────────────────────────────────────────────────

function czAllZones() {
    const pushed = czState.statesForDistricts;
    czEnsureAutoDistrictZones();

    // 1. States not subdivided
    const states = czState.stateZones.filter(z => {
        const constituents = czGetZoneConstituentStates(z);
        return constituents.every(s => !pushed.has(s));
    });

    // 2. Merged districts
    const mergedDistricts = czState.districtZones;

    // 3. Auto unmerged individual districts
    const autoDistricts = Object.values(czState.autoDistrictZones);

    // 4. Custom split sub-zones
    const custom = czState.customZones;

    return [...states, ...mergedDistricts, ...autoDistricts, ...custom];
}

// ── Zone List (Sidebar) ───────────────────────────────────────────────────────

function czRenderZonesList() {
    const inner = document.getElementById('cz-zones-list-inner');
    const countEl = document.getElementById('cz-zone-count');
    const tblCountEl = document.getElementById('cz-table-count');
    if (!inner) return;

    const all = czAllZones();
    if (countEl) countEl.textContent = all.length;
    if (tblCountEl) tblCountEl.textContent = `${all.length} zones`;

    if (!all.length) {
        inner.innerHTML = '<div style="color:#64748b;font-size:0.73rem;padding:4px;">No zones yet.</div>';
        return;
    }

    const badge = { state: 'ST', 'state-merged': 'ST+', districts: 'DT', custom: 'CU' };
    inner.innerHTML = all.map(z =>
        `<div class="cz-zone-item" onclick="czHighlightZone(${z.id})">` +
        `<span class="cz-zone-swatch" style="background:${z.color};"></span>` +
        `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${z.name}">` +
        `<strong>${z.id}</strong> · ${z.name}</span>` +
        `<span style="font-size:0.63rem;color:#475569;margin-right:4px;">${badge[z.type] || 'ZN'}</span>` +
        `<button class="cz-zone-del" onclick="event.stopPropagation();czDeleteZone(${z.id})" title="Delete">✕</button>` +
        `</div>`
    ).join('');
}

function czDeleteZone(id) {
    if (!confirm(`Delete zone #${id}?`)) return;

    // Remove from stateZones
    let idx = czState.stateZones.findIndex(z => z.id === id);
    if (idx !== -1) czState.stateZones.splice(idx, 1);

    // Remove from districtZones
    idx = czState.districtZones.findIndex(z => z.id === id);
    if (idx !== -1) czState.districtZones.splice(idx, 1);

    // Remove from autoDistrictZones
    Object.keys(czState.autoDistrictZones).forEach(k => {
        if (czState.autoDistrictZones[k].id === id) {
            delete czState.autoDistrictZones[k];
        }
    });

    // Remove from customZones
    idx = czState.customZones.findIndex(z => z.id === id);
    if (idx !== -1) czState.customZones.splice(idx, 1);

    czRefreshColors();
    czRenderTable();
}

// ── Highlight Zone on Map ─────────────────────────────────────────────────────

function czHighlightZone(id) {
    const zone = czAllZones().find(z => z.id === id);
    if (!zone || !window.pa_map) return;
    const bounds = new google.maps.LatLngBounds();
    let found = false;

    // 1. State zones
    if (zone.type === 'state' || zone.type === 'state-merged') {
        const names = [zone.name, ...(zone.mergedWith || [])];
        if (czState.statesLayer) {
            czState.statesLayer.forEach(f => {
                if (names.includes(f.getProperty('stname'))) {
                    f.getGeometry().forEachLatLng(ll => { bounds.extend(ll); found = true; });
                }
            });
        }
    } else if (zone.type === 'districts' || zone.districts) {
        // 2. District zones
        const dists = zone.districts || [zone.name];
        if (czState.districtsLayer) {
            czState.districtsLayer.forEach(f => {
                if (dists.includes(f.getProperty('dtname'))) {
                    f.getGeometry().forEachLatLng(ll => { bounds.extend(ll); found = true; });
                }
            });
        }
    } else if (zone.type === 'custom' || zone.geometry) {
        // 3. Custom zones
        if (czState.customLayer) {
            czState.customLayer.forEach(f => {
                if (f.getProperty('zone_id') === id) {
                    f.getGeometry().forEachLatLng(ll => { bounds.extend(ll); found = true; });
                }
            });
        }
    }

    if (found) {
        window.pa_map.fitBounds(bounds);
    }
}

// ── Table View (50% Split) ────────────────────────────────────────────────────

function czViewTable() {
    const sb = document.getElementById('cz-sidebar');
    const tp = document.getElementById('cz-table-panel');
    if (sb) sb.style.display = 'none';
    if (!tp) return;

    tp.classList.remove('cz-genie-out');
    tp.classList.add('cz-genie-in');
    czTableLayout(czState.tableLayoutMode || '50');
    czRenderTable();
    setTimeout(() => {
        tp.classList.remove('cz-genie-in');
    }, 300);
}

function czCloseTable() {
    const tp = document.getElementById('cz-table-panel');
    const sb = document.getElementById('cz-sidebar');
    const expBtn = document.getElementById('cz-table-expand-btn');
    const mp = document.getElementById('pa-map-pane');

    if (tp && tp.style.display !== 'none') {
        tp.classList.remove('cz-genie-in');
        tp.classList.add('cz-genie-out');
        setTimeout(() => {
            tp.style.display = 'none';
            tp.classList.remove('cz-genie-out');
            if (expBtn) expBtn.style.display = 'none';
            if (mp) { mp.style.display = 'block'; mp.style.flex = '1'; }
            if (sb) sb.style.display = 'flex';
            if (window.pa_map) {
                google.maps.event.trigger(window.pa_map, 'resize');
            }
        }, 200);
        return;
    }

    if (tp) tp.style.display = 'none';
    if (expBtn) expBtn.style.display = 'none';
    if (mp) { mp.style.display = 'block'; mp.style.flex = '1'; }
    if (sb) sb.style.display = 'flex';
    if (window.pa_map) {
        setTimeout(() => google.maps.event.trigger(window.pa_map, 'resize'), 100);
    }
}

function czTableLayout(mode) {
    czState.tableLayoutMode = mode;
    const tp = document.getElementById('cz-table-panel');
    const mp = document.getElementById('pa-map-pane');
    const expBtn = document.getElementById('cz-table-expand-btn');
    if (!tp || !mp) return;

    if (mode === 'collapse') {
        tp.classList.remove('cz-genie-in');
        tp.classList.add('cz-genie-out');
        setTimeout(() => {
            tp.style.display = 'none';
            tp.classList.remove('cz-genie-out');
            mp.style.flex = '1';
            mp.style.display = 'block';
            if (expBtn) expBtn.style.display = 'block';
            if (window.pa_map) {
                google.maps.event.trigger(window.pa_map, 'resize');
            }
        }, 200);
        return;
    }

    if (mode === 'full') {
        tp.style.display = 'flex';
        tp.style.flex = '1';
        tp.style.width = '100%';
        mp.style.display = 'none';
        if (expBtn) expBtn.style.display = 'none';
    } else {
        // '50'
        tp.style.display = 'flex';
        tp.style.flex = '0 0 50%';
        tp.style.width = '50%';
        mp.style.flex = '1';
        mp.style.display = 'block';
        if (expBtn) expBtn.style.display = 'none';
    }

    if (window.pa_map) {
        setTimeout(() => google.maps.event.trigger(window.pa_map, 'resize'), 100);
    }
}

function czSortTable(col) {
    if (czState.sortCol === col) {
        czState.sortDir = czState.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        czState.sortCol = col;
        czState.sortDir = 'asc';
    }
    czRenderTable();
}

function _czGetZoneSortVal(z, col) {
    if (col === 'id') return Number(z.id) || 0;
    if (col === 'name') return String(z.name || '').toLowerCase();
    if (col === 'district_region') {
        let reg = '';
        if (z.type === 'custom') reg = z.district || z.name;
        else if (z.districts && z.districts.length) reg = z.districts.join(', ');
        else if (z.mergedWith && z.mergedWith.length) reg = [z.name, ...z.mergedWith].join(', ');
        else reg = z.stname || z.name;
        return String(reg || '').toLowerCase();
    }
    if (col === 'stname') {
        const st = z.stname || (z.type === 'state' ? z.name : '');
        return String(st || '').toLowerCase();
    }
    if (col === 'component_name') {
        return String(z.component_name || '').toLowerCase();
    }
    return '';
}

function czRenderTable() {
    const tbody = document.getElementById('cz-zone-table-body');
    const tblCountEl = document.getElementById('cz-table-count');
    if (!tbody) return;

    const all = czAllZones();
    if (tblCountEl) tblCountEl.textContent = `${all.length} zones`;

    // Update sort arrows in header
    ['id', 'name', 'district_region', 'stname', 'component_name'].forEach(c => {
        const arrowEl = document.getElementById(`cz-sort-arrow-${c}`);
        const thEl = arrowEl ? arrowEl.parentElement : null;
        if (arrowEl) {
            if (czState.sortCol === c) {
                arrowEl.textContent = czState.sortDir === 'asc' ? '▲' : '▼';
                if (thEl) thEl.classList.add('active-sort');
            } else {
                arrowEl.textContent = '↕';
                if (thEl) thEl.classList.remove('active-sort');
            }
        }
    });

    all.sort((a, b) => {
        const valA = _czGetZoneSortVal(a, czState.sortCol);
        const valB = _czGetZoneSortVal(b, czState.sortCol);
        let cmp = 0;
        if (typeof valA === 'number' && typeof valB === 'number') {
            cmp = valA - valB;
        } else {
            cmp = String(valA).localeCompare(String(valB));
        }
        return czState.sortDir === 'asc' ? cmp : -cmp;
    });

    tbody.innerHTML = all.map(z => {
        // Region description:
        let reg = '';
        if (z.type === 'custom') {
            reg = z.district || z.name;
        } else if (z.districts && z.districts.length) {
            reg = z.districts.join(', ');
        } else if (z.mergedWith && z.mergedWith.length) {
            reg = [z.name, ...z.mergedWith].join(', ');
        } else {
            reg = z.stname || z.name;
        }

        const stVal = z.stname || (z.type === 'state' ? z.name : '');

        return `<tr onclick="czSelectTableRow(this, ${z.id})" id="cz-trow-${z.id}">` +
            `<td style="text-align:center;">` +
            `<input type="number" value="${z.id}" min="1" style="width:42px;padding:2px;text-align:center;font-weight:600;" onchange="czTableUpdateZone(${z.id},'id',this.value)">` +
            `</td>` +
            `<td><input type="text" value="${z.name}" onchange="czTableUpdateZone(${z.id},'name',this.value)"></td>` +
            `<td><input type="text" value="${reg}" onchange="czTableUpdateZone(${z.id},'district_region',this.value)"></td>` +
            `<td><input type="text" value="${stVal}" onchange="czTableUpdateZone(${z.id},'stname',this.value)"></td>` +
            `<td><input type="text" value="${z.component_name || ''}" placeholder="Component…" onchange="czTableUpdateZone(${z.id},'component_name',this.value)"></td>` +
            `<td style="text-align:center;"><button class="cz-zone-del" onclick="event.stopPropagation();czDeleteZone(${z.id});czRenderTable();">✕</button></td>` +
            `</tr>`;
    }).join('');
}

function czSelectTableRow(tr, id) {
    document.querySelectorAll('#cz-zone-table-body tr').forEach(r => r.classList.remove('cz-row-selected'));
    if (tr) tr.classList.add('cz-row-selected');
    czHighlightZone(id);
}

function czTableUpdateZone(id, field, value) {
    const all = czAllZones();
    const zone = all.find(z => z.id == id);
    if (zone) {
        if (field === 'id') zone.id = parseInt(value, 10) || zone.id;
        else zone[field] = value;
        czRenderZonesList();
    }
}

function czAddTableRow() {
    czState.stateZones.push({
        id: czState.nextId++,
        name: `Zone ${czState.nextId}`,
        color: czColor(),
        mergedWith: [],
        type: 'state',
        stname: '',
        component_num: '',
        component_name: ''
    });
    czRenderTable();
    czRenderZonesList();
}

// ── Export ────────────────────────────────────────────────────────────────────

async function czExportZones() {
    // Sync any components assigned from Place Assign
    czSyncComponentsFromPlaceAssign();

    const all = czAllZones();
    if (!all.length) {
        czToast('No zones to export.', 'error');
        return;
    }

    const payload = {
        zones: all.map(z => {
            let reg = z.district_region || '';
            if (!reg) {
                if (z.type === 'custom') reg = z.district || z.name;
                else if (z.districts && z.districts.length) reg = z.districts.join(', ');
                else if (z.mergedWith && z.mergedWith.length) reg = [z.name, ...z.mergedWith].join(', ');
                else reg = z.stname || z.name;
            }

            let statesList = [];
            if (z.type === 'state' || z.type === 'state-merged') {
                statesList = czGetZoneConstituentStates(z);
            } else {
                statesList = [z.stname || ''];
            }

            return {
                zone_num: z.id,
                zone_name: z.name,
                district_region: reg,
                districts: z.districts || (z.district ? [z.district] : []),
                states: statesList,
                stname: z.stname || (statesList.length ? statesList[0] : z.name),
                type: z.type === 'custom' ? 'split' : (z.type || 'districts'),
                geometry: z.geometry || null,
                component_num: z.component_num || '',
                component_name: z.component_name || '',
            };
        })
    };

    try {
        czToast('Generating export ZIP (GeoJSON + Excel)…');
        const r = await fetch('/api/districts/dissolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(await r.text());

        const blob = await r.blob();
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(blob),
            download: 'zones_export.zip'
        });
        a.click();
        URL.revokeObjectURL(a.href);
        czToast('Export downloaded successfully!');
    } catch (e) {
        console.error('CZ export failed', e);
        czToast('Export failed: ' + e.message, 'error');
    }
}

// ── Components Mode Integration ───────────────────────────────────────────────

function czInjectZonesForComponents() {
    czToast('Loading created zones into Components mode…');
    const all = czAllZones();
    if (!all.length) return;

    const features = [];

    all.forEach(z => {
        const props = {
            __odin_id: String(z.id),
            zone_num: String(z.id),
            zone_name: z.name,
            stname: z.stname || '',
            dtname: z.name,
            district_region: z.district_region || z.name,
            component_num: z.component_num || '',
            component_name: z.component_name || ''
        };

        // 1. Custom scissor zone
        if (z.type === 'custom' && z.geometry) {
            features.push({
                type: 'Feature',
                geometry: z.geometry,
                properties: props
            });
            return;
        }

        // 2. State zones
        if (z.type === 'state' || z.type === 'state-merged') {
            const names = czGetZoneConstituentStates(z);
            if (czState.statesGeoJson && czState.statesGeoJson.features) {
                czState.statesGeoJson.features.forEach(f => {
                    const st = f.properties && f.properties.stname;
                    if (names.includes(st) && f.geometry) {
                        features.push({
                            type: 'Feature',
                            geometry: f.geometry,
                            properties: { ...props, stname: st }
                        });
                    }
                });
            }
            return;
        }

        // 3. District zones
        const dists = z.districts || [z.name];
        if (czState.districtsGeoJson && czState.districtsGeoJson.features) {
            czState.districtsGeoJson.features.forEach(f => {
                const dt = f.properties && f.properties.dtname;
                if (dists.includes(dt) && f.geometry) {
                    features.push({
                        type: 'Feature',
                        geometry: f.geometry,
                        properties: { ...props, dtname: dt }
                    });
                }
            });
        }
    });

    if (features.length) {
        window.pa_geoJsonData = {
            type: 'FeatureCollection',
            features: features
        };
        if (window.pa_map && typeof paApplyGeoJsonOverlay === 'function') {
            paApplyGeoJsonOverlay();
        }
    }
}

function czSyncComponentsFromPlaceAssign() {
    if (!window.pa_components || !window.pa_components.length) return;
    const all = czAllZones();

    window.pa_components.forEach(comp => {
        const compNum = comp.id || comp.component_num || '';
        const compName = comp.name || '';
        const assigned = comp.assigned_zones || [];

        assigned.forEach(zid => {
            const z = all.find(x => String(x.id) === String(zid));
            if (z) {
                z.component_num = String(compNum);
                z.component_name = compName;
            }
        });
    });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function czToggleSection(bodyId) {
    const b = document.getElementById(bodyId);
    if (b) b.style.display = b.style.display === 'none' ? 'flex' : 'none';
}

let _czToastTmr = null;
function czToast(msg, type) {
    type = type || 'info';
    let el = document.getElementById('cz-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'cz-toast';
        el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;' +
            'background:#080e1c;border-radius:10px;padding:8px 22px;font-size:0.82rem;' +
            'font-family:Inter,sans-serif;color:#e2e8f0;border:1px solid #1e293b;' +
            'backdrop-filter:blur(8px);box-shadow:0 6px 24px rgba(0,0,0,0.6);pointer-events:none;transition:opacity 0.3s;';
        document.body.appendChild(el);
    }
    el.style.borderColor = type === 'error' ? 'rgba(239,68,68,0.5)' : '#2563eb';
    el.style.color = type === 'error' ? '#fca5a5' : '#e2e8f0';
    el.textContent = msg;
    el.style.opacity = '1';
    if (_czToastTmr) clearTimeout(_czToastTmr);
    _czToastTmr = setTimeout(function() { el.style.opacity = '0'; }, 3000);
}

// ── Info popover helper ───────────────────────────────────────────────────────

window.czToggleInfo = function(btn, text) {
    let pop = document.getElementById('cz-info-popover');
    const hidePop = () => {
        if (!pop || pop.style.display === 'none') return;
        pop.classList.remove('cz-popover-genie-in');
        pop.classList.add('cz-popover-genie-out');
        setTimeout(() => {
            pop.style.display = 'none';
            pop.classList.remove('cz-popover-genie-out');
        }, 150);
    };

    if (pop && pop.dataset.anchor === text && pop.style.display !== 'none') {
        hidePop();
        return;
    }
    if (!pop) {
        pop = document.createElement('div');
        pop.id = 'cz-info-popover';
        pop.className = 'cz-info-popover';
        document.body.appendChild(pop);
        document.addEventListener('click', e => {
            if (!e.target.closest('.cz-info-btn') && !e.target.closest('#cz-info-popover')) {
                hidePop();
            }
        });
    }
    pop.textContent = text;
    pop.dataset.anchor = text;
    pop.style.display = 'block';

    const rect = btn.getBoundingClientRect();
    const topPos = rect.bottom + 6;
    const leftPos = Math.max(10, Math.min(rect.left - 40, window.innerWidth - 240));
    pop.style.top = topPos + 'px';
    pop.style.left = leftPos + 'px';

    // Calculate genie transform-origin directly targeting the center of the ⓘ button
    const originX = Math.round(rect.left + rect.width / 2 - leftPos);
    pop.style.transformOrigin = `${originX}px -6px`;

    pop.classList.remove('cz-popover-genie-out');
    pop.classList.add('cz-popover-genie-in');
    setTimeout(() => {
        pop.classList.remove('cz-popover-genie-in');
    }, 240);
};
