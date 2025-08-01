const express = require('express');
const router = express.Router();
const path = require('path');
const xlsx = require('xlsx');
const fs = require('fs');

const excelPath = path.join(__dirname, '..', 'Deals_DifferentInstruments.xlsx');

// Columns to extract
const filterFields = ['AssetId', 'Portfolio', 'Currency', 'Instrument', 'DiscountCurve', 'ProjectionCurve'];

// Get unique filter options
router.get('/filters', (req, res) => {
    try {
        const workbook = xlsx.readFile(excelPath);
        const sheetNames = workbook.SheetNames;

        const filters = {
            AssetId: new Set(),
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
    } catch(error) {
        console.error('Error reading Excel file:', error);
        res.status(500).json({ error: 'Failed to load filter options' });
    }
})

module.exports = router;