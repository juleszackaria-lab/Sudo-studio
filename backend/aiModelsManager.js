const fs = require('fs');
const path = require('path');
const axios = require('axios');

const modelsPath = path.join(__dirname, 'models');

if (!fs.existsSync(modelsPath)) {
  fs.mkdirSync(modelsPath);
}

const models = [
  {
    name: 'Mistral',
    url: 'https://huggingface.co/mistral/resolve/main/pytorch_model.bin',
    fileName: 'mistral.bin',
  },
  {
    name: 'LLaMA',
    url: 'https://huggingface.co/llama/resolve/main/pytorch_model.bin',
    fileName: 'llama.bin',
  },
];

function listModels() {
  return models.map((model) => {
    const filePath = path.join(modelsPath, model.fileName);
    return {
      name: model.name,
      fileName: model.fileName,
      installed: fs.existsSync(filePath),
    };
  });
}

async function downloadModel(modelName) {
  const model = models.find((m) => m.name === modelName);
  if (!model) {
    throw new Error(`Model ${modelName} not found.`);
  }

  const filePath = path.join(modelsPath, model.fileName);
  if (fs.existsSync(filePath)) {
    console.log(`Model ${modelName} is already downloaded.`);
    return;
  }

  const writer = fs.createWriteStream(filePath);
  const response = await axios({
    url: model.url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log(`Model ${modelName} downloaded successfully.`);
      resolve();
    });
    writer.on('error', (err) => {
      console.error(`Error downloading model ${modelName}:`, err);
      reject(err);
    });
  });
}

module.exports = {
  listModels,
  downloadModel,
};