const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const curveCache = { definitions: new Map() };

// Extract all curve names from text provided
function extractCurveNamesFromText(text) {
    const curveNames = new Set();
    const blocks = text.split('#BeginCurve');
    for (const block of blocks) {
        const match = block.match(/CurveName\s+([^\s]+)/);
        if (match) {
            const name = match[1].trim();

            // Don't display Surv_Generic curves in dropdown menu
            if (!name.startsWith('Surv_Generic')) {
                curveNames.add(name);
            }
        }
    }
    return curveNames;
}

// Returns list of curve names from definitions file for specific curve class
function getCurveNames() {
    let filePaths = [path.join(__dirname, '..', 'MasterFile.txt')];

    const allNames = new Set();
    for (const filePath of filePaths) {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const names = extractCurveNamesFromText(content);
            names.forEach(name => allNames.add(name));
        }
    }
    return Array.from(allNames).sort();
}

// Returns curve block (from #BeginCurve to #EndCurve) for given curve name
function extractCurveBlock(text, curveName) {
    const lines = text.split('\n');
    let insideBlock = false;
    let currentCurve = '';
    let blockLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#BeginCurve')) {
            insideBlock = true;
            currentCurve = '';
            blockLines = [line];
        } else if (insideBlock && line.startsWith('CurveName')) {
            currentCurve = line.split(/\s+/)[1]?.trim();
            blockLines.push(line);
        } else if (insideBlock) {
            blockLines.push(line);
            if (line.startsWith('#EndCurve') && currentCurve === curveName) {
                return blockLines.join('\n');
            }
        }
    }

    return null;
}

// Returns definition block for a curve
function defBlock(curveName) {
    const blocks = [];
    const cdsNames = new Set([
        'Surv_ORIXC_SNRFOR_CR14_100bp.JPY', 'Surv_Panas_SNRFOR_CR14_100bp.JPY', 'Surv_SumitoRealty_SNRFOR_CR14_10',
        'Surv_Honda_SNRFOR_CR14_100bp.JPY',
        'Surv_SonyG_SNRFOR_CR14_100bp.JPY', 'Surv_Komat_SNRFOR_CR14_100bp.JPY', 'Surv_Japan_SNRFOR_CR14_100bp.USD',
        'Surv_Islam_SNRFOR_CR14_100bp.USD'
    ]);

    const filePath = path.join(__dirname, '..', 'MasterFile.txt');
    const content = fs.readFileSync(filePath, 'utf8');

    if (cdsNames.has(curveName)) {
        if (curveName.endsWith('.JPY')) {
            const tonar = extractCurveBlock(content, 'TONAR.ASIA.JPY');
            const surv = extractCurveBlock(content, 'Surv_Generic.JPY');
            const main = extractCurveBlock(content, curveName);
            if (tonar) blocks.push({ name: 'TONAR.ASIA.JPY', block: tonar });
            if (surv) blocks.push({ name: 'Surv_Generic.JPY', block: surv });
            if (main) blocks.push({ name: curveName, block: main });
        } else if (curveName.endsWith('.USD')) {
            const sofr = extractCurveBlock(content, 'SOFR.ASIA.USD');
            const surv = extractCurveBlock(content, 'Surv_Generic.USD');
            const main = extractCurveBlock(content, curveName);
            if (sofr) blocks.push({ name: 'SOFR.ASIA.USD', block: sofr });
            if (surv) blocks.push({ name: 'Surv_Generic.USD', block: surv });
            if (main) blocks.push({ name: curveName, block: main });
        }
    } else {
        if (curveCache.definitions.has(curveName)) {
            blocks.push({ name: curveName, block: curveCache.definitions.get(curveName) });
            return blocks;
        }

        const block = extractCurveBlock(content, curveName);
        if (block) {
            curveCache.definitions.set(curveName, block);
            blocks.push({ name: curveName, block });
        }
    }
    return blocks;
}


// Returns parent indices for given curve from the definitions file
function findParentIndices(curveName) {

    // CDS: map Surv curves to corresponding Surv_Generic definitions for USD andJPY
    // Parent Curves: Surv_Generic.USD --> SOFR.ASIA.USD, Surv_Generic.JPY --> TONAR.ASIA.JPY
    const cdsNames = new Set([
        'Surv_ORIXC_SNRFOR_CR14_100bp.JPY', 'Surv_Panas_SNRFOR_CR14_100bp.JPY', 'Surv_SumitoRealty_SNRFOR_CR14_10',
        'Surv_Honda_SNRFOR_CR14_100bp.JPY',
        'Surv_SonyG_SNRFOR_CR14_100bp.JPY', 'Surv_Komat_SNRFOR_CR14_100bp.JPY', 'Surv_Japan_SNRFOR_CR14_100bp.USD',
        'Surv_Islam_SNRFOR_CR14_100bp.USD'
    ]);

    if (cdsNames.has(curveName)) {
        if (curveName.endsWith('.JPY')) {
            curveName = 'Surv_Generic.JPY';
        } else if (curveName.endsWith('.USD')) {
            curveName = 'Surv_Generic.USD';
        }
    }

    const rootDir = path.join(__dirname, '..');
    let filePaths = [path.join(rootDir, 'MasterFile.txt')];

    for (const filePath of filePaths) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const blocks = content.split('#BeginCurve');
        for (const block of blocks) {
            const curveMatch = block.match(/CurveName\s+(\S+)/);
            if (curveMatch && curveMatch[1] === curveName) {
                const parentMatch = block.match(/ParentIndices\s+(\S+)/);
                if (parentMatch) {
                    return parentMatch[1].split(':').filter(name => name !== curveName);
                } else {
                    return [];
                }
            }
        }
    }

    return null;
}

// Runs Python script to generate curve quotes data for selected curves
router.post('/generate-quotes', async (req, res) => {
    console.log('Running Python script');
    const { date } = req.body;

    const defPath = path.join(__dirname, '..', 'curve_manager', 'CDef_CurveManager.txt');
    const quotePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');
    fs.writeFileSync(quotePath, '', 'utf8');

    try {
        const { spawnSync } = require('child_process');
        const scriptPath = path.join(__dirname, '..', 'FindurCurve.py');

        const defPath = path.join(__dirname, '..', 'curve_manager', 'CDef_CurveManager.txt');

        // Create Python script command
        const args = [scriptPath, '-curveDate', date];

        args.push('-curveDefFile', defPath);

        const templatePath = path.join(__dirname, '..', 'curve_manager', 'Templates_CurveManager.txt');
        args.push('-curveTemplate', templatePath);

        const curveNamesPath = path.join(__dirname, '..', 'curve_manager', 'CurveNames_CurveManager.txt');
        args.push('-curveNames', curveNamesPath);

        const quotePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');
        args.push('-curveQuoteFile', quotePath);

        console.log('Executing command:', ['python', ...args].join(' '));

        const result = spawnSync('python', args, { encoding: 'utf8' });

        if (result.error) {
            console.error('❌ Python script error:', result.error.message);
            return res.status(500).json({ error: result.error.message });
        }

        if (result.status !== 0) {
            console.error('❌ Python script failed:', result.stderr);
            return res.status(500).json({ error: result.stderr });
        }

        const output = result.stdout;

        // Get curves with missing quotes data
        let missingCurves = [];
        const match = output.match(/Curves in definition file WITHOUT data:\s*([\s\S]*?)(?:\n\s*\n|Data has been written|$)/);
        if (match) {
            missingCurves = match[1].trim().split('\n').map(line => line.trim()).filter(Boolean);
        }

        console.log('✅ Python script output:', output);

        // Create another file for storing copy of original quotes data
        const originalPath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager_original.txt');
        fs.copyFileSync(quotePath, originalPath);

        res.json({ message: 'Quotes generated successfully', output: result.stdout, missingCurves });
    } catch (err) {
        console.error('Python script error:', err);
        return res.status(500).json({ error: 'Error while running Python script' });
    }
});

// Returns list of curve names in CQuotes_CurveManager.txt (user's selected curves)
router.get('/quotes-curve-list', (req, res) => {
    const filePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'CQuotes_CurveManager.txt not found' });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const names = Array.from(extractCurveNamesFromText(content));
    res.json({ curves: names });
});


// Returns list of all curve names for specific curve class
router.get('/all-curve-names', (req, res) => {
    try {
        const curveNames = getCurveNames();
        res.json(curveNames);
    } catch (err) {
        res.status(500).json({ error: 'Failed to extract curve names' });
    }
});

// Returns definition block for specific curve
router.get('/definition/:curveName', (req, res) => {
    try {
        let { curveName } = req.params;
        const cdsNames = new Set([
            'Surv_ORIXC_SNRFOR_CR14_100bp.JPY', 'Surv_Panas_SNRFOR_CR14_100bp.JPY', 'Surv_SumitoRealty_SNRFOR_CR14_10',
            'Surv_Honda_SNRFOR_CR14_100bp.JPY',
            'Surv_SonyG_SNRFOR_CR14_100bp.JPY', 'Surv_Komat_SNRFOR_CR14_100bp.JPY', 'Surv_Japan_SNRFOR_CR14_100bp.USD',
            'Surv_Islam_SNRFOR_CR14_100bp.USD'
        ]);

        if (cdsNames.has(curveName)) {
            if (curveName.endsWith('.JPY')) {
                curveName = 'Surv_Generic.JPY';
            } else if (curveName.endsWith('.USD')) {
                curveName = 'Surv_Generic.USD';
            }
        }
        const blocks = defBlock(curveName);

        // Find the block that matches the curveName
        const mainBlock = blocks.find(b => b.name === curveName);

        if (mainBlock && typeof mainBlock.block === 'string') {
            res.send(mainBlock.block.trim());
        } else {
            res.status(404).send(`Definition block for ${curveName} not found.`);
        }
    } catch (err) {
        console.error('Failed to read indv def file:', err);
        res.status(500).json({ error: 'Failed to read indv def file' });
    }
});

// Returns quote block for specific curve
router.get('/quotes/:curveName', (req, res) => {
    const curveName = req.params.curveName;
    const filePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('');
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const parents = findParentIndices(curveName) || [];

    const blocks = content.split('#BeginCurve').filter(Boolean);
    const relevantBlocks = blocks.filter(block => {
        const match = block.match(/CurveName\s+(\S+)/);
        return match && (match[1] === curveName || parents.includes(match[1]));
    });

    const result = relevantBlocks.map(block => '#BeginCurve' + block.trim()).join('\n\n');
    res.send(result);
});

// Returns original quote data for specific curve
router.get('/original-quotes/:curveName', (req, res) => {
    try {
        const filePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager_original.txt');
        const content = fs.readFileSync(filePath, 'utf8');
        const block = extractCurveBlock(content, req.params.curveName);

        if (!block) {
            return res.status(404).send('');
        }

        res.send(block.trim());
    } catch (err) {
        console.error('Failed to read original quotes:', err);
        res.status(500).json({ error: 'Failed to read original quotes' });
    }
});


// Update specific quote value in file, searches for row that was edited
function updateQuoteInFile(filePath, curveName, rowIndex, field, newValue) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        console.error('Failed to read quotes file:', err);
        return;
    }

    const lines = content.split('\n');
    let insideCurve = false;
    let currentCurve = '';
    let inQuotesSection = false;
    let headerFields = [];
    let currentRow = -1;
    const updatedLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('#BeginCurve')) {
            insideCurve = true;
            currentCurve = '';
            inQuotesSection = false;
            updatedLines.push(line);
            continue;
        }

        if (insideCurve && line.startsWith('CurveName')) {
            currentCurve = line.split(/\s+/)[1]?.trim();
            updatedLines.push(line);
            continue;
        }

        if (insideCurve && currentCurve === curveName &&
            (line.includes('///:CurveMarketQuotes') || line.includes('///:CurveDefinition'))) {
            inQuotesSection = true;
            updatedLines.push(line);
            headerFields = lines[++i].trim().split('\t'); // header row
            updatedLines.push(lines[i]); // header
            updatedLines.push(lines[++i]); // separator
            continue;
        }

        if (inQuotesSection && line.startsWith('#EndCurve')) {
            inQuotesSection = false;
            insideCurve = false;
            updatedLines.push(line);
            continue;
        }

        if (inQuotesSection && currentCurve === curveName) {
            currentRow++;
            if (currentRow === rowIndex) {
                const parts = line.trim().split('\t');
                const rowMap = Object.fromEntries(headerFields.map((h, idx) => [h, parts[idx]]));
                rowMap[field] = newValue;
                const updatedRow = headerFields.map(h => rowMap[h] ?? '').join('\t');
                updatedLines.push(updatedRow);
            } else {
                updatedLines.push(line);
            }
        } else {
            updatedLines.push(line);
        }
    }

    fs.writeFileSync(filePath, updatedLines.join('\n'), 'utf8');
}


// Update quotes value changes (Rate, Spread) for curve in CQuotes_CurveManager.txt
router.post('/quotes/:curveName', (req, res) => {
    const { rowIndex, field, newValue } = req.body;
    const filePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');

    try {
        updateQuoteInFile(filePath, req.params.curveName, rowIndex, field, newValue);
        res.json({ message: 'Quote updated successfully' });
    } catch (err) {
        console.error('Failed to update quote:', err);
        res.status(500).json({ error: 'Failed to update quote' });
    }
});

// Returns parent curves for given curve
router.get('/parents/:curveName', (req, res) => {
    try {
        const parents = findParentIndices(req.params.curveName);
        res.json({ curve: req.params.curveName, parents });
    } catch (err) {
        console.error('Failed to extract parent indices: ', err);
        res.status(500).json({ error: 'Internal server error' });
    }
})

// Download quotes for selected curves in curve manager
router.get('/download/curveManagerQuotes', (req, res) => {
    const filePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');
    if (fs.existsSync(filePath)) {
        res.download(filePath, 'CQuotes_CurveManager.txt');
    } else {
        res.status(404).json({ error: 'Quotes file not found' });
    }
})

// Download curve definitions
router.get('/download/curveManagerDef', (req, res) => {
    const filePath = path.join(__dirname, '..', 'curve_manager', 'CDef_CurveManager.txt');
    if (fs.existsSync(filePath)) {
        res.download(filePath, 'CDef_CurveManager.txt');
    } else {
        res.status(404).json({ error: 'Def file not found' });
    }
})


// Download Curve Manager PAVE output
router.get('/download/curveManager', (req, res) => {
    const filePath = path.join(__dirname, '..', 'curve_manager', 'curve_DF.txt');
    if (fs.existsSync(filePath)) {
        res.download(filePath, 'curve_DF.txt');
    } else {
        res.status(404).json({ error: 'Output file not found' });
    }
});

// Download Debug.txt
router.get('/download/debug', (req, res) => {
    const filePath = path.join(__dirname, '..', 'curve_manager', 'Debug.txt');
    if (fs.existsSync(filePath)) {
        res.download(filePath, 'Debug.txt');
    } else {
        res.status(404).json({ error: 'Debug file not found' });
    }
})

// Add definitions for selected curves and their parent curves to CDef_CurveManager.txt
// Special cases for CDS and IRPDF curves
router.post('/generate-selected-curves-def', (req, res) => {

    const cdsNames = new Set([
        'Surv_ORIXC_SNRFOR_CR14_100bp.JPY', 'Surv_Panas_SNRFOR_CR14_100bp.JPY', 'Surv_SumitoRealty_SNRFOR_CR14_10',
        'Surv_Honda_SNRFOR_CR14_100bp.JPY',
        'Surv_SonyG_SNRFOR_CR14_100bp.JPY', 'Surv_Komat_SNRFOR_CR14_100bp.JPY', 'Surv_Japan_SNRFOR_CR14_100bp.USD',
        'Surv_Islam_SNRFOR_CR14_100bp.USD'
    ]);

    const irpdfNames = new Set([
        'FX_JPY.USD', 'FX_USD.AUD'
    ]);

    const dataContainerNames = new Set([
        'BOND_PRICES.CAD', 'BOND_PRICES.JPY', 'BOND_PRICES.USD',
        'MarketPX.CAD', 'MarketPX.JPY', 'MarketPX.USD',
        'FX_CAD.USD', 'FX_JPY.USD', 'FX_SGD.USD', 'FX_USD.AUD',
        'FX_USD.EUR', 'FX_USD.GBP', 'FX_USD.NZD',
        'IBOXUSHY.USD', 'MFCPRIndx.CAD'
    ]);

    const masterPath = path.join(__dirname, '..', 'MasterFile.txt');
    const masterText = fs.readFileSync(masterPath, 'utf8');

    const { curves } = req.body;
    const visited = new Set();
    const allCurves = new Set();

    const matchedCDS = new Set();
    const matchedIRPDFDataContainer = new Set();

    function collectHierarchy(curveName) {
        if (visited.has(curveName)) return;
        visited.add(curveName);

        if (cdsNames.has(curveName)) {
            matchedCDS.add(curveName);
            allCurves.add(curveName);
        } else if (irpdfNames.has(curveName) || dataContainerNames.has(curveName)) {
            matchedIRPDFDataContainer.add(curveName);
        } else {
            const parents = findParentIndices(curveName) || [];
            parents.forEach(collectHierarchy);
            allCurves.add(curveName);
        }
    }

    curves.forEach(collectHierarchy);

    // ALM Curves: add selected curves to CQuotes_CurveManager.txt
    const defPath = path.join(__dirname, '..', 'curve_manager', 'CDef_CurveManager.txt');
    fs.writeFileSync(defPath, '', 'utf8');

    try {
        if (allCurves.size > 0) {
            const existingDefs = fs.readFileSync(defPath, 'utf8');

            const existingCurveNames = extractCurveNamesFromText(existingDefs);
            const writtenCurves = new Set(existingCurveNames);
            let combinedDef = '';

            for (const name of allCurves) {
                const blocks = defBlock(name); // returns array of { name, block }

                for (const { name: curveName, block } of blocks) {
                    // Prevent duplicates
                    if (!writtenCurves.has(curveName)) {
                        combinedDef += block + '\n';
                        writtenCurves.add(curveName);
                    }
                }
            }

            if (combinedDef.trim()) {
                fs.appendFileSync(defPath, combinedDef, 'utf8');
            }
        }


        if (matchedCDS.size > 0) {
            const cdsCurveList = path.join(__dirname, '..', 'curve_manager', 'CurveNames_CurveManager.txt');
            const cdsOutput = [...matchedCDS].join('\n') + '\n';
            fs.writeFileSync(cdsCurveList, cdsOutput, 'utf8');
        }

        if (matchedIRPDFDataContainer.size > 0) {
            const irpdfOutputPath = path.join(__dirname, '..', 'curve_manager', 'Templates_CurveManager.txt');
            const matchedBlocks = [...matchedIRPDFDataContainer]
                .map(name => extractCurveBlock(masterText, name))
                .filter(Boolean)
                .join('\n\n');
            fs.writeFileSync(irpdfOutputPath, matchedBlocks.trim() + '\n', 'utf8');
        }

        res.json({ message: '✅ Curve group saved successfully.' });
    } catch (err) {
        console.error('❌ Failed to write master files:', err);
        res.status(500).json({ error: 'Failed to write master files' });
    }
});


// Updates quotes data for specific CPI curve
function updateCPIValueInFile(filePath, curveName, section, matchKey, newValue) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let insideCurve = false;
    let currentCurve = '';
    let inSection = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#BeginCurve')) {
            insideCurve = true;
            currentCurve = '';
            inSection = false;
            continue;
        }

        if (insideCurve && line.startsWith('CurveName')) {
            currentCurve = line.split(/\s+/)[1]?.trim();
            continue;
        }

        if (insideCurve && currentCurve === curveName) {
            if (line.startsWith(`///:${section}`)) {
                inSection = true;
                continue;
            }

            if (inSection) {
                if (line.startsWith('///:') || line.startsWith('#') || line === '') {
                    inSection = false;
                    continue;
                }

                const parts = line.split(/\s+/);
                if (section === 'HistoricalCPI' && parts[0] === matchKey) {
                    lines[i] = `${parts[0]}\t${newValue}`;
                    break;
                } else if (section === 'SeasonalityRate' && parts[0] === matchKey) {
                    lines[i] = `${parts[0]}\t${newValue}`;
                    break;
                } else if (section === 'ZeroCouponInflationSwap' && parts[0] === 'ZCIS' && parts[1] === matchKey) {
                    lines[i] = `ZCIS\t${parts[1]}\t${newValue}`;
                    break;
                }
            }
        }

        if (line.startsWith('#EndCurve')) {
            insideCurve = false;
            currentCurve = '';
            inSection = false;
        }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}


// Update changes to CPI quotes file
router.post('/cpi-quotes/:curveName', (req, res) => {
    const filePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');
    const { historicalCPI, seasonalityRate, zcis } = req.body;
    const curveName = req.params.curveName;

    try {
        historicalCPI.forEach(row =>
            updateCPIValueInFile(filePath, curveName, 'HistoricalCPI', row.date, row.rate)
        );
        seasonalityRate.forEach(row =>
            updateCPIValueInFile(filePath, curveName, 'SeasonalityRate', row.month, row.rate)
        );
        zcis.forEach(row => {
            if (row.years != null && row.yield != null) {
                updateCPIValueInFile(filePath, curveName, 'ZeroCouponInflationSwap', row.years.toString(), row.yield);
            }
        });

        res.json({ message: '✅ CPI quotes updated successfully' });
    } catch (err) {
        console.error('❌ Failed to update CPI quotes:', err);
        res.status(500).json({ error: 'Failed to update CPI quotes' });
    }
});


// Get original CPI quotes data for a specific curve
router.get('/original-cpi-quotes/:curveName', (req, res) => {
    const filePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager_original.txt');
    const curveName = req.params.curveName;

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const block = extractCurveBlock(content, curveName);
        if (!block) {
            return res.status(404).json({ error: `Curve ${curveName} not found in original CPI quotes file` });
        }

        const lines = block.split('\n');
        const historicalCPI = [];
        const seasonalityRate = [];
        const zcis = [];
        let section = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('///:HistoricalCPI')) {
                section = 'historical';
                continue;
            } else if (trimmed.startsWith('///:SeasonalityRate')) {
                section = 'seasonality';
                continue;
            } else if (trimmed.startsWith('///:ZeroCouponInflationSwap')) {
                section = 'zcis';
                continue;
            } else if (trimmed.startsWith('///:') || trimmed.startsWith('#') || trimmed === '') {
                section = null;
                continue;
            }

            const parts = trimmed.split(/\s+/);
            if (section === 'historical' && parts.length === 2) {
                historicalCPI.push({ date: parts[0], rate: parseFloat(parts[1]) });
            } else if (section === 'seasonality' && parts.length === 2) {
                seasonalityRate.push({ month: parts[0], rate: parseFloat(parts[1]) });
            } else if (section === 'zcis' && parts.length === 3 && parts[0] === 'ZCIS') {
                zcis.push({ years: parseFloat(parts[1]), yield: parseFloat(parts[2]) });
            }
        }

        res.json({ curveName, historicalCPI, seasonalityRate, zcis });
    } catch (err) {
        console.error('Failed to read original CPI quotes:', err);
        res.status(500).json({ error: 'Failed to read original CPI quotes file' });
    }
});

// Sends CPI quotes data to frontend for displaying
router.get('/cpi-quotes/:curveName', (req, res) => {
    const filePath = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');
    const curveName = req.params.curveName;

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const block = extractCurveBlock(content, curveName);
        if (!block) return res.status(404).send('');

        const lines = block.split('\n');
        const historicalCPI = [], seasonalityRate = [], zcis = [];
        let section = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('///:HistoricalCPI')) section = 'historical';
            else if (trimmed.startsWith('///:SeasonalityRate')) section = 'seasonality';
            else if (trimmed.startsWith('///:ZeroCouponInflationSwap')) section = 'zcis';
            else if (trimmed.startsWith('///:') || trimmed.startsWith('#') || trimmed === '') section = null;
            else {
                const parts = trimmed.split(/\s+/);
                if (section === 'historical' && parts.length === 2 && parts[0] !== 'Date' && !isNaN(parseFloat(parts[1]))) {
                    historicalCPI.push({ date: parts[0], rate: parseFloat(parts[1]) });
                } else if (section === 'seasonality' && parts.length === 2 && parts[0] !== 'Month' && !isNaN(parseFloat(parts[1]))) {
                    seasonalityRate.push({ month: parts[0], rate: parseFloat(parts[1]) });
                } else if (section === 'zcis' && parts.length === 3 && parts[0] === 'ZCIS' && !isNaN(parseFloat(parts[1])) && !isNaN(parseFloat(parts[2]))) {
                    zcis.push({ years: parseFloat(parts[1]), yield: parseFloat(parts[2]) });
                }
            }
        }

        res.json({ curveName, historicalCPI, seasonalityRate, zcis });
    } catch (err) {
        console.error('Failed to read CPI quotes:', err);
        res.status(500).json({ error: 'Failed to read CPI quotes file' });
    }
});

// Clear CDef_CurveManager.txt and CQuotes_CurveManager.txt for resetting curve group
router.post('/clear-curve-files', (req, res) => {
    try {
        defFile = path.join(__dirname, '..', 'curve_manager', 'CDef_CurveManager.txt');
        quotesFile = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager.txt');
        originalQuotesFile = path.join(__dirname, '..', 'curve_manager', 'CQuotes_CurveManager_original.txt');
        cdsCurveList = path.join(__dirname, '..', 'curve_manager', 'CurveNames_CurveManager.txt');
        templates = path.join(__dirname, '..', 'curve_manager', 'Templates_CurveManager.txt');

        fs.writeFileSync(defFile, '');
        fs.writeFileSync(quotesFile, '');
        fs.writeFileSync(originalQuotesFile, '');
        fs.writeFileSync(cdsCurveList, '');
        fs.writeFileSync(templates, '');
        res.json({ status: 'success', message: 'Curve group reset successfully.' });
    } catch (err) {
        console.error('Error clearing files:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Get the last modified time of the PAVE.exe file used by the website
router.get('/PAVE-modified-time', (req, res) => {
    const filePath = path.join(__dirname, '..', 'Dll_Exe_file', 'PAVE.exe');
    try {
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            res.json({ modifiedTime: stats.mtime });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (err) {
        console.error('Error retrieving file stats:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


module.exports = router;
