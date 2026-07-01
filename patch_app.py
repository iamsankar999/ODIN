import re

with open("frontend/js/app.js", "r", encoding="utf-8") as f:
    code = f.read()

# 1. Remove projectShpBlob global
code = code.replace("let projectShpBlob = null;\n", "")

# 2. handleWizardFileUpload modification
old_hwfu = """function handleWizardFileUpload(input, type) {
    if (currentMode === 'Place assign') {
        // Place Assign: Button 1 (shp) → new shapefile zip | Button 2 (od) → Zone Assign ZIP
        if (type === 'shp') {
            // Upload new shapefile for re-zoning
            handleShapefileUpload({ target: input });
        } else {
            // Upload previously exported Zone Assign ZIP
            const file = input.files ? input.files[0] : null;
            if (file) handleZoneAssignZipUpload(file);
        }
    } else {
        if (type === 'shp') handleShapefileUpload({ target: input });
        else handleFileUpload({ target: input });
    }
}"""
new_hwfu = """function handleWizardFileUpload(input, type) {
    handleFileUpload({ target: input });
}"""
if old_hwfu in code:
    code = code.replace(old_hwfu, new_hwfu)

# 3. checkWizardCompletion modification
old_cwc = """function checkWizardCompletion() {
    const newProjectReady = filesUploaded.shp && filesUploaded.od;"""
new_cwc = """function checkWizardCompletion() {
    const newProjectReady = filesUploaded.od;"""
code = code.replace(old_cwc, new_cwc)

# 4. selectModeForSetup modification (removing shapefile lines)
old_mode = """    // Restore Zone Assign defaults
    const shpBtn   = document.getElementById('wizard-shp-btn');
    const odBtn    = document.getElementById('wizard-od-btn');
    const shpInput = document.getElementById('wizard-shapefile-upload');
    const odInput  = document.getElementById('wizard-od-upload');
    const openProjectPanel = document.getElementById('panel-open-project');
    
    if (shpBtn && shpBtn.childNodes[0]) shpBtn.childNodes[0].textContent = 'Upload Shapefile';
    if (odBtn && odBtn.childNodes[0]) odBtn.childNodes[0].textContent = 'Upload OD Dataset';
    if (odInput) odInput.accept = '.csv,.xlsx';
    if (openProjectPanel) openProjectPanel.style.display = '';"""
new_mode = """    // Restore Zone Assign defaults
    const odBtn    = document.getElementById('wizard-od-btn');
    const odInput  = document.getElementById('wizard-od-upload');
    const openProjectPanel = document.getElementById('panel-open-project');
    
    if (odBtn && odBtn.childNodes[0]) odBtn.childNodes[0].textContent = 'Upload OD Dataset';
    if (odInput) odInput.accept = '.csv,.xlsx';
    if (openProjectPanel) openProjectPanel.style.display = '';"""
code = code.replace(old_mode, new_mode)

# 5. performAutoSave
old_save = """    // 2. Original Files (Stashed in app state)
    if (projectOdBlob) {
        zip.file("od_dataset.xlsx", projectOdBlob);
    }
    if (projectShpBlob) {
        zip.file("shapefile.zip", projectShpBlob);
    }"""
new_save = """    // 2. Original Files (Stashed in app state)
    if (projectOdBlob) {
        zip.file("od_dataset.xlsx", projectOdBlob);
    }"""
code = code.replace(old_save, new_save)

# 6. parseProjectZip
old_parse = """    if (odFile) {
        const odBlob = await odFile.async("blob");
        projectOdBlob = odBlob;
        currentUploadedFile = odBlob;
        await handleFileUpload(odBlob, true);
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
        await handleShapefileUpload(shpBlob, true);
    }
}"""
new_parse = """    if (odFile) {
        const odBlob = await odFile.async("blob");
        projectOdBlob = odBlob;
        currentUploadedFile = odBlob;
        await handleFileUpload(odBlob, true);
    } else {
        throw new Error("Invalid project bundle: Could not find an Excel (.xlsx) dataset.");
    }
}"""
code = code.replace(old_parse, new_parse)

# 7. Add handleAppendDataUpload
append_data_fn = """
async function handleAppendDataUpload(input) {
    const file = input.files ? input.files[0] : (input.target ? input.target.files[0] : input);
    if (!file) return;

    if (!projectOdBlob) {
        alert("Cannot append data: Original OD dataset is missing from the project.");
        return;
    }

    const btn = document.getElementById('append-od-btn');
    if (btn) {
        btn.classList.add('loading');
        btn.textContent = "Merging & Processing Data...";
    }

    const formData = new FormData();
    formData.append('base_excel', projectOdBlob, 'base_od_dataset.xlsx');
    formData.append('new_excel', file, 'new_od_dataset.xlsx');

    try {
        const response = await fetch('/api/upload/append_excel/process', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Server error");
        }

        const result = await response.json();

        // Download the merged excel blob and replace projectOdBlob
        const blobResp = await fetch(`/api/download/temp_excel/${result.temp_id}`);
        if (blobResp.ok) {
            projectOdBlob = await blobResp.blob();
            currentUploadedFile = projectOdBlob;
        }

        const newPlazasList = result.data.unmatched_places;
        let newPlazasFoundCount = 0;

        // Merge newly detected plazas
        newPlazasList.forEach(p => {
            if (!uniquePlazas.includes(p)) {
                uniquePlazas.push(p);
                allUnmatchedPlaces.push({
                    originalName: p,
                    assigned_user: allUsers[allUnmatchedPlaces.length % Math.max(allUsers.length, 1)] || "All Users"
                });
                newPlazasFoundCount++;
            }
        });

        if (result.data.survey_locations && result.data.survey_locations.length > 0) {
            let newSurveyLocations = false;
            result.data.survey_locations.forEach(sl => {
                if (!plazaMapping[sl]) {
                    plazaMapping[sl] = { lat: null, lng: null }; // Needs mapping
                    newSurveyLocations = true;
                }
            });

            if (newSurveyLocations) {
                alert(`New survey locations detected. Please map them before continuing.`);
                selectMode('Place assign'); 
            }
        }

        globalTotalOccurrences = result.data.total_occurrences;
        placeOccurrencesMap = result.data.place_occurrences;
        filterPlacesByUser(); // refresh UI
        updateProgressUI();

        alert(`Data merged successfully! Found ${newPlazasFoundCount} new places to resolve.`);
        triggerAutoSave();
    } catch (error) {
        console.error("Append upload failed:", error);
        alert("Failed to append data: " + error.message);
    } finally {
        if (btn) {
            btn.classList.remove('loading');
            btn.innerHTML = `+ Append Extra OD Data<input type="file" id="append-od-upload" accept=".xlsx" style="display:none;" onchange="handleAppendDataUpload(this)">`;
        }
    }
}
"""

# Insert handleAppendDataUpload right before handleFileUpload
if "async function handleFileUpload(event" in code:
    code = code.replace("async function handleFileUpload(event", append_data_fn + "\nasync function handleFileUpload(event")

# 8. Remove handleShapefileUpload completely
# We'll use regex to remove it
code = re.sub(r"async function handleShapefileUpload[\s\S]*?(?=\nasync function|\nfunction showLoading)", "", code)

with open("frontend/js/app.js", "w", encoding="utf-8") as f:
    f.write(code)
print("app.js patched.")
