// AI Models Manager
// This module handles downloading, caching, and managing AI models.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const modelsDir = path.join(__dirname, 'ai', 'models');

// Ensure the models directory exists
if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
}

/**
 * Download a model from a given URL.
 * @param {string} modelName - The name of the model.
 * @param {string} url - The URL to download the model from.
 * @returns {Promise<string>} - The path to the downloaded model.
 */
async function downloadModel(modelName, url) {
    const modelPath = path.join(modelsDir, modelName);

    if (fs.existsSync(modelPath)) {
        console.log(`Model "${modelName}" already exists.`);
        return modelPath;
    }

    console.log(`Downloading model "${modelName}" from ${url}...`);

    const writer = fs.createWriteStream(modelPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            console.log(`Model "${modelName}" downloaded successfully.`);
            resolve(modelPath);
        });
        writer.on('error', (error) => {
            console.error(`Failed to download model "${modelName}":`, error);
            reject(error);
        });
    });
}

/**
 * List all available models in the cache.
 * @returns {string[]} - An array of model names.
 */
function listModels() {
    return fs.readdirSync(modelsDir).filter((file) => fs.statSync(path.join(modelsDir, file)).isFile());
}

/**
 * Delete a model from the cache.
 * @param {string} modelName - The name of the model to delete.
 */
function deleteModel(modelName) {
    const modelPath = path.join(modelsDir, modelName);

    if (fs.existsSync(modelPath)) {
        fs.unlinkSync(modelPath);
        console.log(`Model "${modelName}" deleted successfully.`);
    } else {
        console.log(`Model "${modelName}" does not exist.`);
    }
}

module.exports = {
    downloadModel,
    listModels,
    deleteModel,
};