// AI Models Manager
// This module handles downloading, caching, metadata and simple lifecycle for AI models.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');

const PY_RUNTIME = path.join(__dirname, '..', 'runtime', 'server.py');
const BASE_PORT = 6000;

const modelsDir = path.join(__dirname, 'models');
const metadataFile = path.join(modelsDir, 'models.json');

// In-memory runtime state for models (status, pid, ...)
const runtimeState = {};

// Ensure the models directory exists
if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
}

// Load or init metadata
let metadata = {};
if (fs.existsSync(metadataFile)) {
    try {
        metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')) || {};
    } catch (e) {
        console.warn('Failed to parse models metadata, starting fresh.');
        metadata = {};
    }
}

function saveMetadata() {
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
}

async function downloadModel(modelName, url) {
    const modelPath = path.join(modelsDir, modelName);

    if (fs.existsSync(modelPath)) {
        console.log(`Model "${modelName}" already exists.`);
        // Ensure metadata exists
        metadata[modelName] = metadata[modelName] || { url, path: modelPath, size: fs.statSync(modelPath).size };
        saveMetadata();
        return modelPath;
    }

    console.log(`Downloading model "${modelName}" from ${url}...`);

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
    // Return metadata entries (name + info)
    return Object.keys(metadata).map((name) => ({ name, ...metadata[name], status: runtimeState[name]?.status || 'stopped' }));
}

function getModelInfo(modelName) {
    if (!metadata[modelName]) return null;
    return { name: modelName, ...metadata[modelName], status: runtimeState[modelName]?.status || 'stopped' };
}

function deleteModel(modelName) {
    const modelPath = path.join(modelsDir, modelName);

    if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
        console.log(`Model "${modelName}" deleted successfully.`);
    } else {
        console.log(`Model "${modelName}" does not exist.`);
    }
    delete metadata[modelName];
    delete runtimeState[modelName];
    saveMetadata();
}

// Simple lifecycle controls (placeholders). Real runtimes should spawn model servers or processes.
function startModel(modelName) {
    if (!metadata[modelName]) throw new Error('Model not found');
    if (runtimeState[modelName] && runtimeState[modelName].status === 'running') return runtimeState[modelName];

    // pick a free port
    const usedPorts = Object.values(runtimeState).map(s => s.port).filter(Boolean);
    let port = BASE_PORT;
    while (usedPorts.includes(port)) port++;

    // logs
    const outLog = path.join(modelsDir, `${modelName}.out.log`);
    const errLog = path.join(modelsDir, `${modelName}.err.log`);

    const child = spawn('python3', [PY_RUNTIME, '--model', modelName, '--port', String(port)], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore']
    });
    try {
        runtimeState[modelName] = { status: 'running', pid: child.pid, port, startedAt: Date.now() };
        // detach so child keeps running
        child.unref();
        console.log(`Started runtime for ${modelName} (pid=${child.pid}) on port ${port}`);
    } catch (e) {
        console.error('Failed to start runtime process', e);
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
        console.warn('Failed to kill process', e.message || e);
    }
    runtimeState[modelName].status = 'stopped';
    runtimeState[modelName].stoppedAt = Date.now();
}

// Inference placeholder: replace with real runtime call (HTTP/RPC to model server, or child process)
async function infer(modelName, input) {
    if (modelName && !metadata[modelName]) throw new Error('Model not available');
    const s = runtimeState[modelName];
    if (!s || s.status !== 'running') {
        // attempt to start
        startModel(modelName);
        // wait briefly for server to spin up
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
        console.error('Inference call failed', e.message || e);
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