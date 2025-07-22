const express = require('express');
const path = require('path');
const app = express();
const port = 5000;
const fs = require('fs');
const { execSync } = require('child_process');

const curveManagerRoutes = require('./routes/curveManagerRoutes');
const scenarioRoutes = require('./routes/scenarioGenerationRoutes');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/curve-manager', curveManagerRoutes);
app.use('/api/scenario-generation', scenarioRoutes);

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});


// Run PAVE using CDef_CurveManager.txt and CQuotes_CurveManager.txt
app.post('/api/run-pave', (req, res) => {
  const valuationDate = req.body.valuationDate;
  const source = req.body.source;
  const type = req.body.type;

  const workingDir = path.join(__dirname, 'curve_manager');
  const exePath = path.join('..', 'Dll_Exe_file', 'PAVE.exe');

  const isALM = source === 'ALM';
  const isIRPDF = type === 'IRPDF';
  const isDataContainer = type === 'Data Container';

  // Exclude definitions argument for ALM and Data Container curves
  let defFlag = '';
  if (!isALM && !isDataContainer) {
    let defFile = '';
    if (isIRPDF) {
      defFile = path.join('..', 'definitions', 'CDef_IRPDF_JPYAUD.txt');
    } else if (type === 'CDS') {
      defFile = path.join('..', 'definitions', 'CDef_CDS.txt');
    } else {
      defFile = 'CDef_CurveManager.txt';
    }
    defFlag = `-txtcdf "${defFile}"`;
  }

  const command = `"${exePath}" -vd ${valuationDate} -path .\\ -c "CQuotes_CurveManager.txt" ${defFlag} -debug "Debug.txt"`;

  console.log(`Running: ${command}`);

  try {
    const output = execSync(command, { cwd: workingDir }).toString();
    const outputFilePath = path.join(workingDir, 'curve_DF.txt');
    console.log(`✅ Output saved to: ${outputFilePath}`);

    const debugPath = path.join(workingDir, 'Debug.txt');
    debugContent = fs.readFileSync(debugPath, 'utf8');
    res.json([{ curve: 'CurveManager', output, debug: debugContent }]);
  } catch (err) {
    console.error(`❌ PAVE failed:`, err.message);
    res.status(500).json({ error: `PAVE failed: ${err.message}` });
  }
});
