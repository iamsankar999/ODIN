/**
* GeoValidate OD System Frontend Logic
* Layout: Analytics permanent on Left/Top, Pending places cycled through via Top nav.
*/

let allUnmatchedPlaces = []; // Holds all unmatched places regardless of user
let unmatchedPlaces = [];    // Holds currently filtered places for UI
let resolvedPlaces = {}; // Track user decisions
let currentIndex = 0;
let allUsers = [];
let plazaMapping = {}; // { "Plaza Name": { lat, lng } }
let pickingPlaza = null; // Currently being picked from map
let filesUploaded = { shp: false, od: false };
let currentUser = "All Users";
let selectedState = "All States"; // Global state filter
let currentMode = "Zone assign"; // New Mode state
let map; // Google Maps Instance
let markers = []; // Track active map markers
let lines = [];   // Track distance polylines
let activeInfoWindow = null; // Track the currently open info window
let plazaVerificationMarkers = {}; // Track green markers for map-picked survey locations

let currentSetupTab = 'new'; // 'new' or 'open'
let projectZipFile = null;
let projectShpBlob = null;
let projectOdBlob = null;
let autoSaveHandle = null;
let autoSaveTimer = null;

let COMMODITIES_ABSTRACT = [];
let COMMODITIES_DETAILED = [];
let commodityViewMode = 'abstract'; // 'abstract' or 'detailed'
let currentUploadedFile = null; // Stash the original file for multi-sheet export
let plazaMappingConfirmed = false; // Toggle for survey mapping view
let uniquePlazas = []; // List of all survey locations

let globalTotalOccurrences = 0;
let placeOccurrencesMap = {};
let selectedFilterPlaza = null;

const INDIAN_STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
    "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
    "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
    "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands",
    "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh",
    "Lakshadweep", "Puducherry"
];

// Removed MOCK_DATA

window.hasGoogleMapsKey = false;
window.googleMapsKey = "";
window.mapsKeyPromise = null;

document.addEventListener('DOMContentLoaded', () => {
    window.mapsKeyPromise = checkGoogleMapsKey();
    initUI();
    checkForUpdates();  // Silent update check on launch
});

// ═══════════════════════════════════════════════════════════════════════════════
//  API KEY SETUP & INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

async function checkGoogleMapsKey() {
    try {
        const resp = await fetch('/api/config/maps-key');
        if (resp.ok) {
            const data = await resp.json();
            if (data.has_key && data.key) {
                // Key exists: dynamically inject Google Maps script
                window.hasGoogleMapsKey = true;
                window.googleMapsKey = data.key;
                injectGoogleMapsScript(data.key);
            }
        }
    } catch (e) {
        console.error("Failed to check Maps API Key status:", e);
    }
}

async function handleLaunchClick() {
    if (window.mapsKeyPromise) {
        await window.mapsKeyPromise;
    }
    
    if (window.hasGoogleMapsKey) {
        switchView('view-mode-selection');
    } else {
        switchView('view-api-setup');
    }
}

function injectGoogleMapsScript(key) {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&callback=initMap&libraries=places&loading=async`;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
}

async function saveGoogleMapsKey() {
    const input = document.getElementById('api-key-input');
    const errorDiv = document.getElementById('api-save-error');
    const btn = document.getElementById('btn-save-api');
    const key = input.value.trim();
    
    if (!key) {
        errorDiv.textContent = "Please enter a valid API key.";
        errorDiv.style.display = 'block';
        return;
    }
    
    btn.disabled = true;
    btn.textContent = "Saving...";
    
    try {
        const resp = await fetch('/api/config/maps-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: key })
        });
        
        const data = await resp.json();
        if (resp.ok) {
            // Success! Switch to the next view
            window.hasGoogleMapsKey = true;
            window.googleMapsKey = key;
            injectGoogleMapsScript(key);
            switchView('view-mode-selection');
        } else {
            throw new Error(data.detail || data.message || "Failed to save key.");
        }
    } catch (e) {
        errorDiv.textContent = e.message;
        errorDiv.style.display = 'block';
        btn.disabled = false;
        btn.textContent = "Save & Launch ODIN";
    }
}


function initUI() {
    const shpInput = document.getElementById('shapefile-upload');
    const odInput = document.getElementById('file-upload');
    if (shpInput) shpInput.addEventListener('change', handleShapefileUpload);
    if (odInput) odInput.addEventListener('change', handleFileUpload);

    // Reset collapsed sub-menus when mouse leaves the parent
    const parents = ['mode-parent', 'setup-parent', 'files-parent', 'base-parent', 'ihmcl-parent'];
    parents.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('mouseleave', () => {
                const subId = id.replace('-parent', '-sub-dropdown');
                const sub = document.getElementById(subId);
                if (sub) sub.classList.remove('collapsed-sub');
            });
        }
    });

    // Explicitly initialize with an empty state
    updateNavigatorDisplay();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTO-UPDATE  — Check GitHub for new versions & self-update
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Silently calls the backend to compare local version against GitHub.
 * If an update is available, shows the notification banner on the intro screen.
 */
async function checkForUpdates() {
    // Don't nag if already dismissed this session
    if (sessionStorage.getItem('odin_update_dismissed')) return;

    try {
        const resp = await fetch('/api/version/check', { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) return;
        const data = await resp.json();

        if (data.update_available) {
            const banner   = document.getElementById('update-banner');
            const tagEl    = document.getElementById('update-version-tag');
            const notesEl  = document.getElementById('update-release-notes');

            if (tagEl) tagEl.textContent = `v${data.latest_version}`;
            if (notesEl) {
                const notes = (data.release_notes || '').split('\n')[0].slice(0, 100);
                notesEl.textContent = notes || '';
            }
            if (banner) banner.style.display = 'block';

            // Store info for triggerUpdate
            window._odinUpdateInfo = data;
        }
    } catch (_) {
        // Offline or timeout — silently skip
    }
}

/**
 * Called when the user clicks "Update Now".
 * Sends POST /api/version/update which downloads, stages, and restarts.
 */
async function triggerUpdate() {
    const btn = document.getElementById('btn-update-now');
    if (!btn) return;

    // Confirm
    if (!confirm('ODIN will download the latest version and restart automatically.\n\nAny unsaved work will be lost.\n\nContinue?')) return;

    // Visual feedback
    btn.disabled = true;
    btn.classList.add('updating');
    btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="spin-icon">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
        </svg>
        Downloading...
    `;

    // Add spin animation inline
    const style = document.createElement('style');
    style.textContent = `@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}.spin-icon{animation:spin 1s linear infinite}`;
    document.head.appendChild(style);

    try {
        const resp = await fetch('/api/version/update', { method: 'POST' });
        const data = await resp.json();

        if (resp.ok) {
            btn.innerHTML = '✓ Restarting ODIN...';
            // Server will shut down; the batch script will relaunch it
            // Show a message to the user
            setTimeout(() => {
                document.body.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                        height:100vh;background:#0f172a;color:#f8fafc;font-family:Inter,sans-serif;gap:1.5rem;">
                        <div style="width:48px;height:48px;border:3px solid #334155;border-top-color:#4ade80;
                            border-radius:50%;animation:spin 1s linear infinite;"></div>
                        <h2 style="margin:0;font-weight:600;">Updating to ${data.version || 'latest'}...</h2>
                        <p style="color:#94a3b8;margin:0;">ODIN will restart automatically. This page will reload.</p>
                        <style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style>
                    </div>
                `;
                // Auto-reload after a delay to reconnect to the restarted server
                let retries = 0;
                const poller = setInterval(async () => {
                    retries++;
                    try {
                        const r = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
                        if (r.ok) {
                            clearInterval(poller);
                            window.location.reload();
                        }
                    } catch (_) { /* server still restarting */ }
                    if (retries > 120) clearInterval(poller); // Give up after ~2 min
                }, 2000);
            }, 1500);
        } else {
            throw new Error(data.detail || 'Update failed');
        }
    } catch (err) {
        btn.disabled = false;
        btn.classList.remove('updating');
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Retry Update
        `;
        alert('Update failed: ' + err.message + '\n\nPlease check your internet connection and try again.');
    }
}

/**
 * Dismiss the update banner for this session.
 */
function dismissUpdateBanner() {
    const banner = document.getElementById('update-banner');
    if (banner) {
        banner.style.animation = 'none';
        banner.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        banner.style.opacity = '0';
        banner.style.transform = 'translateY(-100%)';
        setTimeout(() => { banner.style.display = 'none'; }, 350);
    }
    sessionStorage.setItem('odin_update_dismissed', '1');
}


// WIZARD NAVIGATION & LOGIC
function switchView(viewId) {
    document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');

    if (viewId === 'view-setup') {
        generateWizardUserInputs();
    }
}

function handleWizardFileUpload(input, type) {
    if (type === 'shp') handleShapefileUpload({ target: input });
    else handleFileUpload({ target: input });
}

function generateWizardUserInputs() {
    const countInput = document.getElementById('wizard-user-count');
    if (!countInput) return;
    const count = parseInt(countInput.value) || 1;
    const container = document.getElementById('wizard-user-names');
    if (!container) return;

    // Preserve existing names if any
    const existingNames = Array.from(container.querySelectorAll('input')).map(i => i.value);

    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'user-name-input';
        input.placeholder = `User ${i + 1} Name`;
        input.style.width = '100%';
        input.style.marginBottom = '8px';
        input.value = existingNames[i] || '';
        input.oninput = checkWizardCompletion;
        container.appendChild(input);
    }
    checkWizardCompletion();
}

function checkWizardCompletion() {
    const newProjectReady = filesUploaded.shp && filesUploaded.od;
    const openProjectReady = projectZipFile !== null;
    const projectReady = newProjectReady || openProjectReady;

    // Track which path we are using for startTask
    if (openProjectReady) currentSetupTab = 'open';
    else if (newProjectReady) currentSetupTab = 'new';

    const nameInputs = document.querySelectorAll('.user-name-input');
    const namesReady = nameInputs.length > 0 && Array.from(nameInputs).every(i => i.value.trim() !== '');

    const startBtn = document.getElementById('wiz-start-btn');
    if (startBtn) {
        if (projectReady && namesReady) {
            startBtn.disabled = false;
            allUsers = Array.from(nameInputs).map(i => i.value.trim());
        } else {
            startBtn.disabled = true;
        }
    }
}

function selectModeForSetup(mode) {
    currentMode = mode;
    document.getElementById('setup-subtitle').textContent = `Setup - ${mode}`;
    switchView('view-setup');
}

function switchSetupTab(tab) {
    currentSetupTab = tab;
    document.querySelectorAll('.setup-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.setup-panel').forEach(p => p.classList.remove('active'));

    const activeBtn = Array.from(document.querySelectorAll('.setup-tab-btn')).find(b => b.textContent.toLowerCase().includes(tab));
    if (activeBtn) activeBtn.classList.add('active');
    
    document.getElementById(`panel-${tab}-project`).classList.add('active');
    checkWizardCompletion();
}

/**
 * START TASK flow:
 * Handles either New Project (fetch unique names) or Open Project (parse ZIP).
 * Then prompts for Auto-Save file handle.
 */
async function startTask() {
    showLoading(`Setting up ${currentMode} Task...`);

    try {
        if (currentSetupTab === 'open') {
            await parseProjectZip(projectZipFile);
            plazaMappingConfirmed = Object.keys(plazaMapping).length > 0;
        } else {
            plazaMappingConfirmed = false; // Fresh project needs resolution
            // uniquePlazas should be populated by the file upload handler
        }

        // Initialize Auto-Save Handle (File System Access API)
        // If we opened a project with a handle, we already have it! No need to prompt again.
        if (!autoSaveHandle) {
            try {
                autoSaveHandle = await window.showSaveFilePicker({
                    suggestedName: `ODIN_Project_${currentMode}_${new Date().toISOString().split('T')[0]}.zip`,
                    types: [{
                        description: 'ODIN Project Bundle (ZIP)',
                        accept: { 'application/zip': ['.zip'] },
                    }],
                });
                console.log("Auto-Save destination established.");
            } catch (err) {
                if (err.name === 'AbortError') {
                    console.log("Auto-save setup skipped by user.");
                } else {
                    console.warn("Auto-Save not supported or failed:", err);
                    alert("Warning: Auto-save will not be active (File System API not supported). Please use manual export periodically.");
                }
            }
        } else {
            console.log("Re-using existing project file handle for auto-save.");
        }

        // Setup users and proceed
        renderUserDropdown();
        if (allUsers.length > 0) {
            allUnmatchedPlaces.forEach((place, index) => {
                place.assigned_user = allUsers[index % allUsers.length];
            });
        }
        
        filterPlacesByUser();
        
        // Restore: Ensure view-main evaluates whether to show survey mapping
        switchView('view-main');
        selectMode(currentMode); // This function handles the survey vs analytics toggle internally
        
        hideLoading();
        // Trigger initial auto-save to wrap original files and current progress state immediately
        triggerAutoSave();
    } catch (err) {
        console.error("Task start failed:", err);
        alert(`Failed to start task: ${err.message}`);
        hideLoading();
    }
}
async function openProjectWithHandle() {
    if ('showOpenFilePicker' in window) {
        try {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: 'ODIN Project Bundle (ZIP)',
                    accept: { 'application/zip': ['.zip'] },
                }],
                multiple: false
            });
            autoSaveHandle = handle;
            const file = await handle.getFile();
            handleProjectZipUpload(file);
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error("Open file picker failed:", err);
                document.getElementById('project-zip-upload').click();
            }
        }
    } else {
        // Fallback to standard file upload
        document.getElementById('project-zip-upload').click();
    }
}

function handleProjectZipUpload(input) {
    const file = input.files ? input.files[0] : (input.target ? input.target.files[0] : input);
    if (!file) return;
    projectZipFile = file;
    document.getElementById('status-zip').className = 'status-success';
    document.getElementById('status-zip').textContent = '● ZIP Loaded';
    checkWizardCompletion();
}

/**
 * AUTO-SAVE logic:
 * Periodically bundles current state into a ZIP and writes to the established handle.
 */
function triggerAutoSave() {
    if (!autoSaveHandle) return;
    
    // 1-second debounce to avoid UI lag
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        try {
            await performAutoSave();
        } catch (err) {
            console.error("Auto-save failed:", err);
        }
    }, 1000);
}

async function performAutoSave() {
    if (!autoSaveHandle || typeof JSZip === 'undefined') return;

    const zip = new JSZip();
    
    // 1. Mapping Progress
    zip.file("resolutions.json", JSON.stringify(resolvedPlaces));
    zip.file("plaza_mapping.json", JSON.stringify(plazaMapping));
    zip.file("project_config.json", JSON.stringify({ mode: currentMode }));
    
    // 2. Original Files (Stashed in app state)
    if (projectOdBlob) {
        zip.file("od_dataset.xlsx", projectOdBlob);
    }
    if (projectShpBlob) {
        zip.file("shapefile.zip", projectShpBlob);
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const writable = await autoSaveHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    
    console.log("Auto-saved project bundle.");
}

/**
 * PARSE PROJECT ZIP:
 * Extracts OD, SHP, and Resolutions from a ZIP project bundle.
 */
async function parseProjectZip(file) {
    if (typeof JSZip === 'undefined') throw new Error("JSZip library not loaded.");
    const zip = await JSZip.loadAsync(file);
    
    // 1. Load Resolutions
    const resFile = zip.file("resolutions.json");
    if (resFile) {
        const content = await resFile.async("string");
        resolvedPlaces = JSON.parse(content);
        console.log("Restored resolutions:", Object.keys(resolvedPlaces).length);
    }
    const pzFile = zip.file("plaza_mapping.json");
    if (pzFile) {
        const content = await pzFile.async("string");
        plazaMapping = JSON.parse(content);
        console.log("Restored plaza mapping.");
    }
    const cfgFile = zip.file("project_config.json");
    if (cfgFile) {
        const content = await cfgFile.async("string");
        const cfg = JSON.parse(content);
        if (cfg.mode) {
            currentMode = cfg.mode;
            const modeSelector = document.getElementById('mode-selector');
            if (modeSelector) modeSelector.value = currentMode;
            console.log("Restored mode:", currentMode);
        }
    }

    // 2. Load and Upload OD Dataset (Smart search)
    let odFile = zip.file("od_dataset.xlsx") || zip.file("ODIN_Resolved_OD_Dataset.xlsx");
    if (!odFile) {
        // Fallback to any .xlsx file
        const candidates = Object.keys(zip.files).filter(name => name.endsWith('.xlsx'));
        if (candidates.length > 0) odFile = zip.file(candidates[0]);
    }

    if (odFile) {
        const odBlob = await odFile.async("blob");
        projectOdBlob = odBlob;
        currentUploadedFile = odBlob;
        await handleFileUpload(odBlob);
    } else {
        throw new Error("Invalid project bundle: Could not find an Excel (.xlsx) dataset.");
    }

    // 3. Load and Upload Shapefile (Smart search)
    let shpFile = zip.file("shapefile.zip") || zip.file("Shapefile_Original.zip");
    if (!shpFile) {
        // Fallback to any other .zip file in the bundle
        const candidates = Object.keys(zip.files).filter(name => name.endsWith('.zip') && name !== file.name);
        if (candidates.length > 0) shpFile = zip.file(candidates[0]);
    }

    if (shpFile) {
        const shpBlob = await shpFile.async("blob");
        projectShpBlob = shpBlob;
        await handleShapefileUpload(shpBlob);
    }
}

// Global click listener
document.addEventListener('click', (e) => {
    // User Selector
    const userContainer = document.getElementById('user-selector-container');
    const userDropdown = document.getElementById('user-dropdown');
    if (userContainer && userDropdown && !userContainer.contains(e.target)) {
        userDropdown.classList.remove('show');
    }

    // Review Dropdown
    const reviewBtn = document.getElementById('review-btn');
    const reviewDropdown = document.getElementById('review-dropdown');
    if (reviewBtn && reviewDropdown && e.target !== reviewBtn && !reviewDropdown.contains(e.target)) {
        reviewDropdown.classList.remove('show');
    }

    // Floating Popup
    const floatingPopup = document.getElementById('floating-popup');
    if (floatingPopup && floatingPopup.classList.contains('active')) {
        if (!floatingPopup.contains(e.target) && !e.target.closest('.clickable-vehicle') && !e.target.closest('.clickable-plaza')) {
            closeFloatingPopup();
        }
    }
});

/**
 * Initializes the Google Maps instance. 
 * Invoked automatically by the Google Maps script callback.
 */
window.initMap = function () {
    // Start with a neutral center; will be updated to survey location centroid once data loads
    const defaultCenter = { lat: 20.5937, lng: 78.9629 };

    map = new google.maps.Map(document.getElementById('map'), {
        zoom: 5,
        center: defaultCenter,
        mapTypeId: 'roadmap',
        // styles: [
        //     // Simple dark mode theme to match UI
        //     { elementType: "geometry", stylers: [{ color: "#abd19dff" }] },
        //     { elementType: "labels.text.stroke", stylers: [{ color: "#3f4e64ff" }] },
        //     { elementType: "labels.text.fill", stylers: [{ color: "#f4ec7cff" }] },
        //     {
        //         featureType: "administrative.locality",
        //         elementType: "labels.text.fill",
        //         stylers: [{ color: "#171d23ff" }]
        //     },
        //     {
        //         featureType: "water",
        //         elementType: "geometry",
        //         stylers: [{ color: "#7a9dd1ff" }]
        //     }
        // ]
    });

    // Map Click Listener for Manual Point Selection
    map.addListener('click', async (e) => {
        const lat = e.latLng.lat();
        const lng = e.latLng.lng();

        // Handle Plaza Picking if active
        if (pickingPlaza) {
            plazaMapping[pickingPlaza] = { lat, lng };

            // Update both Modal (if exists) and Left-Pane list
            const rowIdModal = `plaza-row-${pickingPlaza.replace(/\s+/g, '-')}`;
            const rowModal = document.getElementById(rowIdModal);
            if (rowModal) {
                rowModal.classList.add('mapped');
                const iModal = rowModal.querySelector('input');
                if (iModal) iModal.value = "Mapped ✓";
            }

            // Place a green marker at the picked location
            addPlazaVerificationMarker(pickingPlaza, { lat, lng });

            // Update Left-Pane View
            renderPlazaMappingView();

            const pickedName = pickingPlaza;
            pickingPlaza = null;
            const btns = document.querySelectorAll('.plaza-pick-btn, .plaza-mapping-btn');
            btns.forEach(b => b.classList.remove('active'));

            alert(`Survey location "${pickedName}" assigned successfully!`);
            return;
        }

        if (!unmatchedPlaces || unmatchedPlaces.length === 0) return;

        // Remove existing temporary manual marker if any
        if (map.tempMarker) map.tempMarker.setMap(null);

        const place = unmatchedPlaces[currentIndex];

        // Place a temporary marker
        map.tempMarker = new google.maps.Marker({
            position: { lat, lng },
            map: map,
            icon: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png',
            animation: google.maps.Animation.DROP
        });

        // Find zone from backend PIP
        const zoneData = await fetchZoneForLocation(lat, lng);
        const zoneId = zoneData ? zoneData.zone : "Unknown Zone";

        // Reverse-geocode to get the nearest place name
        let nearestPlaceName = "Unknown Location";
        try {
            const geocoder = new google.maps.Geocoder();
            const geocodeResult = await new Promise((resolve, reject) => {
                geocoder.geocode({ location: { lat, lng } }, (results, status) => {
                    if (status === 'OK' && results && results.length > 0) resolve(results);
                    else reject(status);
                });
            });
            // Find the best locality/sublocality name from the results
            for (const result of geocodeResult) {
                const types = result.types || [];
                // Prefer locality, sublocality, village, or political area
                if (types.some(t => ['locality', 'sublocality', 'sublocality_level_1', 'administrative_area_level_3', 'political'].includes(t))) {
                    // Extract the short name from address_components
                    for (const comp of result.address_components) {
                        if (comp.types.some(t => ['locality', 'sublocality', 'sublocality_level_1', 'administrative_area_level_3'].includes(t))) {
                            nearestPlaceName = comp.long_name;
                            break;
                        }
                    }
                    if (nearestPlaceName !== "Unknown Location") break;
                }
            }
            // Fallback: just use the first result's formatted address first part
            if (nearestPlaceName === "Unknown Location" && geocodeResult.length > 0) {
                const firstAddr = geocodeResult[0].formatted_address || "";
                const firstPart = firstAddr.split(',')[0]?.trim();
                if (firstPart) nearestPlaceName = firstPart;
            }
        } catch (e) {
            console.warn("Reverse geocode failed:", e);
        }

        // Show confirmation popup with place name
        const infoContent = document.createElement('div');
        infoContent.style.cssText = 'color: black; min-width: 220px; font-family:sans-serif; padding:5px;';
        
        const plazas = place.analytics?.plazas?.headers || [];
        const resolvedFor = resolvedPlaces[place.original_name] || {};

        infoContent.innerHTML = `
            <div style="font-weight: bold; font-size: 14px; margin-bottom: 3px; border-bottom:1px solid #eee; padding-bottom:5px;">${nearestPlaceName}</div>
            <div style="font-size: 11px; color: #666; margin-bottom: 5px;">📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
            <div style="font-size: 12px; color: #d59563; font-weight: bold; margin-bottom: 8px;">🗺️ Zone: ${zoneId}</div>
            <div style="margin-bottom:12px;">
                <label style="font-size:11px; font-weight:600; color:#666; display:block; margin-bottom:5px;">RESOLVE FOR:</label>
                <label style="display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; margin-bottom:6px;">
                    <input type="checkbox" id="resolve-all-check" checked> Apply to ALL Plazas
                </label>
                <div id="plaza-selection-list" style="display:none; margin-left:20px; max-height:100px; overflow-y:auto; border:1px solid #eee; border-radius:4px; padding:4px;">
                    ${plazas.map(p => `
                        <label style="display:flex; align-items:center; gap:6px; font-size:11px; margin-bottom:3px; padding:2px; ${resolvedFor[p] ? 'color:#999; text-decoration:line-through;' : ''}">
                            <input type="checkbox" class="plaza-resolve-item" value="${p}" ${resolvedFor[p] ? 'disabled' : 'checked'}> ${p}
                        </label>
                    `).join('')}
                </div>
            </div>
        `;

        const btn = document.createElement('button');
        btn.textContent = `Confirm & Resolve`;
        btn.style.cssText = 'background:#16a34a;color:white;border:none;padding:8px 10px;border-radius:4px;cursor:pointer;width:100%;font-size:12px;font-weight:600;box-shadow:0 2px 4px rgba(0,0,0,0.1);';
        btn.addEventListener('click', () => {
            const resolveAll = infoContent.querySelector('#resolve-all-check').checked;
            let selectedPlazas = null;
            if (!resolveAll) {
                selectedPlazas = Array.from(infoContent.querySelectorAll('.plaza-resolve-item:checked')).map(i => i.value);
                if (selectedPlazas.length === 0) {
                    alert("Please select at least one plaza or choose 'Apply to ALL'.");
                    return;
                }
            }

            if (activeInfoWindow) activeInfoWindow.close();
            selectSuggestion(place.id, {
                name: nearestPlaceName,
                lat: lat,
                lng: lng,
                zone: zoneId
            }, selectedPlazas);
            triggerAutoSave();
        });

        infoContent.appendChild(btn);

        // Toggle sub-list
        const allCheck = infoContent.querySelector('#resolve-all-check');
        const subList = infoContent.querySelector('#plaza-selection-list');
        allCheck.addEventListener('change', () => {
            subList.style.display = allCheck.checked ? 'none' : 'block';
        });

        const infowindow = new google.maps.InfoWindow({ content: infoContent });
        if (activeInfoWindow) activeInfoWindow.close();
        infowindow.open(map, map.tempMarker);
        activeInfoWindow = infowindow;
    });

    // Remove the placeholder visually once initialized
    const placeholder = document.getElementById('map-placeholder');
    if (placeholder) placeholder.style.display = 'none';
};

async function fetchZoneForLocation(lat, lng) {
    try {
        const response = await fetch(`http://localhost:8000/api/zone?lat=${lat}&lng=${lng}`);
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.error("Error fetching zone:", error);
        return null;
    }
}

async function handleShapefileUpload(event) {
    const file = event.target ? event.target.files[0] : event;
    if (!file) return;

    const shpBtns = [
        document.querySelector('label[for="shapefile-upload"]'),
        document.getElementById('wizard-shp-btn'),
        document.getElementById('shapefile-label')
    ];

    // Show Loading in buttons
    shpBtns.forEach(btn => {
        if (btn) {
            btn.classList.add("loading");
            if (btn.childNodes[0]) btn.childNodes[0].textContent = "Uploading Shapefile...";
        }
    });

    const formData = new FormData();
    if (file.name) {
        formData.append('file', file);
    } else {
        formData.append('file', file, 'shapefile.zip');
    }

    try {
        const response = await fetch('http://localhost:8000/api/upload/shapefile', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Server error");
        }

        const result = await response.json();
        filesUploaded.shp = true;
        // Stash the blob for project bundles
        projectShpBlob = file;

        // Update UI Elements to Loaded state
        shpBtns.forEach(btn => {
            if (btn) {
                btn.classList.remove("loading", "not-loaded");
                btn.classList.add("loaded");
                if (btn.childNodes[0]) btn.childNodes[0].textContent = "Shapefile Loaded ✓";
            }
        });

        const statusDot = document.getElementById('status-shp');
        if (statusDot) {
            statusDot.classList.remove('status-pending');
            statusDot.classList.add('status-check');
            statusDot.textContent = "✓";
        }

        checkWizardCompletion();
        checkFilesCollapsed();

        // Silent success - no alert
    } catch (error) {
        console.error("Shapefile upload failed:", error);
        shpBtns.forEach(btn => {
            if (btn) btn.classList.remove("loading");
        });
        alert("Shapefile upload failed: " + error.message);
    }
}

function showLoading(text) {
    const overlay = document.getElementById('loading-overlay');
    const textEl = document.getElementById('loading-text');
    if (text) textEl.textContent = text;
    overlay.classList.add('active');
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('active');
}

function clearAnalytics() {
    document.getElementById('vehicle-body').innerHTML = `<tr class="empty-state"><td colspan="10">No data</td></tr>`;
    document.querySelector('#plaza-table thead').innerHTML = `<tr><th>Waiting for data</th></tr>`;
    document.querySelector('#plaza-table tbody').innerHTML = ``;
    document.getElementById('commodity-body').innerHTML = `<tr class="empty-state"><td colspan="9">No data</td></tr>`;
}

async function handleFileUpload(event) {
    const file = event.target ? event.target.files[0] : event;
    if (!file) return;
    currentUploadedFile = file;
    projectOdBlob = file; // Stash for bundle

    const odBtns = [
        document.querySelector('label[for="file-upload"]'),
        document.getElementById('wizard-od-btn'),
        document.getElementById('file-label')
    ];

    // Show Loading in buttons
    odBtns.forEach(btn => {
        if (btn) {
            btn.classList.add("loading");
            if (btn.childNodes[0]) btn.childNodes[0].textContent = "Processing Dataset...";
        }
    });

    const formData = new FormData();
    if (file.name) {
        formData.append('file', file);
    } else {
        formData.append('file', file, 'od_dataset.xlsx');
    }
    formData.append('mode', currentMode);

    try {
        const response = await fetch('http://localhost:8000/api/upload/excel', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Server error");
        }

        const result = await response.json();
        filesUploaded.od = true;

        // Update UI Elements
        odBtns.forEach(btn => {
            if (btn) {
                btn.classList.remove("loading", "not-loaded");
                btn.classList.add("loaded");
                if (btn.childNodes[0]) btn.childNodes[0].textContent = "OD Dataset Loaded ✓";
            }
        });

        const statusDot = document.getElementById('status-od');
        if (statusDot) {
            statusDot.classList.remove('status-pending');
            statusDot.classList.add('status-check');
            statusDot.textContent = "✓";
            if (result.ca_codes_abstract && result.ca_codes_abstract.length > 0) {
                COMMODITIES_ABSTRACT = result.ca_codes_abstract.map(row => {
                    const vals = Object.values(row);
                    return {
                        code: vals.length > 0 ? vals[0].toString() : '?',
                        name: vals.length > 1 ? vals[1] : 'Unknown Commodity'
                    };
                });
            }
            if (result.ca_codes_detailed && result.ca_codes_detailed.length > 0) {
                COMMODITIES_DETAILED = result.ca_codes_detailed.map(row => {
                    const vals = Object.values(row);
                    return {
                        code: vals.length > 0 ? vals[0].toString() : '?',
                        name: vals.length > 1 ? vals[1] : 'Unknown Commodity'
                    };
                });
            }

        }

        renderUserDropdown();

        if (result.data && result.data.length > 0) {
            placeOccurrencesMap = {};
            globalTotalOccurrences = 0;
            result.data.forEach(p => {
                placeOccurrencesMap[p.original_name] = p.total_occurrences || 0;
                globalTotalOccurrences += (p.total_occurrences || 0);
            });
            
            allUnmatchedPlaces = [...result.data];

            const plazaSet = new Set();
            allUnmatchedPlaces.forEach(place => {
                if (place.analytics && place.analytics.plazas && place.analytics.plazas.headers) {
                    place.analytics.plazas.headers.forEach(h => plazaSet.add(h));
                }
            });
            uniquePlazas = Array.from(plazaSet).sort();
            plazaMappingConfirmed = false;

            if (allUsers.length > 0) {
                allUnmatchedPlaces.forEach((place, index) => {
                    place.assigned_user = allUsers[index % allUsers.length];
                });
            }

            // FILTER: If we opened a project, some places are already resolved
            const resolvedNames = Object.keys(resolvedPlaces);
            if (resolvedNames.length > 0) {
                allUnmatchedPlaces = allUnmatchedPlaces.filter(p => {
                    const mapped = resolvedPlaces[p.original_name] || {};
                    // If "Apply to All" exists or ALL recorded plazas are mapped
                    if (mapped["__all__"]) return false;
                    const plazaHeaders = p.analytics?.plazas?.headers || [];
                    const allMapped = plazaHeaders.every(h => mapped[h]);
                    return !allMapped;
                });
            }

            filterPlacesByUser();
            checkWizardCompletion();
            // Silent success
        } else {
            alert(`Upload succeeded, but no unique OD pairs were found (Total records: ${result.total_rows || 0})`);
        }
    } catch (error) {
        console.error("Excel upload failed:", error);
        odBtns.forEach(btn => {
            if (btn) btn.classList.remove("loading");
        });
        alert("Excel upload failed: " + error.message);
    } finally {
        document.title = "GeoValidate OD";
    }
}

async function downloadProgress() {
    if (Object.keys(resolvedPlaces).length === 0) {
        alert("No places have been resolved yet. Please resolve at least one place before downloading.");
        return;
    }

    document.title = "Exporting Progress... GeoValidate OD";

    const formData = new FormData();
    formData.append('mapping', JSON.stringify(resolvedPlaces));

    if (projectOdBlob) {
        formData.append('excel_file', projectOdBlob);
    }

    if (projectShpBlob) {
        formData.append('shapefile_zip', projectShpBlob);
    }

    // Add survey location details
    formData.append('plaza_mapping', JSON.stringify(plazaMapping));

    showLoading("Generating Project ZIP Export...");

    try {
        const response = await fetch('http://localhost:8000/api/export/progress', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(errText || "Export Server error");
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'ODIN_Export_Project.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        hideLoading();
        setTimeout(() => alert("Successfully exported resolved places progress!"), 50);
    } catch (error) {
        console.error("Export progress failed:", error);
        hideLoading();
        setTimeout(() => alert("Export progress failed: " + error.message), 50);
    } finally {
        document.title = "GeoValidate OD";
    }
}
function toggleTheme() {
    const body = document.body;
    const thumb = document.getElementById("toggle-thumb");

    body.classList.toggle("light-theme");

    if (body.classList.contains("light-theme")) {
        thumb.innerHTML = "☀️";
    } else {
        thumb.innerHTML = "🌙";
    }
}
function loadDataset(data) {
    unmatchedPlaces = [...data];
    currentIndex = 0;
    updateNavigatorDisplay();
    renderCurrentPlace();
}

function toggleProjectDropdown() {
    const dropdown = document.getElementById('project-dropdown');
    if (dropdown) dropdown.classList.toggle('show');
}

function selectMode(mode) {
    currentMode = mode;

    // Update header display
    const modeDisplay = document.getElementById('current-mode-display');
    if (modeDisplay) modeDisplay.textContent = mode;

    // UI Panels Toggle
    const surveyMappingPane = document.getElementById('survey-mapping-pane');
    const standardView = document.getElementById('standard-analytics-view');
    const navigator = document.querySelector('.place-navigator');

    // Header elements to hide during survey verification
    const reviewContainer = document.getElementById('review-selector-container');
    const manualSelectCard = document.querySelector('.manual-select-card');
    const manualSearchCard = document.querySelector('.manual-search-card');

    if (!plazaMappingConfirmed && uniquePlazas.length > 0) {
        if (surveyMappingPane) surveyMappingPane.style.display = 'flex';
        if (standardView) standardView.style.display = 'none';
        if (navigator) navigator.style.display = 'none';
        // Hide header Review, +, and Search during survey verification
        if (reviewContainer) reviewContainer.style.display = 'none';
        if (manualSelectCard) manualSelectCard.style.display = 'none';
        if (manualSearchCard) manualSearchCard.style.display = 'none';
        renderPlazaMappingView();
    } else {
        if (surveyMappingPane) surveyMappingPane.style.display = 'none';
        if (standardView) standardView.style.display = 'flex';
        if (navigator) navigator.style.display = 'flex';
        // Show header Review, +, and Search after confirmation
        if (reviewContainer) reviewContainer.style.display = '';
        if (manualSelectCard) manualSelectCard.style.display = '';
        if (manualSearchCard) manualSearchCard.style.display = '';
    }

    // Update active class in menu
    const isZone = mode === 'Zone assign';
    const zoneItem = document.getElementById('sub-mode-zone');
    const placeItem = document.getElementById('sub-mode-place');
    if (zoneItem) zoneItem.classList.toggle('active-mode', isZone);
    if (placeItem) placeItem.classList.toggle('active-mode', !isZone);

    // Collapse the sub-menu
    const subDropdown = document.getElementById('mode-sub-dropdown');
    if (subDropdown) subDropdown.classList.add('collapsed-sub');

    // Re-filter the places based on the new mode
    allUnmatchedPlaces.forEach(p => { p.suggestions = []; });
    filterPlacesByUser();
    if (unmatchedPlaces.length > 0) renderCurrentPlace();
}

/**
 * Renders the initial survey location verification list
 */
function renderPlazaMappingView() {
    const list = document.getElementById('plaza-mapping-list');
    if (!list) return;
    list.innerHTML = '';

    uniquePlazas.forEach(name => {
        const isMapped = !!plazaMapping[name];
        const statusClass = isMapped ? 'status-mapped' : 'status-unmapped';
        const statusText = isMapped ? 'Verified' : 'Pending';
        const itemClass = isMapped ? 'plaza-mapping-item mapped' : 'plaza-mapping-item';
        const btnClass = pickingPlaza === name ? 'plaza-mapping-btn active' : 'plaza-mapping-btn';
        const coordsDisplay = isMapped ? `${plazaMapping[name].lat.toFixed(4)}, ${plazaMapping[name].lng.toFixed(4)}` : '';

        const item = document.createElement('div');
        item.className = itemClass;
        item.innerHTML = `
            <div class="plaza-mapping-header">
                <span class="plaza-name-label">${name}</span>
                <span class="plaza-status-badge ${statusClass}">${statusText}</span>
            </div>
            <div class="plaza-mapping-tools">
                <div class="plaza-search-container">
                    <input type="text" class="plaza-search-input" 
                           placeholder="Search location or enter lat, lng..." 
                           value="${coordsDisplay}"
                           id="search-plaza-${name.replace(/\s+/g, '_')}" 
                           onfocus="setupPlazaAutocomplete('${name}')">
                </div>
                <button class="${btnClass}" title="Pick on Map" onclick="startPickingPlaza('${name}')">
                    +
                </button>
            </div>
        `;
        list.appendChild(item);

        // Add coordinate-input listener (Enter key)
        const inputEl = item.querySelector('.plaza-search-input');
        if (inputEl) {
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = inputEl.value.trim();
                    // Try to parse as coordinates: "lat, lng" or "lat lng"
                    const coordMatch = val.match(/^\s*(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)\s*$/);
                    if (coordMatch) {
                        const lat = parseFloat(coordMatch[1]);
                        const lng = parseFloat(coordMatch[2]);
                        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                            const pos = { lat, lng };
                            plazaMapping[name] = pos;
                            addPlazaVerificationMarker(name, pos);
                            renderPlazaMappingView();
                            if (map) {
                                map.panTo(pos);
                                map.setZoom(15);
                            }
                        } else {
                            alert('Invalid coordinates. Latitude must be -90 to 90, longitude -180 to 180.');
                        }
                    }
                    // If not coordinates, let Autocomplete handle it naturally
                }
            });
        }
    });
}

function startPickingPlaza(name) {
    pickingPlaza = name;
    renderPlazaMappingView(); // Update buttons state
    alert(`Click anywhere on the map to set the location for: ${name}`);

    // Also center map on studying area if we have any prev mapping or just general area
    if (map && !plazaMapping[name]) {
        const firstPlaza = Object.values(plazaMapping)[0];
        if (firstPlaza) map.panTo(firstPlaza);
    }
}

function setupPlazaAutocomplete(name) {
    const input = document.getElementById(`search-plaza-${name.replace(/\s+/g, '_')}`);
    if (!input || input.dataset.autocompleteInit) return;

    const autocomplete = new google.maps.places.Autocomplete(input);
    autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (!place.geometry) return;

        const pos = {
            lat: place.geometry.location.lat(),
            lng: place.geometry.location.lng()
        };

        plazaMapping[name] = pos;
        addPlazaVerificationMarker(name, pos);
        renderPlazaMappingView();

        // Move map to selected location
        if (map) {
            map.panTo(pos);
            map.setZoom(15);
        }
    });
    input.dataset.autocompleteInit = "true";
}

/**
 * Adds or replaces a green verification marker for a survey location on the map.
 */
function addPlazaVerificationMarker(plazaName, pos) {
    if (!map) return;

    // Remove existing marker for this plaza if any
    if (plazaVerificationMarkers[plazaName]) {
        plazaVerificationMarkers[plazaName].setMap(null);
    }

    // Create a green marker
    const marker = new google.maps.Marker({
        position: pos,
        map: map,
        title: `Survey Location: ${plazaName}`,
        icon: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png',
        animation: google.maps.Animation.DROP
    });

    // Add info window
    const infoContent = `
        <div style="color: black; min-width: 150px;">
            <div style="font-weight: bold; font-size: 14px; margin-bottom: 5px;">${plazaName}</div>
            <div style="font-size: 12px; color: #16a34a; font-weight: bold;">✓ Survey Location Verified</div>
            <div style="font-size: 11px; margin-top: 5px;">${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}</div>
        </div>
    `;
    const infowindow = new google.maps.InfoWindow({ content: infoContent });
    marker.addListener('click', () => {
        if (activeInfoWindow) activeInfoWindow.close();
        infowindow.open(map, marker);
        activeInfoWindow = infowindow;
    });

    plazaVerificationMarkers[plazaName] = marker;
}

/**
 * Clears all plaza verification markers from the map.
 */
function clearPlazaVerificationMarkers() {
    Object.values(plazaVerificationMarkers).forEach(m => m.setMap(null));
    plazaVerificationMarkers = {};
}

function confirmPlazaMapping() {
    const unmapped = uniquePlazas.filter(n => !plazaMapping[n]);
    if (unmapped.length > 0) {
        if (!confirm(`Warning: ${unmapped.length} survey locations are still pending. Proceed anyway?`)) {
            return;
        }
    }

    plazaMappingConfirmed = true;

    // Clear verification markers — the regular blue star markers will now take over
    clearPlazaVerificationMarkers();

    selectMode(currentMode); // This will switch back to standard analytics view
}


function filterPlacesByUser() {
    let filtered = [...allUnmatchedPlaces];

    // Filter by User
    if (currentUser !== "All Users") {
        filtered = filtered.filter(p => p.assigned_user === currentUser);
    }

    // Filter by Mode (Removed strict assigned_zone filter to match user request for identical interface)
    /*
    if (currentMode === "Place assign") {
        filtered = filtered.filter(p => p.assigned_zone != null && p.assigned_zone !== "");
    }
    */

    unmatchedPlaces = filtered;
    currentIndex = 0;
    updateNavigatorDisplay();
    renderCurrentPlace();
}

function toggleUserDropdown() {
    document.getElementById('user-dropdown').classList.toggle('show');
}

function selectUser(user) {
    currentUser = user;
    document.getElementById('current-user-display').textContent = user;
    document.getElementById('user-dropdown').classList.remove('show');

    // Update active class
    const items = document.querySelectorAll('.user-dropdown-item');
    items.forEach(item => {
        if (item.textContent === user) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    filterPlacesByUser();
}

function renderUserDropdown() {
    const dropdown = document.getElementById('user-dropdown');
    dropdown.innerHTML = '';

    if (allUsers.length === 0) {
        document.getElementById('current-user-display').textContent = "No data loaded";
        const emptyOpt = document.createElement('div');
        emptyOpt.className = 'user-dropdown-item';
        emptyOpt.textContent = "No data loaded";
        emptyOpt.style.color = "var(--text-secondary)";
        emptyOpt.style.pointerEvents = "none";
        dropdown.appendChild(emptyOpt);
        return;
    }

    // Set header if All Users is active
    if (currentUser === "All Users") {
        document.getElementById('current-user-display').textContent = "All Users";
    }

    // "All Users" Option
    const allOpt = document.createElement('div');
    allOpt.className = 'user-dropdown-item' + (currentUser === "All Users" ? ' active' : '');
    allOpt.textContent = "All Users";
    allOpt.onclick = () => selectUser("All Users");
    dropdown.appendChild(allOpt);

    // Individual Users
    allUsers.forEach(user => {
        const opt = document.createElement('div');
        opt.className = 'user-dropdown-item' + (currentUser === user ? ' active' : '');
        opt.textContent = user;
        opt.onclick = () => selectUser(user);
        dropdown.appendChild(opt);
    });
}

function updateNavigatorDisplay() {
    const countDisplay = document.getElementById('unmatched-count');
    const total = unmatchedPlaces.length;

    let resolvedOccurrences = 0;
    Object.keys(resolvedPlaces).forEach(name => {
        resolvedOccurrences += placeOccurrencesMap[name] || 0;
    });
    const completionPercent = globalTotalOccurrences > 0 ? Math.round((resolvedOccurrences / globalTotalOccurrences) * 100) : 0;
    const progressEl = document.getElementById('completion-progress');
    if (progressEl) {
        progressEl.textContent = `${completionPercent}%`;
    }

    if (total === 0) {
        if (countDisplay) countDisplay.textContent = `Pending: 0 / 0`;
        const nameEl = document.getElementById('selected-place-name');
        if (nameEl) nameEl.textContent = "All Validated";
        const prevBtn = document.getElementById('prev-place');
        const nextBtn = document.getElementById('next-place');
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        clearAnalytics();
        return;
    }

    const currentPos = currentIndex + 1;
    if (countDisplay) countDisplay.textContent = `Pending: ${total}`;

    const prevBtn = document.getElementById('prev-place');
    const nextBtn = document.getElementById('next-place');
    if (prevBtn) prevBtn.disabled = (currentIndex === 0);
    if (nextBtn) nextBtn.disabled = (currentIndex === total - 1);
}

// Helper: Sort OD pair strings by their embedded count in decreasing order
// Parses patterns like "AARA - GOPALGANJ [8]" or "AARA - GORAKHPUR (4)"
function sortPairsByCount(pairsArray) {
    if (!Array.isArray(pairsArray) || pairsArray.length === 0) return pairsArray;
    return [...pairsArray].sort((a, b) => {
        const countA = extractCountFromPair(a);
        const countB = extractCountFromPair(b);
        return countB - countA;
    });
}

function extractCountFromPair(pairString) {
    // Match number inside brackets [N] or parentheses (N) at the end
    const match = pairString.match(/[\[(]\s*(\d+)\s*[\])]\s*$/);
    return match ? parseInt(match[1], 10) : 0;
}

// Helper: Green gradient for top-N heat coloring
function getHeatColor(val, maxVal) {
    if (!maxVal || maxVal === 0 || val === 0) return '';
    const ratio = Math.min(val / maxVal, 1);
    const alpha = 0.2 + ratio * 0.6;
    return `background:rgba(34,197,94,${alpha.toFixed(2)});color:${ratio > 0.55 ? '#fff' : 'inherit'};border-radius:6px;`;
}

function renderVehicleAnalytics() {
    const tbody = document.getElementById('vehicle-body');
    const place = unmatchedPlaces[currentIndex];
    if (!place || !place.analytics) return;
    
    let vehicles = place.analytics.vehicles;
    let vehicleInteractions = place.analytics.vehicleInteractions;
    
    if (selectedFilterPlaza && place.analytics.vehiclesPlaza && place.analytics.vehiclesPlaza[selectedFilterPlaza]) {
        vehicles = place.analytics.vehiclesPlaza[selectedFilterPlaza];
        vehicleInteractions = place.analytics.vehicleInteractionsPlaza[selectedFilterPlaza] || {};
    }
    
    if (!vehicles || Object.keys(vehicles).length === 0) {
        tbody.innerHTML = `<tr class="empty-state"><td colspan="10">No data</td></tr>`;
        return;
    }
    const cols = ['CAR', 'MB', 'GB', 'ML', 'LGV', '2T', '3T', '4T', '5T', '6T'];
    let html = '<tr>';
    cols.forEach(c => {
        let val = vehicles[c] || 0;
        let intHTML = '';
        if (vehicleInteractions && vehicleInteractions[c]) {
            intHTML = `<div class="pill-badge clickable-vehicle" title="View Details" onclick="showInteractionDetails('${c}', event)"><span>${val}</span></div>`;
        } else {
            intHTML = `<span>${val}</span>`;
        }
        html += `<td>${intHTML}</td>`;
    });
    html += '</tr>';
    tbody.innerHTML = html;
}

function togglePlazaFilter(plaza, event) {
    if (event) event.stopPropagation();
    
    // Toggle class on body for global styling hooks
    const body = document.body;
    const analyticsView = document.getElementById('standard-analytics-view');
    const leftPane = (analyticsView && analyticsView.closest('.left-pane')) || document.querySelector('.left-pane');
    
    const plazaTrimmed = plaza.trim();
    if (selectedFilterPlaza === plazaTrimmed) {
        selectedFilterPlaza = null; // deselect
        body.classList.remove('plaza-filter-active');
        if (leftPane) leftPane.classList.remove('filter-active');
    } else {
        selectedFilterPlaza = plazaTrimmed;
        body.classList.add('plaza-filter-active');
        if (leftPane) leftPane.classList.add('filter-active');
    }
    
    renderVehicleAnalytics();
    renderPlazaAnalytics(); // Re-render to update the active capsule state
    renderCommodityMatrix();
}

function renderPlazaAnalytics(plazasArg) {
    const thead = document.querySelector('#plaza-table thead') || document.getElementById('plaza-head');
    const tbody = document.querySelector('#plaza-table tbody') || document.getElementById('plaza-body');
    const place = unmatchedPlaces[currentIndex];
    const plazas = plazasArg || (place && place.analytics && place.analytics.plazas);
    
    // Fail safe if table is missing or data is empty
    if (!thead || !tbody) return;
    
    if (!plazas || !plazas.headers || plazas.headers.length === 0) {
        thead.innerHTML = `<tr><th>Waiting for data</th></tr>`;
        tbody.innerHTML = ``;
        return;
    }

    const resolvedFor = (place && resolvedPlaces[place.original_name]) ? resolvedPlaces[place.original_name] : {};
    const top20Max = plazas.counts ? Math.max(...plazas.counts) : 1;

    let rowHtml = '<tr>';
    
    plazas.headers.forEach((h, i) => {
        const hTrimmed = h.trim();
        const count = plazas.counts[i];
        const isResolved = resolvedFor[hTrimmed] || resolvedFor["__all__"];
        const isActive = selectedFilterPlaza === hTrimmed;
        
        const cardClass = isActive ? 'plaza-card selected-plaza-active' : 'plaza-card';
        const resolutionMark = isResolved ? ' <span style="color:#16a34a; font-size:10px;">⬤</span>' : '';
        const heatBgColor = getHeatColor(count, top20Max); 
        
        rowHtml += `
            <td style="padding: 2px;">
                <div class="${cardClass}" onclick="togglePlazaFilter('${hTrimmed}', event)" title="Click to filter by ${hTrimmed}">
                    <div class="plaza-name-box">
                        ${hTrimmed}${resolutionMark}
                    </div>
                    <div class="plaza-count-box" style="${heatBgColor}" onclick="event.stopPropagation(); showPlazaInteractions('${h}', event)" title="View interactions for ${hTrimmed}">
                        ${count}
                    </div>
                </div>
            </td>
        `;
    });
    
    rowHtml += '</tr>';
    
    // Clear thead as we are using a single row in tbody for cards
    thead.innerHTML = '';
    tbody.innerHTML = rowHtml;
}

function renderCommodityMatrix() {
    const tbody = document.getElementById('commodity-body');
    const place = unmatchedPlaces[currentIndex];
    if (!place || !place.analytics) return;
    
    let matrix, interactions;
    if (selectedFilterPlaza && place.analytics.commodityMatrixAbstractPlaza && place.analytics.commodityMatrixAbstractPlaza[selectedFilterPlaza]) {
        matrix = commodityViewMode === 'detailed' ? place.analytics.commodityMatrixDetailedPlaza[selectedFilterPlaza] : place.analytics.commodityMatrixAbstractPlaza[selectedFilterPlaza];
        interactions = commodityViewMode === 'detailed' ? (place.analytics.commodityInteractionsDetailedPlaza[selectedFilterPlaza] || {}) : (place.analytics.commodityInteractionsAbstractPlaza[selectedFilterPlaza] || {});
    } else {
        matrix = commodityViewMode === 'detailed' ? place.analytics.commodityMatrixDetailed : place.analytics.commodityMatrixAbstract;
        interactions = commodityViewMode === 'detailed' ? place.analytics.commodityInteractionsDetailed : place.analytics.commodityInteractionsAbstract;
    }
    
    // Fallback if the dict is entirely missing for some reason
    matrix = matrix || {};
    interactions = interactions || {};

    if (Object.keys(matrix).length === 0) {
        tbody.innerHTML = `<tr class="empty-state"><td colspan="8">Load data</td></tr>`;
        return;
    }
    const commodityList = commodityViewMode === 'detailed' ? COMMODITIES_DETAILED : COMMODITIES_ABSTRACT;
    const codeLookup = {};
    commodityList.forEach(c => { codeLookup[c.code.toString()] = c.name; });

    const vehicleCols = ['ML', 'LGV', '2T', '3T', '4T', '5T', '6T'];

    // Collect row totals (skip code 0) for top-5 row highlighting
    const rowData = [];
    Object.entries(matrix).forEach(([code, row]) => {
        if (code === '0' || code === 0) return;
        const total = vehicleCols.reduce((s, col) => s + (row[col] || 0), 0);
        // Exclude rows where the total sum of vehicles is 0
        if (total > 0) {
            rowData.push({ code, row, total });
        }
    });
    // Sort by total to find top-5 codes
    const sorted = [...rowData].sort((a, b) => b.total - a.total);
    const top5Codes = new Set(sorted.slice(0, 5).map(r => r.code));

    // Collect ALL individual cell values for top-20 cell highlighting
    const allCellVals = [];
    rowData.forEach(({ row }) => vehicleCols.forEach(col => allCellVals.push(row[col] || 0)));
    allCellVals.sort((a, b) => b - a);
    const top20CellThreshold = allCellVals[Math.min(19, allCellVals.length - 1)] || 0;
    const cellMaxVal = allCellVals[0] || 1;

    let html = '';
    rowData.forEach(({ code, row, total }) => {
        const name = codeLookup[code] || `Code ${code}`;
        const hasInteractions = interactions[code] && Object.keys(interactions[code]).length > 0;
        const isTop5 = top5Codes.has(code);
        const rowClass = isTop5 ? 'class="commodity-top5"' : '';
        html += `<tr ${rowClass} style="cursor:default;">`;
        html += `<td title="Code ${code}">${name}</td>`;
        vehicleCols.forEach(col => {
            const v = row[col] || 0;
            const isTop20Cell = v > 0 && v >= top20CellThreshold;
            const cellHeat = isTop20Cell ? getHeatColor(v, cellMaxVal) : '';
            const cellClick = hasInteractions ? `class="clickable-vehicle" onclick="showCommodityInteractions('${code}', '${col}', '${name.replace(/'/g, "\\'")}', event)"` : '';
            html += `<td ${cellClick}><span style="display:inline-block;padding:2px 6px;${cellHeat}">${v}</span></td>`;
        });
        html += '</tr>';
    });
    tbody.innerHTML = html;
}

function showCommodityInteractions(commCode, vehicleType, commName, event) {
    if (event) event.stopPropagation();
    if (unmatchedPlaces.length === 0) return;
    const place = unmatchedPlaces[currentIndex];

    let interactions = {};
    if (selectedFilterPlaza && place.analytics.commodityInteractionsAbstractPlaza && place.analytics.commodityInteractionsAbstractPlaza[selectedFilterPlaza]) {
        interactions = commodityViewMode === 'detailed' ? (place.analytics.commodityInteractionsDetailedPlaza[selectedFilterPlaza] || {}) : (place.analytics.commodityInteractionsAbstractPlaza[selectedFilterPlaza] || {});
    } else {
        const interactionKey = commodityViewMode === 'detailed' ? 'commodityInteractionsDetailed' : 'commodityInteractionsAbstract';
        interactions = (place && place.analytics && place.analytics[interactionKey]) || {};
    }

    let interactList = interactions[commCode] ? interactions[commCode][vehicleType] : null;

    const titleStr = `${commName} - ${vehicleType}`;
    let contentHTML = '';

    if (!interactList || (Array.isArray(interactList) && interactList.length === 0) || (typeof interactList === 'object' && Object.keys(interactList).length === 0)) {
        contentHTML = `<ul class="interaction-list"><li>No explicit interactions computed.</li></ul>`;
    } else if (Array.isArray(interactList)) {
        // Already flat list - sort by count descending
        const sorted = sortPairsByCount(interactList);
        contentHTML = `<ul class="interaction-list">`;
        sorted.forEach(pairString => { contentHTML += `<li>${pairString}</li>`; });
        contentHTML += `</ul>`;
    } else if (!selectedFilterPlaza) {
        // No plaza selected: flatten all directions into single sorted list
        const allPairs = [];
        Object.values(interactList).forEach(pairs => {
            if (Array.isArray(pairs)) allPairs.push(...pairs);
        });
        const sorted = sortPairsByCount(allPairs);
        contentHTML = `<ul class="interaction-list">`;
        sorted.forEach(pairString => { contentHTML += `<li>${pairString}</li>`; });
        contentHTML += `</ul>`;
    } else {
        // Plaza selected: show direction-wise split
        const dirKeys = Object.keys(interactList);
        contentHTML = `<div class="direction-split">`;
        dirKeys.forEach(dir => {
            contentHTML += `
                <div class="direction-column">
                    <h4>Direction: ${dir}</h4>
                    <ul class="interaction-list small">
                        ${interactList[dir].map(pair => `<li>${pair}</li>`).join('')}
                    </ul>
                </div>
            `;
        });
        contentHTML += `</div>`;
    }

    openFloatingPopup(event, titleStr, contentHTML);
}

    function openFloatingPopup(event, title, contentHTML) {
        let popup = document.getElementById('floating-popup');
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'floating-popup';
            popup.className = 'floating-popup';
            popup.innerHTML = `
                <div class="popup-header">
                    <h3 id="floating-popup-title"></h3>
                    <button class="btn-close" onclick="closeFloatingPopup()">×</button>
                </div>
                <div class="popup-body" id="floating-popup-body"></div>
            `;
            document.body.appendChild(popup);
        }

    document.getElementById('floating-popup-title').textContent = title;
    document.getElementById('floating-popup-body').innerHTML = contentHTML;

    // Visibility hidden to calculate layout
    popup.style.visibility = 'hidden';
    popup.classList.remove('out');
    popup.classList.add('active');

    const rect = popup.getBoundingClientRect();
    const margin = 10;

    // CONSTRAIN TO LEFT PANE
    const leftPane = document.querySelector('.left-pane');
    const bounds = leftPane ? leftPane.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };

    // Origin calculation for Genie effect
    const targetRect = event.target.getBoundingClientRect();
    const originX = targetRect.left + targetRect.width / 2;
    const originY = targetRect.top + targetRect.height / 2;
    
    // Default: Open to the right and below
    let left = targetRect.right + 5;
    let top = targetRect.top;

    // Check right space
    if (left + rect.width > bounds.right - margin) {
        // Try opening to the left of the target
        left = targetRect.left - rect.width - 5;
    }

    // Check left space
    if (left < bounds.left + margin) {
        left = bounds.left + margin;
    }

    // Check bottom space
    if (top + rect.height > bounds.bottom - margin) {
        // Try shifting up
        top = bounds.bottom - rect.height - margin;
    }

    // Check top space
    if (top < bounds.top + margin) {
        top = bounds.top + margin;
    }

    // Set genie transform origin relative to the popup's top-left
    popup.style.setProperty('--genie-x', `${originX - left}px`);
    popup.style.setProperty('--genie-y', `${originY - top}px`);
    popup.style.transformOrigin = `${originX - left}px ${originY - top}px`;

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.visibility = 'visible';
    
    popup.classList.add('genie-effect');
}

function closeFloatingPopup() {
    const popup = document.getElementById('floating-popup');
    if (popup && popup.classList.contains('active')) {
        popup.classList.add('out');
        setTimeout(() => {
            popup.classList.remove('active', 'out', 'genie-effect');
        }, 400);
    }
}

function showInteractionDetails(category, event) {
    if (event) event.stopPropagation();
    if (unmatchedPlaces.length === 0) return;
    const place = unmatchedPlaces[currentIndex];

    let vehicleInteractions = place.analytics.vehicleInteractions || {};
    if (selectedFilterPlaza && place.analytics.vehicleInteractionsPlaza && place.analytics.vehicleInteractionsPlaza[selectedFilterPlaza]) {
        vehicleInteractions = place.analytics.vehicleInteractionsPlaza[selectedFilterPlaza];
    }

    let interactList = vehicleInteractions[category];

    const title = `${category} Interactions`;
    let contentHTML = '';

    if (!interactList || (Array.isArray(interactList) && interactList.length === 0) || (typeof interactList === 'object' && Object.keys(interactList).length === 0)) {
        contentHTML = `<ul class="interaction-list"><li>No details available.</li></ul>`;
    } else if (Array.isArray(interactList)) {
        // Already flat list - sort by count descending
        const sorted = sortPairsByCount(interactList);
        contentHTML = `<ul class="interaction-list">`;
        sorted.forEach(pair => { contentHTML += `<li>${pair}</li>`; });
        contentHTML += `</ul>`;
    } else if (!selectedFilterPlaza) {
        // No plaza selected: flatten all directions into single sorted list
        const allPairs = [];
        Object.values(interactList).forEach(pairs => {
            if (Array.isArray(pairs)) allPairs.push(...pairs);
        });
        const sorted = sortPairsByCount(allPairs);
        contentHTML = `<ul class="interaction-list">`;
        sorted.forEach(pair => { contentHTML += `<li>${pair}</li>`; });
        contentHTML += `</ul>`;
    } else {
        // Plaza selected: show direction-wise split
        const dirKeys = Object.keys(interactList);
        contentHTML = `<div class="direction-split">`;
        dirKeys.forEach(dir => {
            contentHTML += `
                <div class="direction-column">
                    <h4>Direction: ${dir}</h4>
                    <ul class="interaction-list small" style="font-size: 0.65rem;">
                        ${interactList[dir].map(pair => `<li>${pair}</li>`).join('')}
                    </ul>
                </div>
            `;
        });
        contentHTML += `</div>`;
    }

    openFloatingPopup(event, title, contentHTML);
}

function showPlazaInteractions(plazaName, event) {
    if (event) event.stopPropagation();
    if (unmatchedPlaces.length === 0) return;
    const place = unmatchedPlaces[currentIndex];

    let contentHTML = '';
    const directions = place.analytics.plazas?.directions?.[plazaName];

    if (!directions || Object.keys(directions).length === 0) {
        contentHTML = `<p style="padding: 1rem; color: var(--text-secondary); text-align: center;">No directional data available.</p>`;
    } else {
        const dirKeys = Object.keys(directions);
        contentHTML = `<div class="direction-split">`;
        dirKeys.forEach(dir => {
            contentHTML += `
                <div class="direction-column">
                    <h4>Direction: ${dir}</h4>
                    <ul class="interaction-list small" style="font-size: 0.65rem;">
                        ${directions[dir].map(pair => `<li>${pair}</li>`).join('')}
                    </ul>
                </div>
            `;
        });
        contentHTML += `</div>`;
    }

    openFloatingPopup(event, `OD Pairs at ${plazaName}`, contentHTML);
}

/**
 * Returns great-circle distance in km between two lat/lng points.
 */
function calculateHaversine(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return parseFloat((R * c).toFixed(1));
}

function renderMapElements(place) {
    if (!map) return;

    markers.forEach(m => m.setMap(null));
    markers = [];
    lines.forEach(l => {
        if (l.line) l.line.setMap(null);
        if (l.label) l.label.setMap(null);
    });
    lines = [];
    if (map.data) {
        map.data.forEach(feature => map.data.remove(feature));
    }
    if (activeInfoWindow) { activeInfoWindow.close(); activeInfoWindow = null; }
    if (map.tempMarker) { map.tempMarker.setMap(null); map.tempMarker = null; } // Clear pick-from-map marker on navigate

    const bounds = new google.maps.LatLngBounds();
    let hasValidPoints = false;
    let plazas = place.analytics?.plazas;

    // 1. Survey location markers — yellow star icon
    if (plazas && plazas.headers && plazas.coords) {
        plazas.headers.forEach((pName, i) => {
            const coordStr = plazas.coords[i];
            if (coordStr && coordStr.lat && coordStr.lng) {
                const mappedPos = plazaMapping[pName];
                const pos = mappedPos || { lat: parseFloat(coordStr.lat), lng: parseFloat(coordStr.lng) };

                const m = new google.maps.Marker({
                    position: pos,
                    map: map,
                    title: pName,
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 10,
                        fillColor: '#FACC15',
                        fillOpacity: 1,
                        strokeColor: '#92400E',
                        strokeWeight: 2
                    }
                });
                markers.push(m);
                bounds.extend(pos);
                hasValidPoints = true;
            }
        });
    }

    // 2. Suggestion Locations — extend bounds to include all suggestions
    if (place.suggestions) {
        place.suggestions.forEach(s => {
            if (s.lat && s.lng) {
                bounds.extend({ lat: s.lat, lng: s.lng });
                hasValidPoints = true;
            }
        });
    }

    // 3. PLAZA LIST
    const plazaList = [];
    if (plazas && plazas.headers && plazas.coords) {
        plazas.headers.forEach((h, i) => {
            const coord = plazaMapping[h] || (plazas.coords[i] ? { lat: parseFloat(plazas.coords[i].lat), lng: parseFloat(plazas.coords[i].lng) } : null);
            if (coord) plazaList.push({ name: h, pos: coord });
        });
    }

    // 4. FULL CROSS-CONNECT: Draw lines between EVERY plaza and EVERY suggestion
    if (plazaList.length > 0 && place.suggestions && place.suggestions.length > 0) {
        plazaList.forEach(p => {
            // Find the closest suggestion for THIS specific plaza to mark as RED
            let minDForThisPlaza = Infinity;
            let closestSugForThisPlaza = null;
            
            place.suggestions.forEach(s => {
                const d = calculateHaversine(p.pos.lat, p.pos.lng, s.lat, s.lng);
                if (d < minDForThisPlaza) {
                    minDForThisPlaza = d;
                    closestSugForThisPlaza = s;
                }
            });

            // Now draw lines to ALL suggestions from this plaza
            place.suggestions.forEach(s => {
                const dist = calculateHaversine(p.pos.lat, p.pos.lng, s.lat, s.lng);
                
                // Store distance locally on suggestion for the Popup UI
                s.plazaDistances = s.plazaDistances || [];
                s.plazaDistances.push({ plaza: p.name, distance: dist });

                const isClosestForThisPlaza = (s === closestSugForThisPlaza);
                
                let color = '#4285F4'; // Default Blue
                let weight = 1.5;
                let zIndex = 50;

                if (isClosestForThisPlaza) {
                    color = '#EF4444'; // Red for closest
                    weight = 3.5;
                    zIndex = 1000;
                } else {
                    // Check if suggestion is outside assigned zone for orange color
                    if (currentMode === "Place assign" && place.assigned_zone && s.zone !== place.assigned_zone) {
                        color = '#FF9800'; 
                    }
                }

                drawMapLine(p.pos, { lat: s.lat, lng: s.lng }, color, weight, zIndex);
            });
        });
    }

    function drawMapLine(p1, p2, color, weight, zIndex) {
        const line = new google.maps.Polyline({
            path: [p1, p2],
            geodesic: true,
            strokeColor: color,
            strokeOpacity: 0.8,
            strokeWeight: weight,
            zIndex: zIndex,
            map: map
        });

        lines.push({ line });
    }

    if (hasValidPoints) {
        if (currentMode === "Place assign") {
            const strictBounds = new google.maps.LatLngBounds();
            let hasStrictPoints = false;
            if (plazas && plazas.coords) {
                plazas.coords.forEach((coord, i) => {
                    if (coord.lat && coord.lng) {
                        const pos = plazaMapping[plazas.headers[i]] || { lat: parseFloat(coord.lat), lng: parseFloat(coord.lng) };
                        strictBounds.extend(pos);
                        hasStrictPoints = true;
                    }
                });
            }
            if (place.zoneGeometry) {
                // Restore visibility of the zone boundary on the map
                map.data.addGeoJson({ type: "Feature", geometry: place.zoneGeometry });
                map.data.setStyle({
                    fillColor: '#4285F4',
                    fillOpacity: 0.05,
                    strokeColor: '#4285F4',
                    strokeWeight: 2,
                    clickable: false
                });

                const tempFeatures = new google.maps.Data();
                tempFeatures.addGeoJson({ type: "Feature", geometry: place.zoneGeometry });
                tempFeatures.forEach(f => {
                    f.getGeometry().forEachLatLng(ll => {
                        strictBounds.extend(ll);
                        hasStrictPoints = true;
                    });
                });
            }
            if (hasStrictPoints) {
                map.fitBounds(strictBounds);
            } else {
                map.fitBounds(bounds);
            }
        } else {
            map.fitBounds(bounds);
        }

        const listener = google.maps.event.addListener(map, "idle", function () {
            if (map.getZoom() > 14) map.setZoom(14);
            google.maps.event.removeListener(listener);
        });
    }
}

function navigatePlace(direction) {
    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < unmatchedPlaces.length) {
        currentIndex = newIndex;
        updateNavigatorDisplay();
        renderCurrentPlace();
    }
}

async function renderCurrentPlace() {
    if (unmatchedPlaces.length === 0) return;

    const place = unmatchedPlaces[currentIndex];

    // Update Header Name
    document.getElementById('selected-place-name').textContent = place.original_name;

    // Update Zone Side Item (Place assign mode only)
    const zoneTag = document.getElementById('place-zone-tag');
    const zoneDisplay = document.getElementById('place-zone-display');
    if (currentMode === "Place assign" && place.assigned_zone) {
        zoneTag.style.display = 'flex';
        zoneDisplay.textContent = place.assigned_zone;
    } else {
        zoneTag.style.display = 'none';
    }

    // Render Analytics directly into permanent layout
    renderVehicleAnalytics(place.analytics.vehicles, place.analytics.vehicleInteractions);
    renderPlazaAnalytics(place.analytics.plazas);

    // Choose correct commodity matrix based on toggle
    const matrix = commodityViewMode === 'detailed' ? place.analytics.commodityMatrixDetailed : place.analytics.commodityMatrixAbstract;
    renderCommodityMatrix(matrix);


    // If suggestions haven't been fetched yet for this place, fetch them lazily
    if (!place.suggestions || place.suggestions.length === 0) {
        // Show loading state for map/suggestions implicitly by clearing old markers
        // and optionally showing a toast or updating the suggestion list UI
        document.title = "Fetching suggestions... GeoValidate OD";

        try {
            const params = new URLSearchParams();
            params.append('name', place.original_name);

            // Build real plaza coords from confirmed plazaMapping (not default centroid)
            const plazaNames = place.analytics.plazas?.headers || [];
            const realPlazaCoords = [];
            const realPlazaMeta = [];
            plazaNames.forEach(pName => {
                const coord = plazaMapping[pName];
                if (coord && coord.lat && coord.lng) {
                    realPlazaCoords.push({ lat: coord.lat, lng: coord.lng });
                    realPlazaMeta.push(pName);
                }
            });

            if (realPlazaCoords.length > 0) {
                params.append('plaza_coords', JSON.stringify(realPlazaCoords));
                params.append('plaza_names', JSON.stringify(realPlazaMeta));
            }


            // If in Place Assign mode, strictly enforce the polygon constraint
            if (currentMode === "Place assign" && place.assigned_zone) {
                params.append('zone_restriction', place.assigned_zone);
            }

            if (selectedState && selectedState !== "All States") {
                params.append('state', selectedState);
            }

            const response = await fetch(`http://localhost:8000/api/suggestions?${params.toString()}`);
            if (response.ok) {
                const data = await response.json();
                if (data.error && currentMode === "Place assign") {
                    console.error("Backend Error:", data.error);
                    window.warnedZones = window.warnedZones || new Set();
                    if (!window.warnedZones.has(data.error)) {
                        alert("Constraint Error: " + data.error + "\n\nPlease ensure your Shapefile is uploaded and contains this zone.");
                        window.warnedZones.add(data.error);
                    }
                }
                place.suggestions = data.suggestions || [];
                place.zoneGeometry = data.zoneGeometry || null;
            } else {
                place.suggestions = [];
            }
        } catch (error) {
            console.error("Failed to fetch suggestions:", error);
            place.suggestions = [];
        } finally {
            document.title = "GeoValidate OD";
        }
    }

    // Render Suggestions and Plazas on Map
    renderMapElements(place);

    // Draw suggestion markers separately to keep them on top
    if (place.suggestions) {
        place.suggestions.forEach(s => {
            if (s.lat && s.lng) {
                const pos = { lat: s.lat, lng: s.lng };

                // Build a concise label: if formatted_address exists, show a short region hint
                let markerLabel = s.name;
                if (s.formatted_address) {
                    // Extract a short region hint from the full address (e.g., "Gorakhpur, Uttar Pradesh" from "Gorakhpur, Uttar Pradesh 273001, India")
                    const parts = s.formatted_address.split(',').map(p => p.trim());
                    // Take first 2 meaningful parts (skip zip/country usually at end)
                    const shortAddr = parts.length > 2 ? parts.slice(0, 2).join(', ') : parts.slice(0, -1).join(', ');
                    if (shortAddr && shortAddr.toLowerCase() !== s.name.toLowerCase()) {
                        markerLabel = shortAddr;
                    }
                }

                const m = new google.maps.Marker({
                    position: pos,
                    map: map,
                    title: s.formatted_address || s.name,
                    icon: {
                        url: "http://maps.google.com/mapfiles/ms/icons/red-dot.png",
                        scaledSize: new google.maps.Size(25, 25)
                    },
                    label: {
                        text: markerLabel,
                        color: "#B91C1C",
                        className: "suggestion-marker-label",
                        fontSize: "12px",
                        fontWeight: "600"
                    }
                });

                m.addListener('click', () => {
                    if (activeInfoWindow) activeInfoWindow.close();
                    const content = document.createElement('div');
                    content.style.cssText = 'color:black; min-width:220px; font-family:sans-serif; padding:5px;';
                    
                    const plazas = place.analytics?.plazas?.headers || [];
                    const resolvedFor = resolvedPlaces[place.original_name] || {};
                    const unresolvedPlazas = plazas.filter(p => !resolvedFor[p] && !resolvedFor["__all__"]);

                    const distHtml = (s.plazaDistances || []).map(pd => 
                        `<div style="font-size:12px;margin-bottom:4px;">📍 <strong>${pd.distance} km</strong> from ${pd.plaza}</div>`
                    ).join('') || (s.dist_km != null ? `<div style="font-size:12px;margin-bottom:4px;">📍 Distance: <strong>${s.dist_km} km</strong></div>` : '');

                    content.innerHTML = `
                        <div style="font-weight:bold;font-size:14px;margin-bottom:4px;border-bottom:1px solid #eee;padding-bottom:5px;">${s.name}</div>
                        ${s.formatted_address ? `<div style="font-size:11px;color:#555;margin-bottom:8px;">📌 ${s.formatted_address}</div>` : ''}
                        
                        <div style="margin-bottom:8px; line-height: 1.4;">
                            ${distHtml}
                        </div>

                        ${s.zone ? `<div style="font-size:12px;margin-bottom:10px;">🗺️ Zone: <strong>${s.zone}</strong></div>` : ''}
                        
                        <div style="margin-bottom:12px;">
                            <label style="font-size:11px; font-weight:600; color:#666; display:block; margin-bottom:5px;">RESOLVE FOR:</label>
                            <label style="display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; margin-bottom:6px;">
                                <input type="checkbox" id="resolve-all-check" checked> Apply to ALL Plazas
                            </label>
                            <div id="plaza-selection-list" style="display:none; margin-left:20px; max-height:100px; overflow-y:auto; border:1px solid #eee; border-radius:4px; padding:4px;">
                                ${plazas.map(p => `
                                    <label style="display:flex; align-items:center; gap:6px; font-size:11px; margin-bottom:3px; padding:2px; ${resolvedFor[p] ? 'color:#999; text-decoration:line-through;' : ''}">
                                        <input type="checkbox" class="plaza-resolve-item" value="${p}" ${resolvedFor[p] ? 'disabled' : 'checked'}> ${p}
                                    </label>
                                `).join('')}
                            </div>
                        </div>
                    `;

                    const resolveBtn = document.createElement('button');
                    resolveBtn.textContent = 'Confirm & Resolve';
                    resolveBtn.style.cssText = 'background:#16a34a;color:white;border:none;padding:8px 10px;border-radius:4px;cursor:pointer;width:100%;font-size:12px;font-weight:600;box-shadow:0 2px 4px rgba(0,0,0,0.1);';
                    
                    resolveBtn.addEventListener('click', () => {
                        const resolveAll = content.querySelector('#resolve-all-check').checked;
                        let selectedPlazas = null;
                        if (!resolveAll) {
                            selectedPlazas = Array.from(content.querySelectorAll('.plaza-resolve-item:checked')).map(i => i.value);
                            if (selectedPlazas.length === 0) {
                                alert("Please select at least one plaza or choose 'Apply to ALL'.");
                                return;
                            }
                        }
                        
                        if (activeInfoWindow) activeInfoWindow.close();
                        selectSuggestion(place.id, s, selectedPlazas);
                    });

                    content.appendChild(resolveBtn);

                    // Toggle sub-list
                    const allCheck = content.querySelector('#resolve-all-check');
                    const subList = content.querySelector('#plaza-selection-list');
                    allCheck.addEventListener('change', () => {
                        subList.style.display = allCheck.checked ? 'none' : 'block';
                    });

                    const iw = new google.maps.InfoWindow({ content });
                    iw.open(map, m);
                    activeInfoWindow = iw;
                });

                markers.push(m);
            }
        });
    }
}
function selectSuggestion(rowId, suggestion, selectedPlazas = null) {
    const place = unmatchedPlaces[currentIndex];
    
    const resolveData = {
        name: suggestion.name,
        lat: suggestion.lat,
        lng: suggestion.lng,
        zone: suggestion.zone || "Unknown",
        resolved_by: currentUser !== "All Users" ? currentUser : (place.assigned_user || "System"),
        rawPlaceInfo: place
    };

    // Auto-add the resolved Google name to the places database if not already present
    if (suggestion.name && suggestion.name.trim()) {
        fetch('http://localhost:8000/api/database/add_place', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: suggestion.name.trim() })
        }).then(res => res.json())
          .then(data => { if (data.status === 'success') console.log(`DB: Added "${suggestion.name}"`); })
          .catch(() => {}); // Fire-and-forget, don't block resolution
    }

    if (!resolvedPlaces[place.original_name]) {
        resolvedPlaces[place.original_name] = {};
    }

    if (!selectedPlazas) {
        // Resolve for ALL
        resolvedPlaces[place.original_name]["__all__"] = resolveData;
    } else {
        // Resolve for specific plazas
        selectedPlazas.forEach(p => {
            resolvedPlaces[place.original_name][p] = resolveData;
        });
    }

    // Fetches zone in background if missing
    if (resolveData.zone === "Unknown" || resolveData.zone === "Calculating...") {
        fetchZoneForLocation(suggestion.lat, suggestion.lng).then(data => {
            if (data && data.zone) {
                if (selectedPlazas) {
                    selectedPlazas.forEach(p => {
                        if (resolvedPlaces[place.original_name][p]) resolvedPlaces[place.original_name][p].zone = data.zone;
                    });
                } else {
                    resolvedPlaces[place.original_name]["__all__"].zone = data.zone;
                }
            }
        });
    }

    // Check if fully resolved
    const recordedPlazas = place.analytics?.plazas?.headers || [];
    const mapping = resolvedPlaces[place.original_name];
    const isFullyResolved = mapping["__all__"] || recordedPlazas.every(p => mapping[p]);

    if (isFullyResolved) {
        const similars = findSimilarUnmatchedPlaces(place.original_name);

        // Remove current place
        unmatchedPlaces.splice(currentIndex, 1);

        // Also remove from allUnmatchedPlaces so it doesn't reappear
        const globalIndex = allUnmatchedPlaces.findIndex(p => p.id === place.id);
        if (globalIndex !== -1) {
            allUnmatchedPlaces.splice(globalIndex, 1);
        }

        if (similars.length > 0) {
            showSimilarityModal(place.original_name, resolveData.zone, similars, resolveData);
            return;
        }

        if (pendingReturnToPlaceId) {
            let backIdx = unmatchedPlaces.findIndex(p => p.id === pendingReturnToPlaceId);
            if (backIdx !== -1) {
                currentIndex = backIdx;
            }
            pendingReturnToPlaceId = null;
        } else {
            if (currentIndex >= unmatchedPlaces.length) {
                currentIndex = Math.max(0, unmatchedPlaces.length - 1);
            }
        }
    }

    // Re-render
    updateNavigatorDisplay();
    renderCurrentPlace();
    
    // Auto-Save progress
    triggerAutoSave();
}

// Manual Map Selection Click Button Helper
function manualMapSelect() {
    if (unmatchedPlaces.length === 0) return;
    alert("Map Interaction Mode Enabled: Click anywhere on the map to drop a pin and resolve this location manually.");
}

function toggleReviewDropdown() {
    const dropdown = document.getElementById('review-dropdown');

    if (!dropdown.classList.contains('show')) {
        dropdown.innerHTML = '';
        const resolvedKeys = Object.keys(resolvedPlaces);

        if (resolvedKeys.length === 0) {
            dropdown.innerHTML = `<div style="padding: 1rem; color: var(--text-secondary); text-align: center; font-size: 0.85rem;">No places validated yet.</div>`;
        } else {
            resolvedKeys.forEach(origName => {
                const mapping = resolvedPlaces[origName];
                const item = document.createElement('div');
                item.className = 'review-dropdown-item';
                item.style.flexDirection = 'column';
                item.style.alignItems = 'flex-start';

                const nameHeader = document.createElement('div');
                nameHeader.style.display = 'flex';
                nameHeader.style.justifyContent = 'space-between';
                nameHeader.style.width = '100%';
                nameHeader.style.marginBottom = '4px';

                const nameSpan = document.createElement('span');
                nameSpan.innerHTML = `<b>${origName}</b>`;

                const editBtn = document.createElement('button');
                editBtn.className = 'btn btn-sm btn-outline';
                editBtn.textContent = 'Edit';
                editBtn.onclick = (e) => { e.stopPropagation(); editResolvedPlace(origName); };

                nameHeader.appendChild(nameSpan);
                nameHeader.appendChild(editBtn);
                item.appendChild(nameHeader);

                // List resolved plazas
                const details = document.createElement('div');
                details.style.fontSize = '11px';
                details.style.color = '#666';
                if (mapping["__all__"]) {
                    details.innerHTML = `&rarr; ${mapping["__all__"].name} (All Plazas)`;
                } else {
                    const plazaNames = Object.keys(mapping).filter(k => k !== "rawPlaceInfo");
                    details.innerHTML = `&rarr; ${plazaNames.length} custom plaza mappings`;
                }
                item.appendChild(details);
                dropdown.appendChild(item);
            });
        }
    }
    dropdown.classList.toggle('show');
}


function openProject() {
    alert("Open Project feature coming soon! This will allow you to resume a saved session by uploading a previously saved mapping file.");
}

// SETUP PLACEHOLDERS
function setupSurveyLocations() {
    const plazas = new Set();
    allUnmatchedPlaces.forEach(p => {
        if (p.analytics && p.analytics.plazas && p.analytics.plazas.headers) {
            p.analytics.plazas.headers.forEach(h => plazas.add(h));
        }
    });

    const uniquePlazas = Array.from(plazas).sort();
    if (uniquePlazas.length === 0) {
        alert("No plazas found in the current dataset. Please upload an OD dataset first.");
        return;
    }

    document.getElementById('survey-modal').classList.add('active');
    document.getElementById('setup-sub-dropdown').classList.add('collapsed-sub');
    renderSurveyModal(uniquePlazas);
}

function closeSurveyModal() {
    document.getElementById('survey-modal').classList.remove('active');
    pickingPlaza = null;
}

function renderSurveyModal(plazas) {
    const container = document.getElementById('survey-plaza-list');
    container.innerHTML = '';

    plazas.forEach(name => {
        const isMapped = !!plazaMapping[name];
        const row = document.createElement('div');
        row.className = `plaza-row ${isMapped ? 'mapped' : ''}`;
        row.id = `plaza-row-${name.replace(/\s+/g, '-')}`;

        row.innerHTML = `
            <div class="plaza-label" title="${name}">${name}</div>
            <div class="plaza-search-container">
                <input type="text" class="plaza-search-input" 
                       id="plaza-input-${name.replace(/\s+/g, '-')}" 
                       placeholder="${isMapped ? 'Mapped' : 'Search location...'}"
                       value="${isMapped ? 'Mapped ✓' : ''}">
            </div>
            <button class="plaza-pick-btn ${pickingPlaza === name ? 'active' : ''}" 
                    onclick="startPlazaPick('${name}')" title="Pick from map">
                +
            </button>
        `;
        container.appendChild(row);

        // Init Autocomplete
        const input = document.getElementById(`plaza-input-${name.replace(/\s+/g, '-')}`);
        const autocomplete = new google.maps.places.Autocomplete(input);
        autocomplete.addListener('place_changed', () => {
            const place = autocomplete.getPlace();
            if (place.geometry) {
                plazaMapping[name] = {
                    lat: place.geometry.location.lat(),
                    lng: place.geometry.location.lng()
                };
                row.classList.add('mapped');
                input.value = "Mapped ✓";
            }
        });
    });
}

function startPickingPlaza(name) {
    pickingPlaza = name;

    // Update Left-Pane View buttons state
    renderPlazaMappingView();

    // Update Modal buttons state (if modal is open)
    const btns = document.querySelectorAll('.plaza-pick-btn');
    btns.forEach(b => b.classList.remove('active'));
    // Note: event might not be defined if called from pane, so we use selectors instead

    alert(`Picking mode active for "${name}". \nPlease click a location on the map to assign it to this plaza.`);

    // Center map on existing mapping or general area
    if (map) {
        if (plazaMapping[name]) {
            map.panTo(plazaMapping[name]);
        } else {
            const firstPlaza = Object.values(plazaMapping)[0];
            if (firstPlaza) map.panTo(firstPlaza);
        }
    }
}

function applyPlazaMapping() {
    // Re-render markers if dataset is loaded
    if (unmatchedPlaces.length > 0) {
        renderCurrentPlace();
    }
    closeSurveyModal();
    alert("Plaza locations updated on map.");
}

function setupUsers() {
    document.getElementById('user-modal').classList.add('active');
    document.getElementById('setup-sub-dropdown').classList.add('collapsed-sub');
    generateUserNameInputs();
}

function closeUserModal() {
    document.getElementById('user-modal').classList.remove('active');
}

function generateUserNameInputs() {
    const container = document.getElementById('user-names-container');
    const count = parseInt(document.getElementById('user-count').value) || 1;

    // Save current values to avoid wiping them when changing count
    const currentValues = Array.from(container.querySelectorAll('input')).map(i => i.value);

    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const row = document.createElement('div');
        row.className = 'user-name-row';
        row.innerHTML = `<input type="text" class="user-name-input" placeholder="User Name ${i + 1}" value="${currentValues[i] || ''}">`;
        container.appendChild(row);
    }
}

function applyUserAssignments() {
    const inputs = document.querySelectorAll('.user-name-input');
    const names = Array.from(inputs).map(i => i.value.trim()).filter(n => n !== '');

    if (names.length === 0) {
        alert("Please enter at least one user name.");
        return;
    }

    allUsers = names;
    currentUser = "All Users"; // Default to All Users after setup

    if (allUnmatchedPlaces.length > 0) {
        // Distribute workload equally (Round-Robin)
        allUnmatchedPlaces.forEach((place, index) => {
            place.assigned_user = allUsers[index % allUsers.length];
        });

        alert(`Workload distributed! ${allUnmatchedPlaces.length} places assigned to ${allUsers.length} users.`);
    } else {
        alert("User list updated. No places loaded yet to distribute.");
    }

    renderUserDropdown();
    filterPlacesByUser();
    closeUserModal();
}

// BASE NUMBER PLACEHOLDERS
function assignPlaza() {
    alert("IHMCL Database - Assign Plaza: Processing plaza assignments for the current dataset...");
    document.getElementById('ihmcl-sub-dropdown').classList.add('collapsed-sub');
}

function runSCF() {
    alert("IHMCL Database - SCF: Computing Seasonal Correction Factors...");
    document.getElementById('ihmcl-sub-dropdown').classList.add('collapsed-sub');
}

function runAADT() {
    alert("IHMCL Database - AADT: Computing Annual Average Daily Traffic...");
    document.getElementById('ihmcl-sub-dropdown').classList.add('collapsed-sub');
}

function customAADT() {
    alert("Custom AADT: This feature will allow you to import and apply custom AADT values.");
    document.getElementById('base-sub-dropdown').classList.add('collapsed-sub');
}

function editResolvedPlace(origName) {
    document.getElementById('review-dropdown').classList.remove('show');

    const mapping = resolvedPlaces[origName];
    if (!mapping) return;

    // Find rawPlaceInfo from any of the keys
    let placeToEdit = null;
    for (let key in mapping) {
        if (mapping[key].rawPlaceInfo) {
            placeToEdit = mapping[key].rawPlaceInfo;
            break;
        }
    }

    if (!placeToEdit) {
        alert("Error: Unable to locate original place data to edit.");
        return;
    }

    // Remove from resolved dictionary
    delete resolvedPlaces[origName];

    // Re-insert at the FRONT
    unmatchedPlaces.unshift(placeToEdit);
    currentIndex = 0;

    updateNavigatorDisplay();
    renderCurrentPlace();
}

// ==== Similarity Suggestion Logic ====

let pendingSimilarityResolveData = null;
let pendingReturnToPlaceId = null;

function jaroWinklerSimilarity(s1, s2) {
    if (s1.length === 0 || s2.length === 0) return 0;
    if (s1 === s2) return 1;

    let range = (Math.floor(Math.max(s1.length, s2.length) / 2)) - 1;
    let s1Matches = new Array(s1.length).fill(false);
    let s2Matches = new Array(s2.length).fill(false);

    let m = 0;
    for (let i = 0; i < s1.length; i++) {
        let start = Math.max(0, i - range);
        let end = Math.min(i + range + 1, s2.length);

        for (let j = start; j < end; j++) {
            if (!s2Matches[j] && s1[i] === s2[j]) {
                s1Matches[i] = true;
                s2Matches[j] = true;
                m++;
                break;
            }
        }
    }

    if (m === 0) return 0;

    let k = 0, numTranspositions = 0;
    for (let i = 0; i < s1.length; i++) {
        if (s1Matches[i]) {
            while (!s2Matches[k]) k++;
            if (s1[i] !== s2[k]) numTranspositions++;
            k++;
        }
    }

    let jaro = ((m / s1.length) + (m / s2.length) + ((m - (numTranspositions / 2)) / m)) / 3;

    let p = 0.1;
    let l = 0;
    while (l < 4 && s1[l] === s2[l]) {
        l++;
    }

    return jaro + l * p * (1 - jaro);
}

function findSimilarUnmatchedPlaces(name) {
    let similars = [];
    let normalizedName = name.toLowerCase().trim();
    if (normalizedName.length <= 3) return similars;

    allUnmatchedPlaces.forEach(p => {
        let pName = p.original_name.toLowerCase().trim();
        if (pName !== normalizedName) {
            let similarity = jaroWinklerSimilarity(normalizedName, pName);
            if (similarity >= 0.90) {
               similars.push(p);
            }
        }
    });

    return similars.filter(p => !resolvedPlaces[p.original_name]);
}

function showSimilarityModal(originalName, zone, similars, resolveData) {
    document.getElementById('similarity-modal-orig').textContent = originalName;
    document.getElementById('similarity-modal-zone').textContent = zone || '?';
    
    // Deep clone resolveData but exclude rawPlaceInfo
    pendingSimilarityResolveData = { ...resolveData };
    
    const list = document.getElementById('similarity-modal-list');
    list.innerHTML = '';
    
    similars.forEach(sim => {
        let occ = placeOccurrencesMap[sim.original_name] || 0;
        let li = document.createElement('div');
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';
        li.style.padding = '8px 12px';
        li.style.borderBottom = '1px solid var(--border)';
        li.id = `sim-row-${sim.id}`;
        
        li.innerHTML = `
            <div style="font-weight: 600; color: var(--text-primary);">${sim.original_name} <span style="font-weight: normal; color: var(--text-secondary); font-size: 11px;">(${occ} occurrences)</span></div>
            <div style="display: flex; gap: 8px;">
                <button class="btn btn-sm btn-primary" onclick="assignSimilar('${sim.id}')">Assign</button>
                <button class="btn btn-sm btn-outline" onclick="reviewSimilar('${sim.id}')">Review & Assign</button>
            </div>
        `;
        list.appendChild(li);
    });
    
    document.getElementById('similarity-modal').classList.add('active');
}

function assignSimilar(placeId) {
    let place = allUnmatchedPlaces.find(p => p.id == placeId);
    if (!place) return;
    
    let resolveData = { ...pendingSimilarityResolveData };
    resolveData.rawPlaceInfo = place;
    
    if (!resolvedPlaces[place.original_name]) {
        resolvedPlaces[place.original_name] = {};
    }
    resolvedPlaces[place.original_name]["__all__"] = resolveData;
    
    let uidx = unmatchedPlaces.findIndex(p => p.id == placeId);
    if (uidx !== -1) {
        unmatchedPlaces.splice(uidx, 1);
        if (currentIndex > uidx) currentIndex--; 
        else if (currentIndex >= unmatchedPlaces.length) currentIndex = Math.max(0, unmatchedPlaces.length - 1);
    }
    let gidx = allUnmatchedPlaces.findIndex(p => p.id == placeId);
    if (gidx !== -1) allUnmatchedPlaces.splice(gidx, 1);
    
    let row = document.getElementById(`sim-row-${placeId}`);
    if (row) {
        row.innerHTML = `<div style="color: #16a34a; font-weight: 600;">${place.original_name} - Assigned ✓</div>`;
    }
    
    triggerAutoSave();
}

function reviewSimilar(placeId) {
    let uidx = unmatchedPlaces.findIndex(p => p.id == placeId);
    if (uidx !== -1) {
        if (!pendingReturnToPlaceId && unmatchedPlaces[currentIndex]) {
            pendingReturnToPlaceId = unmatchedPlaces[currentIndex].id;
        }
        currentIndex = uidx;
        closeSimilarityModal();
    } else {
        alert("Cannot review, place not found in current view.");
    }
}

function closeSimilarityModal() {
    document.getElementById('similarity-modal').classList.remove('active');
    pendingSimilarityResolveData = null;
    updateNavigatorDisplay();
    renderCurrentPlace();
}

// Manual Text Search utilizing Google Places Service
function manualTextSearch() {
    if (unmatchedPlaces.length === 0 || !map) return;
    const input = document.getElementById('manual-search-input').value;
    if (!input) return;

    const request = {
        query: input,
        fields: ['name', 'geometry'],
    };

    const service = new google.maps.places.PlacesService(map);
    service.findPlaceFromQuery(request, async (results, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && results && results.length > 0) {
            const placeData = results[0];
            const lat = placeData.geometry.location.lat();
            const lng = placeData.geometry.location.lng();

            // Pan to it
            map.setCenter(placeData.geometry.location);
            map.setZoom(14);

            // Remove temp marker if any
            if (map.tempMarker) map.tempMarker.setMap(null);

            // Place marker
            map.tempMarker = new google.maps.Marker({
                position: placeData.geometry.location,
                map: map,
                icon: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png',
                animation: google.maps.Animation.DROP
            });

            // Find PIP Zone
            const zoneData = await fetchZoneForLocation(lat, lng);
            const zoneId = zoneData ? zoneData.zone : "Unknown Zone";

            // Open info window to confirm
            const place = unmatchedPlaces[currentIndex];
            const infoContent = document.createElement('div');
            infoContent.style.cssText = 'color: black; min-width: 220px; font-family:sans-serif; padding:5px;';
            
            const plazas = place.analytics?.plazas?.headers || [];
            const resolvedFor = resolvedPlaces[place.original_name] || {};

            infoContent.innerHTML = `
                <div style="font-weight: bold; font-size: 14px; margin-bottom: 3px; border-bottom:1px solid #eee; padding-bottom:5px;">${placeData.name}</div>
                <div style="font-size: 11px; color: #666; margin-bottom: 5px;">📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
                <div style="font-size: 12px; color: #d59563; font-weight: bold; margin-bottom: 8px;">🗺️ Zone: ${zoneId}</div>
                <div style="margin-bottom:12px;">
                    <label style="font-size:11px; font-weight:600; color:#666; display:block; margin-bottom:5px;">RESOLVE FOR:</label>
                    <label style="display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; margin-bottom:6px;">
                        <input type="checkbox" id="resolve-all-check" checked> Apply to ALL Plazas
                    </label>
                    <div id="plaza-selection-list" style="display:none; margin-left:20px; max-height:100px; overflow-y:auto; border:1px solid #eee; border-radius:4px; padding:4px;">
                        ${plazas.map(p => `
                            <label style="display:flex; align-items:center; gap:6px; font-size:11px; margin-bottom:3px; padding:2px; ${resolvedFor[p] ? 'color:#999; text-decoration:line-through;' : ''}">
                                <input type="checkbox" class="plaza-resolve-item" value="${p}" ${resolvedFor[p] ? 'disabled' : 'checked'}> ${p}
                            </label>
                        `).join('')}
                    </div>
                </div>
            `;

            const btn = document.createElement('button');
            btn.textContent = `Confirm & Resolve`;
            btn.style.cssText = 'background:#16a34a;color:white;border:none;padding:8px 10px;border-radius:4px;cursor:pointer;width:100%;font-size:12px;font-weight:600;box-shadow:0 2px 4px rgba(0,0,0,0.1);';
            btn.addEventListener('click', () => {
                const resolveAll = infoContent.querySelector('#resolve-all-check').checked;
                let selectedPlazas = null;
                if (!resolveAll) {
                    selectedPlazas = Array.from(infoContent.querySelectorAll('.plaza-resolve-item:checked')).map(i => i.value);
                    if (selectedPlazas.length === 0) {
                        alert("Please select at least one plaza or choose 'Apply to ALL'.");
                        return;
                    }
                }

                if (activeInfoWindow) activeInfoWindow.close();
                selectSuggestion(place.id, {
                    name: placeData.name,
                    lat: lat,
                    lng: lng,
                    zone: zoneId
                }, selectedPlazas);
                triggerAutoSave();
            });

            infoContent.appendChild(btn);

            // Toggle sub-list
            const allCheck = infoContent.querySelector('#resolve-all-check');
            const subList = infoContent.querySelector('#plaza-selection-list');
            allCheck.addEventListener('change', () => {
                subList.style.display = allCheck.checked ? 'none' : 'block';
            });

            const infowindow = new google.maps.InfoWindow({ content: infoContent });
            if (activeInfoWindow) activeInfoWindow.close();
            infowindow.open(map, map.tempMarker);
            activeInfoWindow = infowindow;
        } else {
            alert(`No exact matches found by Google Places for: "${input}". Try picking on the map directly.`);
        }
    });
}

// 1. File Dropdown
const fileBtn = document.getElementById("file-btn-main");
const fileDropdown = document.getElementById("file-dropdown-main");

if (fileBtn) {
    fileBtn.addEventListener("click", () => {
        if (fileDropdown) fileDropdown.classList.toggle("show");
    });
}

document.addEventListener("click", (e) => {
    // 1. Dropdowns (Project, User, Review)
    const selectors = [
        { container: '.project-selector', dropdown: 'project-dropdown' },
        { container: '.user-selector', dropdown: 'user-dropdown' },
        { container: '.review-selector', dropdown: 'review-dropdown' }
    ];

    selectors.forEach(s => {
        if (!e.target.closest(s.container)) {
            const el = document.getElementById(s.dropdown);
            if (el) el.classList.remove('show');
        }
    });

    // 2. Floating Popup (Analytics Map Info)
    const popup = document.getElementById("floating-popup");
    if (popup && popup.classList.contains("active")) {
        // Close if click is outside the popup AND outside any trigger elements
        const isTrigger = e.target.closest(".clickable-vehicle") ||
            e.target.closest(".clickable-plaza") ||
            e.target.closest(".clickable-plaza-hdr");

        if (!e.target.closest(".floating-popup") && !isTrigger) {
            closeFloatingPopup();
        }
    }

    // 3. User Management Modal
    const userModal = document.getElementById("user-modal");
    if (userModal && userModal.classList.contains("active")) {
        // Close only if clicking the background overlay (outside modal-content)
        if (e.target === userModal) {
            closeUserModal();
        }
    }

    // 4. Survey Mapping Modal
    const surveyModal = document.getElementById("survey-modal");
    if (surveyModal && surveyModal.classList.contains("active")) {
        if (e.target === surveyModal) {
            closeSurveyModal();
        }
    }
});

function checkFilesCollapsed() {
    const shpBtn = document.getElementById('shapefile-label');
    const odBtn = document.getElementById('file-label');
    const shpLoaded = shpBtn && shpBtn.classList.contains('loaded');
    const odLoaded = odBtn && odBtn.classList.contains('loaded');

    if (shpLoaded && odLoaded) {
        const filesSub = document.getElementById('files-sub-dropdown');
        if (filesSub) filesSub.classList.add('collapsed-sub');
    }
}

/* ========================= */
/* PERSISTENCE & SESSION     */
/* ========================= */

function saveProgress(withAlert = true) {
    const session = {
        allUnmatchedPlaces,
        resolvedPlaces,
        allUsers,
        currentUser,
        currentMode,
        plazaMapping,
        plazaMappingConfirmed,
        uniquePlazas,
        filesUploaded,
        currentIndex,
        timestamp: new Date().getTime()
    };

    try {
        localStorage.setItem('geovalidate_session', JSON.stringify(session));
        if (withAlert) alert("Progress saved successfully to local storage!");
        checkSavedSession(); // Update resume button visibility
    } catch (e) {
        console.error("Save failed:", e);
        alert("Failed to save progress. Local storage may be full.");
    }
}

function checkSavedSession() {
    const sessionStr = localStorage.getItem('geovalidate_session');
    const resumeBtn = document.getElementById('resume-btn');
    if (resumeBtn) {
        resumeBtn.style.display = sessionStr ? 'block' : 'none';
    }
}

function resumeSession() {
    const sessionStr = localStorage.getItem('geovalidate_session');
    if (!sessionStr) return;

    try {
        const session = JSON.parse(sessionStr);

        // Restore State
        allUnmatchedPlaces = session.allUnmatchedPlaces || [];
        resolvedPlaces = session.resolvedPlaces || {};
        allUsers = session.allUsers || [];
        currentUser = session.currentUser || "All Users";
        currentMode = session.currentMode || "Zone assign";
        plazaMapping = session.plazaMapping || {};
        plazaMappingConfirmed = session.plazaMappingConfirmed || false;
        uniquePlazas = session.uniquePlazas || [];
        filesUploaded = session.filesUploaded || { shp: false, od: false };
        currentIndex = session.currentIndex || 0;

        // Update UI Components
        renderUserDropdown();
        selectUser(currentUser);
        selectMode(currentMode);

        // Switch to Main View
        switchView('view-main');

        // Trigger re-render of map and analytics
        filterPlacesByUser();

        alert(`Session resumed! Found ${Object.keys(resolvedPlaces).length} resolved places and ${allUnmatchedPlaces.length} pending.`);
    } catch (e) {
        console.error("Resume failed:", e);
        alert("Failed to resume session. Saved data may be corrupted.");
    }
}

/* ========================= */
/* BACK / EXIT FLOW          */
/* ========================= */

function showBackOptions() {
    document.getElementById('back-modal').classList.add('active');
}

function closeBackModal() {
    document.getElementById('back-modal').classList.remove('active');
}

function saveAndLeave() {
    saveProgress(false); // Save without alert
    leaveWithoutSaving(); // Then leave
}

function leaveWithoutSaving() {
    closeBackModal();
    switchView('view-mode-selection');
}

/* ========================= */
/* BACKEND STATUS INDICATOR  */
/* ========================= */
async function checkBackendStatus() {
    const dot = document.getElementById("system-dot");

    try {
        const response = await fetch("http://localhost:8000/api/health");

        if (response.ok) {
            dot.classList.remove("offline");
            dot.classList.add("online");
        } else {
            throw new Error();
        }

    } catch (error) {
        dot.classList.remove("online");
        dot.classList.add("offline");
    }
}

/* check every 5 seconds */
setInterval(checkBackendStatus, 5000);

/* check immediately on load */
checkBackendStatus();
/* State Filter Logic */

function toggleStateFilter() {
    const dropdown = document.getElementById("state-dropdown");
    if (!dropdown.classList.contains("show")) {
        renderStateDropdown();
    }
    dropdown.classList.toggle("show");
}

function renderStateDropdown() {
    const dropdown = document.getElementById("state-dropdown");
    dropdown.innerHTML = "";

    // Add "All States" option
    const allOpt = document.createElement("div");
    allOpt.className = "state-item" + (selectedState === "All States" ? " active" : "");
    allOpt.textContent = "All States";
    allOpt.onclick = () => selectState("All States");
    dropdown.appendChild(allOpt);

    INDIAN_STATES.forEach(state => {
        const item = document.createElement("div");
        item.className = "state-item" + (selectedState === state ? " active" : "");
        item.textContent = state;
        item.onclick = () => selectState(state);
        dropdown.appendChild(item);
    });
}

function selectState(stateName) {
    selectedState = stateName;

    // Update button label
    const label = document.getElementById("state-filter-label");
    if (label) label.textContent = stateName === "All States" ? "State" : stateName;

    // Visually highlight filter btn when a state is active  
    const btn = document.getElementById("state-filter-btn");
    if (btn) {
        if (stateName && stateName !== "All States") {
            btn.style.borderColor = "var(--accent)";
            btn.style.color = "var(--accent)";
        } else {
            btn.style.borderColor = "";
            btn.style.color = "";
        }
    }

    // Close dropdown
    document.getElementById("state-dropdown").classList.remove("show");

    // When state changes, clear cached suggestions and re-fetch for current place
    if (unmatchedPlaces.length > 0) {
        const place = unmatchedPlaces[currentIndex];
        place.suggestions = [];
        renderCurrentPlace();
    }
}

function switchCommodityView(mode) {
    commodityViewMode = mode;

    // Update UI active state
    const abstractBtn = document.getElementById('toggle-abstract');
    const detailedBtn = document.getElementById('toggle-detailed');
    if (abstractBtn) abstractBtn.classList.toggle('active', mode === 'abstract');
    if (detailedBtn) detailedBtn.classList.toggle('active', mode === 'detailed');

    const toggleContainer = document.querySelector('.commodity-toggle');
    if (toggleContainer) {
        if (mode === 'detailed') {
            toggleContainer.classList.add('detailed-active');
        } else {
            toggleContainer.classList.remove('detailed-active');
        }
    }

    // Re-render current place with new matrix mode
    if (unmatchedPlaces.length > 0) {
        renderCurrentPlace();
    }
}

// Proximity lines on map replace the suggestion list sidebar

// Close dropdowns when clicking outside
window.addEventListener("click", (e) => {
    if (!e.target.closest(".state-filter-selector")) {
        const d = document.getElementById("state-dropdown");
        if (d) d.classList.remove("show");
    }
    if (!e.target.closest(".user-selector")) {
        const d = document.getElementById("user-dropdown");
        if (d) d.classList.remove("show");
    }
});
