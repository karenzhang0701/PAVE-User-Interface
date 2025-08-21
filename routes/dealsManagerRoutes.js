const express = require('express');
const router = express.Router();
const path = require('path');
const xlsx = require('xlsx');
const fs = require('fs');
const { execSync } = require('child_process');

const excelPath = path.join(__dirname, '..', 'Deals_DifferentInstruments.xlsx');
const outputDir = path.join(__dirname, '..', 'deals_manager');

// Columns that user can filter by
const filterFields = ['Portfolio', 'Currency', 'Instrument', 'DiscountCurve', 'ProjectionCurve'];

// Download deals valuation output
router.get('/download/output', (req, res) => {
    let filePath = '';

    // Output is CDS_Greeks.txt if user defined scenarios, otherwise CDS_PV.txt
    const scenarioPath = path.join(__dirname, '..', 'scenario_generation', 'scenario_definition.txt');
    const stats = fs.statSync(scenarioPath);
    // Check if scenario_definition file is empty
    if (stats.size > 0) {
        filePath = path.join(__dirname, '..', 'deals_manager', 'CDS_Greeks.txt');
    } else {
        filePath = path.join(__dirname, '..', 'deals_manager', 'CDS_PV.txt');
    }
    
    if (fs.existsSync(filePath)) {
        res.download(filePath, 'CDS_PV.txt');
    } else {
        res.status(404).json({ error: 'CDS_PV file not found ' });
    }
})

// Download deals txt file
router.get('/download/deals', (req, res) => {
    const filePath = path.join(__dirname, '..', 'deals_manager', 'Deals_CDS.txt');
    if (fs.existsSync(filePath)) {
        res.download(filePath, 'Deals.txt');
    } else {
        res.status(404).json({ error: 'Deals file not found ' });
    }
})

// Returns list of unique values for each filter field (portfolio, currency, instrument type...)
router.get('/filters', (req, res) => {
    try {

        // Read Excel file from path
        const workbook = xlsx.readFile(excelPath);

        // Get all sheet names
        const sheetNames = workbook.SheetNames;

        // Object with sets to store unique values for each filter field
        const filters = {
            Portfolio: new Set(),
            Currency: new Set(),
            Instrument: new Set(),
            DiscountCurve: new Set(),
            ProjectionCurve: new Set()
        };

        // Loop through each Excel sheet
        sheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];

            // Convert Excel sheet to JSON format
            const jsonData = xlsx.utils.sheet_to_json(sheet, {
                defval: '',
                raw: false
            });

            // Loop through each row in the Excel sheet and add values to filters set
            jsonData.forEach(row => {
                // filterFields are ['Portfolio', 'Currency', 'Instrument', 'DiscountCurve', 'ProjectionCurve'];
                filterFields.forEach(field => {
                    if (row[field]) {
                        filters[field].add(row[field]);
                    }
                })
            })
        })

        // Convert set to sorted arrays
        const result = {};
        for (const field in filters) {
            result[field] = Array.from(filters[field]).sort();
        }
        console.log(result);
        // Send to frontend for displaying dropdown menus
        res.json(result);
    } catch (error) {
        console.error('Error reading Excel file:', error);
        res.status(500).json({ error: 'Failed to load filter options' });
    }
})


// Trims whitespace from all fields in a row
function normalizeKeys(row) {
    return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.trim(), value])
    );
}

// Checks if row matches all filters
function matchesFilters(row, filters) {
    for (const field of filterFields) {
        if (filters[field] && filters[field].length > 0) {
            const rowValue = (row[field] || '').toString().trim();
            if (!filters[field].includes(rowValue)) {
                return false;
            }
        }
    }
    return true;
}

// Formats dates
function formatHoldingsDate(value) {
    const date = new Date(value);
    if (!isNaN(date)) {
        // Format as M/D/YYYY without leading zeros
        const mm = date.getMonth() + 1;
        const dd = date.getDate();
        const yyyy = date.getFullYear();
        return `${mm}/${dd}/${yyyy}`;
    }
    return value;
}

// Generates deals based on user's selected filters
// Creates txt files grouped by instrument type (i.e. Deals_CDS.txt, Deals_IRS.txt)
router.post('/send-selected-data', (req, res) => {
    const { AssetId: assetIds = [], SecId: secIds = [], ...selectedFilters } = req.body;
    console.log('✅ Received data:', req.body);

    try {
        const workbook = xlsx.readFile(excelPath);
        const sheetNames = workbook.SheetNames;

        // Group filtered deal rows by sheet name (instrument type: IRS, CS, CDS, CPI, BondForward)
        const sheetGroups = {};

        // Loop through each sheet in Excel file
        for (const sheetName of sheetNames) {
            const sheet = workbook.Sheets[sheetName];

            // Convert sheet to JSON
            const rawData = xlsx.utils.sheet_to_json(sheet, {
                defval: '',
                raw: false
            });

            const jsonData = rawData.map(normalizeKeys);

            if (jsonData.length === 0) continue;

            // Extract headers from first row in Excel file
            const headers = Object.keys(jsonData[0]);

            // Filtering uses AND logic -- outputted deals must match ALL filters selected by user
            // Filter based on asset Ids first
            const assetIdFilteredRows = assetIds.length > 0
                ? jsonData.filter(row => assetIds.includes((row['AssetId'] || '').toString().trim()))
                : jsonData;

            // Then filter based on Sec Ids
            const secIdFilteredRows = secIds.length > 0
                ? assetIdFilteredRows.filter(row => secIds.includes((row['SecId'] || '').toString().trim()))
                : assetIdFilteredRows;

            // Apply rest of filters
            const finalFilteredRows = secIdFilteredRows.filter(row => matchesFilters(row, selectedFilters));

            if (!sheetGroups[sheetName]) {
                sheetGroups[sheetName] = {
                    headers,
                    rows: []
                };
            }

            // Add filtered deal rows to instrument type groups
            sheetGroups[sheetName].rows.push(...finalFilteredRows);
        }

        // Write filtered deal rows to separate txt files grouped by instrument type
        for (const [sheetName, { headers, rows }] of Object.entries(sheetGroups)) {
            if (rows.length === 0) continue;

            const filePath = path.join(outputDir, `Deals_${sheetName}.txt`);
            const lines = [headers.join('\t')];

            rows.forEach(row => {
                const line = headers.map(h => {
                    let val = row[h] ?? '';
                    if (h === 'HoldingsDate') {
                        val = formatHoldingsDate(val);
                    }
                    return val.toString().trim();
                }).join('\t');
                lines.push(line);
            });


            fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
            console.log(`📁 Written ${rows.length} rows to ${filePath}`);
        }

        // Number of rows written to each txt file
        const totalCount = Object.values(sheetGroups).reduce((sum, group) => sum + group.rows.length, 0);
        console.log('✅ Total filtered rows written:', totalCount);

        // List of instrument types that have deals written to a txt file
        const writtenSheets = Object.entries(sheetGroups)
            .filter(([_, group]) => group.rows.length > 0)
            .map(([sheetName]) => sheetName);

        console.log(writtenSheets);

        res.json({
            message: 'Filtered data written to sheet-specific TXT files',
            count: totalCount,
            sheets: writtenSheets
        });

    } catch (error) {
        console.error('❌ Error processing Excel file:', error);
        res.status(500).json({ error: 'Failed to process and write data' });
    }
});

// Split deals txt file into headers and rows
function parseTxtFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split('\t');
    const rows = lines.slice(1).map(line => {
        const values = line.split('\t');
        const row = {};
        headers.forEach((h, i) => {
            row[h] = values[i] || '';
        });
        return row;
    });
    return { headers, rows };
}

// Display deals file in table format
function generateDealsTable(headers, rows, title = 'Quotes', highlightSamples = false) {
    let html = `
    <h2 class="text-xl font-semibold text-gray-800 mb-4">${title}</h2>
    <div style="max-height: 600px; overflow-y: auto; overflow-x: auto;">
    <table class="w-auto max-w-5xl border border-gray-300 divide-y divide-gray-200 text-sm text-gray-900 mb-6 rounded-md">
      <thead class="bg-gray-50">
        <tr>
          ${headers.map(h => `<th class="px-3 py-2 border-r border-gray-200 text-left">${h}</th>`).join('')}
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-200">
    `;

    rows.forEach((row, index) => {
        const isSample = highlightSamples && index < 2;
        html += `<tr${isSample ? ' style="background-color: #e1e1e1ff;"' : ''}>`;
        headers.forEach(h => {
            const value = row[h] ?? '';
            html += `<td class="px-3 py-2 border-r border-gray-200">${value}</td>`;
        });
        html += `</tr>`;
    });

    html += `
      </tbody>
    </table>
    </div>
    `;

    return html;
}

// Display output file in table format
// Same as generateHTMLTable but displays table in full without limiting height
function generateOutputTable(headers, rows) {
    let html = `
    <div class="overflow-visible">
    <table class="w-auto max-w-5xl border border-gray-300 divide-y divide-gray-200 text-sm text-gray-900 mb-6 rounded-md">
      <thead class="bg-gray-50">
        <tr>
          ${headers.map(h => `<th class="px-3 py-2 border-r border-gray-200 text-left">${h}</th>`).join('')}
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-200">
    `;

    rows.forEach(row => {
        html += `<tr>`;
        headers.forEach(h => {
            const value = row[h] ?? '';
            html += `<td class="px-3 py-2 border-r border-gray-200">${value}</td>`;
        });
        html += `</tr>`;
    });

    html += `
      </tbody>
    </table>
    </div>
    `;

    return html;
}


// Generates table format for deals file and sends to frontend for display
router.get('/preview-table/:fileName', (req, res) => {
    const fileName = req.params.fileName;
    const filePath = path.join(outputDir, fileName);

    try {
        const { headers, rows } = parseTxtFile(filePath);
        const html = generateDealsTable(headers, rows, fileName.replace('.txt', ''));
        res.send(html);
    } catch (error) {
        console.error('❌ Error rendering table:', error);
        res.status(500).send('Failed to render table');
    }
});

// Generate table format for output file
router.get('/preview-output', (req, res) => {
    let filePath = '';

    // Display CDS_Greeks.txt if scenario was defined
    // Otherwise, display CDS_PV.txt
    const scenarioPath = path.join(__dirname, '..', 'scenario_generation', 'scenario_definition.txt');
    const stats = fs.statSync(scenarioPath);
    if (stats.size > 0) {
        filePath = path.join(__dirname, '..', 'deals_manager', 'CDS_Greeks.txt');
    } else {
        filePath = path.join(__dirname, '..', 'deals_manager', 'CDS_PV.txt');
    }

    try {
        const { headers, rows } = parseTxtFile(filePath);
        const html = generateOutputTable(headers, rows);
        res.send(html);
    } catch (error) {
        console.error('❌ Error rendering table:', error);
        res.status(500).send('Failed to render table');
    }
});

// Download specific deals txt file
router.get('/download/:fileName', (req, res) => {
    const fileName = req.params.fileName;
    const filePath = path.join(outputDir, fileName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }

    res.download(filePath, fileName, err => {
        if (err) {
            console.error('❌ Error sending file:', err);
            res.status(500).send('Failed to download file');
        }
    });
});

// Generates table format of deals for specific instrument type, for user to add new deals
router.get('/instrument-preview/:instrumentType', (req, res) => {
    const instrumentType = req.params.instrumentType.trim();
    try {
        const workbook = xlsx.readFile(excelPath);
        const sheetNames = workbook.SheetNames;
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

        // Find rows that match specified instrument type
        // Find pair of deals with same base SecId (eg 8347372_0 and 8347372_1) to display as sample deals
        for (const sheetName of sheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const jsonData = xlsx.utils.sheet_to_json(sheet, {
                defval: '',
                raw: false
            });


            if (jsonData.length === 0) continue;

            const filtered = jsonData.filter(row =>
                (row['Instrument'] ?? '').toString().trim() === instrumentType
            );

            if (filtered.length === 0) continue;

            const baseSecIdGroups = {};
            filtered.forEach(row => {
                const fullSecId = (row['SecId'] ?? '').toString().trim();
                const baseSecId = fullSecId.split('_')[0];
                if (!baseSecIdGroups[baseSecId]) baseSecIdGroups[baseSecId] = [];
                baseSecIdGroups[baseSecId].push(row);
            });

            let sampleRows = [];
            for (const group of Object.values(baseSecIdGroups)) {
                if (group.length >= 2) {
                    sampleRows = group.slice(0, 2);
                    break;
                }
            }

            // Write headers to Deals_CDS.txt (hard coded for now)
            const headers = Object.keys(jsonData[0]);
            const filePath = path.join(__dirname, '..', 'deals_manager', `Deals_CDS.txt`);
            fs.writeFileSync(filePath, headers.join('\t'), 'utf8');
            console.log(`📁 Written headers to ${filePath}`);

            // Generate HTML table for user to add new deals
            const html = generateDealsTable(headers, sampleRows, `${instrumentType} Deals`, true);
            return res.send(html);
        }

        res.status(404).send('Instrument type not found in any sheet.');
    } catch (error) {
        console.error('❌ Error generating preview:', error);
        res.status(500).send('Failed to generate preview.');
    }
});

// Save user's defined deals to Deals_CDS.txt file (hard coded for now)
router.post('/save-new-deals', (req, res) => {
    const { headers, rows } = req.body;
    const fileName = `Deals_CDS.txt`;
    const filePath = path.join(outputDir, fileName);

    try {
        // Start with headers
        const lines = [headers.join('\t')];

        // Add each row
        rows.forEach(row => {
            const line = headers.map(h => {
                let val = row[h] ?? '';
                if (h === 'HoldingsDate') {
                    val = formatHoldingsDate(val);
                }
                return val.toString().trim();
            }).join('\t');

            lines.push(line);
        });

        // Write all lines with newline separator
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
        console.log(`✅ Saved ${rows.length} deals to ${filePath}`);

        res.json({ message: `✅ Saved ${rows.length} deals successfully`, file: fileName });
    } catch (err) {
        console.error('❌ Error saving deals:', err);
        res.status(500).json({ error: 'Failed to save deals' });
    }
});

// Returns all discount and projection curves found in Deals_CDS.txt
router.get('/discount-projection-curves', (req, res) => {
    const filePath = path.join(__dirname, '..', 'deals_manager', 'Deals_CDS.txt');

    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.trim().split('\n');
        const headers = lines[0].split('\t');

        const discountCurveIndex = headers.indexOf('DiscountCurve');
        const projectionCurveIndex = headers.indexOf('ProjectionCurve');

        if (discountCurveIndex === -1 || projectionCurveIndex === -1) {
            return res.status(400).json({ error: 'Required columns not found in Deals_CDS.txt' });
        }

        const uniqueCurves = new Set();

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            if (cols[discountCurveIndex]) uniqueCurves.add(cols[discountCurveIndex].trim());
            if (cols[projectionCurveIndex]) uniqueCurves.add(cols[projectionCurveIndex].trim());
        }

        res.json({ curves: Array.from(uniqueCurves) });
    } catch (err) {
        console.error('❌ Error reading curves:', err);
        res.status(500).json({ error: 'Failed to read curves from Deals_CDS.txt' });
    }
});

// Run valuation
router.post('/run-pave', (req, res) => {
    const { valuationDate } = req.body;

    const workingDir = path.join(__dirname, '..', 'deals_manager');
    const pavePath = path.join(__dirname, '..', 'deals_manager', 'PAVE.exe');
    const debugPath = path.join(workingDir, 'Debug.txt');
    const exceptionPath = path.join(workingDir, 'exception_trace.txt');
    fs.writeFileSync(exceptionPath, '');
    fs.writeFileSync(debugPath, '');

    // Only include scenario definition arguments if scenario was defined
    let scenarioArgs = "";
    const scenarioPath = path.join(__dirname, '..', 'scenario_generation', 'scenario_definition.txt');
    const stats = fs.statSync(scenarioPath);
    if (stats.size > 0) {
        scenarioArgs = "-sd ../scenario_generation/scenario_definition.txt -gd Greeks.txt";
    }

    // Use CDef_CurveManager.txt and CQuotes_CurveManager.txt
    // Uses Deals_CDS.txt as input file (hard coded for now)
    const command = `"${pavePath}" -vd ${valuationDate} -path .\\ -i Deals_CDS.txt -c ../curve_manager/CQuotes_CurveManager.txt -txtcdf ../curve_manager/CDef_CurveManager.txt -o PV.txt -cf Cashflow.txt ${scenarioArgs} -debug Debug.txt -header Portfolio:PortfolioId:AssetId`;

    console.log(`Running: ${command}`);

    try {
        const output = execSync(command, { cwd: workingDir }).toString();
        console.log('✅ PAVE executed successfully');

        // Read Debug.txt and PV.txt contents
        const pvPath = path.join(workingDir, 'CDS_PV.txt');

        const debugContent = fs.readFileSync(debugPath, 'utf8');
        const pvContent = fs.readFileSync(pvPath, 'utf8');
        const exceptionContent = fs.readFileSync(exceptionPath, 'utf8');

        res.json({
            message: '✅ PAVE executed successfully',
            output,
            debug: debugContent,
            pv: pvContent,
            exception_trace: exceptionContent
        });
    } catch (err) {
        console.error('❌ PAVE execution error:', err.message);
        res.status(500).json({ error: `PAVE failed: ${err.message}` });
    }
});

module.exports = router;