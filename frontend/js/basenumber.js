// basenumber.js

let ihmclPlazas = [];
let ihmclData = {}; // { plazaName: [monthly records] }
let userPlazaMapping = {}; // { surveyLocation: { status: 'mapped'|'skipped', ihmclName: null } }

let currentAnalyticsPlaza = null;
let aadtSelection = null; // e.g. '2023'
let scfSelections = []; // array of selected FYs for SCF averaging
let monthSelections = []; // array of selected months

// Chart instances
let madtChartInst = null;
let madrChartInst = null;

const VEHICLES = ['CAR_JEEP', 'LCV', 'BUS_TRUCK', '3_AXLE', '4_6_AXLE', 'OSV'];

async function startBaseNumberMode() {
    showBaseLoading('Loading IHMCL Plazas...');
    try {
        const response = await fetch('http://localhost:8000/api/ihmcl/plazas');
        const data = await response.json();
        ihmclPlazas = data.plazas || [];
    } catch (e) {
        console.error('Failed to load IHMCL plazas:', e);
        alert('Failed to load IHMCL baseline data from backend.');
        hideBaseLoading();
        return;
    }
    
    hideBaseLoading();
    switchView('view-basenumber-mapping');
    renderMappingList();
}

function showBaseLoading(text) {
    const overlay = document.getElementById('loading-overlay');
    const textEl = document.getElementById('loading-text');
    if (overlay) overlay.style.display = 'flex';
    if (textEl) textEl.innerText = text;
}

function hideBaseLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
}

function renderMappingList() {
    const list = document.getElementById('basenumber-mapping-list');
    list.innerHTML = '';
    
    // Fallback if OD not loaded or not unique
    const plazasToMap = (typeof uniquePlazas !== 'undefined' && uniquePlazas.length > 0) 
        ? uniquePlazas 
        : ['Demo Survey Location 1', 'Demo Survey Location 2']; // fallback for testing without full flow
    
    plazasToMap.forEach(plaza => {
        if (!userPlazaMapping[plaza]) {
            // Attempt auto-map if exact name match exists
            const autoMatch = ihmclPlazas.find(p => p.toLowerCase() === plaza.toLowerCase());
            userPlazaMapping[plaza] = { status: autoMatch ? 'mapped' : 'pending', ihmclName: autoMatch || '' };
        }
        
        const state = userPlazaMapping[plaza];
        const isSkipped = state.status === 'skipped';
        
        let options = '<option value="">-- Select IHMCL Plaza --</option>';
        ihmclPlazas.forEach(ip => {
            options += `<option value="${ip}" ${state.ihmclName === ip ? 'selected' : ''}>${ip}</option>`;
        });
        
        const rowHTML = `
            <div style="flex: 1; font-weight: 500; ${isSkipped ? 'text-decoration: line-through; opacity: 0.5;' : ''}">${plaza}</div>
            <select class="data-input" style="flex: 2; padding: 0.5rem; background: var(--bg-dark); color: white; border: 1px solid var(--border); ${isSkipped ? 'opacity: 0.5; pointer-events: none;' : ''}" onchange="updateMapping('${plaza}', this.value)">
                ${options}
            </select>
            <div style="display: flex; gap: 0.5rem;">
                <button class="btn btn-sm ${isSkipped ? 'btn-primary' : 'btn-outline'}" onclick="toggleSkip('${plaza}')">
                    ${isSkipped ? 'Undo Skip' : 'Skip'}
                </button>
                <button class="btn btn-sm btn-outline" onclick="alert('Custom mode: You can enter manual base numbers later.')">Custom</button>
            </div>
        `;
        
        const row = document.createElement('div');
        row.style.cssText = `padding: 1rem; border: 1px solid var(--border); border-radius: 8px; background: ${isSkipped ? 'rgba(255,255,255,0.05)' : 'var(--bg-panel)'}; display: flex; align-items: center; justify-content: space-between; gap: 1rem;`;
        row.innerHTML = rowHTML;
        list.appendChild(row);
    });
}

function updateMapping(surveyId, ihmclName) {
    if (ihmclName) {
        userPlazaMapping[surveyId] = { status: 'mapped', ihmclName: ihmclName };
    } else {
        userPlazaMapping[surveyId] = { status: 'pending', ihmclName: '' };
    }
}

function toggleSkip(surveyId) {
    const state = userPlazaMapping[surveyId];
    if (state.status === 'skipped') {
        state.status = 'pending';
        state.ihmclName = '';
    } else {
        state.status = 'skipped';
        state.ihmclName = '';
    }
    renderMappingList();
}

async function proceedToBaseNumberAnalytics() {
    const plazasToMap = (typeof uniquePlazas !== 'undefined' && uniquePlazas.length > 0) ? uniquePlazas : Object.keys(userPlazaMapping);
    
    const pending = plazasToMap.filter(p => userPlazaMapping[p].status === 'pending');
    if (pending.length > 0) {
        alert(`Please map or skip all survey locations. ${pending.length} remaining.`);
        return;
    }
    
    const mappedIhmclNames = plazasToMap
        .filter(p => userPlazaMapping[p].status === 'mapped')
        .map(p => userPlazaMapping[p].ihmclName);
        
    const uniqueMappedNames = [...new Set(mappedIhmclNames)];
    
    if (uniqueMappedNames.length === 0) {
        alert('No locations mapped. Analytics requires at least one mapped plaza.');
        return;
    }
    
    showBaseLoading('Fetching IHMCL Data...');
    try {
        const response = await fetch('http://localhost:8000/api/ihmcl/plaza_data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(uniqueMappedNames)
        });
        const resData = await response.json();
        ihmclData = resData.data;
        
        hideBaseLoading();
        switchView('view-basenumber-analytics');
        initAnalyticsDashboard(uniqueMappedNames);
    } catch (e) {
        console.error('Failed to load plaza data:', e);
        alert('Failed to fetch analytics data.');
        hideBaseLoading();
    }
}

// Analytics Logic
function initAnalyticsDashboard(mappedPlazas) {
    const monthSelector = document.getElementById('bn-month-selector');
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    monthSelector.innerHTML = '';
    months.forEach(m => {
        monthSelector.innerHTML += `
            <div class="month-pill" id="pill-${m}" onclick="toggleMonth('${m}')" 
                 style="padding: 0.25rem 0.75rem; border: 1px solid var(--border); border-radius: 16px; cursor: pointer; color: var(--text-secondary);">
                 ${m}
            </div>
        `;
    });
    monthSelections = [];
    aadtSelection = null;
    scfSelections = [];

    const graphSel = document.getElementById('bn-graph-plaza-selector');
    graphSel.innerHTML = '';
    mappedPlazas.forEach(p => {
        graphSel.innerHTML += `
            <div class="graph-plaza-pill active" data-plaza="${p}" onclick="toggleGraphPlaza(this, '${p}')"
                 style="padding: 0.5rem 1rem; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 8px; cursor: pointer;">
                 ${p}
            </div>
        `;
    });
    
    const calcSel = document.getElementById('bn-plaza-selector');
    calcSel.innerHTML = '';
    mappedPlazas.forEach((p, idx) => {
        calcSel.innerHTML += `
            <div class="bn-calc-tab" id="calc-tab-${idx}" onclick="selectCalcPlaza('${p}', ${idx})"
                 style="padding: 0.5rem 1rem; cursor: pointer; font-weight: 500; color: var(--text-secondary);">
                 ${p}
            </div>
        `;
    });
    
    if (mappedPlazas.length > 0) {
        selectCalcPlaza(mappedPlazas[0], 0);
        renderGraphs();
    }
}

function selectCalcPlaza(plaza, index) {
    currentAnalyticsPlaza = plaza;
    aadtSelection = null;
    scfSelections = [];
    
    // Update active tab styles
    document.querySelectorAll('.bn-calc-tab').forEach((el, i) => {
        if (i === index) {
            el.style.borderBottom = '2px solid var(--accent)';
            el.style.color = 'var(--accent)';
        } else {
            el.style.borderBottom = 'none';
            el.style.color = 'var(--text-secondary)';
        }
    });
    
    recalculateTables();
}

function toggleMonth(month) {
    const idx = monthSelections.indexOf(month);
    const pill = document.getElementById(`pill-${month}`);
    if (idx > -1) {
        monthSelections.splice(idx, 1);
        pill.style.background = 'transparent';
        pill.style.color = 'var(--text-secondary)';
        pill.style.borderColor = 'var(--border)';
    } else {
        monthSelections.push(month);
        pill.style.background = 'var(--accent)';
        pill.style.color = 'white';
        pill.style.borderColor = 'var(--accent)';
    }
    recalculateTables();
}

function selectAADT(fy) {
    aadtSelection = fy;
    recalculateTables();
}

function toggleSCF(fy) {
    const idx = scfSelections.indexOf(fy);
    if (idx > -1) scfSelections.splice(idx, 1);
    else scfSelections.push(fy);
    recalculateTables();
}

function recalculateTables() {
    if (!currentAnalyticsPlaza || !ihmclData[currentAnalyticsPlaza]) return;
    
    const records = ihmclData[currentAnalyticsPlaza];
    
    // Group by FY
    let fyData = {};
    records.forEach(r => {
        if (!r.FY) return;
        if (!fyData[r.FY]) fyData[r.FY] = { records: [], totalDays: 0 };
        fyData[r.FY].records.push(r);
        fyData[r.FY].totalDays += r.Days_In_Month || 30; // rough fallback if missing
    });
    
    const aadtTbody = document.querySelector('#bn-aadt-table tbody');
    const scfTbody = document.querySelector('#bn-scf-table tbody');
    aadtTbody.innerHTML = '';
    scfTbody.innerHTML = '';
    
    let aadtVals = {}; // computed active AADT
    
    window.currentSCFs = {}; // store globally for updateBaseNumber
    
    // Process each full FY
    Object.keys(fyData).sort().forEach(fy => {
        const d = fyData[fy];
        if (d.records.length !== 12) return; // Only process full 12 month FYs
        
        let sums = { 'CAR_JEEP': 0, 'LCV': 0, 'BUS_TRUCK': 0, '3_AXLE': 0, '4_6_AXLE': 0, 'OSV': 0, 'TOTAL': 0 };
        let scfSums = { 'CAR_JEEP': 0, 'LCV': 0, 'BUS_TRUCK': 0, '3_AXLE': 0, '4_6_AXLE': 0, 'OSV': 0, 'TOTAL': 0 };
        let scfDays = 0;
        
        d.records.forEach(r => {
            const rDays = r.Days_In_Month || 30;
            VEHICLES.forEach(v => {
                const cnt = Number(r[v + '_CNT']) || 0;
                sums[v] += cnt;
                if (monthSelections.includes(r.Month_Name)) scfSums[v] += cnt;
            });
            sums['TOTAL'] += Number(r['TOTAL_CNT']) || 0;
            if (monthSelections.includes(r.Month_Name)) {
                scfSums['TOTAL'] += Number(r['TOTAL_CNT']) || 0;
                scfDays += rDays;
            }
        });
        
        const days = d.totalDays;
        const aadt = {};
        const scf = {};
        
        let aadtHtml = `<td><input type="radio" name="aadt-sel" onchange="selectAADT('${fy}')" ${aadtSelection===fy?'checked':''}></td><td>FY${fy}</td>`;
        let scfHtml = `<td><input type="checkbox" onchange="toggleSCF('${fy}')" ${scfSelections.includes(fy)?'checked':''}></td><td>FY${fy}</td>`;
        
        ['CAR_JEEP', 'LCV', 'BUS_TRUCK', '3_AXLE', '4_6_AXLE', 'OSV', 'TOTAL'].forEach(v => {
            aadt[v] = sums[v] / days;
            
            // New SCF logic per user instructions:
            // scf for a month in a FY = AADT of that FY / (monthly total traffic for that month / total days of that month)
            if (scfSums[v] > 0 && scfDays > 0) {
                let periodAvg = scfSums[v] / scfDays;
                scf[v] = aadt[v] / periodAvg;
            } else {
                scf[v] = 0;
            }
            
            aadtHtml += `<td>${aadt[v].toFixed(2)}</td>`;
            scfHtml += `<td>${scf[v].toFixed(3)}</td>`;
            
            if (aadtSelection === fy) aadtVals[v] = aadt[v];
        });
        
        window.currentSCFs[fy] = scf;
        
        aadtTbody.innerHTML += `<tr>${aadtHtml}</tr>`;
        
        if (monthSelections.length > 0) {
            scfTbody.innerHTML += `<tr>${scfHtml}</tr>`;
        }
    });
    
    if (Object.keys(fyData).length === 0) {
        aadtTbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">No fully completed FYs data found.</td></tr>`;
    }
    if (monthSelections.length === 0) {
        scfTbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">Select months to calculate SCF.</td></tr>`;
    }
    
    updateBaseNumber(aadtVals);
}

function updateBaseNumber(aadtVals) {
    const finalTbody = document.querySelector('#bn-final-table tbody');
    if (!aadtSelection || monthSelections.length === 0 || scfSelections.length === 0) {
        finalTbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-secondary);">Select Plaza, AADT FY, and at least one SCF FY to calculate.</td></tr>`;
        return;
    }
    
    let scfTotals = { 'CAR_JEEP': 0, 'LCV': 0, 'BUS_TRUCK': 0, '3_AXLE': 0, '4_6_AXLE': 0, 'OSV': 0, 'TOTAL': 0 };
    let validFys = 0;
    
    // Average chosen SCFs directly from window.currentSCFs
    scfSelections.forEach(fy => {
        if (window.currentSCFs && window.currentSCFs[fy]) {
            validFys++;
            ['CAR_JEEP', 'LCV', 'BUS_TRUCK', '3_AXLE', '4_6_AXLE', 'OSV', 'TOTAL'].forEach(v => {
                scfTotals[v] += window.currentSCFs[fy][v];
            });
        }
    });
    
    let html = `<td>AADT(${aadtSelection}) * AvgSCF(${scfSelections.length} Yrs)</td>`;
    
    if (validFys > 0) {
        ['CAR_JEEP', 'LCV', 'BUS_TRUCK', '3_AXLE', '4_6_AXLE', 'OSV', 'TOTAL'].forEach(v => {
            let avgScf = scfTotals[v] / validFys;
            let bn = aadtVals[v] * avgScf;
            html += `<td><strong>${bn.toFixed(0)}</strong></td>`;
        });
    } else {
        html = `<td colspan="8" style="text-align: center; color: var(--text-secondary);">No valid SCFs found for selected FYs.</td>`;
    }
    
    finalTbody.innerHTML = `<tr>${html}</tr>`;
}

// Graph Logic
function toggleGraphPlaza(elem, plaza) {
    if (elem.classList.contains('active')) {
        elem.classList.remove('active');
        elem.style.background = 'transparent';
        elem.style.color = 'var(--text-primary)';
    } else {
        elem.classList.add('active');
        elem.style.background = 'var(--accent)';
        elem.style.color = 'white';
    }
    renderGraphs();
}

function renderGraphs() {
    const activePlazas = Array.from(document.querySelectorAll('.graph-plaza-pill.active')).map(e => e.getAttribute('data-plaza'));
    
    // We want X-axis to be chronological months (Date).
    // Let's gather all unique dates across selected plazas and sort them.
    let dateSet = new Set();
    activePlazas.forEach(p => {
        if(ihmclData[p]) ihmclData[p].forEach(r => { if(r.Date) dateSet.add(r.Date); });
    });
    let labels = Array.from(dateSet).sort();
    
    let madtDatasets = [];
    let madrDatasets = [];
    
    const colors = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#2dd4bf'];
    
    activePlazas.forEach((plaza, idx) => {
        const color = colors[idx % colors.length];
        if(!ihmclData[plaza]) return;
        
        let madtData = [];
        let madrData = [];
        
        labels.forEach(dateStr => {
            const rec = ihmclData[plaza].find(r => r.Date === dateStr);
            if (rec) {
                const days = rec.Days_In_Month || 30;
                madtData.push((rec.TOTAL_CNT || 0) / days);
                madrData.push((rec.TOTAL_AMT || 0) / days);
            } else {
                madtData.push(null);
                madrData.push(null);
            }
        });
        
        madtDatasets.push({
            label: plaza,
            data: madtData,
            borderColor: color,
            tension: 0.1,
            fill: false,
            spanGaps: true
        });
        madrDatasets.push({
            label: plaza,
            data: madrData,
            backgroundColor: color, // For bars if we want them, else line
            borderColor: color,
            tension: 0.1,
            fill: false,
            spanGaps: true
        });
    });
    
    // Create or update chart instances
    const ctxMadt = document.getElementById('madtChart').getContext('2d');
    const ctxMadr = document.getElementById('madrChart').getContext('2d');
    
    // Configure common aesthetics for odin dark theme
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.scale.grid.color = 'rgba(255,255,255,0.05)';
    
    if (madtChartInst) madtChartInst.destroy();
    madtChartInst = new Chart(ctxMadt, {
        type: 'line',
        data: { labels, datasets: madtDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
        }
    });
    
    if (madrChartInst) madrChartInst.destroy();
    madrChartInst = new Chart(ctxMadr, {
        type: 'line',
        data: { labels, datasets: madrDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
        }
    });
}
