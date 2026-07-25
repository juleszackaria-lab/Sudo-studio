// AI Models Manager
// PKG-SAFE: all writable paths use process.execPath-relative resolution.
// Under pkg, __dirname = /snapshot/... (READ-ONLY virtual FS).
// All directories that need writing use BASE (install root).

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');

// ----------------------------------------------------------------
// PKG-SAFE base directory
// pkg  → path.dirname(process.execPath) = C:\SudoStudio\app\
//        path.join(..., '..') = C:\SudoStudio\   (install root)
// dev  → path.join(__dirname, '..', '..') = backend's parent
// ----------------------------------------------------------------
const BASE = process.pkg
  ? path.join(path.dirname(process.execPath), '..')
  : path.join(__dirname, '..', '..');

// Python runtime script lives inside the snapshot (read-only is fine for reads)
const PY_RUNTIME = process.pkg
  ? path.join(path.dirname(process.execPath), 'runtime', 'server.py')
  : path.join(__dirname, '..', 'runtime', 'server.py');

const BASE_PORT = 6000;

// Writable models directory — next to the exe at install root level
const modelsDir    = path.join(BASE, 'data', 'ai-models');
const metadataFile = path.join(modelsDir, 'models.json');

console.log('[PKG-SAFE] aiModelsManager writing to:', modelsDir);

// In-memory runtime state for models (status, pid, ...)
const runtimeState = {};

// Ensure the models directory exists
try {
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
    console.log('[PKG-SAFE] Created models dir:', modelsDir);
  }
} catch (e) {
  console.error('[aiModelsManager] WARNING: Cannot create modelsDir:', e.message);
}

// Load or init metadata
let metadata = {};
try {
  if (fs.existsSync(metadataFile)) {
    metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')) || {};
  }
} catch (e) {
  console.warn('[aiModelsManager] Failed to parse models metadata, starting fresh:', e.message);
  metadata = {};
}

function saveMetadata() {
  try {
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
  } catch (e) {
    console.error('[aiModelsManager] Cannot save metadata:', e.message);
  }
}

async function downloadModel(modelName, url) {
  const modelPath = path.join(modelsDir, modelName);

  if (fs.existsSync(modelPath)) {
    console.log(`Model "${modelName}" already exists at ${modelPath}`);
    metadata[modelName] = metadata[modelName] || { url, path: modelPath, size: fs.statSync(modelPath).size };
    saveMetadata();
    return modelPath;
  }

  console.log(`[PKG-SAFE] Downloading model "${modelName}" to ${modelPath}...`);

  const writer = fs.createWriteStream(modelPath);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      const size = fs.statSync(modelPath).size;
      metadata[modelName] = { url, path: modelPath, size };
      saveMetadata();
      console.log(`Model "${modelName}" downloaded successfully.`);
      resolve(modelPath);
    });
    writer.on('error', (error) => {
      console.error(`Failed to download model "${modelName}":`, error);
      try { fs.unlinkSync(modelPath); } catch (e) {}
      reject(error);
    });
  });
}

function listModels() {
  return Object.keys(metadata).map((name) => ({
    name,
    ...metadata[name],
    status: runtimeState[name]?.status || 'stopped',
  }));
}

function getModelInfo(modelName) {
  if (!metadata[modelName]) return null;
  return { name: modelName, ...metadata[modelName], status: runtimeState[modelName]?.status || 'stopped' };
}

function deleteModel(modelName) {
  const modelPath = path.join(modelsDir, modelName);

  if (fs.existsSync(modelPath)) {
    fs.unlinkSync(modelPath);
    console.log(`Model "${modelName}" deleted.`);
  } else {
    console.log(`Model "${modelName}" does not exist.`);
  }
  delete metadata[modelName];
  delete runtimeState[modelName];
  saveMetadata();
}

function startModel(modelName) {
  if (!metadata[modelName]) throw new Error('Model not found');
  if (runtimeState[modelName] && runtimeState[modelName].status === 'running') {
    return runtimeState[modelName];
  }

  // Pick a free port
  const usedPorts = Object.values(runtimeState).map(s => s.port).filter(Boolean);
  let port = BASE_PORT;
  while (usedPorts.includes(port)) port++;

  const child = spawn('python3', [PY_RUNTIME, '--model', modelName, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    runtimeState[modelName] = { status: 'running', pid: child.pid, port, startedAt: Date.now() };
    child.unref();
    console.log(`Started runtime for ${modelName} (pid=${child.pid}) on port ${port}`);
  } catch (e) {
    console.error('[aiModelsManager] Failed to start runtime process:', e);
    throw e;
  }
  return runtimeState[modelName];
}

function stopModel(modelName) {
  const s = runtimeState[modelName];
  if (!s) return;
  try {
    if (s.pid) process.kill(s.pid);
  } catch (e) {
    console.warn('[aiModelsManager] Failed to kill process:', e.message || e);
  }
  runtimeState[modelName].status = 'stopped';
  runtimeState[modelName].stoppedAt = Date.now();
}

async function infer(modelName, input) {
  if (modelName && !metadata[modelName]) throw new Error('Model not available');
  const s = runtimeState[modelName];
  if (!s || s.status !== 'running') {
    startModel(modelName);
    await new Promise(r => setTimeout(r, 3000));
  }
  const state = runtimeState[modelName];
  if (!state || !state.port) {
    return { reply: `Runtime not available for ${modelName}` };
  }
  try {
    const url = `http://127.0.0.1:${state.port}/infer`;
    const resp = await axios.post(url, { input });
    return resp.data;
  } catch (e) {
    console.error('[aiModelsManager] Inference call failed:', e.message || e);
    return { reply: `Inference failed: ${e.message || e}` };
  }
}

module.exports = {
  downloadModel,
  listModels,
  deleteModel,
  getModelInfo,
  startModel,
  stopModel,
  infer,
};
