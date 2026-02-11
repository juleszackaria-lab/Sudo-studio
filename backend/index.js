const express = require('express');
const { installSDK, configurePath } = require('./installers/sdkInstaller');
const { checkEnvironment } = require('./doctor/environmentDoctor');

const app = express();
const PORT = 3001;

app.use(express.json());

// Endpoint to check environment
app.get('/api/doctor', async (req, res) => {
  try {
    const report = await checkEnvironment();
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to install SDK
app.post('/api/install-sdk', (req, res) => {
  const { sdkName, downloadUrl, installPath } = req.body;

  if (!sdkName || !downloadUrl || !installPath) {
    return res.status(400).json({ success: false, error: 'Missing parameters.' });
  }

  installSDK(sdkName, downloadUrl, installPath);
  res.json({ success: true, message: `${sdkName} installation started.` });
});

// Endpoint to configure PATH
app.post('/api/configure-path', (req, res) => {
  const { newPath } = req.body;

  if (!newPath) {
    return res.status(400).json({ success: false, error: 'Missing newPath parameter.' });
  }

  configurePath(newPath);
  res.json({ success: true, message: `PATH configuration started for ${newPath}.` });
});

app.listen(PORT, () => {
  console.log(`Papito backend running on http://localhost:${PORT}`);
});