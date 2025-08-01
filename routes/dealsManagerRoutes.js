const express = require('express');
const router = express.Router();
const path = require('path');
const xlsx = require('xlsx');
const fs = require('fs');

const excelPath = path.join(__dirname, '..', 'Deals_DifferentInstruments.xlsx');

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

// POST endpoint to receive selected data and filter Excel sheets

router.post('/send-selected-data', (req, res) => {
    const { 'Asset Id': assetIds = [], ...selectedFilters } = req.body;
    console.log('Received data: ', req.body);

    try {
        const workbook = xlsx.readFile(excelPath);
        const sheetNames = workbook.SheetNames;
        const filteredResults = [];

        const instrumentsToSearch = selectedFilters.Instrument?.length > 0
            ? selectedFilters.Instrument
            : sheetNames;

        for (const sheetName of instrumentsToSearch) {
            if (!workbook.Sheets[sheetName]) continue;

            const jsonData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

            const assetIdFilteredRows = assetIds.length > 0
                ? jsonData.filter(row => assetIds.includes(row['AssetId']))
                : jsonData;

            const finalFilteredRows = assetIdFilteredRows.filter(row => matchesFilters(row, selectedFilters));
            filteredResults.push(...finalFilteredRows);
        }

        console.log('Filtered results:', filteredResults.length);
        res.json(filteredResults);
    } catch (error) {
        console.error('Error processing Excel file:', error);
        res.status(500).json({ error: 'Failed to process data' });
    }
});


module.exports = router;