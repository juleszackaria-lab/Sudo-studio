// filesystem.js — PKG-SAFE file service
// Under pkg, __dirname = /snapshot/... (READ-ONLY virtual FS).
// Never resolve write paths relative to __dirname.
// All writes use BASE (install root) as anchor.

const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------
// PKG-SAFE base directory
// ----------------------------------------------------------------
const BASE = process.pkg
  ? path.join(path.dirname(process.execPath), '..')
  : path.join(__dirname, '..', '..');

/**
 * saveFile(filePath, content)
 *
 * filePath — relative path from install root (e.g. 'data/myfile.txt')
 *            or absolute path (absolute paths are used as-is).
 * content  — string content to write.
 */
const saveFile = (filePath, content) => {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(BASE, filePath);

  console.log('[PKG-SAFE] filesystem.saveFile writing to:', resolvedPath);

  // Ensure parent directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(resolvedPath, content);
  console.log(`Fichier sauvegardé à ${resolvedPath}`);
};

module.exports = { saveFile };
