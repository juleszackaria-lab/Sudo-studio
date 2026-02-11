const fs = require('fs');
const path = require('path');

const saveFile = (filePath, content) => {
  fs.writeFileSync(path.resolve(__dirname, filePath), content);
  console.log(`Fichier sauvegardé à ${filePath}`);
};

module.exports = { saveFile };