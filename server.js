const express = require('express');
const path = require('path');
const app = express();
const port = 5000;
const fs = require('fs');
const { execSync } = require('child_process');

const curveManagerRoutes = require('./routes/curveManagerRoutes');
const scenarioRoutes = require('./routes/scenarioGenerationRoutes');
const dealManagerRoutes = require('./routes/dealsManagerRoutes.js');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/curve-manager', curveManagerRoutes);
app.use('/api/scenario-generation', scenarioRoutes);
app.use('/api/deals-manager', dealManagerRoutes);

// Static file serving
app.use('/deals_manager', express.static(path.join(__dirname, 'deals_manager')));

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});


// Run PAVE using CDef_CurveManager.txt and CQuotes_CurveManager.txt
app.post('/api/run-pave', (req, res) => {
  const valuationDate = req.body.valuationDate;

  const workingDir = path.join(__dirname, 'curve_manager');
  const exePath = path.join('..', 'Dll_Exe_file', 'PAVE.exe');
  const defFilePath = path.join(workingDir, 'CDef_CurveManager.txt');

  let defFlag = '';
  const stats = fs.statSync(defFilePath);
  if (stats.size > 0) {
    defFlag = '-txtcdf CDef_CurveManager.txt';
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
