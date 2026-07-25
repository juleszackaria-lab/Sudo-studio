// download-models.js — PKG-SAFE model downloader
// Under pkg, __dirname = /snapshot/... (READ-ONLY virtual FS).
// All writes use BASE (install root) via process.execPath.

const fs = require('fs');
const https = require('https');
const path = require('path');

const MAX_SIZE_MB = 100;

// ----------------------------------------------------------------
// PKG-SAFE base directory
// ----------------------------------------------------------------
const BASE = process.pkg
  ? path.join(path.dirname(process.execPath), '..')
  : path.join(__dirname, '..');

const modelsDir = path.join(BASE, 'data', 'ai-models');

console.log('[PKG-SAFE] download-models writing to:', modelsDir);

const download = (url, dest) => {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const contentLength = parseInt(response.headers['content-length'], 10) / (1024 * 1024);

      if (contentLength > MAX_SIZE_MB) {
        console.error(`File ${url} exceeds max size (${MAX_SIZE_MB} MB).`);
        response.destroy();
        return reject(new Error('File too large.'));
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
};

const models = [
  { url: 'https://huggingface.co/gpt2/resolve/main/pytorch_model.bin',             dest: path.join(modelsDir, 'gpt2.bin') },
  { url: 'https://huggingface.co/bert-base-uncased/resolve/main/pytorch_model.bin', dest: path.join(modelsDir, 'bert-base-uncased.bin') },
];

(async () => {
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
    console.log('[PKG-SAFE] Created models dir:', modelsDir);
  }

  for (const model of models) {
    console.log(`Downloading ${model.url}...`);
    try {
      await download(model.url, model.dest);
      console.log(`Saved to ${model.dest}`);
    } catch (error) {
      console.error(`Failed to download ${model.url}:`, error.message);
    }
  }
  console.log('All models downloaded.');
})();
