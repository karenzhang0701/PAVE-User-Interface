const express = require('express');
const router = express.Router();
const path = require('path');
const xlsx = require('xlsx');
const fs = require('fs');
const app = express();

const excelPath = path.join(__dirname, '..', 'Deals_DifferentInstruments.xlsx');
const outputDir = path.join(__dirname, '..', 'deals_manager');

// Columns to extract
const filterFields = ['Portfolio', 'Currency', 'Instrument', 'DiscountCurve', 'ProjectionCurve'];

// Get unique filter options
router.get('/filters', (req, res) => {
    try {
        const workbook = xlsx.readFile(excelPath);
        const sheetNames = workbook.SheetNames;

        const filters = {
            Portfolio: new Set(),
            Currency: new Set(),
            Instrument: new Set(),
            DiscountCurve: new Set(),
            ProjectionCurve: new Set()
        };

        sheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const jsonData = xlsx.utils.sheet_to_json(sheet);

            jsonData.forEach(row => {
                filterFields.forEach(field => {
                    if (row[field]) {
                        filters[field].add(row[field]);
                    }
                })
            })
        })

        const result = {};
        for (const field in filters) {
            result[field] = Array.from(filters[field]).sort();
        }
        console.log(result);
        res.json(result);
    } catch (error) {
        console.error('Error reading Excel file:', error);
        res.status(500).json({ error: 'Failed to load filter options' });
    }
})


// Normalize keys in each row
function normalizeKeys(row) {
    return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key.trim(), value])
    );
}

// Match filters with normalized values
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

// Construct deals txt files based on user's filters and send results to frontend
router.post('/send-selected-data', (req, res) => {
    const { AssetId: assetIds = [], SecId: secIds = [], ...selectedFilters } = req.body;
    console.log('✅ Received data:', req.body);

    try {
        const workbook = xlsx.readFile(excelPath);
        const sheetNames = workbook.SheetNames;
        const sheetGroups = {};

        for (const sheetName of sheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const rawData = xlsx.utils.sheet_to_json(sheet, { defval: '' });
            const jsonData = rawData.map(normalizeKeys);

            if (jsonData.length === 0) continue;

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

            sheetGroups[sheetName].rows.push(...finalFilteredRows);
        }

        // Write filtered rows to txt files grouped by instrument type
        for (const [sheetName, { headers, rows }] of Object.entries(sheetGroups)) {
            if (rows.length === 0) continue;

            const filePath = path.join(outputDir, `Deals_${sheetName}.txt`);
            const lines = [headers.join('\t')];

            rows.forEach(row => {
                const line = headers.map(h => (row[h] ?? '').toString().trim()).join('\t');
                lines.push(line);
            });

            fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
            console.log(`📁 Written ${rows.length} rows to ${filePath}`);
        }


        const totalCount = Object.values(sheetGroups).reduce((sum, group) => sum + group.rows.length, 0);
        console.log('✅ Total filtered rows written:', totalCount);

        // Get created deals files
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
function generateDealsTable(headers, rows, title = 'Quotes') {
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

// Deletes all files in deals_manager folder
router.delete('/clear-files', (req, res) => {
    const dealsDir = path.join(__dirname, '..', 'deals_manager');
    let deletedFiles = [];

    try {
        if (fs.existsSync(dealsDir)) {
            fs.readdirSync(dealsDir).forEach(file => {
                const filePath = path.join(dealsDir, file);
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                    deletedFiles.push(file);
                }
            })
        }
        console.log('Deleted files:', deletedFiles);
        res.json({ message: `✅ Deleted ${deletedFiles.length} files.` });
    } catch (err) {
        console.error('Error deleting files:', err);
        res.status(500).json({ error: 'Failed to delete files.' });
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


module.exports = router;