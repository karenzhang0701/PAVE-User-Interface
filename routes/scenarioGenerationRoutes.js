const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const curveCache = {
  names: null,
  definitions: new Map()
};

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

// Extract all curve names from text provided
function extractCurveNamesFromText(text) {
  const curveNames = new Set();
  const blocks = text.split('#BeginCurve');
  for (const block of blocks) {
    const match = block.match(/CurveName\s+([^\s]+)/);
    if (match) {
      const name = match[1].trim();

      // Skip Surv_Generic curves
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
  console.log(blocks);
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

// Returns list of all curve names for specific curve class
router.get('/all-curve-names', (req, res) => {
  try {
    const curveNames = getCurveNames();
    res.json(curveNames);
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract curve names' });
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

// Sends quotes values (scenario generation) to the frontend
router.get('/scenario-quotes/:curveName', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const block = extractCurveBlock(content, req.params.curveName);
    if (!block) {
      return res.status(404).json({ error: 'Curve not found in scenario quotes file' });
    }
    res.send(block.trim());
  } catch (err) {
    console.error('Failed to read scenario quotes:', err);
    res.status(500).json({ error: 'Failed to read scenario quotes file' });
  }
});

// Sends CPI quotes data to frontend for displaying
router.get('/cpi-quotes/:curveName', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
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
router.post('/save-cpi-quotes/:curveName', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
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


// Sends original CPI quotes for a specific curve
router.get('/original-cpi-quotes/:curveName', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup_original.txt');
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

// Returns curve category from CQuotes
function getCurveCategory(curveName) {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
  if (!fs.existsSync(filePath)) return null;

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let insideCurve = false;
  let currentCurve = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#BeginCurve')) {
      insideCurve = true;
      currentCurve = '';
    } else if (insideCurve && trimmed.startsWith('CurveName')) {
      currentCurve = trimmed.split(/\s+/)[1];
    } else if (insideCurve && trimmed.startsWith('CurveCategory') && currentCurve === curveName) {
      return trimmed.split(/\s+/)[1];
    } else if (trimmed.startsWith('#EndCurve')) {
      insideCurve = false;
      currentCurve = '';
    }
  }

  return null;
}


// Return tenors from definitions block
function extractTenorsFromDef(defBlock, curveName) {
  const lines = defBlock.split('\n');
  let tenors = [];

  const startIndex = lines.findIndex(line => line.includes('///:CurveMarketQuotes'));
  if (startIndex === -1) return [];

  let tenorIndex = -1;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const headerLine = lines[i].trim();
    if (headerLine === '' || headerLine.startsWith('-')) continue;

    const headers = headerLine.split(/\s+/);
    tenorIndex = headers.indexOf('Tenor');
    if (tenorIndex !== -1) {
      for (let j = i + 2; j < lines.length; j++) {
        const row = lines[j].trim();
        if (row === '' || row.startsWith('#EndCurve')) break;

        const parts = row.split(/\s+/);
        if (parts.length > tenorIndex) {
          tenors.push(parts[tenorIndex]);
        }
      }
      break;
    }
  }

  return [...new Set(tenors)].map(tenor => `${tenor}${curveName}`);
}


function extractRiskFactors(text, curveName) {
  const lines = text.split('\n');
  const riskFactors = [];

  let insideCurve = false;
  let curveType = null;
  let inQuotesSection = false;
  let headers = [];
  let keyIndex = -1;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#BeginCurve')) {
      insideCurve = true;
      curveType = null;
      inQuotesSection = false;
      headers = [];
      keyIndex = -1;
      continue;
    }

    if (trimmed.startsWith('#EndCurve')) {
      insideCurve = false;
      curveType = null;
      inQuotesSection = false;
      headers = [];
      keyIndex = -1;
      continue;
    }

    if (!insideCurve) continue;

    if (trimmed.startsWith('CurveType')) {
      curveType = trimmed.split(/\s+/)[1];
    }

    if (trimmed.startsWith('///:CurveMarketQuotes')) {
      inQuotesSection = true;
      headers = [];
      keyIndex = -1;
      continue;
    }

    if (inQuotesSection && headers.length === 0 && trimmed && !trimmed.startsWith('-')) {
      headers = trimmed.split(/\t/);
      if (curveType === 'BondSpotCurve') {
        keyIndex = headers.indexOf('Cusip');
      } else if (curveType === 'SpotPriceCurve') {
        keyIndex = headers.indexOf('Ticker');
      }
      continue;
    }

    if (inQuotesSection && headers.length > 0 && trimmed && !trimmed.startsWith('-')) {
      const parts = trimmed.split(/\t/);
      if (keyIndex >= 0 && parts.length > keyIndex) {
        riskFactors.push(parts[keyIndex]);
      }
    }
  }

  return riskFactors;
}


// Send tenors to frontend
router.post('/tenors', (req, res) => {
  const curves = req.body.curves;
  const shock = req.body.shock;
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
  const content = fs.readFileSync(filePath, 'utf8');

  const dataContainerNames = new Set([
    'BOND_PRICES.CAD', 'BOND_PRICES.JPY', 'BOND_PRICES.USD',
    'MarketPX.CAD', 'MarketPX.JPY', 'MarketPX.USD',
    'FX_CAD.USD', 'FX_JPY.USD', 'FX_SGD.USD', 'FX_USD.AUD',
    'FX_USD.EUR', 'FX_USD.GBP', 'FX_USD.NZD',
    'IBOXUSHY.USD', 'MFCPRIndx.CAD'
  ]);

  const curveData = curves.map(curveName => {
    const block = extractCurveBlock(content, curveName);
    const curveCategory = getCurveCategory(curveName);
    let tenors = [];

    const curveType = dataContainerNames.has(curveName) ? 'EQ' : 'IR';
    console.log(shock === 'ALL');

    if (shock === 'ALL') {
      if (curveCategory === 'BondSpotCurve' || curveCategory === 'SpotPriceCurve') {
        tenors = extractRiskFactors(block);
      } else if (curveType === 'IR') {
        tenors = [`3m`, `6m`, `1y`, `2y`,
          `3y`, `5y`, `7y`, `10y`,
          `20y`, `30y`
        ];
      } else {
        tenors = extractTenorsFromDef(block, curveName);
      }
    } else if (shock === 'Curve Name') {
      if (curveCategory === 'BondSpotCurve' || curveCategory === 'SpotPriceCurve') {
        tenors = extractRiskFactors(block);
      } else {
        tenors = extractTenorsFromDef(block, curveName);
      }
    }

    return {
      name: curveName,
      type: curveType,
      tenors: tenors
    };
  });

  res.json({ curves: curveData });
});


// Returns list of curve names in CQuotes_ScenarioGroup.txt (user's selected curves)
router.get('/quotes-curve-list', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'CQuotes_ScenarioGroup.txt not found' });
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const names = Array.from(extractCurveNamesFromText(content));
  res.json({ curves: names });
});

// Returns quote block for specific curve
router.get('/quotes/:curveName', (req, res) => {
  const curveName = req.params.curveName;
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');

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

// Updates quote data changes in CQuotes_ScenarioGroup.txt
router.post('/save-quote-changes/:curveName', (req, res) => {
  const { rowIndex, field, newValue } = req.body;
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');

  try {
    updateQuoteInFile(filePath, req.params.curveName, rowIndex, field, newValue);
    res.json({ message: 'Quote updated successfully' });
  } catch (err) {
    console.error('Failed to update quote:', err);
    res.status(500).json({ error: 'Failed to update quote' });
  }
});


// Returns original quote data for specific curve
router.get('/original-quotes/:curveName', (req, res) => {
  try {
    const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup_original.txt');
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

// Runs Python script to generate curve quotes data for selected curves
router.post('/generate-quotes', async (req, res) => {
  console.log('Running Python script');
  const { date } = req.body;

  const defPath = path.join(__dirname, '..', 'scenario_generation', 'CDef_ScenarioGroup.txt');
  const quotePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
  fs.writeFileSync(quotePath, '', 'utf8');

  try {
    const { spawnSync } = require('child_process');
    const scriptPath = path.join(__dirname, '..', 'FindurCurve.py');

    const defPath = path.join(__dirname, '..', 'scenario_generation', 'CDef_ScenarioGroup.txt');

    // Create Python script command dpending on curve type
    const args = [scriptPath, '-curveDate', date];

    args.push('-curveDefFile', defPath);

    const templatePath = path.join(__dirname, '..', 'scenario_generation', 'Templates_ScenarioGroup.txt');
    args.push('-curveTemplate', templatePath);

    const curveNamesPath = path.join(__dirname, '..', 'scenario_generation', 'CurveNames_ScenarioGroup.txt');
    args.push('-curveNames', curveNamesPath);

    const quotePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
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

    // Get curves with missing quotes data
    let missingCurves = [];
    const output = result.stdout;
    const match = output.match(/Curves in definition file WITHOUT data:\s*([\s\S]*?)(?:\n\s*\n|Data has been written|$)/);
    if (match) {
      missingCurves = match[1].trim().split('\n').map(line => line.trim()).filter(Boolean);
    }

    console.log('✅ Python script output:', result.stdout);

    // Create another file for storing copy of original quotes data
    const originalPath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup_original.txt');
    fs.copyFileSync(quotePath, originalPath);

    res.json({ message: 'Quotes generated successfully', output: result.stdout, missingCurves });
  } catch (err) {
    console.error('Python script error:', err);
    return res.status(500).json({ error: 'Error while running Python script' });
  }
});

// Add definitions for selected curves and their parent curves to CDef_ScenarioGroup.txt
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

  const defPath = path.join(__dirname, '..', 'scenario_generation', 'CDef_ScenarioGroup.txt');
  fs.writeFileSync(defPath, '', 'utf8');


  console.log(allCurves);
  console.log(matchedCDS);
  console.log(matchedIRPDFDataContainer);

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
      const cdsCurveList = path.join(__dirname, '..', 'scenario_generation', 'CurveNames_ScenarioGroup.txt');
      const cdsOutput = [...matchedCDS].join('\n') + '\n';
      fs.writeFileSync(cdsCurveList, cdsOutput, 'utf8');
    }

    if (matchedIRPDFDataContainer.size > 0) {
      const irpdfOutputPath = path.join(__dirname, '..', 'scenario_generation', 'Templates_ScenarioGroup.txt');
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

// Generate scenario definitions file based on user's selected parameters
router.post('/save-scenario-def', (req, res) => {
  const scenario = req.body;
  const type = req.query.type;
  const isShockByCurveType = ['Bond', 'YieldCurve', 'Surv'].includes(scenario.curveName);

  const fileName = `scenario_definition.txt`;
  const filePath = path.join(__dirname, '..', 'scenario_generation', fileName);

  const prefix = type === 'Data Container' ? 'EQ' : 'IR';
  let content = `\nGridSurfaceName\tALM_QIS_DV01\n///:Parameters\n`;

  if (scenario.containsDC === 'some') {
    content += `IRDataType\t${scenario.IRDataType}\n`;
    content += `EQDataType\t${scenario.EQDataType}\n`;
  } else if (scenario.containsDC === 'all') {
    content += `EQDataType\t${scenario.EQDataType}\n`;
  } else {
    content += `IRDataType\t${scenario.IRDataType}\n`;
  }

  if (!scenario.IRRiskFactors && !scenario.EQRiskFactors) {
    content += `${prefix}RiskFactors\t3m:6m:1y:2y:3y:5y:7y:10y:20y:30y\n`;
  } else if (scenario.containsDC === 'some') {
    content += `IRRiskFactors\t${scenario.IRRiskFactors}\n`;
    content += `EQRiskFactors\t${scenario.EQRiskFactors}\n`;
  } else if (scenario.containsDC === 'all') {
    content += `EQRiskFactors\t${scenario.EQRiskFactors}\n`;
  } else if (scenario.containsDC === 'none') {
    content += `IRRiskFactors\t${scenario.IRRiskFactors}\n`;
  }

  if (scenario.IRShockType === 'Spread') content += `${prefix}ShockType\tSpread\n`;

  if (scenario.containsDC === 'some') {
    content += `IRShockAmt\t0.001\n`;
    content += `EQShockAmt\t0.01\n`;
  } else if (scenario.containsDC === 'all') {
    content += `EQShockAmt\t0.01\n`;
  } else {
    content += `IRShockAmt\t0.001\n`;
  }

  if (scenario.Greek === false) content += `GreekOff\ttrue\n`;

  if (scenario.tenors && Array.isArray(scenario.tenors)) {
    content += `\n///:GridName\t${scenario.tenors.join('\t')}\n`;
  } else {
    content += `\n///:GridName\tCurveName\t3m\t6m\t1y\t2y\t3y\t5y\t7y\t10y\t20y\t30y\n`;
  }

  scenario.rows.forEach(row => {
    const rowValues = row.values.join('\t');
    content += `${row.GridName}\t${rowValues}\n`;
  });

  try {
    const contentWithCRLF = content.replace(/\n/g, '\r\n');
    fs.writeFileSync(filePath, contentWithCRLF, { encoding: 'utf8' });
    res.json({ message: '✅ Scenario saved successfully', file: fileName });
  } catch (err) {
    console.error('❌ Failed to save scenario:', err);
    res.status(500).json({ error: 'Failed to save scenario file' });
  }
});

// Run PAVE for scenario generation
router.post('/run-scenario-generation', (req, res) => {
  const valuationDate = req.body.valuationDate;

  // Run from scenario_generation folder
  const workingDir = path.join(__dirname, '..', 'scenario_generation');
  const exePath = path.join('..', 'Dll_Exe_file', 'PAVE.exe');
  const defFilePath = path.join(workingDir, 'CDef_ScenarioGroup.txt');

  let defFlag = '';
  const stats = fs.statSync(defFilePath);
  if (stats.size > 0) {
    defFlag = '-txtcdf CDef_ScenarioGroup.txt';
  }

  const quoteFile = 'CQuotes_ScenarioGroup.txt';
  const scenarioFile = 'scenario_definition.txt';
  const outputFilePath = path.join(workingDir, 'curve_scenario.txt');

  const command = `"${exePath}" -vd ${valuationDate} -path .\\ -c "${quoteFile}" ${defFlag} -debug "Debug.txt" -sd "${scenarioFile}"`;

  console.log(`Running: ${command}`);

  try {
    const output = execSync(command, { cwd: workingDir, maxBuffer: 1024 * 1024 * 50 });
    console.log(`✅ Output saved to: ${outputFilePath}`);

    const fileContent = fs.readFileSync(outputFilePath, 'utf8');
    const debugPath = path.join(__dirname, '..', 'scenario_generation', 'Debug.txt');
    const debugContent = fs.readFileSync(debugPath, 'utf8');
    res.json([{ curve: 'Scenario', output: fileContent, debug: debugContent }]);
  } catch (err) {
    console.error(`❌ PAVE failed:`, err.message);
    res.status(500).json({ error: `PAVE failed: ${err.message}` });
  }
});

// Send scenario definition file to frontend
router.get('/scenario/:curveName', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'scenario_definition.txt');
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    res.send(content);
  } else {
    res.status(404).json({ error: 'Scenario file not found' });
  }
});

// Sends scenario txt file in plain text to frontend for "Viewing Scenario File"
router.get('/scenario.txt', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'scenario_definition.txt');
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(filePath);
});

// Returns parent curves for given curve
router.get('/parents/:curveName', (req, res) => {
  try {
    const parents = findParentIndices(req.params.curveName);
    if (parents == null) {
      return res.status(404).json({ error: 'Curve not found' });
    }
    res.json({ curve: req.params.curveName, parents });
  } catch (err) {
    console.error('Failed to extract parent indices: ', err);
    res.status(500).json({ error: 'Internal server error' });
  }
})

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


// Returns curve category from CQuotes file
router.get('/curve-category/:curveName', (req, res) => {
  const curveName = req.params.curveName;
  const category = getCurveCategory(curveName);

  if (category) {
    res.json({ curveName, curveCategory: category });
  } else {
    res.status(404).json({ error: `CurveCategory not found for ${curveName}` });
  }
});

// Download quotes for selected curves in scenario generation
router.get('/download/scenarioQuotes', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'CQuotes_ScenarioGroup.txt');
  } else {
    res.status(404).json({ error: 'Quotes file not found ' });
  }
})

// Download curve definitions
router.get('/download/curveDef', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'CDef_ScenarioGroup.txt');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'CDef_ScenarioGroup.txt');
  } else {
    res.status(404).json({ error: 'Def file not found ' });
  }
})


// Download PAVE output from scenario generation
router.get('/download/scenarioOutput', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'curve_scenario.txt');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'curve_scenario.txt');
  } else {
    res.status(404).json({ error: 'Scenario output file not found' });
  }
});

// Download scenario definition file
router.get('/download/scenarioDefinition', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'scenario_definition.txt');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'scenario_definition.txt');
  } else {
    res.status(404).json({ error: 'Scenario definition file not found' });
  }
})

// Download Debug.txt
router.get('/download/debug', (req, res) => {
  const filePath = path.join(__dirname, '..', 'scenario_generation', 'Debug.txt');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'Debug.txt');
  } else {
    res.status(404).json({ error: 'Debug file not found' });
  }
})

// Clear CDef_ScenarioGroup.txt and CQuotes_ScenarioGroup.txt for resetting curve group
router.post('/clear-curve-files', (req, res) => {
  try {
    defFile = path.join(__dirname, '..', 'scenario_generation', 'CDef_ScenarioGroup.txt');
    quotesFile = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup.txt');
    originalQuotesFile = path.join(__dirname, '..', 'scenario_generation', 'CQuotes_ScenarioGroup_original.txt');
    curveNames = path.join(__dirname, '..', 'scenario_generation', 'CurveNames_ScenarioGroup.txt');
    template = path.join(__dirname, '..', 'scenario_generation', 'Templates_ScenarioGroup.txt');

    fs.writeFileSync(defFile, '');
    fs.writeFileSync(quotesFile, '');
    fs.writeFileSync(originalQuotesFile, '');
    fs.writeFileSync(curveNames, '');
    fs.writeFileSync(template, '');
    res.json({ status: 'success', message: 'Curve group reset successfully.' });
  } catch (err) {
    console.error('Error clearing files:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
