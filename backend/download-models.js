const fs = require('fs');
const https = require('https');
const path = require('path');

const MAX_SIZE_MB = 100; // Taille maximale autorisée pour les téléchargements

const download = (url, dest) => {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const contentLength = parseInt(response.headers['content-length'], 10) / (1024 * 1024);

      if (contentLength > MAX_SIZE_MB) {
        console.error(`Le fichier ${url} dépasse la taille maximale autorisée (${MAX_SIZE_MB} Mo).`);
        response.destroy();
        return reject(new Error('Fichier trop volumineux.'));
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
  { url: 'https://huggingface.co/gpt2/resolve/main/pytorch_model.bin', dest: path.join(__dirname, 'models', 'gpt2.bin') },
  { url: 'https://huggingface.co/bert-base-uncased/resolve/main/pytorch_model.bin', dest: path.join(__dirname, 'models', 'bert-base-uncased.bin') },
];

(async () => {
  if (!fs.existsSync(path.join(__dirname, 'models'))){
    fs.mkdirSync(path.join(__dirname, 'models'));
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
